import { describe, expect, it } from 'vitest';
import {
  MIN_ROLLING_TRADES,
  MIN_SCATTER_POINTS,
  ROLLING_WINDOW,
  durationScale,
  durationTicks,
  mean,
  rollingAverage,
  sampleNotice,
  scatterPoints,
  winFlags,
} from './trends';
import type { TrendTrade } from '../gateway/types';

function trade(overrides: Partial<TrendTrade>): TrendTrade {
  return {
    positionId: 1,
    symbol: 'EURUSD',
    side: 'buy',
    volume: 1,
    openTime: 0,
    closeTime: 0,
    profit: 10,
    r: 1,
    risk: 10,
    durationSec: 3600,
    mfe: null,
    mae: null,
    tag: null,
    day: '2026-11-14',
    ...overrides,
  };
}

describe('trends helpers', () => {
  it('滚动均值只在窗口满了之后出点', () => {
    expect(rollingAverage([1, 2, 3, 4], 2)).toEqual([
      { index: 1, value: 1.5 },
      { index: 2, value: 2.5 },
      { index: 3, value: 3.5 },
    ]);
    expect(rollingAverage([1, 2], 3)).toEqual([]);
    expect(rollingAverage([5, 5, 5], 3)).toEqual([{ index: 2, value: 5 }]);
  });

  it('胜负按 0.005 分界', () => {
    expect(
      winFlags([trade({ profit: 1 }), trade({ profit: -1 }), trade({ profit: 0.001 })]),
    ).toEqual([1, 0, 0]);
  });

  it('散点只收同时有时长和 R 的交易', () => {
    const points = scatterPoints([
      trade({ positionId: 1, r: 2, durationSec: 600 }),
      trade({ positionId: 2, r: null }),
      trade({ positionId: 3, durationSec: 0 }),
      trade({ positionId: 4, r: -1, durationSec: 7200, profit: -20 }),
    ]);
    expect(points).toEqual([
      { positionId: 1, minutes: 10, r: 2, win: true },
      { positionId: 4, minutes: 120, r: -1, win: false },
    ]);
  });

  it('横轴刻度与平方根压缩', () => {
    expect(durationScale(0)).toBe(0);
    expect(durationScale(1440)).toBeGreaterThan(durationScale(60));
    expect(durationTicks(30).map((tick) => tick.label)).toEqual(['15分', '1时']);
    expect(durationTicks(2000).map((tick) => tick.label)).toEqual(['15分', '1时', '4时', '1天']);
  });

  it('样本门槛提示', () => {
    expect(sampleNotice(0, 'rolling')).toContain('还没有');
    expect(sampleNotice(MIN_ROLLING_TRADES - 1, 'rolling')).toContain('满 27 笔');
    expect(sampleNotice(MIN_ROLLING_TRADES, 'rolling')).toBeNull();
    expect(sampleNotice(MIN_ROLLING_TRADES - 1, 'rollingR')).toContain('带止损');
    expect(sampleNotice(MIN_ROLLING_TRADES, 'rollingR')).toBeNull();
    expect(sampleNotice(3, 'scatter')).toContain(`满 ${MIN_SCATTER_POINTS} 个`);
    expect(sampleNotice(MIN_SCATTER_POINTS, 'scatter')).toBeNull();
    expect(ROLLING_WINDOW).toBe(20);
  });

  it('均值', () => {
    expect(mean([])).toBe(0);
    expect(mean([1, 2, 3])).toBe(2);
  });
});
