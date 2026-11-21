import { describe, expect, it } from 'vitest';
import { MAX_STEP_COUNT, isValidPlanPercent, normalizeClosePercent } from './planStep';

describe('planStep', () => {
  it('档位上限与网关一致', () => {
    expect(MAX_STEP_COUNT).toBe(8);
  });

  it('模板比例保留 (0, 100) 区间', () => {
    expect(normalizeClosePercent(0.5)).toBe(0.5);
    expect(normalizeClosePercent(99.9)).toBe(99.9);
    expect(normalizeClosePercent(0)).toBeNull();
    expect(normalizeClosePercent(100)).toBeNull();
    expect(normalizeClosePercent(null)).toBeNull();
    expect(normalizeClosePercent('')).toBeNull();
  });

  it('手动分批只接受 1–99', () => {
    expect(isValidPlanPercent(1)).toBe(true);
    expect(isValidPlanPercent(99)).toBe(true);
    expect(isValidPlanPercent(0.5)).toBe(false);
    expect(isValidPlanPercent(0)).toBe(false);
    expect(isValidPlanPercent(100)).toBe(false);
    expect(isValidPlanPercent(null)).toBe(false);
  });
});
