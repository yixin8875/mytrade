/** 错过机会页的纯函数：状态文案、配色、本地时间输入框互转。 */

import type { MissedList, MissedStatus } from '../gateway/types';

export const MISSED_STATUS_LABELS: Record<MissedStatus, string> = {
  tp: '到目标',
  sl: '止损',
  timeout: '超时未了结',
  open: '还没走完',
  no_entry: '没触发',
  no_data: '没有 M1 数据',
  invalid: '计划无效',
};

/** MT5 的 M1 时间按服务器时区存；数据库里的 observedAt 也用同一口径 */
export function toServerEpoch(utcSeconds: number, serverOffset: number): number {
  return Math.round(utcSeconds + (Number.isFinite(serverOffset) ? serverOffset : 0));
}

export function toUtcEpoch(serverSeconds: number, serverOffset: number): number {
  return Math.round(serverSeconds - (Number.isFinite(serverOffset) ? serverOffset : 0));
}

export function missedStatusTone(status: MissedStatus): string {
  switch (status) {
    case 'tp':
      return 'border-console-gain/30 bg-console-gain/10 text-console-gain';
    case 'sl':
      return 'border-console-loss/30 bg-console-loss-soft text-console-loss';
    case 'timeout':
      return 'border-console-warn/30 bg-console-warn/10 text-console-warn';
    case 'open':
      return 'border-console-accent/30 bg-console-accent/10 text-console-accent';
    case 'invalid':
      return 'border-console-warn/40 bg-console-warn/10 text-console-warn';
    default:
      return 'border-console-line bg-console-line/20 text-console-muted';
  }
}

/** 结束时是否已经有了确定的 R */
export function isSettled(status: MissedStatus): boolean {
  return status === 'tp' || status === 'sl' || status === 'timeout';
}

/** 有入场、但没有走到目标/止损的结果，可以展示 MFE/MAE */
export function hasEntry(status: MissedStatus): boolean {
  return isSettled(status) || status === 'open';
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** epoch 秒 → datetime-local 的本地时间字符串 */
export function toLocalInput(ts: number): string {
  const date = new Date(ts * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** datetime-local 字符串 → epoch 秒；空值或坏值返回 0 */
export function fromLocalInput(value: string): number {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? Math.floor(time / 1000) : 0;
}

/** 11/14 10:00 */
export function fmtMissedTime(ts: number): string {
  const date = new Date(ts * 1000);
  if (Number.isNaN(date.getTime())) return '—';
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

export function summaryLine(summary: MissedList['summary']): string {
  const parts = [`共 ${summary.total} 笔`];
  if (summary.simulated > 0) parts.push(`到目标 ${summary.hits} / 止损 ${summary.stops}`);
  if (summary.totalR != null) {
    parts.push(`理论 ${summary.totalR >= 0 ? '+' : ''}${summary.totalR.toFixed(1)}R`);
  }
  return parts.join(' · ');
}

/** 负数 R 用亏损色，正数用盈利色 */
export function rTone(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'text-console-faint';
  if (value > 0) return 'text-console-gain';
  if (value < 0) return 'text-console-loss';
  return 'text-console-muted';
}
