import { render, screen } from '@testing-library/react';
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
