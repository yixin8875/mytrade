/** 深度筛选与交叉分析：筛选、分组汇总、二维矩阵，全部在本地按交易序列计算。 */

import type { Side, TrendTrade } from '../gateway/types';
import { isLoss, isWin } from './metrics';

export interface FilterCtx {
  /** MT5 服务器相对 UTC 的秒数（journal 里存的是服务器时间） */
  serverOffset: number;
  /** 复盘时区分钟数（东八区 = 480） */
  timezoneOffsetMin: number;
}

export const HOUR_BUCKETS = [
  { key: '0-5', label: '00–05 时' },
  { key: '6-11', label: '06–11 时' },
  { key: '12-17', label: '12–17 时' },
  { key: '18-23', label: '18–23 时' },
];

export const DURATION_BUCKETS = [
  { key: 'lt15', label: '15 分内' },
  { key: '15-60', label: '15 分–1 时' },
  { key: '1-4h', label: '1–4 时' },
  { key: 'gt4h', label: '4 时以上' },
];

export const WEEKDAY_KEYS = [1, 2, 3, 4, 5, 6, 7];
export const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** 平仓时间在复盘时区里的整点（0–23） */
export function localHour(closeTime: number, ctx: FilterCtx): number {
  const seconds = closeTime - ctx.serverOffset + ctx.timezoneOffsetMin * 60;
  return Math.floor((((seconds % 86400) + 86400) % 86400) / 3600);
}

export function hourBucket(hour: number): string {
  if (hour < 6) return '0-5';
  if (hour < 12) return '6-11';
  if (hour < 18) return '12-17';
  return '18-23';
}

export function durationBucket(durationSec: number | null): string {
  if (durationSec == null || durationSec <= 0) return 'unknown';
  const minutes = durationSec / 60;
  if (minutes < 15) return 'lt15';
  if (minutes < 60) return '15-60';
  if (minutes < 240) return '1-4h';
  return 'gt4h';
}

/** "2026-11-14" → 1..7（周一 = 1） */
export function weekdayOfDay(day: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return 0;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCDay() || 7;
}

export interface Filters {
  symbols: string[];
  sides: Side[];
  /** 空字符串表示未标记 */
  tags: string[];
  weekdays: number[];
  hours: string[];
  durations: string[];
  result: 'all' | 'win' | 'loss';
}

export const EMPTY_FILTERS: Filters = {
  symbols: [],
  sides: [],
  tags: [],
  weekdays: [],
  hours: [],
  durations: [],
  result: 'all',
};

export function isFiltered(filters: Filters): boolean {
  return (
    filters.symbols.length > 0 ||
    filters.sides.length > 0 ||
    filters.tags.length > 0 ||
    filters.weekdays.length > 0 ||
    filters.hours.length > 0 ||
    filters.durations.length > 0 ||
    filters.result !== 'all'
  );
}

/** 某个维度上的展示名；未标记与未知都有自己的说法 */
export function dimensionValue(trade: TrendTrade, dimension: string, ctx: FilterCtx): string {
  switch (dimension) {
    case 'symbol':
      return trade.symbol;
    case 'side':
      return trade.side === 'buy' ? '做多' : '做空';
    case 'tag':
      return trade.tag?.trim() || '未标记';
    case 'weekday': {
      const weekday = weekdayOfDay(trade.day);
      return weekday ? WEEKDAY_LABELS[weekday - 1] : '未知';
    }
    case 'hour': {
      const bucket = hourBucket(localHour(trade.closeTime, ctx));
      return HOUR_BUCKETS.find((item) => item.key === bucket)?.label ?? bucket;
    }
    case 'duration': {
      const bucket = durationBucket(trade.durationSec);
      if (bucket === 'unknown') return '未知';
      return DURATION_BUCKETS.find((item) => item.key === bucket)?.label ?? bucket;
    }
    default:
      return '全部';
  }
}

export function applyFilters(
  trades: TrendTrade[],
  filters: Filters,
  ctx: FilterCtx,
): TrendTrade[] {
  return trades.filter((trade) => {
    if (filters.symbols.length > 0 && !filters.symbols.includes(trade.symbol)) return false;
    if (filters.sides.length > 0 && !filters.sides.includes(trade.side)) return false;
    if (filters.tags.length > 0 && !filters.tags.includes(trade.tag?.trim() || '')) return false;
    if (filters.weekdays.length > 0 && !filters.weekdays.includes(weekdayOfDay(trade.day))) {
      return false;
    }
    if (filters.hours.length > 0) {
      const bucket = hourBucket(localHour(trade.closeTime, ctx));
      if (!filters.hours.includes(bucket)) return false;
    }
    if (filters.durations.length > 0) {
      const bucket = durationBucket(trade.durationSec);
      if (!filters.durations.includes(bucket)) return false;
    }
    if (filters.result === 'win' && trade.profit <= 0.005) return false;
    if (filters.result === 'loss' && trade.profit >= -0.005) return false;
    return true;
  });
}

