import { describe, expect, it } from 'vitest';
import {
  MISSED_STATUS_LABELS,
  fmtMissedTime,
  fromLocalInput,
  hasEntry,
  isSettled,
  missedStatusTone,
  rTone,
  summaryLine,
  toLocalInput,
  toServerEpoch,
  toUtcEpoch,
} from './missed';

describe('missed helpers', () => {
  it('本地时间输入框往返', () => {
    const ts = 1793701800; // 整分钟，往返不丢秒
    expect(fromLocalInput(toLocalInput(ts))).toBe(ts);
    expect(fromLocalInput('')).toBe(0);
    expect(fromLocalInput('not-a-date')).toBe(0);
  });

  it('状态文案与配色齐全', () => {
    const statuses = [
      'tp',
      'sl',
      'timeout',
      'open',
      'no_entry',
      'no_data',
      'invalid',
    ] as const;
    for (const status of statuses) {
      expect(MISSED_STATUS_LABELS[status]).toBeTruthy();
      expect(missedStatusTone(status)).toContain('console-');
    }
    expect(isSettled('tp')).toBe(true);
    expect(isSettled('sl')).toBe(true);
    expect(isSettled('timeout')).toBe(true);
    expect(isSettled('open')).toBe(false);
    expect(isSettled('no_entry')).toBe(false);
    expect(hasEntry('open')).toBe(true);
    expect(hasEntry('invalid')).toBe(false);
  });

  it('服务器时间口径可以来回换', () => {
    const utc = 1794614340;
    expect(toUtcEpoch(toServerEpoch(utc, -43200), -43200)).toBe(utc);
    expect(toServerEpoch(utc, -43200)).toBe(utc - 43200);
    expect(toServerEpoch(utc, Number.NaN)).toBe(utc);
  });

  it('汇总文案', () => {
    expect(summaryLine({ total: 0, simulated: 0, hits: 0, stops: 0, totalR: null })).toBe(
      '共 0 笔',
    );
    expect(summaryLine({ total: 3, simulated: 2, hits: 1, stops: 1, totalR: 2 })).toBe(
      '共 3 笔 · 到目标 1 / 止损 1 · 理论 +2.0R',
    );
  });

  it('R 的颜色与时间格式', () => {
    expect(rTone(1)).toContain('gain');
    expect(rTone(-1)).toContain('loss');
    expect(rTone(null)).toContain('faint');
    expect(fmtMissedTime(0)).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
  });
});
