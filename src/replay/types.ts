import type { Bar, OrderType, Side, SymbolInfo, TemplateStep } from '../gateway/types';

/** 复盘页自己的数据类型；不引用任何实盘订单/持仓类型，避免误用。 */
export type ReplayStatus =
  | 'preparing'
  | 'ready'
  | 'running'
  | 'paused'
  | 'finished'
  | 'archived'
  | 'error';

export type ReplayDataSource = 'gateway' | 'demo';

export interface ReplaySettings {
  /** 初始资金 */
  initialBalance: number;
  currency: string;
  leverage: number;
  /** 会话内固定点差（按品种 point 计） */
  spreadPoints: number;
  /** 每手单边佣金 */
  commissionPerLot: number;
  /** 默认显示周期，如 15 */
  timeframe: string;
  /** 单笔风险占净值的百分比 */
  riskPercent: number;
}

export interface ReplayOrder {
  id: string;
  side: Side;
  type: OrderType;
  volume: number;
  /** 限价/停损委托价；市价单为 0 */
  price: number;
  sl: number | null;
  tp: number | null;
  tag: string;
  createdAt: number;
  /** 只在下一根 M1 开盘成交（市价单） */
  atNextOpen: boolean;
  /** 下单时启用的模板阶段；成交后由引擎在到达 R 时执行 */
  steps?: TemplateStep[];
  templateName?: string;
}

export interface ReplayPosition {
  id: string;
  side: Side;
  volume: number;
  entry: number;
  sl: number | null;
  tp: number | null;
  openTs: number;
  /** 开仓时这一笔的初始风险（账户货币） */
  initialRisk: number | null;
  /** 开仓时入场到止损的价差；部分平仓后 R 距离不变 */
  initialRiskPrice?: number | null;
  openCommission: number;
  tag: string;
  mfe: number;
  mae: number;
  /** 模板阶段已执行到第几个，避免重复触发 */
  templateStep: number;
  /** 这一笔要执行的模板阶段（下单时快照） */
  steps?: TemplateStep[];
  templateName?: string;
}

export interface ReplayTrade {
  id: string;
  side: Side;
  volume: number;
  entry: number;
  exit: number;
  openTs: number;
  closeTs: number;
  /** 扣掉开平佣金后的净盈亏 */
  profit: number;
  commission: number;
  r: number | null;
  tag: string;
  closedBy: 'manual' | 'sl' | 'tp' | 'finish' | 'stop_out' | 'template';
  mfe: number;
  mae: number;
}

export interface ReplayNote {
  id: string;
  time: number;
  text: string;
  tag: string;
}

export interface EquityPoint {
  t: number;
  v: number;
  peak: number;
}

export interface ReplaySession {
  id: string;
  name: string;
  symbol: string;
  /** 创建时的品种规格快照；回放不依赖当前 MT5 账户 */
  symbolInfo: SymbolInfo;
  /** 会话区间的第一根与最后一根 M1（服务器时间，秒） */
  startTs: number;
  endTs: number;
  /** 为了指标预热而额外载入的起点 */
  fetchStartTs: number;
  settings: ReplaySettings;
  status: ReplayStatus;
  dataSource: ReplayDataSource;
  createdAt: number;
  updatedAt: number;

  /** 已处理到的位置（bars 数组下标，表示已处理 bars[0..cursorIndex-1]） */
  startIndex: number;
  cursorIndex: number;
  /** 会话区间的 M1 根数（不含预热） */
  totalBars: number;
  /** 游标处最后一根已回放 M1 的时间（epoch 秒）；刷新后列表也能显示真实行情时间 */
  cursorTs?: number;

  balance: number;
  equity: number;
  peakEquity: number;
  maxDrawdownPct: number;
  equityCurve: EquityPoint[];

  orders: ReplayOrder[];
  positions: ReplayPosition[];
  trades: ReplayTrade[];
  notes: ReplayNote[];

  error?: string;
  finishedAt?: number;
}

export interface ReplayStats {
  /** 已平仓净盈亏 */
  netPnl: number;
  /** 含浮盈的净值变化 */
  equityPnl: number;
  returnPct: number;
  maxDrawdownPct: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  profitFactor: number | null;
  avgR: number | null;
  totalR: number;
  grossProfit: number;
  grossLoss: number;
  expectancy: number | null;
  byTag: { tag: string; trades: number; totalR: number; pnl: number }[];
  rBins: { label: string; count: number; negative: boolean }[];
}

export interface ReplayBar extends Bar {
  /** 便于聚合时判断是否来自会话区间 */
  session?: boolean;
}
