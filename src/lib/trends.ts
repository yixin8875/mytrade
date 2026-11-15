/** 绩效趋势与散点的纯函数：滚动均值、散点坐标、样本门槛。 */

import type { TrendTrade } from '../gateway/types';
import { isWin } from './metrics';

/** 20 笔滚动窗口 */
export const ROLLING_WINDOW = 20;

/** 至少 27 笔才画第一条滚动线（20 笔窗口 + 7 笔缓冲） */
export const MIN_ROLLING_TRADES = 27;

/** 少于 8 个点不画散点，改用精确值表格 */
export const MIN_SCATTER_POINTS = 8;

export interface RollPoint {
  /** 该窗口最后一笔在序列里的下标 */
  index: number;
  value: number;
}

/** 简单滚动均值；不足一个窗口时不出点 */
export function rollingAverage(values: number[], window: number): RollPoint[] {
  if (window <= 0 || values.length < window) return [];
  const out: RollPoint[] = [];
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index];
    if (index >= window) sum -= values[index - window];
    if (index >= window - 1) {
      out.push({ index, value: sum / window });
    }
  }
  return out;
}

/** 每笔的胜负：盈利 0.005 以内算平 */
export function winFlags(trades: TrendTrade[]): number[] {
  return trades.map((trade) => (isWin(trade.profit) ? 1 : 0));
}

export interface ScatterPoint {
  positionId: number;
  /** 持仓分钟数 */
  minutes: number;
  /** 实现 R */
  r: number;
  win: boolean;
}

export function scatterPoints(trades: TrendTrade[]): ScatterPoint[] {
  const out: ScatterPoint[] = [];
  for (const trade of trades) {
    if (trade.r == null || trade.durationSec == null) continue;
    if (trade.durationSec <= 0) continue;
    out.push({
      positionId: trade.positionId,
      minutes: trade.durationSec / 60,
      r: trade.r,
      win: isWin(trade.profit),
    });
  }
  return out;
}

/** 持仓时长跨好几个数量级，横轴用平方根压缩 */
export function durationScale(minutes: number): number {
  return Math.sqrt(Math.max(0, minutes));
}

/** 横轴刻度：15 分钟 / 1 小时 / 4 小时 / 1 天 / 1 周 */
export function durationTicks(maxMinutes: number): { minutes: number; label: string }[] {
  const all = [
    { minutes: 15, label: '15分' },
    { minutes: 60, label: '1时' },
    { minutes: 240, label: '4时' },
    { minutes: 1440, label: '1天' },
    { minutes: 10080, label: '1周' },
  ];
  const visible = all.filter((tick) => tick.minutes <= maxMinutes * 1.05);
  return visible.length >= 2 ? visible : all.slice(0, 2);
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** 样本不足时的说明；够了返回 null */
export function sampleNotice(
  count: number,
  kind: 'rolling' | 'rollingR' | 'scatter',
): string | null {
  if (kind === 'rolling' || kind === 'rollingR') {
    const unit = kind === 'rolling' ? '笔交易' : '笔带止损的交易';
    if (count === 0) return `区间内还没有${kind === 'rolling' ? '交易' : '带止损的交易'}`;
    if (count < MIN_ROLLING_TRADES) {
      return `只有 ${count} ${unit}，满 ${MIN_ROLLING_TRADES} 笔再画 ${ROLLING_WINDOW} 笔滚动线`;
    }
    return null;
  }
  if (count === 0) return '区间内还没有同时有持仓时长与 R 的交易';
  if (count < MIN_SCATTER_POINTS) {
    return `只有 ${count} 个点，满 ${MIN_SCATTER_POINTS} 个再画散点；下面先列精确值`;
  }
  return null;
}
