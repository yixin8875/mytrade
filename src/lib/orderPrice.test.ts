import { describe, expect, it } from 'vitest';
import type { Quote, SymbolInfo } from '../gateway/types';
import { defaultPrice, roundToTick } from './orderPrice';

const INFO: SymbolInfo = {
  name: 'XAUUSD',
  description: 'Gold vs US Dollar',
  digits: 2,
  point: 0.01,
  tickSize: 0.01,
  tickValue: 1,
  contractSize: 100,
  minVolume: 0.01,
  maxVolume: 100,
  volumeStep: 0.01,
  stopsLevelPoints: 0,
  freezeLevelPoints: 0,
  spreadPoints: 20,
  tradeMode: 4,
  fillingMode: 1,
  visible: true,
  currency: 'USD',
  marginMode: 'hedging',
};

const QUOTE: Quote = {
  symbol: 'XAUUSD',
  bid: 3980,
  ask: 3980.2,
  time: 1_700_000_000,
  timeMs: 1_700_000_000_000,
};

describe('roundToTick', () => {
  it('按 tickSize 对齐并保留品种小数位', () => {
    expect(roundToTick(3980.234, INFO)).toBe(3980.23);
    expect(roundToTick(3980.236, INFO)).toBe(3980.24);
    expect(roundToTick(3980.2, INFO)).toBe(3980.2);
  });

  it('没有品种信息时原样返回', () => {
    expect(roundToTick(3980.234)).toBe(3980.234);
  });

  it('tickSize 缺失时退回 point', () => {
    expect(roundToTick(3980.234, { ...INFO, tickSize: 0 })).toBe(3980.23);
  });

  it('tick 为 0 时按 digits 取整', () => {
    expect(roundToTick(1.2345, { ...INFO, digits: 2, tickSize: 0, point: 0 })).toBe(1.23);
  });
});

describe('defaultPrice', () => {
  it('限价贴对手价', () => {
    expect(defaultPrice('buy', 'limit', QUOTE, INFO)).toBe(3980);
    expect(defaultPrice('sell', 'limit', QUOTE, INFO)).toBe(3980.2);
  });

  it('停损离现价 10 个 tick', () => {
    expect(defaultPrice('buy', 'stop', QUOTE, INFO)).toBe(3980.3);
    expect(defaultPrice('sell', 'stop', QUOTE, INFO)).toBe(3979.9);
  });

  it('市价用当前可成交价', () => {
    expect(defaultPrice('buy', 'market', QUOTE, INFO)).toBe(3980.2);
    expect(defaultPrice('sell', 'market', QUOTE, INFO)).toBe(3980);
  });

  it('缺报价或品种信息时返回 0', () => {
    expect(defaultPrice('buy', 'market', null, INFO)).toBe(0);
    expect(defaultPrice('buy', 'market', QUOTE, undefined)).toBe(0);
  });
});
