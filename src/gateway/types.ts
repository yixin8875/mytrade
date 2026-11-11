export type ConnState = 'connecting' | 'open' | 'closed';
export type Side = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop';
export type TradeMode = 'readonly' | 'demo' | 'live';

export interface SymbolInfo {
  name: string;
  description: string;
  digits: number;
  point: number;
  tickSize: number;
  tickValue: number;
  contractSize: number;
  minVolume: number;
  maxVolume: number;
  volumeStep: number;
  stopsLevelPoints: number;
  freezeLevelPoints: number;
  spreadPoints: number;
  tradeMode: number;
  fillingMode: number;
  visible: boolean;
  currency: string;
  marginMode: 'hedging' | 'netting';
}

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  time: number;
  timeMs: number;
  /** 券商服务器时间与 UTC 的差（秒） */
  serverOffset?: number;
}

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** 网关配置文件里配置的一个 MT5 终端账户 */
export interface AccountOption {
  id: string;
  label: string;
  login: number;
  server: string;
  terminalPath?: string;
  active: boolean;
  connected: boolean;
  /** 本机已用 Windows DPAPI 保存密码，可在启动/切换时自动登录 */
  hasPassword?: boolean;
  /** 是否来自 config.json 的 accounts；false 表示单终端回退账户 */
  configured?: boolean;
  /** 账户级风控覆盖；未出现的字段跟随全局默认 */
  risk?: Partial<RiskLimits>;
}

export interface Account {
  login: number;
  server: string;
  company: string;
  name: string;
  currency: string;
  leverage: number;
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  marginLevel: number | null;
  /** 追缴保证金比例（%），强平价估算用 */
  marginSoCall?: number;
  /** 强平比例（%），强平价估算用 */
  marginSoSo?: number;
  marginMode: 'hedging' | 'netting';
  tradeAllowed: boolean;
  accountType: 'demo' | 'contest' | 'real' | 'unknown';
}

/** 移动止损计划（网关每 0.4 秒执行一次） */
export interface TrailingPlan {
  distancePoints: number;
  stepPoints: number;
  activatedAt: number;
}

export interface Position {
  ticket: number;
  identifier: number;
  symbol: string;
  side: Side;
  volume: number;
  openPrice: number;
  sl: number | null;
  tp: number | null;
  profit: number;
  /** 打到止损时的盈亏（账户货币，负数） */
  slProfit?: number | null;
  /** 打到止盈时的盈亏（账户货币，正数） */
  tpProfit?: number | null;
  swap: number;
  commission: number;
  magic: number;
  comment: string;
  openTime: number;
  /** 当前仓位被强平的估算价（只有杠杆/仓位足够大时才给得出） */
  stopOutPrice?: number | null;
  /** 已启用的移动止损计划 */
  trailing?: TrailingPlan | null;
}

export interface Order {
  ticket: number;
  symbol: string;
  type: OrderType;
  side: Side;
  volume: number;
  initialVolume: number;
  filledVolume: number;
  price: number;
  sl: number | null;
  tp: number | null;
  state: string;
  comment: string;
  magic: number;
  createdAt: number;
  expiration: number | null;
}

/** 可按账户覆盖的风控字段；账户覆盖会盖在全局默认之上 */
export interface RiskLimits {
  max_lot: number;
  max_risk_pct: number;
  max_spread_points: number;
  max_positions: number;
  /** 当日亏损（已实现 + 浮动）上限，占起始余额的百分比；0 = 不限制 */
  daily_loss_pct: number;
  /** 当日最多开仓次数；0 = 不限制 */
  max_trades_per_day: number;
  /** 连续亏损达到该次数后进入冷却；0 = 不启用 */
  max_consecutive_losses: number;
  cooldown_minutes: number;
}

export interface GatewayConfig extends RiskLimits {
  trade_mode: TradeMode;
  allow_live: boolean;
  deviation_points: number;
  trailing_step_points: number;
  magic: number;
  /** 已配置的第三方推送通道名（不含密钥） */
  alert_channel_names?: string[];
}

/** 当日风控状态（网关按服务器时间计算） */
export interface RiskStatus {
  dayStartBalance: number;
  dayPnl: number;
  dailyLoss: number;
  dailyLossLimit: number;
  /** 今日还能亏多少 */
  remaining: number;
  tradesToday: number;
  maxTrades: number;
  consecutiveLosses: number;
  maxConsecutiveLosses: number;
  cooldownUntil: number;
  cooldownRemainingSec: number;
  halted: boolean;
  haltReason: string;
  canTrade: boolean;
  blockReason: string;
}

export interface BreakevenResult {
  ticket: number;
  sl: number;
  changed: boolean;
  retcode: number;
  comment: string;
}

export interface GatewayTerminal {
  company: string;
  name: string;
  build: number;
  path: string;
  connected: boolean;
  tradeAllowed: boolean;
  dllsAllowed: boolean;
}

export interface GatewayHealth {
  connected: boolean;
  terminal: GatewayTerminal | null;
  account: Account | null;
  /** 配置里的多账户列表 */
  accounts?: AccountOption[];
  activeAccountId?: string;
  /** 当前账户真正生效的风控（全局默认 + 账户覆盖） */
  limits?: RiskLimits;
  /** 当前账户自己保存的覆盖项 */
  accountRisk?: Partial<RiskLimits>;
  tradeMode: TradeMode;
  config: GatewayConfig;
  /** 最近一次算出的当日风控状态 */
  risk?: RiskStatus | null;
  lastError: { code: number | string; message: string } | null;
  serverTime: number;
  /** 券商服务器时间与 UTC 的差（秒），用于图表时区 */
  serverOffset: number;
  version: string;
}

