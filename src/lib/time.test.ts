import { describe, expect, it } from 'vitest';
import { fmtLocalDay, fmtLocalTime, rowOffset, toUtcSeconds } from './time';

describe('toUtcSeconds', () => {
  it('减去服务器偏移，非法偏移按 0 处理', () => {
    expect(toUtcSeconds(10_000, 3_600)).toBe(6_400);
    expect(toUtcSeconds(10_000, 0)).toBe(10_000);
    expect(toUtcSeconds(10_000, Number.NaN)).toBe(10_000);
    expect(toUtcSeconds(Number.NaN, 3_600)).toBe(0);
  });
});

describe('rowOffset', () => {
  it('单笔偏移优先，老记录回退到账户偏移', () => {
    expect(rowOffset({ server_offset: 7_200 }, 0)).toBe(7_200);
    expect(rowOffset({ server_offset: null }, 3_600)).toBe(3_600);
    expect(rowOffset({}, 3_600)).toBe(3_600);
    expect(rowOffset(null, 0)).toBe(0);
    expect(rowOffset({ server_offset: 0 }, 3_600)).toBe(0);
  });
});

describe('本机时间格式化', () => {
  it('空值显示占位符', () => {
    expect(fmtLocalTime(0)).toBe('—');
    expect(fmtLocalDay(0)).toBe('—');
  });

  it('跨日时按偏移换算', () => {
    // 2024-01-01T00:30:00Z
    const raw = Date.UTC(2024, 0, 1, 0, 30) / 1000;
    expect(fmtLocalDay(raw + 3_600, 3_600)).toBe(fmtLocalDay(raw, 0));
    expect(fmtLocalTime(raw + 3_600, 3_600)).toBe(fmtLocalTime(raw, 0));
  });
});
