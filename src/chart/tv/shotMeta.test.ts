import { describe, expect, it } from 'vitest';
import type { ShotMeta } from './shotMeta';
import { isShotMeta, shotY } from './shotMeta';

const META: ShotMeta = {
  version: 1,
  digits: 2,
  symbol: 'XAUUSD',
  interval: '15',
  anchors: [
    { price: 3900, y: 0.9 },
    { price: 3925, y: 0.7 },
    { price: 3950, y: 0.5 },
    { price: 3975, y: 0.3 },
    { price: 4000, y: 0.1 },
  ],
};

describe('shotY', () => {
  it('区间内按锚点线性插值', () => {
    expect(shotY(3950, META)).toEqual({ y: 0.5, edge: null });
    expect(shotY(3962.5, META)).toEqual({ y: 0.4, edge: null });
    expect(shotY(3912.5, META)).toEqual({ y: 0.8, edge: null });
  });

  it('超出区间时夹到锚点并标记方向', () => {
    expect(shotY(3800, META)).toEqual({ y: 0.9, edge: 'below' });
    expect(shotY(4100, META)).toEqual({ y: 0.1, edge: 'above' });
  });

  it('正好落在边界上不标记边缘', () => {
    expect(shotY(3900, META)).toEqual({ y: 0.9, edge: null });
    expect(shotY(4000, META)).toEqual({ y: 0.1, edge: null });
  });

  it('锚点顺序颠倒也能算', () => {
    const reversed = { ...META, anchors: [...META.anchors].reverse() };
    expect(shotY(3962.5, reversed)).toEqual({ y: 0.4, edge: null });
  });

  it('越界比例被压到 1.2%–98.8%', () => {
    const extreme: ShotMeta = {
      ...META,
      anchors: [
        { price: 3900, y: 1.5 },
        { price: 4000, y: -0.5 },
      ],
    };
    expect(shotY(3950, extreme)?.y).toBeCloseTo(0.5, 10);
    expect(shotY(3800, extreme)?.y).toBe(0.988);
    expect(shotY(4100, extreme)?.y).toBe(0.012);
  });

  it('锚点不足或价格非法时返回 null', () => {
    expect(shotY(3950, { ...META, anchors: [META.anchors[0]] })).toBeNull();
    expect(shotY(Number.NaN, META)).toBeNull();
  });
});

describe('isShotMeta', () => {
  it('接受至少两个数值锚点的对象', () => {
    expect(isShotMeta(META)).toBe(true);
    expect(isShotMeta({ anchors: [{ price: 1, y: 0 }, { price: 2, y: 1 }] })).toBe(true);
  });

  it('拒绝缺锚点或数值非法的数据', () => {
    expect(isShotMeta(null)).toBe(false);
    expect(isShotMeta({})).toBe(false);
    expect(isShotMeta({ anchors: [{ price: 1, y: 0 }] })).toBe(false);
    expect(isShotMeta({ anchors: [{ price: 1, y: 0 }, { price: 'x', y: 1 }] })).toBe(false);
    expect(isShotMeta({ anchors: [{ price: 1, y: 0 }, { price: 2, y: Number.NaN }] })).toBe(
      false,
    );
    expect(isShotMeta('meta')).toBe(false);
  });
});
