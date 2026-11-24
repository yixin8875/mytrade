import type { PriceAlert } from '../gateway/types';
import { fmtPrice } from './format';

/** 告警线 / 标签的颜色：和买绿、卖红、入场蓝、强平橙都区分开的琥珀色 */
export const ALERT_COLOR = '#b45309';

/** 图上备注最多显示的字符数，太长会把右侧小块撑出图表 */
const NOTE_MAX = 14;

/** 图上只标注当前品种、启用中的告警；停用的告警不进图 */
export function alertsOnChart(
  alerts: PriceAlert[],
  symbol: string | null | undefined,
): PriceAlert[] {
  if (!symbol) return [];
  return alerts.filter((alert) => alert.enabled && alert.symbol === symbol);
}

/** 右侧小块文字：方向 + 价格 + 截断后的备注 */
export function alertChipText(alert: PriceAlert, digits: number): string {
  const kind = alert.kind === 'above' ? '上穿' : '下穿';
  const note = (alert.note ?? '').trim();
  const short = note.length > NOTE_MAX ? `${note.slice(0, NOTE_MAX)}…` : note;
  return `${kind} ${fmtPrice(alert.price, digits)}${short ? ` · ${short}` : ''}`;
}
