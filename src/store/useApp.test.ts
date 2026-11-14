import { beforeEach, describe, expect, it } from 'vitest';
import type { DraftOrder, Quote, TradeTemplate } from '../gateway/types';
import { DEFAULT_ACCENT } from '../lib/accent';
import { DEFAULT_TEMPLATE } from '../lib/template';
import { GOLD_INFO } from '../replay/testUtils';
import {
  activeTemplate,
  handleGlobalShortcut,
  routeFromHash,
  selectSymbolInfo,
  useApp,
} from './useApp';

const QUOTE: Quote = {
  symbol: 'XAUUSD',
  bid: 3980,
  ask: 3980.2,
  time: 1_700_000_000,
  timeMs: 1_700_000_000_000,
};

function draft(overrides: Partial<DraftOrder> = {}): DraftOrder {
  return {
    active: false,
    side: 'buy',
    type: 'limit',
    price: 0,
    sl: null,
    tp: null,
    volume: 0.01,
    ...overrides,
  };
}

function cloneTemplate(template: TradeTemplate): TradeTemplate {
  return { ...template, steps: template.steps.map((step) => ({ ...step })) };
}

function resetStore(): void {
  const template = cloneTemplate(DEFAULT_TEMPLATE);
  useApp.setState({
    page: 'overview',
    conn: 'closed',
    symbols: [GOLD_INFO],
    symbol: 'XAUUSD',
    quote: null,
    account: null,
    positions: [],
    orders: [],
    draft: draft(),
    preview: null,
    risk: { mode: 'percent', value: 1, auto: true },
    riskStatus: null,
    alerts: [],
    alertsOpen: false,
    calendarOpen: false,
    paletteOpen: false,
    templates: [template],
    activeTemplateId: template.id,
    templateArmed: false,
    theme: 'light',
    layout: '1',
    layoutSync: { symbol: false, interval: false, crosshair: true, time: false, dateRange: false },
    accentColor: DEFAULT_ACCENT,
    alertSound: true,
    alertDesktop: false,
    watchlist: ['XAUUSD'],
    watchRows: [],
    orderTag: '',
    toast: null,
  });
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  resetStore();
});

function savedTemplates(): { activeId: string; list: TradeTemplate[] } {
  return JSON.parse(window.localStorage.getItem('mytrade.templates') ?? '{}') as {
    activeId: string;
    list: TradeTemplate[];
  };
}

describe('routeFromHash', () => {
  it('取第一段作为页面', () => {
    window.history.replaceState(null, '', '/#/reports');
    expect(routeFromHash()).toBe('reports');

    window.history.replaceState(null, '', '#/replay/session-1');
    expect(routeFromHash()).toBe('replay');
  });

  it('未知或空 hash 回到概览', () => {
    window.history.replaceState(null, '', '/#/nope');
    expect(routeFromHash()).toBe('overview');

    window.history.replaceState(null, '', '/');
    expect(routeFromHash()).toBe('overview');
  });
});

describe('setPage', () => {
  it('写回 hash', () => {
    useApp.getState().setPage('trade');
    expect(useApp.getState().page).toBe('trade');
    expect(window.location.hash).toBe('#/trade');
  });

  it('复盘子路由不会被覆盖', () => {
    window.history.replaceState(null, '', '#/replay/session-1');
    useApp.getState().setPage('replay');
    expect(window.location.hash).toBe('#/replay/session-1');
    expect(useApp.getState().page).toBe('replay');
  });
});

