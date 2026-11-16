import { describe, expect, it } from 'vitest';
import { GOLD_INFO } from '../replay/testUtils';
import { maxLoss, validateStops } from './stops';

const FX = { stopsLevel: 20, point: 0.00001 };

describe('validateStops', () => {
  it('方向正确且距离足够时通过', () => {
    expect(validateStops('buy', 1.065, 1.06, 1.07, FX)).toBeNull();
    expect(validateStops('sell', 1.065, 1.07, 1.06, FX)).toBeNull();
  });

  it('拦下方向错误', () => {
    expect(validateStops('buy', 1.065, 1.07, 0, FX)).toBe('多单止损必须低于当前价');
    expect(validateStops('buy', 1.065, 0, 1.06, FX)).toBe('多单止盈必须高于当前价');
    expect(validateStops('sell', 1.065, 1.06, 0, FX)).toBe('空单止损必须高于当前价');
    expect(validateStops('sell', 1.065, 0, 1.07, FX)).toBe('空单止盈必须低于当前价');
  });

  it('拦下小于券商最小距离的价位', () => {
    expect(validateStops('buy', 1.065, 1.0649, 0, FX)).toBe('止损距离至少 20 点');
    expect(validateStops('buy', 1.065, 0, 1.0651, FX)).toBe('止盈距离至少 20 点');
  });

  it('0 表示清除，不参与校验', () => {
    expect(validateStops('buy', 1.065, 0, 0, FX)).toBeNull();
  });

  it('拿不到当前价时不拦', () => {
    expect(validateStops('buy', 0, 1.2, 0.9, FX)).toBeNull();
  });
});

describe('maxLoss', () => {
  it('多单按开仓价到止损的距离估算', () => {
    expect(maxLoss('buy', 0.1, 3950, 3940, GOLD_INFO)).toBeCloseTo(100);
  });

  it('空单方向相反', () => {
    expect(maxLoss('sell', 0.2, 3950, 3960, GOLD_INFO)).toBeCloseTo(200);
  });

  it('止损不在亏损一侧时返回 null', () => {
    expect(maxLoss('buy', 0.1, 3950, 3960, GOLD_INFO)).toBeNull();
    expect(maxLoss('sell', 0.1, 3950, 3940, GOLD_INFO)).toBeNull();
  });

  it('缺报价参数时返回 null', () => {
    expect(maxLoss('buy', 0.1, 3950, 3940, { ...GOLD_INFO, tickValue: 0 })).toBeNull();
    expect(maxLoss('buy', 0.1, 3950, 3940, { ...GOLD_INFO, tickSize: 0, point: 0 })).toBeNull();
  });

  it('数量或价格非法时返回 null', () => {
    expect(maxLoss('buy', 0, 3950, 3940, GOLD_INFO)).toBeNull();
    expect(maxLoss('buy', 0.1, 0, 3940, GOLD_INFO)).toBeNull();
    expect(maxLoss('buy', 0.1, 3950, 0, GOLD_INFO)).toBeNull();
  });
});
