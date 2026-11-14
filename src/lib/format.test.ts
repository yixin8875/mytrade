import { describe, expect, it } from 'vitest';
import {
  fmtMoney,
  fmtPrice,
  fmtSigned,
  fmtVolume,
  roundVolume,
  signedClass,
  snapToLevel,
  spreadPoints,
  volumeDecimals,
} from './format';

describe('fmtPrice', () => {
  it('按位数格式化', () => {
    expect(fmtPrice(1.23456)).toBe('1.23456');
    expect(fmtPrice(2000.1, 2)).toBe('2000.10');
    expect(fmtPrice(0, 2)).toBe('0.00');
  });

  it('空值和非法数字用占位符', () => {
    expect(fmtPrice(null)).toBe('—');
    expect(fmtPrice(undefined)).toBe('—');
    expect(fmtPrice(Number.NaN)).toBe('—');
    expect(fmtPrice(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('fmtMoney / fmtSigned', () => {
  it('金额保留两位并加千分位', () => {
    expect(fmtMoney(12_345.678)).toBe('12,345.68');
    expect(fmtMoney(-5)).toBe('-5.00');
    expect(fmtMoney(null)).toBe('—');
  });

  it('带符号数字只在非负时加 +', () => {
    expect(fmtSigned(1.234)).toBe('+1.23');
    expect(fmtSigned(-1.234)).toBe('-1.23');
    expect(fmtSigned(0)).toBe('+0.00');
    expect(fmtSigned(Number.NaN)).toBe('—');
  });
});

describe('手数精度', () => {
  it('按最小步长推导小数位', () => {
    expect(volumeDecimals(1)).toBe(0);
    expect(volumeDecimals(0.1)).toBe(1);
    expect(volumeDecimals(0.01)).toBe(2);
    expect(volumeDecimals(0.001)).toBe(3);
    expect(volumeDecimals(0)).toBe(2);
    expect(volumeDecimals(Number.NaN)).toBe(2);
  });

  it('格式化手数', () => {
    expect(fmtVolume(1.2345, 0.01)).toBe('1.23');
    expect(fmtVolume(1.2345, 1)).toBe('1');
    expect(fmtVolume(null)).toBe('—');
  });

  it('roundVolume 向下取整到步长并夹在最小/最大手数之间', () => {
    expect(roundVolume(0.237, 0.01, 0.01, 100)).toBe(0.23);
    expect(roundVolume(0.001, 0.01, 0.01, 100)).toBe(0.01);
    expect(roundVolume(500, 0.01, 0.01, 100)).toBe(100);
    expect(roundVolume(2.9, 1, 1, 100)).toBe(2);
    expect(roundVolume(0.05, 0, 0.01, 100)).toBe(0.05);
  });
});

describe('spreadPoints', () => {
  it('按 point 折算点差', () => {
    expect(spreadPoints(2000, 2000.2, 0.01)).toBeCloseTo(20, 9);
    expect(spreadPoints(1.086, 1.08612, 0.00001)).toBeCloseTo(12, 9);
  });

  it('point 缺失时返回 0', () => {
    expect(spreadPoints(1, 2, 0)).toBe(0);
  });
});

describe('snapToLevel', () => {
  it('FX 五位报价吸附到 10 个 pip', () => {
    expect(snapToLevel(1.08654, 5, 0.00001)).toBe(1.087);
    expect(snapToLevel(1.08651, 5, 0.00001)).toBe(1.087);
    expect(snapToLevel(1.0864, 5, 0.00001)).toBe(1.086);
  });

  it('黄金与日元吸附到 10 个 point', () => {
    expect(snapToLevel(3982.34, 2, 0.01)).toBe(3982.3);
    expect(snapToLevel(152.456, 3, 0.001)).toBe(152.46);
  });

  it('非法输入原样返回', () => {
    expect(snapToLevel(Number.NaN, 2, 0.01)).toBeNaN();
    expect(snapToLevel(1.23, 2, 0)).toBe(1.23);
  });
});

describe('signedClass', () => {
  it('按盈亏方向返回配色类', () => {
    expect(signedClass(1)).toBe('text-tv-up');
    expect(signedClass(-1)).toBe('text-tv-down');
    expect(signedClass(0)).toBe('text-tv-muted');
    expect(signedClass(null)).toBe('text-tv-muted');
  });
});