describe('下单模板', () => {
  it('activeTemplate 找不到当前 id 时退回第一条', () => {
    const state = useApp.getState();
    expect(activeTemplate(state).id).toBe('default');

    useApp.setState({ activeTemplateId: 'missing' });
    expect(activeTemplate(useApp.getState()).id).toBe('default');
  });

  it('切换模板会校验 id 并持久化', () => {
    useApp.getState().createTemplate();
    const second = useApp.getState().templates[1];

    useApp.getState().setActiveTemplate('missing');
    expect(useApp.getState().activeTemplateId).toBe(second.id);

    useApp.getState().setActiveTemplate('default');
    expect(useApp.getState().activeTemplateId).toBe('default');
    expect(savedTemplates().activeId).toBe('default');
  });

  it('复制当前模板会生成副本并选中它', () => {
    useApp.getState().addTemplate();
    const state = useApp.getState();

    expect(state.templates).toHaveLength(2);
    expect(state.templates[1].name).toBe('默认模板 副本');
    expect(state.templates[1].id).not.toBe('default');
    expect(state.templates[1].steps).toEqual(DEFAULT_TEMPLATE.steps);
    expect(state.activeTemplateId).toBe(state.templates[1].id);
    expect(savedTemplates().list).toHaveLength(2);
  });

  it('新建空白模板用默认参数并按序号命名', () => {
    useApp.getState().createTemplate();
    const created = useApp.getState().templates[1];

    expect(created.name).toBe('模板 2');
    expect(created.riskPercent).toBe(DEFAULT_TEMPLATE.riskPercent);
    expect(created.rewardR).toBe(DEFAULT_TEMPLATE.rewardR);
    expect(useApp.getState().activeTemplateId).toBe(created.id);
  });

  it('更新模板时清洗数值并按 R 排序', () => {
    useApp.getState().updateTemplate('default', {
      name: '  我的模板  ',
      riskPercent: 0,
      rewardR: 999,
      steps: [
        { atR: 3, closePercent: 50, moveBreakeven: false },
        { atR: 1, closePercent: null, moveBreakeven: true },
      ],
    });
    const template = useApp.getState().templates[0];

    expect(template.id).toBe('default');
    expect(template.name).toBe('我的模板');
    expect(template.riskPercent).toBe(0.5);
    expect(template.rewardR).toBe(2);
    expect(template.steps).toEqual([
      { atR: 1, closePercent: null, moveBreakeven: true },
      { atR: 3, closePercent: 50, moveBreakeven: false },
    ]);
    expect(savedTemplates().list[0].steps).toHaveLength(2);
  });

  it('最后一条模板不能删除', () => {
    useApp.getState().deleteTemplate('default');
    expect(useApp.getState().templates).toHaveLength(1);
  });

  it('删除正在启用的模板会切到第一条并解除', () => {
    useApp.getState().createTemplate();
    useApp.getState().setTemplateArmed(true);
    const active = useApp.getState().activeTemplateId;

    useApp.getState().deleteTemplate(active);
    const state = useApp.getState();

    expect(state.templates).toHaveLength(1);
    expect(state.activeTemplateId).toBe('default');
    expect(state.templateArmed).toBe(false);
    expect(state.toast).toMatchObject({ kind: 'info', text: '当前模板已删除，下单模板已解除' });
    expect(savedTemplates().list).toHaveLength(1);
  });

  it('删除非启用模板不影响已启用的计划', () => {
    useApp.getState().createTemplate();
    useApp.getState().setActiveTemplate('default');
    useApp.getState().setTemplateArmed(true);

    const other = useApp.getState().templates[1];
    useApp.getState().deleteTemplate(other.id);
    const state = useApp.getState();

    expect(state.activeTemplateId).toBe('default');
    expect(state.templateArmed).toBe(true);
    expect(state.templates).toHaveLength(1);
  });
});

describe('setSymbol', () => {
  it('切换品种会清空报价、止盈止损和已启用的模板', () => {
    useApp.setState({
      quote: QUOTE,
      templateArmed: true,
      draft: draft({ active: true, price: 4000, sl: 3990, tp: 4010 }),
    });

    useApp.getState().setSymbol('EURUSD');
    const state = useApp.getState();

    expect(state.symbol).toBe('EURUSD');
    expect(state.quote).toBeNull();
    expect(state.templateArmed).toBe(false);
    expect(state.draft).toEqual(draft());
    expect(state.toast).toMatchObject({ kind: 'info', text: '已切换品种，下单模板已解除' });
  });

  it('没有启用的模板时不打扰用户', () => {
    useApp.getState().setSymbol('EURUSD');
    expect(useApp.getState().toast).toBeNull();
  });

  it('未激活的草稿原样保留', () => {
    useApp.setState({ draft: draft({ price: 3976, sl: 3968 }) });
    useApp.getState().setSymbol('EURUSD');
    expect(useApp.getState().draft.price).toBe(3976);
    expect(useApp.getState().draft.sl).toBe(3968);
  });
});

describe('设置项', () => {
  it('patchRisk 合并并写入 localStorage', () => {
    useApp.getState().patchRisk({ value: 2 });
    expect(useApp.getState().risk).toEqual({ mode: 'percent', value: 2, auto: true });
    expect(JSON.parse(window.localStorage.getItem('mytrade.risk') ?? '{}')).toEqual({
      mode: 'percent',
      value: 2,
      auto: true,
    });
  });

  it('强调色非法时回到默认，合法时统一成小写六位', () => {
    useApp.getState().setAccentColor('nope');
    expect(useApp.getState().accentColor).toBe(DEFAULT_ACCENT);

    useApp.getState().setAccentColor('#ABC');
    expect(useApp.getState().accentColor).toBe('#aabbcc');
    expect(JSON.parse(window.localStorage.getItem('mytrade.accent') ?? '""')).toBe('#aabbcc');
  });

  it('布局 id 会被规范化后保存', () => {
    useApp.getState().setLayout('quad');
    expect(useApp.getState().layout).toBe('4');

    useApp.getState().setLayout('bogus');
    expect(useApp.getState().layout).toBe('1');
    expect(JSON.parse(window.localStorage.getItem('mytrade.layout') ?? '""')).toBe('1');
  });

  it('多图同步开关按字段合并', () => {
    useApp.getState().setLayoutSync({ crosshair: false, symbol: true });
    expect(useApp.getState().layoutSync).toEqual({
      symbol: true,
      interval: false,
      crosshair: false,
      time: false,
      dateRange: false,
    });
  });
});

