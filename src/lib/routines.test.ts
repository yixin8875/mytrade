import { describe, expect, it } from 'vitest';
import {
  PHASE_ORDER,
  dateLabel,
  heatCellTitle,
  heatTone,
  parseDayKey,
  rateText,
  shiftDay,
  streakText,
  weekdayMaskText,
  weekdayOf,
} from './routines';

describe('routines helpers', () => {
  it('翻日期跨月跨年', () => {
    expect(shiftDay('2026-11-14', 1)).toBe('2026-11-15');
    expect(shiftDay('2026-11-30', 1)).toBe('2026-12-01');
    expect(shiftDay('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('星期按周一=1', () => {
    expect(weekdayOf('2026-11-02')).toBe(1);
    expect(weekdayOf('2026-11-08')).toBe(7);
    expect(weekdayOf('2026-11-14')).toBe(6);
  });

  it('日期文案', () => {
    expect(dateLabel('2026-11-14', '2026-11-14')).toBe('今天');
    expect(dateLabel('2026-11-13', '2026-11-14')).toBe('昨天');
    expect(dateLabel('2026-11-12', '2026-11-14')).toBe('11月12日 周四');
  });

  it('星期掩码文案', () => {
    expect(weekdayMaskText([1, 2, 3, 4, 5])).toBe('工作日');
    expect(weekdayMaskText([1, 2, 3, 4, 5, 6, 7])).toBe('每天');
    expect(weekdayMaskText([6, 7])).toBe('周末');
    expect(weekdayMaskText([1, 3])).toBe('周一、周三');
    expect(weekdayMaskText([1, 2, 3, 4, 5, 6])).toBe('周一至周六');
    expect(weekdayMaskText([2, 3])).toBe('周二、周三');
    expect(weekdayMaskText([])).toBe('未设置');
  });

  it('热力图色阶与文案', () => {
    expect(heatTone(null)).toContain('console-line');
    expect(heatTone(1)).toContain('console-gain');
    expect(heatTone(0)).toContain('console-loss');
    expect(rateText(null)).toBe('—');
    expect(rateText(0.666)).toBe('67%');
    expect(streakText(0)).toBe('还没开始');
    expect(streakText(4)).toBe('连续 4 天');
    expect(heatCellTitle('2026-11-14', 3, 2, false)).toBe('2026-11-14 · 2/3 完成');
    expect(heatCellTitle('2026-11-15', 0, 0, true)).toBe('2026-11-15 · 还没到');
  });

  it('阶段顺序固定为盘前/盘中/盘后', () => {
    expect(PHASE_ORDER).toEqual(['pre', 'during', 'post']);
    expect(parseDayKey('bad').getUTCFullYear()).toBe(1970);
  });
});
