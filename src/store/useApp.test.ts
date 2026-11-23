import { beforeEach, describe, expect, it } from 'vitest';
import type { DraftOrder, Quote, TradeTemplate } from '../gateway/types';
import { DEFAULT_ACCENT } from '../lib/accent';
import { DEFAULT_TEMPLATE } from '../lib/template';
import { GOLD_INFO } from '../replay/testUtils';
import {
  activeTemplate,
  handleGlobalShortcut,
  LEGACY_PAGES,
  PAGES,
  routeFromHash,
  selectSymbolInfo,
  syncPageFromHash,
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
    symbol: '',
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
    alertPrefill: null,
    calendarOpen: false,
    paletteOpen: false,
    templates: [template],
    activeTemplateId: template.id,
    templateArmed: false,
    theme: 'light',
    breakevenOffset: 0,
    layout: '1',
    layoutSync: { symbol: false, interval: false, crosshair: true, time: false },
    accentColor: DEFAULT_ACCENT,
    alertSound: true,
    alertDesktop: false,
    watchlist: ['XAUUSD'],
    watchRows: [],
    orderTag: '',
    toast: null,
    ticketOpen: false,
    crosshairPrice: null,
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
    window.history.replaceState(null, '', '/#/insights');
    expect(routeFromHash()).toBe('insights');

    window.history.replaceState(null, '', '#/replay/session-1');
    expect(routeFromHash()).toBe('replay');
  });

  it('旧深链映射到容器页', () => {
    window.history.replaceState(null, '', '/#/reports');
    expect(routeFromHash()).toBe('insights');

    window.history.replaceState(null, '', '/#/diary');
    expect(routeFromHash()).toBe('records');

    window.history.replaceState(null, '', '/#/missed');
    expect(routeFromHash()).toBe('discipline');
  });

  it('运行时旧深链同时切换页签', () => {
    window.history.replaceState(null, '', '/#/diary');
    syncPageFromHash();
    expect(useApp.getState().page).toBe('records');
    expect(useApp.getState().recordsTab).toBe('calendar');

    window.history.replaceState(null, '', '/#/missed');
    syncPageFromHash();
    expect(useApp.getState().page).toBe('discipline');
    expect(useApp.getState().disciplineTab).toBe('missed');
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

  it('旧页面落到容器页并切到对应页签', () => {
    useApp.getState().setPage('diary');
    expect(useApp.getState().page).toBe('records');
    expect(useApp.getState().recordsTab).toBe('calendar');
    expect(window.location.hash).toBe('#/records');

    useApp.getState().setPage('trends');
    expect(useApp.getState().page).toBe('insights');
    expect(useApp.getState().insightsTab).toBe('review');
    expect(window.location.hash).toBe('#/insights');
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

describe('patchDraft', () => {
  it('激活草稿时记住当前品种，之后拖动止损不会丢', () => {
    useApp.getState().patchDraft({ active: true, type: 'market' });
    expect(useApp.getState().draft.symbol).toBe('XAUUSD');

    useApp.getState().patchDraft({ sl: 3900 });
    expect(useApp.getState().draft.symbol).toBe('XAUUSD');

    useApp.getState().resetDraft();
    expect(useApp.getState().draft.symbol).toBe('');
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

  it('保本偏移按 0–500 整数保存', () => {
    useApp.getState().setBreakevenOffset(5.6);
    expect(useApp.getState().breakevenOffset).toBe(6);
    expect(JSON.parse(window.localStorage.getItem('mytrade.breakevenOffset') ?? 'null')).toBe(6);

    useApp.getState().setBreakevenOffset(-3);
    expect(useApp.getState().breakevenOffset).toBe(0);

    useApp.getState().setBreakevenOffset(999);
    expect(useApp.getState().breakevenOffset).toBe(500);
  });

  it('多图同步开关按字段合并', () => {
    useApp.getState().setLayoutSync({ crosshair: false, symbol: true });
    expect(useApp.getState().layoutSync).toEqual({
      symbol: true,
      interval: false,
      crosshair: false,
      time: false,
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
      draft({ active: true, symbol: 'XAUUSD', side: 'buy', type: 'market', price: 3980.2 }),
    );
    expect(useApp.getState().toast).toMatchObject({ kind: 'info' });
    useApp.getState().clearToast();

    useApp.getState().resetDraft();
    handleGlobalShortcut(new KeyboardEvent('keydown', { key: 'S' }));
    expect(useApp.getState().draft).toEqual(
      draft({ active: true, symbol: 'XAUUSD', side: 'sell', type: 'market', price: 3980 }),
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

  it('Alt+A 预填告警，Alt+Shift+B/S 预填买卖草稿', () => {
    tradeReady();
    useApp.setState({ crosshairPrice: 3970, alertsOpen: false, ticketOpen: false });

    handleGlobalShortcut(new KeyboardEvent('keydown', { key: 'a', altKey: true }));
    expect(useApp.getState().alertsOpen).toBe(true);
    expect(useApp.getState().alertPrefill).toMatchObject({ price: 3970, kind: 'below' });

    useApp.getState().clearAlertPrefill();
    useApp.getState().setAlertsOpen(false);

    handleGlobalShortcut(new KeyboardEvent('keydown', { key: 'B', altKey: true, shiftKey: true }));
    expect(useApp.getState().draft).toMatchObject({
      active: true,
      side: 'buy',
      type: 'limit',
      price: 3970,
    });
    expect(useApp.getState().ticketOpen).toBe(true);
    useApp.getState().resetDraft();

    handleGlobalShortcut(new KeyboardEvent('keydown', { key: 'S', altKey: true, shiftKey: true }));
    expect(useApp.getState().draft).toMatchObject({ side: 'sell', type: 'stop', price: 3970 });
  });

  it('没有十字线价格时 Alt 快捷键用对手价兜底', () => {
    tradeReady();
    useApp.setState({ crosshairPrice: null, draft: draft() });

    handleGlobalShortcut(new KeyboardEvent('keydown', { key: 'b', altKey: true, shiftKey: true }));
    expect(useApp.getState().draft).toMatchObject({ type: 'limit', price: 3980.2 });
  });

  it('Alt 快捷键在输入框、弹窗、非交易台都不响应', () => {
    tradeReady();
    const input = document.createElement('input');
    document.body.append(input);
    const typed = new KeyboardEvent('keydown', { key: 'a', altKey: true });
    Object.defineProperty(typed, 'target', { value: input });
    handleGlobalShortcut(typed);
    expect(useApp.getState().alertsOpen).toBe(false);
    input.remove();

    const modal = document.createElement('div');
    modal.dataset.modal = '';
    document.body.append(modal);
    handleGlobalShortcut(new KeyboardEvent('keydown', { key: 'a', altKey: true }));
    expect(useApp.getState().alertsOpen).toBe(false);
    modal.remove();

    useApp.setState({ page: 'overview' });
    handleGlobalShortcut(new KeyboardEvent('keydown', { key: 'a', altKey: true }));
    expect(useApp.getState().alertsOpen).toBe(false);
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

describe('chartQuickAction', () => {
  function tradeReady(): void {
    useApp.setState({
      page: 'trade',
      symbols: [GOLD_INFO],
      symbol: 'XAUUSD',
      quote: QUOTE,
      draft: draft(),
      alertsOpen: false,
      ticketOpen: false,
      alertPrefill: null,
      crosshairPrice: null,
      toast: null,
    });
  }

  it('买入只预填草稿并打开下单区', () => {
    tradeReady();
    useApp.getState().chartQuickAction('buy', 3970);
    const state = useApp.getState();

    expect(state.draft).toEqual(
      draft({ active: true, symbol: 'XAUUSD', side: 'buy', type: 'limit', price: 3970 }),
    );
    expect(state.ticketOpen).toBe(true);
    expect(state.toast).toMatchObject({
      kind: 'info',
      text: '已预填 XAUUSD 限价买入，核对后下单',
    });
  });

  it('卖出按点击价推导为停损', () => {
    tradeReady();
    useApp.getState().chartQuickAction('sell', 3970);

    expect(useApp.getState().draft).toMatchObject({
      active: true,
      side: 'sell',
      type: 'stop',
      price: 3970,
    });
  });

  it('价格先按 tick 对齐', () => {
    tradeReady();
    useApp.getState().chartQuickAction('buy', 3970.234);

    expect(useApp.getState().draft.price).toBe(3970.23);
  });

  it('警报写入 alertPrefill，nonce 递增，可清空', () => {
    tradeReady();
    useApp.getState().chartQuickAction('alert', 3970);
    let state = useApp.getState();
    expect(state.alertsOpen).toBe(true);
    expect(state.alertPrefill).toEqual({
      symbol: 'XAUUSD',
      price: 3970,
      kind: 'below',
      nonce: 1,
    });
    expect(state.draft.active).toBe(false);

    useApp.getState().chartQuickAction('alert', 3990);
    state = useApp.getState();
    expect(state.alertPrefill).toMatchObject({ price: 3990, kind: 'above', nonce: 2 });

    useApp.getState().clearAlertPrefill();
    expect(useApp.getState().alertPrefill).toBeNull();
  });

  it('不在交易台或价格无效时什么都不做', () => {
    tradeReady();
    useApp.setState({ page: 'overview' });
    useApp.getState().chartQuickAction('buy', 3970);
    expect(useApp.getState().draft.active).toBe(false);

    useApp.setState({ page: 'trade', toast: null });
    useApp.getState().chartQuickAction('buy', 0);
    expect(useApp.getState().draft.active).toBe(false);
    expect(useApp.getState().toast).toMatchObject({ kind: 'error' });
  });

  it('图表品种与全局不同时先切换品种再预填', () => {
    const eur = {
      ...GOLD_INFO,
      name: 'EURUSD',
      digits: 5,
      point: 0.00001,
      tickSize: 0.00001,
    };
    useApp.setState({
      page: 'trade',
      symbols: [GOLD_INFO, eur],
      symbol: 'XAUUSD',
      quote: { ...QUOTE, symbol: 'EURUSD', bid: 1.1, ask: 1.10002 },
      draft: draft(),
      ticketOpen: false,
      toast: null,
    });

    useApp.getState().chartQuickAction('buy', 1.09, 'EURUSD');
    const state = useApp.getState();

    expect(state.symbol).toBe('EURUSD');
    expect(state.draft).toMatchObject({
      active: true,
      symbol: 'EURUSD',
      side: 'buy',
      type: 'limit',
      price: 1.09,
    });
  });

  it('切换账号时清空告警预填', () => {
    tradeReady();
    useApp.getState().chartQuickAction('alert', 3970);
    expect(useApp.getState().alertPrefill).not.toBeNull();

    useApp.getState().resetForAccountSwitch();
    expect(useApp.getState().alertPrefill).toBeNull();
  });
});

describe('容器页与设置返回', () => {
  it('页签 setter 只改页签，不动当前页面', () => {
    useApp.getState().setPage('overview');
    useApp.getState().setRecordsTab('calendar');
    useApp.getState().setInsightsTab('review');
    useApp.getState().setDisciplineTab('routines');

    const state = useApp.getState();
    expect(state.page).toBe('overview');
    expect(state.recordsTab).toBe('calendar');
    expect(state.insightsTab).toBe('review');
    expect(state.disciplineTab).toBe('routines');
  });

  it('旧页面全部落到容器页，且旧页面不在顶层导航里', () => {
    const legacyPages = Object.keys(LEGACY_PAGES);
    expect(legacyPages.sort()).toEqual([
      'analysis',
      'diary',
      'executions',
      'journal',
      'missed',
      'reports',
      'routines',
      'strategy',
      'trends',
    ]);

    for (const page of legacyPages) {
      expect(PAGES).not.toContain(page);
      useApp.getState().setPage(page as never);
      expect(useApp.getState().page).toBe(LEGACY_PAGES[page].page);
      expect(window.location.hash).toBe(`#/${LEGACY_PAGES[page].page}`);
    }
  });

  it('openSettings 记住来源页，重复打开不覆盖', () => {
    useApp.getState().setPage('trade');
    useApp.getState().openSettings('diagnostics');

    expect(useApp.getState().page).toBe('settings');
    expect(useApp.getState().settingsSection).toBe('diagnostics');
    expect(useApp.getState().settingsReturn).toBe('trade');

    // 已经在设置页时再切分区，返回目标保持最初来源
    useApp.getState().openSettings('ai');
    expect(useApp.getState().settingsReturn).toBe('trade');

    useApp.getState().setPage(useApp.getState().settingsReturn as never);
    expect(useApp.getState().page).toBe('trade');
  });

  it('导出天数默认 30 天，可改成全部（0）', () => {
    expect(useApp.getState().exportDays).toBe(30);
    useApp.getState().setExportDays(0);
    expect(useApp.getState().exportDays).toBe(0);
    useApp.getState().setExportDays(90);
    expect(useApp.getState().exportDays).toBe(90);
  });
});
