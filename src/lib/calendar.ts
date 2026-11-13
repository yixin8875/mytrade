import { gateway } from '../gateway/client';
import type { CalendarWeek } from '../gateway/types';

const CACHE_MS = 5 * 60 * 1000;

let cached: { at: number; data: CalendarWeek } | null = null;

/** 本周财经事件；网关自己有 6 小时磁盘缓存，这里再挡一层页面内频繁调用。 */
export async function loadCalendar(force = false): Promise<CalendarWeek> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.data;
  const data = await gateway.call<CalendarWeek>('calendar.week', {}, 10_000);
  cached = { at: Date.now(), data };
  return data;
}

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF', 'CNY'];

/** 品种关联的货币：EURUSD → EUR/USD，XAUUSD → USD，NAS100 → USD。 */
export function currenciesForSymbol(symbol: string): string[] {
  const text = symbol.toUpperCase();
  const found = CURRENCIES.filter((code) => text.includes(code));
  return found.length > 0 ? found : ['USD'];
}

export const IMPACT_LABEL: Record<string, string> = {
  High: '高',
  Medium: '中',
  Low: '低',
  Holiday: '休市',
};

export function impactRank(impact: string): number {
  if (impact === 'High') return 0;
  if (impact === 'Medium') return 1;
  if (impact === 'Low') return 2;
  return 3;
}
