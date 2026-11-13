import { create } from 'zustand';
import { normalizeLayoutId } from '../chart/layouts';
import { DEFAULT_ACCENT, normalizeHex } from '../lib/accent';
import type {
  Account,
  ConnState,
  DraftOrder,
  GatewayHealth,
  Order,
  Position,
  PriceAlert,
  Quote,
  RiskSettings,
  RiskStatus,
  SymbolInfo,
  TemplateStep,
  Toast,
  TradePreview,
  TradeTemplate,
  WatchlistRow,
} from '../gateway/types';

export type SidebarTab = 'positions' | 'orders' | 'watchlist';
/** 布局预设 id，见 chart/layouts.ts */
export type ChartLayout = string;

/** 多图布局里要同步到所有图表的内容 */
export interface ChartSync {
  symbol: boolean;
  interval: boolean;
  crosshair: boolean;
  /** 可视时间区间（滚动/缩放） */
  time: boolean;
  /** 日期范围选择器 */
  dateRange: boolean;
}

/** 浅色 = 冷灰仪器台，白色 = 纯白底材，深色 = 墨色阶梯 */
export type Theme = 'light' | 'white' | 'dark';

export const THEMES: Theme[] = ['light', 'white', 'dark'];

/** 控制台页面：概览 / 交易台 / 交易日志 / 统计报表 / 执行质量 / 审计日志 / 设置 */
export type Page =
  | 'overview'
  | 'trade'
  | 'journal'
  | 'reports'
  | 'executions'
  | 'audit'
  | 'settings';

export const PAGES: Page[] = [
  'overview',
  'trade',
  'journal',
  'reports',
  'executions',
  'audit',
  'settings',
];

/** 设置页左侧分区，和 SettingsPanel 的 NAV 一一对应 */
export type SettingsSection =
  | 'appearance'
  | 'chart'
  | 'pine'
  | 'template'
  | 'risk'
  | 'accounts'
  | 'alerts'
  | 'updates'
  | 'about';

