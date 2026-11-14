import { describe, expect, it } from 'vitest';
import type { SymbolInfo } from '../gateway/types';
import { generateDemoBars } from './demo';
import { GOLD_INFO } from './testUtils';

const FX_INFO: SymbolInfo = {
  ...GOLD_INFO,
  name: 'EURUSD',
  description: 'Euro vs US Dollar',
  digits: 5,
  point: 0.00001,
  tickSize: 0.00001,
  contractSize: 100_000,
  currency: 'EUR',
};

const at = (iso: string) =>
  Date.UTC(
    Number(iso.slice(0, 4)),
    Number(iso.slice(5, 7)) - 1,
    Number(iso.slice(8, 10)),
    Number(iso.slice(11, 13)),
    Number(iso.slice(14, 16)),
  ) / 1000;

describe('generateDemoBars', () => {
  const from = at('2024-01-08T00:00'); // 周一
  const to = at('2024-01-09T23:59');

  it('生成覆盖区间并按分钟对齐的 M1', () => {
    const bars = generateDemoBars('XAUUSD', GOLD_INFO, from, to);
    expect(bars.length).toBeGreaterThan(1_000);
    expect(bars[0].time).toBe(from);
    expect(bars[bars.length - 1].time).toBeLessThanOrEqual(to);
    for (const item of bars) {
      expect(item.time % 60).toBe(0);
    }
  });

  it('OHLC 自洽且价格按 tick 对齐', () => {
    const bars = generateDemoBars('XAUUSD', GOLD_INFO, from, to);
    for (const item of bars) {
      expect(item.high).toBeGreaterThanOrEqual(Math.max(item.open, item.close));
      expect(item.low).toBeLessThanOrEqual(Math.min(item.open, item.close));
      expect(item.high).toBeGreaterThanOrEqual(item.low);
      expect(Math.abs(item.close - Math.round(item.close * 100) / 100)).toBeLessThan(1e-9);
      expect(item.volume).toBeGreaterThan(0);
      expect(Number.isInteger(item.volume)).toBe(true);
    }
  });

  it('同样的输入得到同样的序列', () => {
    const first = generateDemoBars('XAUUSD', GOLD_INFO, from, to);
    const second = generateDemoBars('XAUUSD', GOLD_INFO, from, to);
    expect(second).toEqual(first);
  });

  it('不同品种的基准价不同', () => {
    const gold = generateDemoBars('XAUUSD', GOLD_INFO, from, to);
    const euro = generateDemoBars('EURUSD', FX_INFO, from, to);
    expect(gold[0].open).toBeGreaterThan(1_000);
    expect(euro[0].open).toBeCloseTo(1.086, 1);
  });

  it('周末休市不生成 K 线', () => {
    const bars = generateDemoBars(
      'XAUUSD',
      GOLD_INFO,
      at('2024-01-12T20:00'), // 周五
      at('2024-01-14T22:00'), // 周日
    );
    for (const item of bars) {
      const date = new Date(item.time * 1000);
      const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
      expect(date.getUTCDay()).not.toBe(6);
      if (date.getUTCDay() === 5) expect(minutes).toBeLessThan(21 * 60);
      if (date.getUTCDay() === 0) expect(minutes).toBeGreaterThanOrEqual(21 * 60);
    }
    expect(bars.some((item) => new Date(item.time * 1000).getUTCDay() === 5)).toBe(true);
    expect(bars.some((item) => new Date(item.time * 1000).getUTCDay() === 0)).toBe(true);
  });

  it('区间反过来时没有数据', () => {
    expect(generateDemoBars('XAUUSD', GOLD_INFO, to, from)).toEqual([]);
  });
});
