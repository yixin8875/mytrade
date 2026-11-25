import { create } from 'zustand';
import { normalizeLayoutId } from '../chart/layouts';
import { DEFAULT_ACCENT, normalizeHex } from '../lib/accent';
import { fallbackQuickPrice, type ChartQuickAction } from '../lib/chartQuickActions';
import { roundToTick } from '../lib/orderPrice';
import { classifyPending } from '../lib/pendingOrder';
import { DEFAULT_TEMPLATE, normalizeTemplateSteps, templateRisk } from '../lib/template';
import type {
  Account,
  ConnState,
  DraftOrder,
  GatewayHealth,
  JournalFilter,
  Order,
  Position,
  PriceAlert,
  Quote,
  RiskSettings,
  RiskStatus,
  SymbolInfo,
  Toast,
  ToastAction,
  TradePreview,
  TradeTemplate,
  WatchlistRow,
} from '../gateway/types';

/** 底部订单托盘页签：持仓 / 挂单 / 成交 / 已平仓 */
export type DockTab = 'positions' | 'orders' | 'deals' | 'closed';
/** 下单模式：常规确认 / 风险计算表格 */
export type OrderEntryMode = 'regular' | 'risk';
/** 布局预设 id，见 chart/layouts.ts */
export type ChartLayout = string;

/** 多图布局里要同步到所有图表的内容 */
export interface ChartSync {
  symbol: boolean;
  interval: boolean;
  crosshair: boolean;
  /** 可视时间区间（滚动/缩放/日期范围选择） */
  time: boolean;
}

/** 浅色 = 冷灰仪器台，白色 = 纯白底材，深色 = 墨色阶梯 */
export type Theme = 'light' | 'white' | 'dark';

/** 图表快捷操作写入的告警预填；AlertsPanel 应用后清空 */
export interface AlertPrefill {
  symbol: string;
  price: number;
  kind: 'above' | 'below';
  /** 每次请求递增，面板据此判断是否需要重新套用 */
  nonce: number;
}

export const THEMES: Theme[] = ['light', 'white', 'dark'];

/** 控制台页面：概览 / 交易台 / 复盘 / 记录 / 分析 / 纪律 / 设置 */
export type Page =
  | 'overview'
  | 'trade'
  | 'replay'
  | 'records'
  | 'insights'
  | 'discipline'
  | 'score'
  | 'audit'
  | 'settings'
  // 合并前的旧页面：只作为兼容入口，setPage 会映射到容器页 + 页签
  | 'journal'
  | 'diary'
  | 'strategy'
  | 'routines'
  | 'missed'
  | 'trends'
  | 'analysis'
  | 'reports'
  | 'executions';

export const PAGES: Page[] = [
  'overview',
  'trade',
  'replay',
  'records',
  'insights',
  'discipline',
  'score',
  'audit',
  'settings',
];

export type RecordsTab = 'list' | 'calendar';
export type InsightsTab = 'reports' | 'review';
export type DisciplineTab = 'strategy' | 'routines' | 'missed';

interface LegacyRoute {
  page: Page;
  recordsTab?: RecordsTab;
  insightsTab?: InsightsTab;
  disciplineTab?: DisciplineTab;
}

/** 旧深链 → 容器页页签；书签和命令面板的旧入口都走这里 */
export const LEGACY_PAGES: Record<string, LegacyRoute> = {
  journal: { page: 'records', recordsTab: 'list' },
  diary: { page: 'records', recordsTab: 'calendar' },
  reports: { page: 'insights', insightsTab: 'reports' },
  executions: { page: 'insights', insightsTab: 'reports' },
  trends: { page: 'insights', insightsTab: 'review' },
  analysis: { page: 'insights', insightsTab: 'review' },
  strategy: { page: 'discipline', disciplineTab: 'strategy' },
  routines: { page: 'discipline', disciplineTab: 'routines' },
  missed: { page: 'discipline', disciplineTab: 'missed' },
};

/** 设置页左侧分区，和 SettingsPanel 的 NAV 一一对应 */
export type SettingsSection =
  | 'appearance'
  | 'chart'
  | 'pine'
  | 'template'
  | 'risk'
  | 'discipline'
  | 'accounts'
  | 'alerts'
  | 'data'
  | 'diagnostics'
  | 'ai'
  | 'updates'
  | 'about';

