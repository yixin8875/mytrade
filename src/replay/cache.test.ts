import { describe, expect, it } from 'vitest';
import type { Bar } from '../gateway/types';
import { mergeBars } from './cache';

const bar = (time: number, close = time): Bar => ({
  time,
  open: close,
  high: close,
  low: close,
  close,
  volume: 1,
});

describe('mergeBars', () => {
  it('没有新数据时原样返回', () => {
    const existing = [bar(1), bar(2)];
    expect(mergeBars(existing, [])).toBe(existing);
  });

  it('按时间排序并去重，新数据覆盖旧数据', () => {
    const merged = mergeBars([bar(2, 20), bar(1, 10)], [bar(3, 30), bar(2, 99)]);
    expect(merged.map((item) => item.time)).toEqual([1, 2, 3]);
    expect(merged[1].close).toBe(99);
  });

  it('不改动传入的数组', () => {
    const existing = [bar(2)];
    const incoming = [bar(1)];
    mergeBars(existing, incoming);
    expect(existing).toHaveLength(1);
    expect(incoming).toHaveLength(1);
  });

  it('时间相同的旧值被新值替换', () => {
    const merged = mergeBars([bar(1, 100)], [bar(1, 200)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].close).toBe(200);
  });
});