/** 用 hash 记住当前页，刷新或从图表 iframe 回来都不会丢 */
export function routeFromHash(): Page {
  const raw = window.location.hash.replace(/^#\/?/, '');
  return (PAGES as string[]).includes(raw) ? (raw as Page) : 'overview';
}

interface AppStore {
  page: Page;
  conn: ConnState;
  health: GatewayHealth | null;
  latency: number | null;
  symbols: SymbolInfo[];
  symbol: string;
  resolution: string;
  quote: Quote | null;
  account: Account | null;
  positions: Position[];
  orders: Order[];
  draft: DraftOrder;
  /** 当前草稿的券商预演结果（保证金/风险/回报），图表上的金额标签也用它 */
  preview: TradePreview | null;
  /** 手数计算设置 */
  risk: RiskSettings;
  /** 网关算出的当日风控状态（亏损额度/连亏/冷却/停机） */
  riskStatus: RiskStatus | null;
  /** 价格告警与通知偏好 */
  alerts: PriceAlert[];
  /** 交易台右侧的告警面板是否展开 */
  alertsOpen: boolean;
  /** 全部下单模板（风险 %、止盈 R、分批止盈阶段），存 localStorage */
  templates: TradeTemplate[];
  /** 下单票当前使用的模板 id */
  activeTemplateId: string;
  /** 下单模板当前是否已启用（本轮草稿） */
  templateArmed: boolean;
  /** 设置页当前分区 */
  settingsSection: SettingsSection;
  layout: ChartLayout;
  layoutSync: ChartSync;
  /** 深色 / 浅色主题，存 localStorage */
  theme: Theme;
  /** 强调色 #rrggbb，存 localStorage；默认色不写覆盖，交给 CSS 默认值 */
  accentColor: string;
  alertSound: boolean;
  alertDesktop: boolean;
  /** 图表十字线最新价格（用于快速建告警） */
  crosshairPrice: number | null;
  /** 自选表 */
  watchlist: string[];
  watchRows: WatchlistRow[];
  /** 下单时填的策略标签 */
  orderTag: string;
  sidebarTab: SidebarTab;
  toast: Toast | null;

  setPage: (page: Page) => void;
  setConn: (conn: ConnState) => void;
  setHealth: (health: GatewayHealth | null) => void;
  setLatency: (latency: number | null) => void;
  setSymbols: (symbols: SymbolInfo[]) => void;
  setSymbol: (symbol: string) => void;
  setResolution: (resolution: string) => void;
  setQuote: (quote: Quote | null) => void;
  setAccount: (account: Account | null) => void;
  setPositions: (positions: Position[]) => void;
  setOrders: (orders: Order[]) => void;
  patchDraft: (patch: Partial<DraftOrder>) => void;
  resetDraft: () => void;
  setPreview: (preview: TradePreview | null) => void;
  patchRisk: (patch: Partial<RiskSettings>) => void;
  setRiskStatus: (riskStatus: RiskStatus | null) => void;
  setAlerts: (alerts: PriceAlert[]) => void;
  setAlertsOpen: (open: boolean) => void;
  setActiveTemplate: (id: string) => void;
  /** 修改指定模板；id / name 之外走同一套清洗规则 */
  updateTemplate: (id: string, patch: Partial<Omit<TradeTemplate, 'id'>>) => void;
  addTemplate: () => void;
  deleteTemplate: (id: string) => void;
  setTemplateArmed: (armed: boolean) => void;
  setSettingsSection: (section: SettingsSection) => void;
  setLayout: (layout: ChartLayout) => void;
  setLayoutSync: (patch: Partial<ChartSync>) => void;
  setTheme: (theme: Theme) => void;
  /** 传非法值时回到默认强调色 */
  setAccentColor: (hex: string) => void;
  setAlertPrefs: (patch: Partial<Pick<AppStore, 'alertSound' | 'alertDesktop'>>) => void;
  setCrosshairPrice: (price: number | null) => void;
  setWatchlist: (watchlist: string[]) => void;
  setWatchRows: (rows: WatchlistRow[]) => void;
  setOrderTag: (tag: string) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  notify: (kind: Toast['kind'], text: string) => void;
  clearToast: () => void;
  /** 切换 MT5 账户后清空上一个账户的运行时状态 */
  resetForAccountSwitch: () => void;
}

const emptyDraft: DraftOrder = {
  active: false,
  side: 'buy',
  type: 'limit',
  price: 0,
  sl: null,
  tp: null,
  volume: 0.01,
};

const defaultRisk: RiskSettings = {
  mode: 'percent',
  value: 1,
  auto: true,
};

const RISK_KEY = 'mytrade.risk';

/** 模板最多带多少个阶段，防止手改配置拖垮 0.4 秒一轮的检查 */
const MAX_STEPS = 8;

const TEMPLATES_KEY = 'mytrade.templates';
/** 旧版本单个模板的键，启动时迁移成列表里的「默认模板」 */
const LEGACY_TEMPLATE_KEY = 'mytrade.template';
/** 全新安装的默认模板：0.5% 风险 + 2R 止盈 + 1R 移到保本 */
const DEFAULT_STEPS: TemplateStep[] = [{ atR: 1, closePercent: null, moveBreakeven: true }];

type TemplateInput = Partial<TradeTemplate> & { breakevenR?: number };

function numIn(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback;
}

function newTemplateId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `tpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

/** 阶段清洗：R 必须为正、平仓比例留空或 1–99、按 R 升序、最多 MAX_STEPS 条 */
function normalizeSteps(raw: unknown): TemplateStep[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const source = (item ?? {}) as Record<string, unknown>;
      const atR = Number(source.atR);
      if (!Number.isFinite(atR) || atR <= 0 || atR > 100) return null;
      const close = source.closePercent == null ? null : Number(source.closePercent);
      const closePercent =
        close != null && Number.isFinite(close) && close > 0 && close < 100 ? close : null;
      return { atR, closePercent, moveBreakeven: source.moveBreakeven === true };
    })
    .filter((item): item is TemplateStep => item !== null)
    .sort((a, b) => a.atR - b.atR)
    .slice(0, MAX_STEPS);
}

/**
 * 把任意来源的模板数据洗干净。
 * 旧版本只有 riskPercent / rewardR / breakevenR 三个字段，这里转成一个
 * 「浮盈 beR 移到保本」的阶段，迁移后行为不变。
 */
function makeTemplate(raw: TemplateInput = {}): TradeTemplate {
  const steps = normalizeSteps(raw.steps);
  const legacyBreakeven = numIn(raw.breakevenR, 0, 50, 0);
  const hasSteps = Array.isArray(raw.steps);
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newTemplateId(),
    name:
      typeof raw.name === 'string' && raw.name.trim()
        ? raw.name.trim().slice(0, 24)
        : '默认模板',
    riskPercent: numIn(raw.riskPercent, 0.01, 100, 0.5),
    rewardR: numIn(raw.rewardR, 0, 50, 2),
    steps:
      hasSteps || legacyBreakeven <= 0
        ? steps
        : [{ atR: legacyBreakeven, closePercent: null, moveBreakeven: true }],
  };
}

interface TemplateBundle {
  templates: TradeTemplate[];
  activeTemplateId: string;
}

/** 读模板列表；没有就按旧版单模板迁移，再不行用默认 0.5% / 2R / 1R 保本 */
function loadTemplates(): TemplateBundle {
  const saved = readJson<{ activeId?: unknown; list?: unknown }>(TEMPLATES_KEY, {});
  const list = Array.isArray(saved.list) ? saved.list.map((item) => makeTemplate(item)) : [];
  if (list.length > 0) {
    const active =
      typeof saved.activeId === 'string' && list.some((item) => item.id === saved.activeId)
        ? saved.activeId
        : list[0].id;
    return { templates: list, activeTemplateId: active };
  }
  const legacyRaw = window.localStorage.getItem(LEGACY_TEMPLATE_KEY);
  const template = legacyRaw
    ? makeTemplate({
        ...(readJson<Record<string, unknown>>(LEGACY_TEMPLATE_KEY, {}) as TemplateInput),
        id: 'default',
        name: '默认模板',
      })
    : makeTemplate({ id: 'default', name: '默认模板', steps: DEFAULT_STEPS });
  return { templates: [template], activeTemplateId: template.id };
}

function saveTemplates(bundle: TemplateBundle): void {
  writeJson(TEMPLATES_KEY, { activeId: bundle.activeTemplateId, list: bundle.templates });
}

/** 当前下单票使用的模板；列表保证至少一条 */
export function activeTemplate(state: {
  templates: TradeTemplate[];
  activeTemplateId: string;
}): TradeTemplate {
  return (
    state.templates.find((item) => item.id === state.activeTemplateId) ?? state.templates[0]
  );
}

/** 风险设置存 localStorage，刷新后不用重新填 */
function loadRisk(): RiskSettings {
  try {
    const raw = window.localStorage.getItem(RISK_KEY);
    if (!raw) return defaultRisk;
    const parsed = JSON.parse(raw) as Partial<RiskSettings>;
    if (
      (parsed.mode === 'amount' || parsed.mode === 'percent') &&
      typeof parsed.value === 'number' &&
      Number.isFinite(parsed.value)
    ) {
      return { mode: parsed.mode, value: parsed.value, auto: parsed.auto !== false };
    }
  } catch {
    /* 读不到就用默认值 */
  }
  return defaultRisk;
}

const LAYOUT_KEY = 'mytrade.layout';
const LAYOUT_SYNC_KEY = 'mytrade.layoutSync';
const THEME_KEY = 'mytrade.theme';
const ACCENT_KEY = 'mytrade.accent';
const RES_KEY = 'mytrade.resolution';
const PREFS_KEY = 'mytrade.alertPrefs';
const WATCH_KEY = 'mytrade.watchlist';
const TAG_KEY = 'mytrade.orderTag';

/** 读 localStorage 里的 JSON，坏数据或读不到就用默认值 */
function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 隐私模式等写不进去就算了 */
  }
}

function loadLayout(): ChartLayout {
  return normalizeLayoutId(readJson<unknown>(LAYOUT_KEY, '1'));
}

function loadTheme(): Theme {
  const raw = readJson<unknown>(THEME_KEY, 'light');
  return raw === 'dark' || raw === 'white' ? raw : 'light';
}

const defaultLayoutSync: ChartSync = {
  symbol: false,
  interval: false,
  crosshair: true,
  time: false,
  dateRange: false,
};

function loadLayoutSync(): ChartSync {
  const raw = readJson<Partial<ChartSync>>(LAYOUT_SYNC_KEY, {});
  const flag = (key: keyof ChartSync) =>
    typeof raw[key] === 'boolean' ? (raw[key] as boolean) : defaultLayoutSync[key];
  return {
    symbol: flag('symbol'),
    interval: flag('interval'),
    crosshair: flag('crosshair'),
    time: flag('time'),
    dateRange: flag('dateRange'),
  };
}

function loadResolution(): string {
  const raw = readJson<unknown>(RES_KEY, '5');
  return typeof raw === 'string' && raw ? raw : '5';
}

interface AlertPrefs {
  sound: boolean;
  desktop: boolean;
}

function loadPrefs(): AlertPrefs {
  const raw = readJson<Partial<AlertPrefs>>(PREFS_KEY, {});
  return { sound: raw.sound !== false, desktop: raw.desktop === true };
}

function loadWatchlist(): string[] {
  const raw = readJson<string[]>(WATCH_KEY, []);
  return Array.isArray(raw) ? raw.filter((item) => typeof item === 'string') : [];
}

function loadTag(): string {
  const raw = window.localStorage.getItem(TAG_KEY);
  return typeof raw === 'string' ? raw : '';
}

let toastSeq = 0;

export const useApp = create<AppStore>((set, get) => ({
  page: routeFromHash(),
  conn: 'closed',
  health: null,
  latency: null,
  symbols: [],
  symbol: '',
  resolution: loadResolution(),
  quote: null,
  account: null,
  positions: [],
  orders: [],
  draft: emptyDraft,
  preview: null,
  risk: loadRisk(),
  riskStatus: null,
  alerts: [],
  alertsOpen: false,
  ...loadTemplates(),
  templateArmed: false,
  settingsSection: 'appearance',
  layout: loadLayout(),
  layoutSync: loadLayoutSync(),
  theme: loadTheme(),
  accentColor: normalizeHex(readJson<unknown>(ACCENT_KEY, DEFAULT_ACCENT)) ?? DEFAULT_ACCENT,
  alertSound: loadPrefs().sound,
  alertDesktop: loadPrefs().desktop,
  crosshairPrice: null,
  watchlist: loadWatchlist(),
  watchRows: [],
  orderTag: loadTag(),
  sidebarTab: 'positions',
  toast: null,

  setPage: (page) => {
    const hash = `#/${page}`;
    if (window.location.hash !== hash) window.location.hash = hash;
    set({ page });
  },
  setConn: (conn) => set({ conn }),
  setHealth: (health) => set({ health }),
  setLatency: (latency) => set({ latency }),
  setSymbols: (symbols) => set({ symbols }),
  setSymbol: (symbol) =>
    set((state) => ({
      symbol,
      quote: null,
      preview: null,
      draft: state.draft.active
        ? { ...state.draft, active: false, sl: null, tp: null, price: 0 }
        : state.draft,
    })),
  setResolution: (resolution) => {
    writeJson(RES_KEY, resolution);
    set({ resolution });
  },
  setQuote: (quote) => set({ quote }),
  setAccount: (account) => set({ account }),
  setPositions: (positions) => set({ positions }),
  setOrders: (orders) => set({ orders }),

  patchDraft: (patch) => set((state) => ({ draft: { ...state.draft, ...patch } })),
  resetDraft: () => set({ draft: { ...emptyDraft }, preview: null }),
  setPreview: (preview) => set({ preview }),
  patchRisk: (patch) =>
    set((state) => {
      const risk = { ...state.risk, ...patch };
      try {
        window.localStorage.setItem(RISK_KEY, JSON.stringify(risk));
      } catch {
        /* 隐私模式等写不进去就算了 */
      }
      return { risk };
    }),
  setRiskStatus: (riskStatus) => set({ riskStatus }),
  setAlerts: (alerts) => set({ alerts }),
  setAlertsOpen: (alertsOpen) => set({ alertsOpen }),
  setActiveTemplate: (id) =>
    set((state) => {
      if (!state.templates.some((item) => item.id === id)) return {};
      saveTemplates({ templates: state.templates, activeTemplateId: id });
      return { activeTemplateId: id };
    }),
  updateTemplate: (id, patch) =>
    set((state) => {
      const templates = state.templates.map((item) =>
        item.id === id ? makeTemplate({ ...item, ...patch, id: item.id }) : item,
      );
      saveTemplates({ templates, activeTemplateId: state.activeTemplateId });
      return { templates };
    }),
  addTemplate: () =>
    set((state) => {
      const base = activeTemplate(state);
      const copy = makeTemplate({
        ...base,
        id: newTemplateId(),
        name: `${base.name.slice(0, 20)} 副本`,
      });
      const templates = [...state.templates, copy];
      saveTemplates({ templates, activeTemplateId: copy.id });
      return { templates, activeTemplateId: copy.id };
    }),
  deleteTemplate: (id) =>
    set((state) => {
      if (state.templates.length <= 1) return {};
      const templates = state.templates.filter((item) => item.id !== id);
      const activeTemplateId =
        state.activeTemplateId === id ? templates[0].id : state.activeTemplateId;
      saveTemplates({ templates, activeTemplateId });
      return { templates, activeTemplateId };
    }),
  setTemplateArmed: (templateArmed) => set({ templateArmed }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  setLayout: (layout) => {
    const next = normalizeLayoutId(layout);
    writeJson(LAYOUT_KEY, next);
    set({ layout: next });
  },
  setLayoutSync: (patch) =>
    set((state) => {
      const layoutSync = { ...state.layoutSync, ...patch };
      writeJson(LAYOUT_SYNC_KEY, layoutSync);
      return { layoutSync };
    }),
  setTheme: (theme) => {
    writeJson(THEME_KEY, theme);
    set({ theme });
  },
  setAccentColor: (hex) => {
    const accentColor = normalizeHex(hex) ?? DEFAULT_ACCENT;
    writeJson(ACCENT_KEY, accentColor);
    set({ accentColor });
  },
  setAlertPrefs: (patch) =>
    set((state) => {
      const prefs = {
        sound: patch.alertSound ?? state.alertSound,
        desktop: patch.alertDesktop ?? state.alertDesktop,
      };
      writeJson(PREFS_KEY, prefs);
      return { alertSound: prefs.sound, alertDesktop: prefs.desktop };
    }),
  setCrosshairPrice: (crosshairPrice) => set({ crosshairPrice }),
  setWatchlist: (watchlist) => {
    writeJson(WATCH_KEY, watchlist);
    set({ watchlist });
  },
  setWatchRows: (watchRows) => set({ watchRows }),
  setOrderTag: (orderTag) => {
    try {
      window.localStorage.setItem(TAG_KEY, orderTag);
    } catch {
      /* ignore */
    }
    set({ orderTag });
  },
  setSidebarTab: (sidebarTab) => set({ sidebarTab }),

  notify: (kind, text) => {
    const id = ++toastSeq;
    set({ toast: { id, kind, text } });
    window.setTimeout(() => {
      if (get().toast?.id === id) set({ toast: null });
    }, 4500);
  },
  clearToast: () => set({ toast: null }),
  resetForAccountSwitch: () =>
    set({
      account: null,
      positions: [],
      orders: [],
      alerts: [],
      riskStatus: null,
      symbols: [],
      symbol: '',
      quote: null,
      preview: null,
      watchRows: [],
      crosshairPrice: null,
      draft: { ...emptyDraft },
    }),
}));

