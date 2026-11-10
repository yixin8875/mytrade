import { create } from 'zustand';
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
  Toast,
  TradePreview,
  WatchlistRow,
} from '../gateway/types';

export type SidebarTab = 'positions' | 'orders' | 'watchlist';
export type ChartLayout = 'single' | 'quad';
export type Theme = 'dark' | 'light';

interface AppStore {
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
  alertsOpen: boolean;
  journalOpen: boolean;
  executionOpen: boolean;
  auditOpen: boolean;
  settingsOpen: boolean;
  /** 下单模板：0.5% 风险 + 2R 止盈 + 1R 自动保本 */
  templateArmed: boolean;
  layout: ChartLayout;
  /** 深色 / 浅色主题，存 localStorage */
  theme: Theme;
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
  setJournalOpen: (open: boolean) => void;
  setExecutionOpen: (open: boolean) => void;
  setAuditOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setTemplateArmed: (armed: boolean) => void;
  setLayout: (layout: ChartLayout) => void;
  setTheme: (theme: Theme) => void;
  setAlertPrefs: (patch: Partial<Pick<AppStore, 'alertSound' | 'alertDesktop'>>) => void;
  setCrosshairPrice: (price: number | null) => void;
  setWatchlist: (watchlist: string[]) => void;
  setWatchRows: (rows: WatchlistRow[]) => void;
  setOrderTag: (tag: string) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  notify: (kind: Toast['kind'], text: string) => void;
  clearToast: () => void;
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
const THEME_KEY = 'mytrade.theme';
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
  return readJson<ChartLayout>(LAYOUT_KEY, 'single') === 'quad' ? 'quad' : 'single';
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
  journalOpen: false,
  executionOpen: false,
  auditOpen: false,
  settingsOpen: false,
  templateArmed: false,
  layout: loadLayout(),
  theme: readJson<Theme>(THEME_KEY, 'dark') === 'light' ? 'light' : 'dark',
  alertSound: loadPrefs().sound,
  alertDesktop: loadPrefs().desktop,
  crosshairPrice: null,
  watchlist: loadWatchlist(),
  watchRows: [],
  orderTag: loadTag(),
  sidebarTab: 'positions',
  toast: null,

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
  setJournalOpen: (journalOpen) => set({ journalOpen }),
  setExecutionOpen: (executionOpen) => set({ executionOpen }),
  setAuditOpen: (auditOpen) => set({ auditOpen }),
  setSettingsOpen: (settingsOpen) =>
    set({
      settingsOpen,
      ...(settingsOpen
        ? {
            alertsOpen: false,
            journalOpen: false,
            executionOpen: false,
            auditOpen: false,
          }
        : {}),
    }),
  setTemplateArmed: (templateArmed) => set({ templateArmed }),
  setLayout: (layout) => {
    writeJson(LAYOUT_KEY, layout);
    set({ layout });
  },
  setTheme: (theme) => {
    writeJson(THEME_KEY, theme);
    set({ theme });
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
    state.setJournalOpen(false);
    state.setExecutionOpen(false);
    state.setAuditOpen(false);
    if (state.draft.active) state.patchDraft({ active: false });
    return;
  }

  let root: Document = document;
  try {
    root = window.top?.document ?? document;
  } catch {
    root = document;
  }
  // 确认窗/弹窗开着时不要改草稿
  if (root.querySelector('[data-modal], [data-confirm]')) return;

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
