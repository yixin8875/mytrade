import { describe, expect, it } from 'vitest';
import golden from '../../testdata/stats_golden.json';
import type { TrendTrade } from '../gateway/types';
import { summarize } from './analysis';

describe('统计口径黄金样本', () => {
  it('前端汇总与共享期望一致', () => {
    const trades = golden.trades as unknown as TrendTrade[];
    const stats = summarize(trades);
    const expected = golden.expected;

    expect(stats.count).toBe(expected.trades);
    expect(stats.wins).toBe(expected.wins);
    expect(stats.losses).toBe(expected.losses);
    expect(stats.net).toBe(expected.net);
    // 前端用比例，后端返回百分数；两边的胜负边界必须一致
    expect(stats.winRate).toBeCloseTo(expected.winRate, 6);
    expect(stats.rTrades).toBe(expected.rTrades);
    expect(stats.avgR).toBeCloseTo(expected.avgR, 2);
  });
});
