/**
 * 回放时间：网关的 K 线时间是「券商服务器时间」，前端一直把它当 UTC 处理，
 * 和图表的时区约定保持一致。这里所有格式化都走 UTC，避免本机时区偏移。
 */

const pad = (value: number) => String(value).padStart(2, '0');

export function fmtDate(ts: number): string {
  if (!ts) return '—';
  const date = new Date(ts * 1000);
  return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function fmtFullDate(ts: number): string {
  if (!ts) return '—';
  const date = new Date(ts * 1000);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function fmtTime(ts: number): string {
  if (!ts) return '—';
  const date = new Date(ts * 1000);
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

export function fmtShort(ts: number): string {
  if (!ts) return '—';
  return `${fmtDate(ts)} ${fmtTime(ts)}`;
}

export function fmtDateTime(ts: number): string {
  if (!ts) return '—';
  return `${fmtFullDate(ts)} ${fmtTime(ts)}`;
}

/** 2026-10-01T00:00（datetime-local 的值），按服务器时间理解 */
export function parseServerInput(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)) / 1000;
}

export function toInputValue(ts: number): string {
  if (!ts) return '';
  return `${fmtFullDate(ts)}T${fmtTime(ts)}`;
}

/** 当天 00:00 */
export function dayStart(ts: number): number {
  return Math.floor(ts / 86400) * 86400;
}

export function dayEnd(ts: number): number {
  return dayStart(ts) + 86400 - 60;
}

export function addDays(ts: number, days: number): number {
  return ts + days * 86400;
}

export function relativeTime(ts: number): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const date = new Date(ts);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`;
  const hours = seconds / 3600;
  return hours >= 10 ? `${Math.round(hours)} 小时` : `${hours.toFixed(1)} 小时`;
}
