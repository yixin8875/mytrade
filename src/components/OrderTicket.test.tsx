import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { GatewayHealth, Quote, SymbolInfo } from '../gateway/types';
import { useApp } from '../store/useApp';
import { GOLD_INFO } from '../replay/testUtils';
import { OrderTicket } from './OrderTicket';

const SYMBOL = { ...GOLD_INFO, name: 'XAUUSD', description: 'Gold' } as SymbolInfo;

const QUOTE: Quote = {
  symbol: 'XAUUSD',
  bid: 2000,
  ask: 2000.5,
  time: 1_763_200_000,
  timeMs: 1_763_200_000_000,
};

const HEALTH = {
  connected: true,
  tradeMode: 'demo',
  account: { currency: 'USD' },
  config: { discipline_mode: 'off' },
} as unknown as GatewayHealth;

function reset(tradeMode: 'readonly' | 'demo' = 'demo') {
  window.localStorage.clear();
  useApp.setState({
    conn: 'open',
    health: { ...HEALTH, tradeMode } as GatewayHealth,
    symbols: [SYMBOL],
    symbol: 'XAUUSD',
    quote: QUOTE,
    draft: {
      active: false,
      symbol: '',
      side: 'buy',
      type: 'market',
      price: 0,
      sl: null,
      tp: null,
      volume: 0.01,
    },
    preview: null,
    risk: { mode: 'percent', value: 1, auto: true },
    riskStatus: null,
    templateArmed: false,
    orderEntryMode: 'regular',
    ticketOpen: true,
  });
}

