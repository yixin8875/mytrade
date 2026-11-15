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
  /** 账户级门禁覆盖；未出现的字段跟随全局默认 */
  discipline?: Partial<AccountDiscipline>;
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
  /** 开仓纪律门禁：off 关闭 / confirm 二次确认 / block 未完成则拒绝 */
  discipline_mode: DisciplineMode;
  /** 默认清单（playbook id），空串表示未配置 */
  discipline_playbook: string;
  /** 强行跳过清单时是否必须填写理由 */
  discipline_require_reason: boolean;
  /** 已配置的第三方推送通道名（不含密钥） */
  alert_channel_names?: string[];
}

export type DisciplineMode = 'off' | 'confirm' | 'block';

/** 账户级门禁覆盖：只写要覆盖的键，其余跟随全局 */
export interface AccountDiscipline {
  mode: DisciplineMode;
  playbook: string;
  require_reason: boolean;
}
export type DisciplineGateState =
  | 'pending'
  | 'passed'
  | 'overridden'
  | 'blocked'
  | 'skipped';

/** 开仓清单里的一条规则：evaluated=false 表示还没勾选 */
export interface DisciplineRule {
  rule: string;
  followed: boolean | null;
  evaluated: boolean;
}

export interface DisciplineGate {
  clientId: string;
  playbookId: string | null;
  mode: DisciplineMode;
  state: DisciplineGateState;
  reason: string | null;
  positionId: number | null;
  createdAt: number;
  updatedAt: number;
  rules: DisciplineRule[];
  missing: string[];
  violated: string[];
}

/** 复盘抽屉里的「开仓时清单」：rules 是开单时的快照，之后改清单不影响 */
export interface PreTradeGateView {
  clientId: string;
  playbookId: string | null;
  playbookName: string | null;
  mode: DisciplineMode;
  state: DisciplineGateState;
  reason: string | null;
  createdAt: number;
  rules: DisciplineRule[];
  missing: string[];
  violated: string[];
}

