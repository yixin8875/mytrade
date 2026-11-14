/** 复盘页共用的纯函数：月份翻页、服务器时间换算、展示文案。 */

export const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

const MONTH_RE = /^(\d{4})-(\d{2})$/;

function parseMonth(month: string): { year: number; month: number } | null {
  const match = MONTH_RE.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const index = Number(match[2]);
  if (index < 1 || index > 12) return null;
  return { year, month: index };
}

/** "2026-11" 前后翻 n 个月，跨年自动进位；坏输入回退到本月 */
export function shiftMonth(month: string, delta: number): string {
  const parsed = parseMonth(month) ?? parseMonth(currentMonth())!;
  const zeroBased = parsed.month - 1 + delta;
  const year = parsed.year + Math.floor(zeroBased / 12);
  const index = ((zeroBased % 12) + 12) % 12;
  return `${year}-${String(index + 1).padStart(2, '0')}`;
}

/** 本机时区下的 YYYY-MM */
export function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function monthLabel(month: string): string {
  const parsed = parseMonth(month);
  return parsed ? `${parsed.year} 年 ${parsed.month} 月` : month;
}

/** MT5 存的是服务器时间，减去 serverOffset 得到真正的 UTC 秒 */
export function toUtcSeconds(raw: number, serverOffset: number): number {
  if (!Number.isFinite(raw)) return 0;
  return raw - (Number.isFinite(serverOffset) ? serverOffset : 0);
}

/** 复盘页展示成交时间：换算成 UTC 后按本机时区显示 */
export function fmtReviewTime(raw: number, serverOffset: number, withDate = false): string {
  if (!raw) return '—';
  const date = new Date(toUtcSeconds(raw, serverOffset) * 1000);
  const time = date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  if (!withDate) return time;
  return `${date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} ${time}`;
}

/** 2026-11-03 → 11/03 */
export function shortDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return match ? `${match[2]}/${match[3]}` : day;
}

export function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(0)}%`;
}

/** R 值统一带符号、两位小数；没有风险数据时显示 — */
export function fmtR(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}R`;
}

export type DayTone = 'win' | 'loss' | 'flat';

export function dayTone(net: number): DayTone {
  if (!Number.isFinite(net) || Math.abs(net) < 0.005) return 'flat';
  return net > 0 ? 'win' : 'loss';
}

/** 样本太小时不给结论，只给描述 */
export function sampleHint(trades: number): string | null {
  if (trades <= 0) return null;
  if (trades < 5) return '样本不足 5 笔，先别据此调整策略';
  if (trades < 20) return '样本偏少，结论仅供参考';
  return null;
}

/** 日历格子里只放得下很短的数字 */
export function compactMoney(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 10000) return `${value < 0 ? '-' : '+'}${(abs / 1000).toFixed(1)}k`;
  return `${value > 0 ? '+' : ''}${Math.round(value)}`;
}