export const selectSymbolInfo = (state: AppStore): SymbolInfo | undefined =>
  state.symbols.find((item) => item.name === state.symbol);

/**
 * 全局快捷键：图表在 iframe 里也能响应，所以 App 和每个图表 iframe 都绑一次。
 * B / S 只准备市价草稿（仍需确认），Esc 关弹窗/取消划线。
 */
export function handleGlobalShortcut(event: KeyboardEvent): void {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  const state = useApp.getState();

  if (event.key === 'Escape') {
    state.setAlertsOpen(false);
    if (state.draft.active) state.patchDraft({ active: false });
    return;
  }

  let root: Document = document;
  try {
    root = window.top?.document ?? document;
  } catch {
    root = document;
  }
  // 确认窗/弹窗开着、或不在交易台时不要改草稿
  if (root.querySelector('[data-modal], [data-confirm]')) return;
  if (state.page !== 'trade') return;

  const key = event.key.toLowerCase();
  if (key !== 'b' && key !== 's') return;
  if (!state.quote) return;
  const info = state.symbols.find((item) => item.name === state.symbol);
  if (!info) return;
  event.preventDefault();
  const side = key === 'b' ? 'buy' : 'sell';
  const price = side === 'buy' ? state.quote.ask : state.quote.bid;
  state.patchDraft({ side, type: 'market', active: true, price });
  state.notify('info', `${side === 'buy' ? '买入' : '卖出'}市价草稿已就绪，核对后发送`);
}