/** order.place 里附带的门禁信息；confirmed 只表示接受风险，不表示清单已完成 */
export interface DisciplinePayload {
  clientOrderId: string;
  playbookId?: string;
  confirmed: boolean;
  reason?: string;
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
  /** 启动时的 SQLite 完整性自检结果；ok 为 null 表示还没跑完 */
  database?: {
    ok: boolean | null;
    messages: string[];
    checkedAt: number;
  };
  /** 网关运行观测：队列深度、慢命令、当前正在执行的命令 */
  runtime?: {
    queueDepth: number;
    commands: number;
    lastCommand: { method: string; ms: number; at: number } | null;
    slowestCommandMs: number;
    busy: { method: string | null; seconds: number } | null;
    pendingReconcile: boolean;
    lastIterationMs: number;
  };
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

/** 模板阶段：浮盈到某个 R 时执行一次动作（分批止盈 / 移保本） */
export interface TemplateStep {
  /** 触发倍数：入场到止损的距离记作 1R */
  atR: number;
  /** 平掉当前剩余仓位的百分比（1–99）；null = 本阶段不平仓，只动止损 */
  closePercent: number | null;
  /** 平仓后把止损移到开仓价 */
  moveBreakeven: boolean;
}

/** 一键下单模板：风险占比、最终止盈、分批止盈阶段 */
export interface TradeTemplate {
  id: string;
  name: string;
  /** 单笔风险占余额的百分比 */
  riskPercent: number;
  /** 最终止盈放在入场价外的 R 倍数；0 = 模板不自动设止盈 */
  rewardR: number;
  /** 按 atR 升序执行；空数组 = 成交后不管理 */
  steps: TemplateStep[];
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

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
  /** 可撤销提示：点击后执行，提示随即消失 */
  action?: ToastAction | null;
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
  /** 开仓订单上的止损价，没有就为空 */
  sl: number | null;
  /** 开仓订单上的止盈价，没有就为空 */
  tp: number | null;
  /** 初始风险（账户货币），用于把盈亏折成 R */
  risk: number | null;
  risk_source: string | null;
  /** 同步这笔交易时的服务器时区差（服务器时间 - UTC，秒）；老记录可能为空 */
  server_offset?: number | null;
  /** 复盘标记时间；未复盘为空 */
  reviewed_at?: number | null;
  has_shot: number;
  recorded_at: number;
}

/** 交易日志的统一筛选；列表与统计共用，保证两处行集合一致 */
export interface JournalFilter {
  symbol?: string;
  tag?: string;
  result?: 'win' | 'loss';
  /** 0 = 待复盘，1 = 已复盘 */
  reviewed?: 0 | 1;
}

export interface JournalBreakdown {
  key: string;
  trades: number;
  wins: number;
  pnl: number;
  winRate: number;
  /** 每笔平均盈亏 */
  expectancy?: number;
  /** 按初始风险折算的平均 R；没有带止损的交易时为空 */
  avgR?: number | null;
}

export interface JournalRStats {
  /** 能折算 R 的交易数（下单时带止损） */
  trades: number;
  /** 占区间全部交易的比例 */
  coverage: number | null;
  avgR: number | null;
  totalR: number;
  bestR: number | null;
  worstR: number | null;
  maxDrawdownR: number;
  /** 最高浮盈达到 1R 的交易占比 */
  hit1R: number | null;
  /** 风险来源计数：成交订单止损 / 持仓期记录 / 下单意图 */
  sources?: {
    journal: number;
    order: number;
    position: number;
    intent: number;
  };
}

export interface JournalTemplateStats {
  planned: number;
  reached1R: number;
  breakeven: number;
  held: number;
  breakevenRate: number | null;
  heldRate: number | null;
  avgR: number | null;
}

export interface JournalExecutionSide {
  trades: number;
  avgSlippage: number | null;
  avgSpread: number | null;
}

export interface JournalExecutionCross {
  matched: number;
  wins: JournalExecutionSide;
  losses: JournalExecutionSide;
}

export interface JournalStats {
  days: number;
  summary: {
    trades: number;
    /** 区间内超过 5000 笔时只统计最近 5000 笔 */
    truncated?: boolean;
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
  /** R 口径的汇总与曲线 */
  r: JournalRStats;
  /** 模板分批止盈的执行情况 */
  template: JournalTemplateStats;
  /** 入场执行成本与输赢的交叉 */
  execution: JournalExecutionCross;
  bySymbol: JournalBreakdown[];
  byHour: JournalBreakdown[];
  byTag: JournalBreakdown[];
  byDuration: JournalBreakdown[];
  curve: { t: number; pnl: number; cum: number }[];
  rCurve: { t: number; r: number; cum: number }[];
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

/** 财经日历事件（来自网关缓存的 ForexFactory 周历） */
export interface CalendarEvent {
  id: string;
  title: string;
  country: string;
  impact: 'High' | 'Medium' | 'Low' | 'Holiday' | string;
  forecast: string;
  previous: string;
  /** 源站 ISO 时间（带时区偏移） */
  date: string;
  /** Unix 秒，前端按本地时区显示 */
  ts: number;
}

export interface CalendarWeek {
  events: CalendarEvent[];
  fetchedAt: number;
  stale: boolean;
  error: string | null;
}

export interface ExportResult {
  kind: 'csv' | 'json' | 'jsonl';
  name: string;
  path: string;
  rows: number;
  bytes: number;
}

export interface BackupInfo {
  name: string;
  path: string;
  bytes: number;
  createdAt: number;
  auditDays?: number;
  screenshots?: number;
  /** 自动备份（tally-auto-*），只保留最近 7 份；手动备份永不自动清理 */
  auto?: boolean;
}

export interface DataPaths {
  dir: string;
  exports: string;
  backups: string;
}

// ---------- 复盘：日历 / 笔记 / 策略 ----------

/** 日历里的一天；没有交易的日子也有格子，trades = 0 */
export interface DiaryDay {
  date: string;
  net: number;
  trades: number;
  wins: number;
  losses: number;
  /** 可折算 R 的交易的总 R；没有带止损的交易时为 null */
  r: number | null;
  rTrades: number;
}

export interface DiaryWeek {
  /** 周一到周日；不属于当前月份的格子为 null */
  days: (DiaryDay | null)[];
  /** 整周合计，包含相邻月份的交易日 */
  total: number;
}

export interface DiarySummary {
  net: number;
  trades: number;
  wins: number;
  losses: number;
  r: number | null;
  rTrades: number;
  winRate: number | null;
  expectancy: number | null;
  avgR: number | null;
  totalR: number;
  avgDurationSec: number;
  tradingDays: number;
  winDays: number;
  lossDays: number;
  dayWinRate: number | null;
  bestDay: DiaryDay | null;
  worstDay: DiaryDay | null;
}

export interface DiaryCalendar {
  month: string;
  today: string;
  timezoneOffsetMin: number;
  weeks: DiaryWeek[];
  summary: DiarySummary;
}

export interface DayNote {
  day: string;
  note: string;
  mood: number | null;
  tags: string[];
  replaySessionId: string | null;
  created_at?: number;
  updated_at?: number | null;
}

export interface NoteTemplate {
  id: number;
  name: string;
  body: string;
}

export interface Playbook {
  id: string;
  login: number;
  name: string;
  description: string;
  rules: string[];
  archived_at: number | null;
  created_at: number;
  updated_at: number;
  /** strategy.list 附带；其他接口可能没有 */
  tradeCount?: number;
}

export interface RuleCheck {
  rule: string;
  /** true = 遵守，false = 违反，null = 还没评估 */
  followed: boolean | null;
}

/** 一笔交易在复盘层的标注；没复盘过的交易为 null */
export interface TradeAnnotation {
  playbookId: string | null;
  playbookName: string | null;
  rating: number | null;
  mistakes: string[];
  note: string;
  reviewedAt: number | null;
  rules: RuleCheck[];
  followed: number;
  broken: number;
}

export interface DiaryRecord extends JournalRecord {
  r: number | null;
  annotation: TradeAnnotation | null;
}

export interface DiaryDayDetail {
  date: string;
  summary: DiarySummary;
  records: DiaryRecord[];
  note: DayNote;
  templates: NoteTemplate[];
  playbooks: Playbook[];
  timezoneOffsetMin: number;
}

export interface TradeNoteDetail {
  positionId: number;
  playbookId: string | null;
  playbookName: string | null;
  rating: number | null;
  mistakes: string[];
  note: string;
  reviewedAt: number | null;
  rules: RuleCheck[];
  /** 开仓时的清单快照；门禁关闭或历史交易为 null */
  preTrade: PreTradeGateView | null;
  playbooks: Playbook[];
  trade: {
    positionId: number;
    symbol: string;
    side: Side;
    volume: number;
    openTime: number;
    closeTime: number;
    profit: number;
    r: number | null;
  };
}

/** 遵守度里的一档交易汇总 */
export interface AdherenceBucket {
  net: number;
  trades: number;
  wins: number;
  losses: number;
  r: number | null;
  rTrades: number;
  winRate: number | null;
  expectancy: number | null;
  avgR: number | null;
  totalR: number;
  avgDurationSec: number;
}

export interface RuleStat {
  rule: string;
  evaluated: number;
  rate: number | null;
  followed: AdherenceBucket;
  broken: AdherenceBucket;
}

export interface AdherenceBook {
  id: string;
  name: string;
  description: string;
  rules: string[];
  archivedAt: number | null;
  /** 关联到这本策略的交易数 */
  total: number;
  /** 所有规则都评估完的交易数 */
  evaluated: number;
  possible: number;
  /** 通过的规则勾选 / 已评估的规则勾选 */
  rate: number | null;
  followed: AdherenceBucket;
  broken: AdherenceBucket;
  unassessed: number;
  ruleStats: RuleStat[];
  /** 开仓前门禁的完成情况（P1） */
  preTrade?: AdherencePreTrade;
}

/** 开仓前清单：跳过（无规则）与未完成（取消）不计入完成率分母 */
export interface AdherencePreTrade {
  total: number;
  passed: number;
  overridden: number;
  skipped: number;
  pending: number;
  /** passed / (passed + overridden) */
  completionRate: number | null;
  /** overridden / (passed + overridden) */
  overrideRate: number | null;
}

export interface AdherenceResult {
  days: number;
  timezoneOffsetMin: number;
  books: AdherenceBook[];
}

export interface ReviewSettings {
  timezoneOffsetMin: number;
  localOffsetMin: number;
}

// ---------- 例行清单（P1） ----------

export type RoutinePhase = 'pre' | 'during' | 'post';

export interface Routine {
  id: number;
  title: string;
  phase: RoutinePhase;
  /** 1 = 周一 … 7 = 周日 */
  weekdays: number[];
  sort: number;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RoutineItem extends Routine {
  due: boolean;
  done: boolean;
}

export interface RoutineDay {
  date: string;
  today: string;
  weekday: number;
  /** 只有今天和最近 7 天能补勾，更早的日期只读 */
  editable: boolean;
  items: RoutineItem[];
  phases: Record<RoutinePhase, RoutineItem[]>;
  summary: {
    total: number;
    done: number;
    rate: number | null;
  };
}

export interface RoutineHeatCell {
  date: string;
  weekday: number;
  due: number;
  done: number;
  rate: number | null;
  future: boolean;
}

export interface RoutineHeatmap {
  start: string;
  end: string;
  today: string;
  weeks: number;
  cells: RoutineHeatCell[];
  summary: {
    rate: number | null;
    done: number;
    due: number;
    streak: number;
  };
}

// ---------- 错过机会（P1） ----------

export type MissedStatus =
  | 'tp'
  | 'sl'
  | 'timeout'
  | 'open'
  | 'no_entry'
  | 'no_data'
  | 'invalid';

export interface MissedSim {
  status: MissedStatus;
  note?: string;
  entryAt?: number;
  entryPrice?: number;
  exitAt?: number;
  exitPrice?: number;
  r?: number | null;
  mfeR?: number | null;
  maeR?: number | null;
  barsHeld?: number;
  bars?: number;
  windowEnd?: number;
  complete?: boolean;
  lastPrice?: number;
}

export interface MissedTrade {
  id: number;
  symbol: string;
  side: Side;
  observedAt: number;
  entryPrice: number | null;
  sl: number | null;
  tp: number | null;
  playbookId: string | null;
  note: string;
  sim: MissedSim | null;
  createdAt: number;
  updatedAt: number;
}

export interface MissedList {
  missed: MissedTrade[];
  summary: {
    total: number;
    simulated: number;
    hits: number;
    stops: number;
    totalR: number | null;
  };
}

// ---------- 绩效趋势与散点（P1） ----------

export interface TrendTrade {
  positionId: number;
  symbol: string;
  side: Side;
  volume: number;
  openTime: number;
  closeTime: number;
  profit: number;
  r: number | null;
  risk: number | null;
  durationSec: number | null;
  mfe: number | null;
  mae: number | null;
  tag: string | null;
  /** YYYY-MM-DD（复盘时区） */
  day: string;
}

export interface TrendSeries {
  days: number;
  start: string;
  end: string;
  timezoneOffsetMin: number;
  trades: TrendTrade[];
}

// ---------- 过程评分（P2） ----------

export interface ScoreComponent {
  key: string;
  label: string;
  weight: number;
  unit: string;
  /** 公式说明，和 settings/文档里的版本一致 */
  rule: string;
  value: number | null;
  score: number | null;
  included: boolean;
  reason: string | null;
}

export interface ProcessScore {
  version: number;
  score: number | null;
  sample: { trades: number; rTrades: number; days: number };
  windowStart: string;
  windowEnd: string;
  components: ScoreComponent[];
  note: string | null;
}

// ---------- AI 复盘（自带 Key，默认关闭） ----------

export type AiKind = 'day' | 'week';

export interface AiProvider {
  id: string;
  label: string;
  defaultModel: string;
}

export interface AiStatus {
  version: number;
  enabled: boolean;
  hasKey: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  providers: AiProvider[];
  notice: string;
}

/** 「将发送哪些字段」里的一行说明 */
export interface AiPayloadField {
  key: string;
  label: string;
  text: string;
}

export interface AiPayloadPreview {
  kind: AiKind;
  date: string;
  fields: AiPayloadField[];
  payload: Record<string, unknown>;
  bytes: number;
}

export interface AiReviewResult {
  kind: AiKind;
  date: string;
  provider: string;
  model: string;
  text: string;
  generatedAt: number;
  cached: boolean;
  fields: AiPayloadField[];
}
