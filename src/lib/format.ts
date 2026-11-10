export function fmtPrice(value: number | null | undefined, digits = 5): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

export function fmtMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function fmtSigned(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

export function volumeDecimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 2;
  if (step >= 1) return 0;
  if (step >= 0.1) return 1;
  if (step >= 0.01) return 2;
  return 3;
}

export function fmtVolume(value: number | null | undefined, step = 0.01): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toFixed(volumeDecimals(step));
}

export function roundVolume(value: number, step: number, min: number, max: number): number {
  if (!Number.isFinite(value) || step <= 0) return value;
  const steps = Math.floor(value / step + 1e-9);
  const rounded = Number((steps * step).toFixed(volumeDecimals(step)));
  return Math.min(max, Math.max(min, rounded));
}

export function fmtClock(ts: number | null | undefined): string {
  if (!ts) return '—';
  const date = new Date(ts * 1000);
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

export function spreadPoints(bid: number, ask: number, point: number): number {
  if (!point) return 0;
  return (ask - bid) / point;
}

/**
 * 吸附到整数点位：FX（5 位报价）取 10 个点，黄金（2 位）取 0.1，
 * 日元（3 位）取 0.01。拖动时按住 Shift 调用。
 */
export function snapToLevel(value: number, digits: number, point: number): number {
  if (!Number.isFinite(value) || !point) return value;
  const step = point * (digits >= 4 ? 100 : 10);
  return Number((Math.round(value / step) * step).toFixed(digits));
}

export function signedClass(value: number | null | undefined): string {
  if (value == null || value === 0) return 'text-tv-muted';
  return value > 0 ? 'text-tv-up' : 'text-tv-down';
}