describe('selectSymbolInfo', () => {
  it('按当前品种找规格，找不到返回 undefined', () => {
    expect(selectSymbolInfo(useApp.getState())?.name).toBe('XAUUSD');
    useApp.setState({ symbol: 'EURUSD' });
    expect(selectSymbolInfo(useApp.getState())).toBeUndefined();
  });
});

describe('resetForAccountSwitch', () => {
  it('清空运行时状态但保留模板与自选', () => {
    useApp.setState({
      account: {
        login: 1,
        server: 'Demo',
        company: 'Broker',
        name: 'Trader',
        currency: 'USD',
        leverage: 100,
        balance: 10000,
        equity: 10000,
        margin: 0,
        freeMargin: 10000,
        marginLevel: null,
        marginMode: 'hedging',
        tradeAllowed: true,
        accountType: 'demo',
      },
      positions: [
        {
          ticket: 1,
          identifier: 1,
          symbol: 'XAUUSD',
          side: 'buy',
          volume: 0.1,
          openPrice: 3900,
          sl: null,
          tp: null,
          profit: 10,
          swap: 0,
          commission: 0,
          magic: 0,
          comment: '',
          openTime: 1_700_000_000,
        },
      ],
      draft: draft({ active: true }),
      templateArmed: true,
    });

    useApp.getState().resetForAccountSwitch();
    const state = useApp.getState();

    expect(state.account).toBeNull();
    expect(state.positions).toEqual([]);
    expect(state.symbol).toBe('');
    expect(state.draft).toEqual(draft());
    expect(state.templateArmed).toBe(false);
    expect(state.templates).toHaveLength(1);
    expect(state.watchlist).toEqual(['XAUUSD']);
  });
});

describe('handleGlobalShortcut', () => {
  function tradeReady(): void {
    useApp.setState({ page: 'trade', quote: QUOTE, draft: draft() });
  }

  it('Ctrl/Cmd+K 开关命令面板', () => {
    handleGlobalShortcut(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
    expect(useApp.getState().paletteOpen).toBe(true);

    handleGlobalShortcut(new KeyboardEvent('keydown', { key: 'K', metaKey: true }));
    expect(useApp.getState().paletteOpen).toBe(false);
  });

  it('带修饰键的其他按键不处理', () => {
    tradeReady();
    handleGlobalShortcut(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true }));
    expect(useApp.getState().draft.active).toBe(false);
  });

  it('B / S 按报价准备市价草稿', () => {
    tradeReady();

    handleGlobalShortcut(new KeyboardEvent('keydown', { key: 'b' }));
    expect(useApp.getState().draft).toEqual(
      draft({ active: true, side: 'buy', type: 'market', price: 3980.2 }),
    );
    expect(useApp.getState().toast).toMatchObject({ kind: 'info' });
    useApp.getState().clearToast();

    useApp.getState().resetDraft();
    handleGlobalShortcut(new KeyboardEvent('keydown', { key: 'S' }));
    expect(useApp.getState().draft).toEqual(
      draft({ active: true, side: 'sell', type: 'market', price: 3980 }),
    );
    useApp.getState().clearToast();
  });

  it('不在交易台、没有报价或输入框里都不响应', () => {
    useApp.setState({ page: 'replay', quote: QUOTE, draft: draft() });
    handleGlobalShortcut(new KeyboardEvent('keydown', { key: 'b' }));
    expect(useApp.getState().draft.active).toBe(false);

    useApp.setState({ page: 'trade', quote: null });
    handleGlobalShortcut(new KeyboardEvent('keydown', { key: 'b' }));
    expect(useApp.getState().draft.active).toBe(false);

    tradeReady();
    const input = document.createElement('input');
    document.body.append(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
    expect(useApp.getState().draft.active).toBe(false);
    input.remove();
  });

  it('弹窗打开时不改草稿', () => {
    tradeReady();
    const modal = document.createElement('div');
    modal.dataset.modal = '';
    document.body.append(modal);

    handleGlobalShortcut(new KeyboardEvent('keydown', { key: 'b' }));
    expect(useApp.getState().draft.active).toBe(false);
    modal.remove();
  });

  it('Esc 关闭面板并解除草稿与模板', () => {
    tradeReady();
    useApp.setState({
      alertsOpen: true,
      calendarOpen: true,
      paletteOpen: true,
      templateArmed: true,
      draft: draft({ active: true, price: 3980 }),
    });

    handleGlobalShortcut(new KeyboardEvent('keydown', { key: 'Escape' }));
    const state = useApp.getState();

    expect(state.alertsOpen).toBe(false);
    expect(state.calendarOpen).toBe(false);
    expect(state.paletteOpen).toBe(false);
    expect(state.templateArmed).toBe(false);
    expect(state.draft.active).toBe(false);
  });
});
