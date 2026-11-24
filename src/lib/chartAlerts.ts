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

/**
 * 用选中画线的价位创建告警：单点（水平线等）取该点，多点取首尾中点。
 * 取不到有效价格时返回 null。
 */
export function drawingAlertPrice(
  points: Array<{ price: number }> | null | undefined,
): number | null {
  const valid = (points ?? []).filter((point) => Number.isFinite(point.price));
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0].price;
  return (valid[0].price + valid[valid.length - 1].price) / 2;
}

/**
 * 告警方向按当前买价判断：价格在现价下方是下穿，否则上穿。
 * 拖动告警线或右侧小块改价后方向要跟着换；拿不到报价时返回 null（保持原方向）。
 */
export function alertKindFor(
  price: number,
  bid: number | null | undefined,
): PriceAlert['kind'] | null {
  if (bid == null || !Number.isFinite(bid) || !(bid > 0)) return null;
  return price < bid ? 'below' : 'above';
}

/** 右侧小块文字：方向 + 价格 + 截断后的备注 */
export function alertChipText(alert: PriceAlert, digits: number): string {
  const kind = alert.kind === 'above' ? '上穿' : '下穿';
  const note = (alert.note ?? '').trim();
  const short = note.length > NOTE_MAX ? `${note.slice(0, NOTE_MAX)}…` : note;
  return `${kind} ${fmtPrice(alert.price, digits)}${short ? ` · ${short}` : ''}`;
}
