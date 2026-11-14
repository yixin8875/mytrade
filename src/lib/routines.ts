/** 例行清单的纯函数：日期前后翻、星期掩码文案、热力图色阶。 */

import { WEEKDAYS } from './review';

export type RoutinePhase = 'pre' | 'during' | 'post';

export const PHASE_ORDER: RoutinePhase[] = ['pre', 'during', 'post'];

export const PHASE_LABELS: Record<RoutinePhase, string> = {
  pre: '盘前',
  during: '盘中',
  post: '盘后',
};

export const PHASE_HINTS: Record<RoutinePhase, string> = {
  pre: '开盘前过一遍',
  during: '盘中只做清单里的事',
  post: '收盘后复盘与准备',
};

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "2026-11-14" → UTC 午夜的 Date，避免本地时区把日期挪一天 */
export function parseDayKey(key: string): Date {
  const match = DAY_RE.exec(key);
  if (!match) return new Date(Date.UTC(1970, 0, 1));
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** 前后翻 n 天，跨月跨年自动进位 */
export function shiftDay(key: string, delta: number): string {
  const date = parseDayKey(key);
  date.setUTCDate(date.getUTCDate() + delta);
  return dayKey(date);
}

/** 周一 = 1 … 周日 = 7 */
export function weekdayOf(key: string): number {
  return parseDayKey(key).getUTCDay() || 7;
}

/** 本机的今天，作为日期导航的兜底锚点 */
export function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

export function dateLabel(key: string, today: string): string {
  if (key === today) return '今天';
  if (key === shiftDay(today, -1)) return '昨天';
  if (key === shiftDay(today, 1)) return '明天';
  const date = parseDayKey(key);
  return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日 周${WEEKDAYS[weekdayOf(key) - 1]}`;
}

/** [1,2,3,4,5] → 工作日；[1..7] → 每天；连续的压缩成「周一至周六」 */
export function weekdayMaskText(days: number[]): string {
  const sorted = [...days].filter((day) => day >= 1 && day <= 7).sort((a, b) => a - b);
  if (sorted.length === 7) return '每天';
  if (sorted.join(',') === '1,2,3,4,5') return '工作日';
  if (sorted.join(',') === '6,7') return '周末';
  if (sorted.length === 0) return '未设置';

  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  const flush = () => {
    if (prev - start >= 2) parts.push(`周${WEEKDAYS[start - 1]}至周${WEEKDAYS[prev - 1]}`);
    else if (prev === start) parts.push(`周${WEEKDAYS[start - 1]}`);
    else parts.push(`周${WEEKDAYS[start - 1]}、周${WEEKDAYS[prev - 1]}`);
  };
  for (let index = 1; index < sorted.length; index += 1) {
    const day = sorted[index];
    if (day === prev + 1) {
      prev = day;
      continue;
    }
    flush();
    start = day;
    prev = day;
  }
  flush();
  return parts.join('、');
}

/** 热力图色阶：没有应做项时留空，全做完用盈利色 */
export function heatTone(rate: number | null): string {
  if (rate == null) return 'bg-console-line/25';
  if (rate >= 1) return 'bg-console-gain/40';
  if (rate >= 0.75) return 'bg-console-gain/20';
  if (rate >= 0.5) return 'bg-console-warn/35';
  if (rate > 0) return 'bg-console-warn/20';
  return 'bg-console-loss/30';
}

export function rateText(rate: number | null): string {
  return rate == null ? '—' : `${Math.round(rate * 100)}%`;
}

/** 连续达标天数：0 天时给一句状态，而不是显示「0 天」 */
export function streakText(streak: number): string {
  if (streak <= 0) return '还没开始';
  return `连续 ${streak} 天`;
}

export function heatCellTitle(
  date: string,
  due: number,
  done: number,
  future: boolean,
): string {
  if (future) return `${date} · 还没到`;
  if (due === 0) return `${date} · 无需执行`;
  return `${date} · ${done}/${due} 完成`;
}