/** account.switch 的返回值 */
export interface SwitchAccountResult {
  activeId: string;
  account: Account | null;
  accounts: AccountOption[];
  health: GatewayHealth;
}

/** accounts.create / accounts.update / accounts.delete 的返回值 */
export interface AccountMutationResult {
  activeId: string;
  accounts: AccountOption[];
  health: GatewayHealth;
}

export interface TradePreview {
  symbol: string;
  side: Side;
  type: OrderType;
  volume: number;
  price: number;
  sl: number | null;
  tp: number | null;
  margin: number;
  freeMargin: number;
  riskAmount: number | null;
  rewardAmount: number | null;
  riskPct: number | null;
  rr: number | null;
  spreadPoints: number;
  stopsLevelPoints: number;
  digits: number;
  warnings: string[];
}

export interface DraftOrder {
  active: boolean;
  side: Side;
  type: OrderType;
  price: number;
  sl: number | null;
  tp: number | null;
  volume: number;
}

/** 按风险算手数的设置 */
export interface RiskSettings {
  /** amount = 固定亏损金额，percent = 余额百分比 */
  mode: 'amount' | 'percent';
  value: number;
  /** 打开后，拖动止损会自动重算手数 */
  auto: boolean;
}

export interface TradeSizing {
  symbol: string;
  side: Side;
  type: OrderType;
  price: number;
  sl: number | null;
  tp: number | null;
  digits: number;
  step: number;
  volume: number;
  targetRisk: number;
  riskPerLot: number;
  riskAmount: number | null;
  rewardAmount: number | null;
  riskPct: number | null;
  rr: number | null;
  balance: number;
  equity: number;
  capped: string[];
  warnings: string[];
}

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
}

export interface JournalRecord {
  /** 该交易所属的 MT5 账户号 */
  login: number;
  position_id: number;
  symbol: string;
  side: Side;
  volume: number;
  entry_price: number;
  exit_price: number;
  profit: number;
  swap: number;
  commission: number;
  open_time: number;
  close_time: number;
  duration_sec: number;
  /** 持仓期间最大浮盈（账户货币） */
  mfe: number | null;
  /** 持仓期间最大浮亏（账户货币） */
  mae: number | null;
  tag: string | null;
  closed_by: 'sl' | 'tp' | 'stop_out' | 'manual' | string | null;
  has_shot: number;
  recorded_at: number;
}

export interface JournalBreakdown {
  key: string;
  trades: number;
  wins: number;
  pnl: number;
  winRate: number;
}

export interface JournalStats {
  days: number;
  summary: {
    trades: number;
    wins: number;
    losses: number;
    winRate: number | null;
    netPnl: number;
    grossProfit: number;
    grossLoss: number;
    profitFactor: number | null;
    expectancy: number | null;
    avgWin: number | null;
    avgLoss: number | null;
    avgDurationSec: number;
    maxDrawdown: number;
    bestTrade: number | null;
    worstTrade: number | null;
  };
  bySymbol: JournalBreakdown[];
  byHour: JournalBreakdown[];
  byTag: JournalBreakdown[];
  curve: { t: number; pnl: number; cum: number }[];
}

export interface PriceAlert {
  id: number;
  login?: number;
  symbol: string;
  kind: 'above' | 'below';
  price: number;
  note: string | null;
  enabled: number;
  repeat: number;
  cooldown_sec: number;
  created_at: number;
  triggered_at: number | null;
  trigger_count: number;
}

export interface AlertEvent {
  id: number;
  symbol: string;
  kind: 'above' | 'below';
  price: number;
  note: string;
  marketPrice: number | null;
  at: number;
  test?: boolean;
}

export interface WatchlistRow {
  symbol: string;
  description: string;
  digits: number;
  point: number;
  bid: number;
  ask: number;
  spreadPoints: number;
  changePct: number | null;
  hasPosition: boolean;
}

export interface TradeEvent {
  clientOrderId: string;
  retcode: number;
  order: number;
  deal: number;
  volume: number;
  price: number;
  comment: string;
  state: string;
  symbol: string;
  side: Side;
}

export interface ExecutionRow {
  id: number;
  login?: number;
  client_id: string;
  ticket: number | null;
  symbol: string;
  side: Side;
  type: OrderType;
  volume: number;
  requested_price: number | null;
  fill_price: number | null;
  spread_points: number | null;
  slippage_points: number | null;
  latency_ms: number | null;
  retcode: number;
  state: 'filled' | 'accepted' | 'working' | 'rejected' | 'unknown';
  reason: string | null;
  created_at: number;
}

export interface ExecutionSymbolStats {
  key: string;
  count: number;
  filled: number;
  rejected: number;
  avgSpread: number | null;
  avgSlippage: number | null;
  avgLatency: number | null;
}

export interface ExecutionStats {
  days: number;
  summary: {
    total: number;
    filled: number;
    rejected: number;
    unknown: number;
    avgSpread: number | null;
    avgSlippage: number | null;
    slipPositivePct: number | null;
    maxSlippage: number | null;
    avgLatency: number | null;
    p50Latency: number | null;
    p90Latency: number | null;
    maxLatency: number | null;
  };
  bySymbol: ExecutionSymbolStats[];
  byHour: { key: string; count: number; rejected: number }[];
  rejectReasons: { key: string; count: number }[];
  rows: ExecutionRow[];
}

export interface AuditRecord {
  ts: string;
  kind: string;
  payload: unknown;
}

export interface AutoBreakevenEvent {
  ticket: number;
  sl: number;
  symbol: string;
}
