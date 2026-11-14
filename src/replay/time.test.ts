import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDays,
  dayEnd,
  dayStart,
  fmtDate,
  fmtDateTime,
  fmtDuration,
  fmtFullDate,
  fmtShort,
  fmtTime,
  parseServerInput,
  relativeTime,
  toInputValue,
} from './time';

const TS = Date.UTC(2024, 0, 15, 8, 5) / 1000;

afterEach(() => {
  vi.useRealTimers();
});

describe('服务器时间格式化（UTC）', () => {
  it('按 UTC 输出日期、时间与组合格式', () => {
    expect(fmtDate(TS)).toBe('01-15');
    expect(fmtFullDate(TS)).toBe('2024-01-15');
    expect(fmtTime(TS)).toBe('08:05');
    expect(fmtShort(TS)).toBe('01-15 08:05');
    expect(fmtDateTime(TS)).toBe('2024-01-15 08:05');
  });

  it('0 与空值用占位符', () => {
    expect(fmtDate(0)).toBe('—');
    expect(fmtTime(0)).toBe('—');
    expect(fmtDateTime(0)).toBe('—');
  });
});

describe('parseServerInput / toInputValue', () => {
  it('把 datetime-local 的值当服务器时间（UTC）解析', () => {
    expect(parseServerInput('2024-01-15T08:05')).toBe(TS);
    expect(parseServerInput(' 2024-01-15T08:05:30 ')).toBe(TS);
  });

  it('格式不对返回 null', () => {
    expect(parseServerInput('2024/01/15 08:05')).toBeNull();
    expect(parseServerInput('')).toBeNull();
  });

  it('与 toInputValue 往返一致', () => {
    expect(toInputValue(TS)).toBe('2024-01-15T08:05');
    expect(parseServerInput(toInputValue(TS))).toBe(TS);
    expect(toInputValue(0)).toBe('');
  });
});

describe('日期边界', () => {
  it('dayStart 取 UTC 当天 00:00，dayEnd 取当天最后一分钟', () => {
    expect(dayStart(TS)).toBe(Date.UTC(2024, 0, 15) / 1000);
    expect(dayEnd(TS)).toBe(Date.UTC(2024, 0, 15) / 1000 + 86_340);
  });

  it('addDays 按整天偏移', () => {
    expect(addDays(TS, 1) - TS).toBe(86_400);
    expect(addDays(TS, -2) - TS).toBe(-172_800);
  });
});

describe('fmtDuration', () => {
  it('小于一小时按分钟，超过按小时', () => {
    expect(fmtDuration(90)).toBe('2 分钟');
    expect(fmtDuration(3_600)).toBe('1.0 小时');
    expect(fmtDuration(3_600 * 9.5)).toBe('9.5 小时');
    expect(fmtDuration(3_600 * 10)).toBe('10 小时');
  });

  it('非正数与非法值用占位符', () => {
    expect(fmtDuration(0)).toBe('—');
    expect(fmtDuration(-1)).toBe('—');
    expect(fmtDuration(Number.NaN)).toBe('—');
  });
});

describe('relativeTime', () => {
  it('按毫秒时间戳给出相对时间', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-10T12:00:00Z'));
    const now = Date.now();

    expect(relativeTime(now - 30_000)).toBe('刚刚');
    expect(relativeTime(now + 30_000)).toBe('刚刚');
    expect(relativeTime(now - 5 * 60_000)).toBe('5 分钟前');
    expect(relativeTime(now - 2 * 3_600_000)).toBe('2 小时前');
    expect(relativeTime(now - 3 * 86_400_000)).toBe('3 天前');
  });

  it('超过一周退回本地月-日', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-10T12:00:00Z'));
    const old = Date.now() - 10 * 86_400_000;
    const date = new Date(old);
    const expected = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(
      date.getDate(),
    ).padStart(2, '0')}`;
    expect(relativeTime(old)).toBe(expected);
  });

  it('0 用占位符', () => {
    expect(relativeTime(0)).toBe('—');
  });
});