/** 用 hash 记住当前页，刷新或从图表 iframe 回来都不会丢 */
export function routeFromHash(): Page {
  const raw = window.location.hash.replace(/^#\/?/, '');
  // 复盘页用 #/replay/<id> 保存当前会话，取第一段判断页面
  const head = raw.split('/')[0];
  const legacy = LEGACY_PAGES[head];
  if (legacy) return legacy.page;
  return (PAGES as string[]).includes(head) ? (head as Page) : 'overview';
}

/** 从旧深链推导容器页签；新 hash 没有页签信息时用默认值 */
function initialTabs(): {
  recordsTab: RecordsTab;
  insightsTab: InsightsTab;
  disciplineTab: DisciplineTab;
} {
  const head = window.location.hash.replace(/^#\/?/, '').split('/')[0];
  const legacy = LEGACY_PAGES[head];
  return {
    recordsTab: legacy?.recordsTab ?? 'list',
    insightsTab: legacy?.insightsTab ?? 'reports',
    disciplineTab: legacy?.disciplineTab ?? 'strategy',
  };
}

/**
 * 浏览器前进/后退或手改 hash 时同步页面与页签。
 * 书签里的旧深链（#/diary、#/trends、#/missed…）不光要落到容器页，
 * 还要选中对应页签，和首次加载时的 initialTabs() 表现一致。
 */
export function syncPageFromHash(): void {
  const head = window.location.hash.replace(/^#\/?/, '').split('/')[0];
  const legacy = LEGACY_PAGES[head];
  if (legacy) {
    useApp.setState({
      ...(legacy.recordsTab ? { recordsTab: legacy.recordsTab } : {}),
      ...(legacy.insightsTab ? { insightsTab: legacy.insightsTab } : {}),
      ...(legacy.disciplineTab ? { disciplineTab: legacy.disciplineTab } : {}),
    });
  }
  useApp.getState().setPage(routeFromHash());
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
  /** 告警面板锚在图表顶栏铃铛下方的页面坐标；null 时用默认位置 */
  alertsAnchor: { left: number; top: number; width: number } | null;
  /** 交易台右侧的财经日历面板是否展开 */
  calendarOpen: boolean;
  /** 是否在图表上标注财经事件（存 localStorage） */
  calendarOverlay: boolean;
  /** Ctrl+K 命令面板 */
  paletteOpen: boolean;
  /** 全部下单模板（风险 %、止盈 R、分批止盈阶段），存 localStorage */
  templates: TradeTemplate[];
  /** 下单票当前使用的模板 id */
  activeTemplateId: string;
  /** 下单模板当前是否已启用（本轮草稿） */
  templateArmed: boolean;
  /** 设置页当前分区 */
  settingsSection: SettingsSection;
  /** 记录页页签：日志列表 / 盈亏日历 */
  recordsTab: RecordsTab;
  /** 分析页页签：报表 / 趋势 / 深度 / 执行质量 */
  insightsTab: InsightsTab;
  /** 纪律页页签：策略 / 例行 / 错过 */
  disciplineTab: DisciplineTab;
  /** 打开设置前所在的页面；设置页「返回」回到这里 */
  settingsReturn: Page | null;
  /** 设置页数据导出区间（天，0 = 全部）；命令面板复用同一选择 */
  exportDays: number;
  /** 每次请求「新建策略」递增，策略页看到变化就打开空白表单 */
  strategyNew: number;
  /** 从复盘/回放跳到日志时要直接打开的交易；Journal 消费后清空 */
  journalFocus: number | null;
  /** 从报表/执行质量下钻到日志时带的筛选；Journal 消费后清空 */
  journalFilter: JournalFilter;
  /** 下钻时一并切换区间（天数，0 = 全部）；null 表示不改 */
  journalDays: number | null;
  layout: ChartLayout;
  layoutSync: ChartSync;
  /** 深色 / 浅色主题，存 localStorage */
  theme: Theme;
  /** 保本偏移（点）：补偿手续费/隔夜利息/滑点，存 localStorage */
  breakevenOffset: number;
  /** 隐私模式：除交易台外把金额显示成 ••••，存 localStorage */
  privacy: boolean;
  /** 强调色 #rrggbb，存 localStorage；默认色不写覆盖，交给 CSS 默认值 */
  accentColor: string;
  alertSound: boolean;
  alertDesktop: boolean;
  /** 图表十字线最新价格（用于快速建告警） */
  crosshairPrice: number | null;
  /** 图表快捷操作预填的告警；面板应用后清空 */
  alertPrefill: AlertPrefill | null;
  /** 自选表 */
  watchlist: string[];
  watchRows: WatchlistRow[];
  /** 下单时填的策略标签 */
  orderTag: string;
  /** 交易台顶部的品种标签（最近打开的品种，当前品种在 setSymbol 时自动加入） */
  openSymbols: string[];
  /** 底部订单托盘高度（px）与是否收起 */
  dockHeight: number;
  dockCollapsed: boolean;
  dockTab: DockTab;
  /** 交易台左侧行情列是否展开 */
  watchColumnOpen: boolean;
  /** 左侧图标栏是否钉住（展开成完整导航） */
  railPinned: boolean;
  /** 下单面板模式：常规模式 / 风险计算表格 */
  orderEntryMode: OrderEntryMode;
  /** 下单面板是否展开（收起后留下窄条） */
  ticketOpen: boolean;
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
  setCalendarOpen: (open: boolean) => void;
  setCalendarOverlay: (enabled: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setActiveTemplate: (id: string) => void;
  /** 修改指定模板；id / name 之外走同一套清洗规则 */
  updateTemplate: (id: string, patch: Partial<Omit<TradeTemplate, 'id'>>) => void;
  addTemplate: () => void;
  /** 新建一个空白模板（与「复制当前模板」区分） */
  createTemplate: () => void;
  deleteTemplate: (id: string) => void;
  /** 设定下单默认启用的模板；null = 取消默认 */
  setAutoApply: (id: string | null) => void;
  /** 新开草稿时套用默认模板；已经启用模板时保持当前选择 */
  armDefaultTemplate: () => void;
  setTemplateArmed: (armed: boolean) => void;
  setSettingsSection: (section: SettingsSection) => void;
  setLayout: (layout: ChartLayout) => void;
  setLayoutSync: (patch: Partial<ChartSync>) => void;
  setTheme: (theme: Theme) => void;
  /** 0–500 的整数点；非法值按 0 */
  setBreakevenOffset: (points: number) => void;
  setPrivacy: (privacy: boolean) => void;
  /** 传非法值时回到默认强调色 */
  setAccentColor: (hex: string) => void;
  setAlertPrefs: (patch: Partial<Pick<AppStore, 'alertSound' | 'alertDesktop'>>) => void;
  setCrosshairPrice: (price: number | null) => void;
  setWatchlist: (watchlist: string[]) => void;
  setWatchRows: (rows: WatchlistRow[]) => void;
  setOrderTag: (tag: string) => void;
  /** 打开/关闭顶部品种标签；关掉当前品种时切到相邻标签 */
  toggleOpenSymbol: (symbol: string) => void;
  closeOpenSymbol: (symbol: string) => void;
  /** 120–480px，越界自动夹紧 */
  setDockHeight: (height: number) => void;
  setDockCollapsed: (collapsed: boolean) => void;
  setDockTab: (tab: DockTab) => void;
  setAlertsAnchor: (anchor: { left: number; top: number; width: number } | null) => void;
  setWatchColumnOpen: (open: boolean) => void;
  setRailPinned: (pinned: boolean) => void;
  setOrderEntryMode: (mode: OrderEntryMode) => void;
  setTicketOpen: (open: boolean) => void;
  /** 图表快捷操作（价格轴 + / 右键菜单 / Alt 快捷键）：只预填草稿或告警，不下单 */
  chartQuickAction: (
    action: ChartQuickAction,
    rawPrice: number,
    symbolOverride?: string,
  ) => void;
  clearAlertPrefill: () => void;
  notify: (kind: Toast['kind'], text: string, action?: ToastAction) => void;
  clearToast: () => void;
  /** 跳到设置页并打开指定分区 */
  openSettings: (section: SettingsSection) => void;
  setRecordsTab: (tab: RecordsTab) => void;
  setInsightsTab: (tab: InsightsTab) => void;
  setDisciplineTab: (tab: DisciplineTab) => void;
  setExportDays: (days: number) => void;
  /** 跳到策略手册并直接打开新建表单 */
  openStrategyNew: () => void;
  setJournalFocus: (positionId: number | null) => void;
  setJournalFilter: (filter: JournalFilter) => void;
  setJournalDays: (days: number | null) => void;
  /** 切换 MT5 账户后清空上一个账户的运行时状态 */
  resetForAccountSwitch: () => void;
}

const emptyDraft: DraftOrder = {
  active: false,
  symbol: '',
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
const BREAKEVEN_OFFSET_KEY = 'mytrade.breakevenOffset';

const TEMPLATES_KEY = 'mytrade.templates';
/** 旧版本单个模板的键，启动时迁移成列表里的「默认模板」 */
const LEGACY_TEMPLATE_KEY = 'mytrade.template';

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

/**
 * 把任意来源的模板数据洗干净。
 * 旧版本只有 riskPercent / rewardR / breakevenR 三个字段，这里转成一个
 * 「浮盈 beR 移到保本」的阶段，迁移后行为不变。
 */
function makeTemplate(raw: TemplateInput = {}): TradeTemplate {
  const steps = normalizeTemplateSteps(raw.steps);
  const legacyBreakeven = numIn(raw.breakevenR, 0, 50, 0);
  const hasSteps = Array.isArray(raw.steps);
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newTemplateId(),
    name:
      typeof raw.name === 'string' && raw.name.trim()
        ? raw.name.trim().slice(0, 24)
        : '默认模板',
    riskMode: raw.riskMode === 'amount' ? 'amount' : 'percent',
    riskPercent: numIn(raw.riskPercent, 0.01, 100, 0.5),
    // 固定金额上限放到 1e9，够覆盖大多数账户货币；金额模式之外只是保留值
    riskAmount: numIn(raw.riskAmount, 0.01, 1_000_000_000, 100),
    rewardR: numIn(raw.rewardR, 0, 50, 2),
    steps:
      hasSteps || legacyBreakeven <= 0
        ? steps
        : [{ atR: legacyBreakeven, closePercent: null, moveBreakeven: true }],
    autoApply: raw.autoApply === true,
  };
}

interface TemplateBundle {
  templates: TradeTemplate[];
  activeTemplateId: string;
}

/** 读模板列表；没有就按旧版单模板迁移，再不行用默认 0.5% / 2R / 1R 保本 */
function loadTemplates(): TemplateBundle {
  // 存进去的可能是 "null"（手动改坏、旧版本恢复备份等），这里必须容忍
  const saved = readJson<{ activeId?: unknown; list?: unknown } | null>(TEMPLATES_KEY, null);
  const list = Array.isArray(saved?.list) ? saved.list.map((item) => makeTemplate(item)) : [];
  if (list.length > 0) {
    const active =
      typeof saved?.activeId === 'string' && list.some((item) => item.id === saved.activeId)
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
    : makeTemplate(DEFAULT_TEMPLATE);
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

/** 保本偏移（点）：补偿手续费/隔夜利息/滑点；0 表示只按开仓价保本 */
function loadBreakevenOffset(): number {
  const raw = readJson<unknown>(BREAKEVEN_OFFSET_KEY, 0);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.round(value), 500);
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
const PRIVACY_KEY = 'mytrade.privacy';
const ACCENT_KEY = 'mytrade.accent';
const RES_KEY = 'mytrade.resolution';
const PREFS_KEY = 'mytrade.alertPrefs';
const WATCH_KEY = 'mytrade.watchlist';
const TAG_KEY = 'mytrade.orderTag';
const OPEN_SYMBOLS_KEY = 'mytrade.openSymbols';
const SYMBOL_KEY = 'mytrade.symbol';
const DOCK_HEIGHT_KEY = 'mytrade.dockHeight';
const DOCK_COLLAPSED_KEY = 'mytrade.dockCollapsed';
const DOCK_TAB_KEY = 'mytrade.dockTab';
const WATCH_COLUMN_KEY = 'mytrade.watchColumnOpen';
const RAIL_PINNED_KEY = 'mytrade.railPinned';
const ENTRY_MODE_KEY = 'mytrade.orderEntryMode';

export const DOCK_MIN_HEIGHT = 120;
export const DOCK_MAX_HEIGHT = 480;

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
  const raw = readJson<unknown>(LAYOUT_KEY, '1');
  const next = normalizeLayoutId(raw);
  // 已下线的多图布局迁移后写回，避免每次启动都重新归一化
  if (next !== raw) writeJson(LAYOUT_KEY, next);
  return next;
}

function loadTheme(): Theme {
  const raw = readJson<unknown>(THEME_KEY, 'light');
  return raw === 'dark' || raw === 'white' ? raw : 'light';
}

function loadPrivacy(): boolean {
  return window.localStorage.getItem(PRIVACY_KEY) === '1';
}

const defaultLayoutSync: ChartSync = {
  symbol: false,
  interval: false,
  crosshair: true,
  time: false,
};

function loadLayoutSync(): ChartSync {
  // 旧版本把「时间」和「日期范围」拆成两个开关，实际效果相同；启动时合并
  const raw = readJson<(Partial<ChartSync> & { dateRange?: boolean }) | null>(
    LAYOUT_SYNC_KEY,
    null,
  );
  const flag = (key: keyof ChartSync) =>
    typeof raw?.[key] === 'boolean' ? (raw[key] as boolean) : defaultLayoutSync[key];
  return {
    symbol: flag('symbol'),
    interval: flag('interval'),
    crosshair: flag('crosshair'),
    time: flag('time') || raw?.dateRange === true,
  };
}

function loadResolution(): string {
  const raw = readJson<unknown>(RES_KEY, '5');
  // 早期下拉把 null 写成了字符串 "null"，加载时挡掉，别让图表收到非法周期
  return typeof raw === 'string' && raw && raw !== 'null' ? raw : '5';
}

interface AlertPrefs {
  sound: boolean;
  desktop: boolean;
}

function loadPrefs(): AlertPrefs {
  const raw = readJson<Partial<AlertPrefs> | null>(PREFS_KEY, null);
  return { sound: raw?.sound !== false, desktop: raw?.desktop === true };
}

const CALENDAR_OVERLAY_KEY = 'mytrade.calendarOverlay';

function loadCalendarOverlay(): boolean {
  return window.localStorage.getItem(CALENDAR_OVERLAY_KEY) === '1';
}

function loadWatchlist(): string[] {
  const raw = readJson<string[]>(WATCH_KEY, []);
  return Array.isArray(raw) ? raw.filter((item) => typeof item === 'string') : [];
}

function loadTag(): string {
  const raw = window.localStorage.getItem(TAG_KEY);
  return typeof raw === 'string' ? raw : '';
}

function loadOpenSymbols(): string[] {
  const raw = readJson<unknown>(OPEN_SYMBOLS_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string' && !!item).slice(0, 12);
}

/** 上次选中的品种；启动时优先恢复，避免每次回到市场报价里字母序第一个。 */
function loadSymbol(): string {
  const raw = readJson<unknown>(SYMBOL_KEY, '');
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  // 老版本只记了每格图表的品种：首次升级时以主图为准，避免多出一个默认标签
  const cells = readJson<unknown>('mytrade.cellSymbols', []);
  if (Array.isArray(cells)) {
    const first = cells.find((item): item is string => typeof item === 'string' && !!item.trim());
    if (first) return first.trim();
  }
  return '';
}

function loadDockHeight(): number {
  const raw = Number(readJson<unknown>(DOCK_HEIGHT_KEY, 208));
  if (!Number.isFinite(raw)) return 208;
  return Math.min(Math.max(Math.round(raw), DOCK_MIN_HEIGHT), DOCK_MAX_HEIGHT);
}

function loadDockCollapsed(): boolean {
  return window.localStorage.getItem(DOCK_COLLAPSED_KEY) === '1';
}

function loadDockTab(): DockTab {
  const raw = readJson<unknown>(DOCK_TAB_KEY, 'positions');
  return raw === 'orders' || raw === 'deals' || raw === 'closed' ? raw : 'positions';
}

function loadWatchColumnOpen(): boolean {
  return window.localStorage.getItem(WATCH_COLUMN_KEY) !== '0';
}

function loadRailPinned(): boolean {
  return window.localStorage.getItem(RAIL_PINNED_KEY) === '1';
}

/** 历史版本存过 oneclick，读取时归一到常规模式 */
function loadOrderEntryMode(): OrderEntryMode {
  const raw = readJson<unknown>(ENTRY_MODE_KEY, 'regular');
  return raw === 'risk' ? 'risk' : 'regular';
}

let toastSeq = 0;

export const useApp = create<AppStore>((set, get) => ({
  page: routeFromHash(),
  conn: 'closed',
  health: null,
  latency: null,
  symbols: [],
  symbol: loadSymbol(),
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
  alertsAnchor: null,
  calendarOpen: false,
  calendarOverlay: loadCalendarOverlay(),
  paletteOpen: false,
  ...loadTemplates(),
  templateArmed: false,
  settingsSection: 'appearance',
  ...initialTabs(),
  settingsReturn: null,
  exportDays: 30,
  strategyNew: 0,
  journalFocus: null,
  journalFilter: {},
  journalDays: null,
  layout: loadLayout(),
  layoutSync: loadLayoutSync(),
  theme: loadTheme(),
  breakevenOffset: loadBreakevenOffset(),
  privacy: loadPrivacy(),
  accentColor: normalizeHex(readJson<unknown>(ACCENT_KEY, DEFAULT_ACCENT)) ?? DEFAULT_ACCENT,
  alertSound: loadPrefs().sound,
  alertDesktop: loadPrefs().desktop,
  crosshairPrice: null,
  alertPrefill: null,
  watchlist: loadWatchlist(),
  watchRows: [],
  orderTag: loadTag(),
  openSymbols: loadOpenSymbols(),
  dockHeight: loadDockHeight(),
  dockCollapsed: loadDockCollapsed(),
  dockTab: loadDockTab(),
  watchColumnOpen: loadWatchColumnOpen(),
  railPinned: loadRailPinned(),
  orderEntryMode: loadOrderEntryMode(),
  ticketOpen: true,
  toast: null,

  setPage: (page) => {
    // 旧页面直接映射成容器页 + 页签，书签和旧调用点都不用改
    const legacy = LEGACY_PAGES[page];
    const base: Page = legacy?.page ?? page;
    const hash = `#/${base}`;
    // 复盘内部路由（#/replay/<id>）由复盘页自己维护，这里不要覆盖
    const keepSubRoute = base === 'replay' && /^#\/replay\//.test(window.location.hash);
    if (!keepSubRoute && window.location.hash !== hash) window.location.hash = hash;
    set({
      page: base,
      ...(legacy?.recordsTab ? { recordsTab: legacy.recordsTab } : {}),
      ...(legacy?.insightsTab ? { insightsTab: legacy.insightsTab } : {}),
      ...(legacy?.disciplineTab ? { disciplineTab: legacy.disciplineTab } : {}),
    });
  },
  setRecordsTab: (recordsTab) => set({ recordsTab }),
  setInsightsTab: (insightsTab) => set({ insightsTab }),
  setDisciplineTab: (disciplineTab) => set({ disciplineTab }),
  setConn: (conn) => set({ conn }),
  setHealth: (health) => set({ health }),
  setLatency: (latency) => set({ latency }),
  setSymbols: (symbols) => set({ symbols }),
  setSymbol: (symbol) => {
    const wasArmed = get().templateArmed;
    set((state) => {
      // 第一次进入交易台时顺带打开自选前两个品种，和 Exness 的标签习惯一致
      const base = state.openSymbols.length
        ? state.openSymbols
        : state.watchlist.filter((item) => item !== symbol).slice(0, 2);
      // 选中只改状态，不挪动标签位置；新品种追加到末尾，超出上限时挤掉最早的
      const openSymbols = !symbol
        ? base
        : base.includes(symbol)
          ? base
          : [...base, symbol].slice(-12);
      writeJson(OPEN_SYMBOLS_KEY, openSymbols);
      writeJson(SYMBOL_KEY, symbol);
      return {
        symbol,
        openSymbols,
        quote: null,
        preview: null,
        templateArmed: false,
        draft: state.draft.active
          ? { ...state.draft, active: false, sl: null, tp: null, price: 0 }
          : state.draft,
      };
    });
    if (wasArmed) get().notify('info', '已切换品种，下单模板已解除');
  },
  setResolution: (resolution) => {
    if (!resolution || resolution === 'null') return;
    writeJson(RES_KEY, resolution);
    set({ resolution });
  },
  setQuote: (quote) => set({ quote }),
  setAccount: (account) => set({ account }),
  setPositions: (positions) => set({ positions }),
  setOrders: (orders) => set({ orders }),

  patchDraft: (patch) =>
    set((state) => {
      const draft = { ...state.draft, ...patch };
      // 激活时记住当前品种：多图布局里其他格子不该画出这条草稿
      if (patch.active === true && !patch.symbol) draft.symbol = state.symbol || draft.symbol;
      return { draft };
    }),
  resetDraft: () => set({ draft: { ...emptyDraft }, preview: null, templateArmed: false }),
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
  setAlertsAnchor: (alertsAnchor) => set({ alertsAnchor }),
  setAlertsOpen: (open) => set(open ? { alertsOpen: true, calendarOpen: false } : { alertsOpen: false }),
  setCalendarOpen: (open) =>
    set(open ? { calendarOpen: true, alertsOpen: false } : { calendarOpen: false }),
  setCalendarOverlay: (calendarOverlay) => {
    try {
      window.localStorage.setItem(CALENDAR_OVERLAY_KEY, calendarOverlay ? '1' : '0');
    } catch {
      /* ignore */
    }
    set({ calendarOverlay });
  },
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setActiveTemplate: (id) =>
    set((state) => {
      if (!state.templates.some((item) => item.id === id)) return {};
      saveTemplates({ templates: state.templates, activeTemplateId: id });
      return { activeTemplateId: id };
    }),
  setAutoApply: (id) =>
    set((state) => {
      const templates = state.templates.map((item) =>
        item.autoApply === (item.id === id) ? item : { ...item, autoApply: item.id === id },
      );
      if (templates.every((item, index) => item === state.templates[index])) return {};
      saveTemplates({ templates, activeTemplateId: state.activeTemplateId });
      return { templates };
    }),
  armDefaultTemplate: () => {
    const state = get();
    // 用户已经手动选好模板时不要覆盖
    if (state.templateArmed) return;
    const auto = state.templates.find((item) => item.autoApply);
    if (!auto) return;
    if (state.activeTemplateId !== auto.id) state.setActiveTemplate(auto.id);
    state.patchRisk(templateRisk(auto));
    state.setTemplateArmed(true);
  },
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
        // 默认启用只保留在原模板上，副本不抢默认位
        autoApply: false,
      });
      const templates = [...state.templates, copy];
      saveTemplates({ templates, activeTemplateId: copy.id });
      return { templates, activeTemplateId: copy.id };
    }),
  createTemplate: () =>
    set((state) => {
      const template = makeTemplate({
        ...DEFAULT_TEMPLATE,
        id: newTemplateId(),
        name: `模板 ${state.templates.length + 1}`,
      });
      const templates = [...state.templates, template];
      saveTemplates({ templates, activeTemplateId: template.id });
      return { templates, activeTemplateId: template.id };
    }),
  deleteTemplate: (id) => {
    const state = get();
    if (state.templates.length <= 1) return;
    const templates = state.templates.filter((item) => item.id !== id);
    const activeTemplateId =
      state.activeTemplateId === id ? templates[0].id : state.activeTemplateId;
    saveTemplates({ templates, activeTemplateId });
    // 删掉正在启用的模板时一并解除，避免计划仍按一个已不存在的模板执行
    const disarm = state.templateArmed && id === state.activeTemplateId;
    set({ templates, activeTemplateId, ...(disarm ? { templateArmed: false } : {}) });
    if (disarm) state.notify('info', '当前模板已删除，下单模板已解除');
  },
  setTemplateArmed: (templateArmed) => set({ templateArmed }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  openSettings: (section) => {
    const current = get().page;
    set((state) => ({
      settingsSection: section,
      settingsReturn: current === 'settings' ? state.settingsReturn : current,
    }));
    get().setPage('settings');
  },
  setExportDays: (exportDays) => set({ exportDays }),
  openStrategyNew: () => {
    get().setPage('strategy');
    set((state) => ({ strategyNew: state.strategyNew + 1 }));
  },
  setJournalFocus: (journalFocus) => set({ journalFocus }),
  setJournalFilter: (journalFilter) => set({ journalFilter }),
  setJournalDays: (journalDays) => set({ journalDays }),
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
  setBreakevenOffset: (points) => {
    const breakevenOffset = Number.isFinite(points)
      ? Math.min(Math.max(Math.round(points), 0), 500)
      : 0;
    writeJson(BREAKEVEN_OFFSET_KEY, breakevenOffset);
    set({ breakevenOffset });
  },
  setPrivacy: (privacy) => {
    try {
      window.localStorage.setItem(PRIVACY_KEY, privacy ? '1' : '0');
    } catch {
      /* ignore */
    }
    set({ privacy });
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
  toggleOpenSymbol: (symbol) => {
    const state = get();
    if (state.openSymbols.includes(symbol)) {
      state.closeOpenSymbol(symbol);
      return;
    }
    const openSymbols = [...state.openSymbols, symbol].slice(-12);
    writeJson(OPEN_SYMBOLS_KEY, openSymbols);
    set({ openSymbols });
  },
  closeOpenSymbol: (symbol) => {
    const state = get();
    const index = state.openSymbols.indexOf(symbol);
    if (index < 0) return;
    const openSymbols = state.openSymbols.filter((item) => item !== symbol);
    writeJson(OPEN_SYMBOLS_KEY, openSymbols);
    const fallback = openSymbols[Math.min(index, openSymbols.length - 1)];
    set({ openSymbols });
    if (state.symbol === symbol && fallback) state.setSymbol(fallback);
  },
  setDockHeight: (height) => {
    const dockHeight = Number.isFinite(height)
      ? Math.min(Math.max(Math.round(height), DOCK_MIN_HEIGHT), DOCK_MAX_HEIGHT)
      : 208;
    writeJson(DOCK_HEIGHT_KEY, dockHeight);
    set({ dockHeight, dockCollapsed: false });
  },
  setDockCollapsed: (dockCollapsed) => {
    try {
      window.localStorage.setItem(DOCK_COLLAPSED_KEY, dockCollapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
    set({ dockCollapsed });
  },
  setDockTab: (dockTab) => {
    writeJson(DOCK_TAB_KEY, dockTab);
    set({ dockTab, dockCollapsed: false });
  },
  setWatchColumnOpen: (watchColumnOpen) => {
    try {
      window.localStorage.setItem(WATCH_COLUMN_KEY, watchColumnOpen ? '1' : '0');
    } catch {
      /* ignore */
    }
    set({ watchColumnOpen });
  },
  setRailPinned: (railPinned) => {
    try {
      window.localStorage.setItem(RAIL_PINNED_KEY, railPinned ? '1' : '0');
    } catch {
      /* ignore */
    }
    set({ railPinned });
  },
  setOrderEntryMode: (orderEntryMode) => {
    writeJson(ENTRY_MODE_KEY, orderEntryMode);
    set({ orderEntryMode, ticketOpen: true });
  },
  setTicketOpen: (ticketOpen) => set({ ticketOpen }),

  chartQuickAction: (action, rawPrice, symbolOverride) => {
    const state = get();
    if (state.page !== 'trade') return;
    const symbol = symbolOverride || state.symbol;
    const info = state.symbols.find((item) => item.name === symbol);
    const price = roundToTick(rawPrice, info);
    if (!symbol || !Number.isFinite(price) || !(price > 0)) {
      state.notify('error', '没有取得有效的图表价格');
      return;
    }
    // 交易台下单与告警保存都用全局 symbol，先对齐；同品种不要调用，否则会清掉草稿
    if (symbol !== state.symbol) get().setSymbol(symbol);

    if (action === 'alert') {
      const quote = get().quote;
      const bid = quote && quote.symbol === symbol ? quote.bid : null;
      const kind = bid != null && price < bid ? 'below' : 'above';
      get().setAlertsOpen(true);
      set((s) => ({
        alertPrefill: { symbol, price, kind, nonce: (s.alertPrefill?.nonce ?? 0) + 1 },
      }));
      get().notify('info', `${symbol} 告警价格已填入，确认后添加`);
      return;
    }

    const current = get();
    // setSymbol 会清掉旧品种的报价；只有同一个品种的报价才能用来判断限价/停损
    const currentQuote = current.quote?.symbol === symbol ? current.quote : null;
    const pending = classifyPending({
      side: action,
      price,
      bid: currentQuote?.bid,
      ask: currentQuote?.ask,
      stopsLevelPoints: info?.stopsLevelPoints,
      point: info?.point,
    });
    current.armDefaultTemplate();
    current.patchDraft({
      active: true,
      symbol,
      side: action,
      type: pending.type ?? 'limit',
      price,
      volume: clampVolume(current.draft.volume, info),
    });
    current.setTicketOpen(true);
    current.notify('info', `已预填 ${symbol} ${pending.label}，核对后下单`);
  },
  clearAlertPrefill: () => set({ alertPrefill: null }),


  notify: (kind, text, action) => {
    const id = ++toastSeq;
    set({ toast: { id, kind, text, action: action ?? null } });
    window.setTimeout(
      () => {
        if (get().toast?.id === id) set({ toast: null });
      },
      action ? 6000 : 4500,
    );
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
      alertPrefill: null,
      templateArmed: false,
      draft: { ...emptyDraft },
    }),
}));

export const selectSymbolInfo = (state: AppStore): SymbolInfo | undefined =>
  state.symbols.find((item) => item.name === state.symbol);

/** 手数夹在品种允许范围内；没有手数时用最小手数 */
function clampVolume(volume: number, info?: SymbolInfo): number {
  if (!info) return volume;
  const min = info.minVolume || 0.01;
  const max = info.maxVolume || Number.POSITIVE_INFINITY;
  return Math.max(min, Math.min(max, volume > 0 ? volume : min));
}

/** 确认窗 / 弹窗是否打开（图表在 iframe 里，要查顶层文档） */
function modalOpen(): boolean {
  let root: Document = document;
  try {
    root = window.top?.document ?? document;
  } catch {
    root = document;
  }
  return !!root.querySelector('[data-modal], [data-confirm]');
}

/**
 * 全局快捷键：图表在 iframe 里也能响应，所以 App 和每个图表 iframe 都绑一次。
 * B / S 只准备市价草稿（仍需确认），Esc 关弹窗/取消划线。
 * Alt+A / Alt+Shift+B / Alt+Shift+S 走图表快捷操作，同样只预填。
 */
export function handleGlobalShortcut(event: KeyboardEvent): void {
  // Ctrl/Cmd+K 打开命令面板；输入框里也要能用
  if (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    event.key.toLowerCase() === 'k'
  ) {
    event.preventDefault();
    const state = useApp.getState();
    state.setPaletteOpen(!state.paletteOpen);
    return;
  }
  // 交易台布局：Ctrl/Cmd + \ 收放自选列，Ctrl/Cmd + J 收放底部托盘
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key === '\\') {
    const state = useApp.getState();
    if (state.page === 'trade') {
      event.preventDefault();
      state.setWatchColumnOpen(!state.watchColumnOpen);
    }
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'j') {
    const state = useApp.getState();
    if (state.page === 'trade') {
      event.preventDefault();
      state.setDockCollapsed(!state.dockCollapsed);
    }
    return;
  }
  const target = event.target as HTMLElement | null;
  const typing = !!target?.closest?.('input, textarea, select, [contenteditable="true"]');

  // Alt 组合：图表快捷操作，只预填草稿/告警，仍需在交易台确认
  if (event.altKey && !event.ctrlKey && !event.metaKey) {
    if (typing) return;
    const altState = useApp.getState();
    if (altState.page !== 'trade' || modalOpen()) return;
    const altKey = event.key.toLowerCase();
    const quick: ChartQuickAction | null =
      altKey === 'a' && !event.shiftKey
        ? 'alert'
        : altKey === 'b' && event.shiftKey
          ? 'buy'
          : altKey === 's' && event.shiftKey
            ? 'sell'
            : null;
    if (!quick) return;
    event.preventDefault();
    const price = altState.crosshairPrice ?? fallbackQuickPrice(quick, altState.quote) ?? 0;
    altState.chartQuickAction(quick, price);
    return;
  }

  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (typing) return;
  const state = useApp.getState();

  if (event.key === 'Escape') {
    state.setAlertsOpen(false);
    state.setCalendarOpen(false);
    state.setPaletteOpen(false);
    if (state.draft.active || state.draft.sl || state.draft.tp) state.resetDraft();
    if (state.templateArmed) state.setTemplateArmed(false);
    return;
  }

  // 确认窗/弹窗开着、或不在交易台时不要改草稿
  if (modalOpen()) return;
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
  state.armDefaultTemplate();
  state.notify('info', `${side === 'buy' ? '买入' : '卖出'}市价草稿已就绪，核对后发送`);
}
