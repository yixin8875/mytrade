import { describe, expect, it } from 'vitest';
import golden from '../../testdata/stats_golden.json';
import type { TrendTrade } from '../gateway/types';
import { groupTrades, localHour, summarize } from './analysis';

const TRADES = golden.trades as unknown as TrendTrade[];
const EXPECTED = golden.expected;

/** 与 journal.stats 的 byHour 口径一致：平仓时间换算到复盘时区后的整点 */
function closeHourKey(trade: TrendTrade): string {
  const hour = localHour(trade.closeTime, {
    serverOffset: golden.serverOffset,
    timezoneOffsetMin: 0,
  });
  return `${String(hour).padStart(2, '0')}:00`;
}

function groupsBy(dimension: 'tag' | 'duration'): Record<string, ReturnType<typeof summarize>> {
  const out: Record<string, ReturnType<typeof summarize>> = {};
  for (const row of groupTrades(TRADES, dimension, { serverOffset: 0, timezoneOffsetMin: 0 })) {
    out[row.key] = row.stats;
  }
  return out;
}

function groupsByHour(): Record<string, ReturnType<typeof summarize>> {
  const buckets = new Map<string, TrendTrade[]>();
  for (const trade of TRADES) {
    const key = closeHourKey(trade);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(trade);
    else buckets.set(key, [trade]);
  }
  return Object.fromEntries(
    [...buckets.entries()].map(([key, rows]) => [key, summarize(rows)]),
  );
}

function expectGroups(
  actual: Record<string, ReturnType<typeof summarize>>,
  expected: Record<
    string,
    { trades: number; wins: number; pnl: number; winRate: number; avgR: number }
  >,
) {
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
  for (const [key, values] of Object.entries(expected)) {
    const row = actual[key];
    expect(row.count, key).toBe(values.trades);
    expect(row.wins, key).toBe(values.wins);
    // 期望值按两位小数记账，-0 与 0 视为相同
    expect(row.net, key).toBeCloseTo(values.pnl, 6);
    // 前端用比例，后端返回百分数（已按 1 位小数取整）
    expect(row.winRate, key).toBeCloseTo(values.winRate / 100, 2);
    expect(row.avgR, key).toBeCloseTo(values.avgR, 1);
  }
}

describe('统计口径黄金样本', () => {
  it('前端汇总与共享期望一致', () => {
    const stats = summarize(TRADES);

    expect(stats.count).toBe(EXPECTED.trades);
    expect(stats.wins).toBe(EXPECTED.wins);
    expect(stats.losses).toBe(EXPECTED.losses);
    expect(stats.net).toBe(EXPECTED.net);
    // 前端用比例，后端返回百分数；两边的胜负边界必须一致
    expect(stats.winRate).toBeCloseTo(EXPECTED.winRate, 6);
    expect(stats.rTrades).toBe(EXPECTED.rTrades);
    expect(stats.avgR).toBeCloseTo(EXPECTED.avgR, 2);
    expect(stats.profitFactor).toBe(EXPECTED.profitFactor);
    expect(stats.expectancy).toBeCloseTo(EXPECTED.expectancy, 2);
    expect(stats.avgDurationSec).toBe(EXPECTED.avgDurationSec);
  });

  it('分组维度与后端一致', () => {
    expectGroups(groupsBy('tag'), EXPECTED.byTag);
    expectGroups(groupsBy('duration'), EXPECTED.byDuration);
    expectGroups(groupsByHour(), EXPECTED.byHour);
  });
});