describe('OrderTicket 下单模式', () => {
  beforeEach(() => reset());

  it('默认常规模式，菜单只提供常规与风险计算表格', async () => {
    const user = userEvent.setup();
    render(<OrderTicket />);

    const trigger = screen.getByRole('button', { name: /下单模式/ });
    expect(trigger).toHaveTextContent('常规模式');

    await user.click(trigger);
    const items = screen.getAllByRole('menuitemradio').map((item) => item.textContent ?? '');
    expect(items).toHaveLength(2);
    expect(items[0]).toContain('常规模式');
    expect(items[1]).toContain('风险计算表格');
    expect(screen.queryByText(/单击模式/)).not.toBeInTheDocument();
  });

  it('切到风险计算表格时显示自动手数', async () => {
    const user = userEvent.setup();
    render(<OrderTicket />);

    await user.click(screen.getByRole('button', { name: /下单模式/ }));
    await user.click(screen.getByRole('menuitemradio', { name: /风险计算表格/ }));

    expect(screen.getAllByText('风险计算表格').length).toBeGreaterThan(0);
    expect(screen.getByText('自动手数')).toBeInTheDocument();
    expect(window.localStorage.getItem('mytrade.orderEntryMode')).toBe('"risk"');
  });

  it('止损快捷按钮按现价偏移', async () => {
    const user = userEvent.setup();
    render(<OrderTicket />);

    await user.click(screen.getByRole('button', { name: '100点' }));

    expect(screen.getByLabelText('止损价格')).toHaveValue(1999.5);
    expect(useApp.getState().draft.sl).toBe(1999.5);
  });

  it('没有止损时 1R 止盈提示先设止损', async () => {
    const user = userEvent.setup();
    render(<OrderTicket />);

    await user.click(screen.getByRole('button', { name: '1R' }));

    expect(useApp.getState().toast?.text).toBe('先设置止损，再按 R 设置止盈');
    expect(useApp.getState().draft.tp).toBeNull();
  });

  it('点击卖出直接进入市价草稿', async () => {
    const user = userEvent.setup();
    render(<OrderTicket />);

    await user.click(screen.getByTitle('以市价卖出'));

    const draft = useApp.getState().draft;
    expect(draft.active).toBe(true);
    expect(draft.side).toBe('sell');
    expect(draft.type).toBe('market');
    expect(draft.price).toBe(2000);
  });

  it('风险计算表格：按风险与止损反算手数，缺止损时禁止提交', async () => {
    const user = userEvent.setup();
    render(<OrderTicket />);

    await user.click(screen.getByRole('button', { name: /下单模式/ }));
    await user.click(screen.getByRole('menuitemradio', { name: /风险计算表格/ }));

    // 风险占比默认 1%，手数以只读行展示
    expect(screen.getByLabelText('风险比例')).toHaveValue(1);
    expect(screen.getByText('自动手数')).toBeInTheDocument();
    expect(screen.getByText('风险占比')).toBeInTheDocument();
    expect(screen.getAllByText('保证金').length).toBeGreaterThan(1);
    const submit = screen.getByRole('button', { name: '设定止损与风险值' });
    expect(submit).toBeDisabled();

    // 固定金额模式下可以直接填风险金额
    await user.click(screen.getByRole('button', { name: '固定金额' }));
    expect(screen.getByLabelText('风险金额')).toHaveValue(1);

    // 填入止损后才允许提交，手数沿用自动值
    await user.click(screen.getByRole('button', { name: '100点' }));
    expect(useApp.getState().draft.sl).toBe(1999.5);
    expect(useApp.getState().risk.auto).toBe(true);
    expect(screen.getByRole('button', { name: '买入 0.01' })).toBeEnabled();
  });

  it('提交市价单先弹确认窗，取消后不发送订单', async () => {
    const user = userEvent.setup();
    render(<OrderTicket />);

    await user.click(screen.getByTitle('以市价买入'));
    await user.click(screen.getByRole('button', { name: '买入 0.01' }));

    const dialog = document.querySelector('[data-confirm="order"]');
    expect(dialog).not.toBeNull();
    expect(dialog).toHaveTextContent('确认下单');
    expect(dialog).toHaveTextContent('市价成交');
    expect(dialog).toHaveTextContent('USD');

    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(document.querySelector('[data-confirm="order"]')).toBeNull();
    // 取消只关弹窗，草稿保留，方便改价后再提交
    expect(useApp.getState().draft.active).toBe(true);
  });

  it('默认模板随卖出一步启用：风险与 2R 止盈直接带入', async () => {
    const user = userEvent.setup();
    useApp.setState({
      templates: [
        {
          id: 'td',
          name: '默认启用',
          riskMode: 'percent',
          riskPercent: 0.7,
          riskAmount: 100,
          rewardR: 2,
          steps: [],
          autoApply: true,
        },
      ],
      activeTemplateId: 'td',
      templateArmed: false,
    });
    render(<OrderTicket />);

    await user.click(screen.getByTitle('以市价卖出'));
    expect(useApp.getState().templateArmed).toBe(true);
    expect(useApp.getState().risk).toEqual({ mode: 'percent', value: 0.7, auto: true });

    await user.click(screen.getByRole('button', { name: '100点' }));
    const draft = useApp.getState().draft;
    expect(draft.sl).toBe(2001);
    expect(draft.tp).toBe(1998);
  });

  it('切换模板立即同步风险，不用再点启用', async () => {
    const user = userEvent.setup();
    useApp.setState({
      templates: [
        {
          id: 'a',
          name: 'A模板',
          riskMode: 'percent',
          riskPercent: 0.5,
          riskAmount: 100,
          rewardR: 2,
          steps: [],
          autoApply: true,
        },
        {
          id: 'b',
          name: 'B模板',
          riskMode: 'percent',
          riskPercent: 1.5,
          riskAmount: 100,
          rewardR: 1,
          steps: [],
          autoApply: false,
        },
      ],
      activeTemplateId: 'a',
      templateArmed: false,
    });
    render(<OrderTicket />);

    await user.click(screen.getByTitle('以市价买入'));
    expect(useApp.getState().risk.value).toBe(0.5);

    await user.click(screen.getByRole('button', { name: /A模板/ }));
    const menu = document.querySelector('[data-modal]') as HTMLElement;
    await user.click(within(menu).getByRole('button', { name: /B模板/ }));

    expect(useApp.getState().activeTemplateId).toBe('b');
    expect(useApp.getState().templateArmed).toBe(true);
    expect(useApp.getState().risk.value).toBe(1.5);
  });

  it('挂单按价格推导限价 / 停损，点差内价格禁止提交', async () => {
    const user = userEvent.setup();
    render(<OrderTicket />);

    await user.click(screen.getByTitle('以市价买入'));
    await user.click(screen.getByRole('button', { name: '挂单' }));

    // 默认价在市价上方 → 停损买入
    expect(screen.getByText('停损买入')).toBeInTheDocument();

    const price = screen.getByLabelText('委托价格');
    await user.clear(price);
    await user.type(price, '1999');
    expect(screen.getByText('限价买入')).toBeInTheDocument();
    expect(useApp.getState().draft.type).toBe('limit');

    await user.clear(price);
    await user.type(price, '2000.2');
    expect(screen.getByText('待定价')).toBeInTheDocument();
    expect(screen.getByText(/点差内/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '委托价无效' })).toBeDisabled();
  });
});
