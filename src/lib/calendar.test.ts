import { describe, expect, it } from 'vitest';
import { currenciesForSymbol, impactRank, IMPACT_LABEL } from './calendar';

describe('currenciesForSymbol', () => {
  it('货币对返回两种货币（调用方按集合使用，不依赖顺序）', () => {
    expect(currenciesForSymbol('EURUSD').sort()).toEqual(['EUR', 'USD']);
    expect(currenciesForSymbol('usdjpy').sort()).toEqual(['JPY', 'USD']);
    expect(currenciesForSymbol('GBPCHF').sort()).toEqual(['CHF', 'GBP']);
  });

  it('贵金属与指数按美元计价', () => {
    expect(currenciesForSymbol('XAUUSD')).toEqual(['USD']);
    expect(currenciesForSymbol('NAS100')).toEqual(['USD']);
  });

  it('未知品种回退到 USD', () => {
    expect(currenciesForSymbol('UNKNOWN')).toEqual(['USD']);
  });
});

describe('impactRank', () => {
  it('高影响排在最前，未知影响排在最后', () => {
    expect(impactRank('High')).toBe(0);
    expect(impactRank('Medium')).toBe(1);
    expect(impactRank('Low')).toBe(2);
    expect(impactRank('Holiday')).toBe(3);
    expect(impactRank('whatever')).toBe(3);
  });

  it('每种影响都有中文标签', () => {
    expect(IMPACT_LABEL.High).toBe('高');
    expect(IMPACT_LABEL.Holiday).toBe('休市');
  });
});
