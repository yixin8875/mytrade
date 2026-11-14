import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTERS,
  applyFilters,
  crossKey,
  crossTab,
  durationBucket,
  groupTrades,
  hourBucket,
  isFiltered,
  localHour,
  summarize,
  weekdayOfDay,
  type FilterCtx,
} from './analysis';
import type { TrendTrade } from '../gateway/types';

const CTX: FilterCtx = { serverOffset: 0, timezoneOffsetMin: 0 };

function trade(overrides: Partial<TrendTrade>): TrendTrade {
  return {
    positionId: 1,
    symbol: 'EURUSD',
    side: 'buy',
    volume: 1,
    openTime: 0,
    closeTime: 10 * 3600,
    profit: 10,
    r: 1,
    risk: 10,
    durationSec: 1200,
    mfe: null,
    mae: null,
    tag: null,
    day: '2026-11-12',
    ...overrides,
  };
}

describe('analysis helpers', () => {
  it('本地整点按时区与服务器偏移换算', () => {
    expect(localHour(0, CTX)).toBe(0);
    expect(localHour(13 * 3600 + 59 * 60, CTX)).toBe(13);
    expect(localHour(-3600, CTX)).toBe(23);
    expect(localHour(0, { serverOffset: -43200, timezoneOffsetMin: 480 })).toBe(20);
  });

  it('时段与持仓分桶', () => {
    expect(hourBucket(0)).toBe('0-5');
    expect(hourBucket(5)).toBe('0-5');
    expect(hourBucket(6)).toBe('6-11');
    expect(hourBucket(18)).toBe('18-23');
    expect(durationBucket(null)).toBe('unknown');
    expect(durationBucket(60)).toBe('lt15');
    expect(durationBucket(30 * 60)).toBe('15-60');
    expect(durationBucket(2 * 3600)).toBe('1-4h');
    expect(durationBucket(5 * 3600)).toBe('gt4h');
  });

  it('日期转星期', () => {
    expect(weekdayOfDay('2026-11-12')).toBe(4);
    expect(weekdayOfDay('2026-11-15')).toBe(7);
    expect(weekdayOfDay('bad')).toBe(0);
  });

  it('筛选按各维度生效', () => {
    const trades = [
      trade({ positionId: 1, symbol: 'EURUSD', tag: '突破', profit: 10 }),
      trade({ positionId: 2, symbol: 'USTEC', tag: null, profit: -10, r: -1, day: '2026-11-13' }),
      trade({
        positionId: 3,
        symbol: 'USTEC',
        side: 'sell',
        tag: '  ',
        profit: 5,
        day: '2026-11-14',
      }),
    ];
    expect(applyFilters(trades, { ...EMPTY_FILTERS }, CTX)).toHaveLength(3);
    expect(applyFilters(trades, { ...EMPTY_FILTERS, symbols: ['USTEC'] }, CTX)).toHaveLength(2);
    expect(applyFilters(trades, { ...EMPTY_FILTERS, sides: ['sell'] }, CTX)).toHaveLength(1);
    expect(applyFilters(trades, { ...EMPTY_FILTERS, tags: [''] }, CTX)).toHaveLength(2);
    expect(applyFilters(trades, { ...EMPTY_FILTERS, weekdays: [4] }, CTX)).toHaveLength(1);
    expect(applyFilters(trades, { ...EMPTY_FILTERS, result: 'win' }, CTX)).toHaveLength(2);
    expect(applyFilters(trades, { ...EMPTY_FILTERS, result: 'loss' }, CTX)).toHaveLength(1);
    expect(applyFilters(trades, { ...EMPTY_FILTERS, hours: ['6-11'] }, CTX)).toHaveLength(3);
    expect(applyFilters(trades, { ...EMPTY_FILTERS, durations: ['gt4h'] }, CTX)).toHaveLength(0);
    expect(isFiltered({ ...EMPTY_FILTERS })).toBe(false);
    expect(isFiltered({ ...EMPTY_FILTERS, result: 'win' })).toBe(true);
  });

  it('汇总与分组', () => {
    const trades = [
      trade({ positionId: 1, profit: 20, r: 2 }),
      trade({ positionId: 2, profit: -10, r: -1 }),
      trade({ positionId: 3, profit: 0, r: null }),
    ];
    const stats = summarize(trades);
    expect(stats.count).toBe(3);
    expect(stats.net).toBe(10);
    expect(stats.wins).toBe(1);
    expect(stats.losses).toBe(1);
    expect(stats.rTrades).toBe(2);
    expect(stats.avgR).toBeCloseTo(0.5);
    expect(stats.expectancy).toBeCloseTo(10 / 3);

    const groups = groupTrades(
      [
        trade({ positionId: 1, symbol: 'USTEC' }),
        trade({ positionId: 2, symbol: 'USTEC' }),
        trade({ positionId: 3, symbol: 'EURUSD' }),
      ],
      'symbol',
      CTX,
    );
    expect(groups.map((group) => group.key)).toEqual(['USTEC', 'EURUSD']);
    expect(groups[0].stats.count).toBe(2);
  });

  it('交叉矩阵给出格子与笔数', () => {
    const trades = [
      trade({ positionId: 1, symbol: 'USTEC', closeTime: 2 * 3600, profit: 10 }),
      trade({ positionId: 2, symbol: 'USTEC', closeTime: 2 * 3600, profit: -5 }),
      trade({ positionId: 3, symbol: 'EURUSD', closeTime: 13 * 3600, profit: 7 }),
    ];
    const tab = crossTab(trades, 'symbol', 'hour', CTX, 'net');
    expect(tab.rows).toEqual(['USTEC', 'EURUSD']);
    expect(tab.cols).toEqual(['00–05 时', '12–17 时']);
    const cell = tab.cells[crossKey('USTEC', '00–05 时')];
    expect(cell.count).toBe(2);
    expect(cell.value).toBe(5);
    const countTab = crossTab(trades, 'symbol', 'hour', CTX, 'count');
    expect(countTab.cells[crossKey('USTEC', '00–05 时')].value).toBe(2);
  });
});
