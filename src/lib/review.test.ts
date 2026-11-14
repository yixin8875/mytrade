import { describe, expect, it } from 'vitest';
import {
  compactMoney,
  currentMonth,
  dayTone,
  fmtPct,
  fmtR,
  fmtReviewTime,
  monthLabel,
  sampleHint,
  shiftMonth,
  shortDay,
  toUtcSeconds,
} from './review';

describe('shiftMonth', () => {
  it('跨年时正确进位与借位', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-11', -1)).toBe('2026-10');
    expect(shiftMonth('2026-06', 12)).toBe('2027-06');
    expect(shiftMonth('2026-06', -12)).toBe('2025-06');
  });

  it('坏输入回退到本月再翻页', () => {
    expect(shiftMonth('bad', 0)).toBe(currentMonth());
    expect(shiftMonth('2026-13', 0)).toBe(currentMonth());
  });
});

describe('monthLabel / shortDay', () => {
  it('把月份和日期转成展示文案', () => {
    expect(monthLabel('2026-11')).toBe('2026 年 11 月');
    expect(monthLabel('nope')).toBe('nope');
    expect(shortDay('2026-11-03')).toBe('11/03');
    expect(shortDay('bad')).toBe('bad');
  });
});

describe('toUtcSeconds / fmtReviewTime', () => {
  it('先减服务器偏移再按本机时区显示', () => {
    // raw 是券商服务器时间（UTC+3）；减 3 小时后是 UTC
    const raw = 1793701800;
    expect(toUtcSeconds(raw, 10800)).toBe(raw - 10800);
    expect(toUtcSeconds(raw, 0)).toBe(raw);
    expect(toUtcSeconds(Number.NaN, 10800)).toBe(0);
  });

  it('空时间显示 —', () => {
    expect(fmtReviewTime(0, 10800)).toBe('—');
  });
});

describe('展示文本', () => {
  it('fmtPct 和 fmtR 统一格式', () => {
    expect(fmtPct(0.756)).toBe('76%');
    expect(fmtPct(null)).toBe('—');
    expect(fmtR(1.234)).toBe('+1.23R');
    expect(fmtR(-0.5)).toBe('-0.50R');
    expect(fmtR(null)).toBe('—');
  });

  it('dayTone 区分盈利 / 亏损 / 打平', () => {
    expect(dayTone(12)).toBe('win');
    expect(dayTone(-12)).toBe('loss');
    expect(dayTone(0)).toBe('flat');
    expect(dayTone(0.001)).toBe('flat');
    expect(dayTone(Number.NaN)).toBe('flat');
  });

  it('compactMoney 在格子里压缩大数', () => {
    expect(compactMoney(128.6)).toBe('+129');
    expect(compactMoney(-128.6)).toBe('-129');
    expect(compactMoney(12345)).toBe('+12.3k');
    expect(compactMoney(-12345)).toBe('-12.3k');
  });

  it('sampleHint 不在小样本上下结论', () => {
    expect(sampleHint(0)).toBeNull();
    expect(sampleHint(3)).toContain('样本不足');
    expect(sampleHint(10)).toContain('样本偏少');
    expect(sampleHint(25)).toBeNull();
  });
});