export interface Stats {
  count: number;
  net: number;
  wins: number;
  losses: number;
  rTrades: number;
  winRate: number | null;
  avgR: number | null;
  expectancy: number | null;
}

export function summarize(trades: TrendTrade[]): Stats {
  let net = 0;
  let wins = 0;
  let losses = 0;
  const rValues: number[] = [];
  for (const trade of trades) {
    net += trade.profit;
    if (isWin(trade.profit)) wins += 1;
    else if (isLoss(trade.profit)) losses += 1;
    if (trade.r != null) rValues.push(trade.r);
  }
  const count = trades.length;
  return {
    count,
    net: Math.round(net * 100) / 100,
    wins,
    losses,
    rTrades: rValues.length,
    winRate: count > 0 ? wins / count : null,
    avgR:
      rValues.length > 0
        ? rValues.reduce((sum, value) => sum + value, 0) / rValues.length
        : null,
    expectancy: count > 0 ? net / count : null,
  };
}

export interface GroupRow {
  key: string;
  stats: Stats;
}

/** 按维度分组，笔数多的在前；同笔数按净盈亏从高到低 */
export function groupTrades(
  trades: TrendTrade[],
  dimension: string,
  ctx: FilterCtx,
): GroupRow[] {
  const groups = new Map<string, TrendTrade[]>();
  for (const trade of trades) {
    const key = dimensionValue(trade, dimension, ctx);
    const bucket = groups.get(key);
    if (bucket) bucket.push(trade);
    else groups.set(key, [trade]);
  }
  return [...groups.entries()]
    .map(([key, rows]) => ({ key, stats: summarize(rows) }))
    .sort((a, b) => b.stats.count - a.stats.count || b.stats.net - a.stats.net);
}

export type CrossMetric = 'net' | 'winRate' | 'avgR' | 'count';

export const CROSS_METRICS: { key: CrossMetric; label: string }[] = [
  { key: 'net', label: '净盈亏' },
  { key: 'winRate', label: '胜率' },
  { key: 'avgR', label: '平均 R' },
  { key: 'count', label: '笔数' },
];

export interface CrossCell {
  value: number | null;
  count: number;
  wins: number;
  rTrades: number;
}

export interface CrossTab {
  rows: string[];
  cols: string[];
  cells: Record<string, CrossCell>;
}

export function crossKey(row: string, col: string): string {
  return `${row}||${col}`;
}

export function crossTab(
  trades: TrendTrade[],
  rowDimension: string,
  colDimension: string,
  ctx: FilterCtx,
  metric: CrossMetric,
): CrossTab {
  const rowSet = new Set<string>();
  const colSet = new Set<string>();
  const groups = new Map<string, TrendTrade[]>();
  for (const trade of trades) {
    const row = dimensionValue(trade, rowDimension, ctx);
    const col = dimensionValue(trade, colDimension, ctx);
    rowSet.add(row);
    colSet.add(col);
    const key = crossKey(row, col);
    const bucket = groups.get(key);
    if (bucket) bucket.push(trade);
    else groups.set(key, [trade]);
  }
  const cells: Record<string, CrossCell> = {};
  for (const [key, rows] of groups.entries()) {
    const stats = summarize(rows);
    const value =
      metric === 'count'
        ? stats.count
        : metric === 'net'
          ? stats.net
          : metric === 'winRate'
            ? stats.winRate
            : stats.avgR;
    cells[key] = {
      value,
      count: stats.count,
      wins: stats.wins,
      rTrades: stats.rTrades,
    };
  }
  const rowWeight = (row: string) =>
    [...groups.entries()]
      .filter(([key]) => key.startsWith(`${row}||`))
      .reduce((sum, [, list]) => sum + list.length, 0);
  const rowsSorted = [...rowSet].sort((a, b) => rowWeight(b) - rowWeight(a));
  return { rows: rowsSorted, cols: [...colSet].sort(), cells };
}
