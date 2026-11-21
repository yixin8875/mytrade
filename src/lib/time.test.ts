import { afterEach, describe, expect, it, vi } from 'vitest';
import { fmtLocalDay, fmtLocalTime, rowOffset, serverDayStart, toUtcSeconds } from './time';

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

describe('serverDayStart', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('按券商服务器日切分，跨日时随偏移变化', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T23:30:00Z'));

    // 服务器时间与 UTC 相同：当天从 1 月 1 日 00:00 起
    expect(serverDayStart(0)).toBe(Date.UTC(2024, 0, 1) / 1000);
    // 服务器快 1 小时：已是服务器 1 月 2 日 00:30，当天从 2 日 00:00 起
    expect(serverDayStart(3_600)).toBe(Date.UTC(2024, 0, 2) / 1000);
  });

  it('非法偏移按 0 处理', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T12:00:00Z'));

    expect(serverDayStart(Number.NaN)).toBe(serverDayStart(0));
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
