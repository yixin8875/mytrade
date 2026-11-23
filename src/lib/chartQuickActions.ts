import { fmtPrice, fmtVolume } from './format';
import { classifyPending, type PendingType } from './pendingOrder';
import type { Quote, SymbolInfo } from '../gateway/types';

/**
 * 图表上的三个快捷动作。买 / 卖的「限价 / 停损」由点击价相对现价推导，
 * 与交易台里的挂单分类完全一致（见 lib/pendingOrder.ts）。
 */
export type ChartQuickAction = 'alert' | 'buy' | 'sell';

export interface QuickActionMeta {
  /** 菜单里的动作名，不含价格 */
  label: string;
  /** 展示用快捷键 */
  hint: string;
}

export const QUICK_ACTION_META: Record<ChartQuickAction, QuickActionMeta> = {
  alert: { label: '添加价格警报', hint: 'Alt+A' },
  buy: { label: '买入', hint: 'Alt+Shift+B' },
  sell: { label: '卖出', hint: 'Alt+Shift+S' },
};

export interface QuickActionItem extends QuickActionMeta {
  action: ChartQuickAction;
  /** 完整菜单文案，例如「买入 0.01 USTEC @ 25,880.03 限价」 */
  text: string;
  price: number;
  type?: PendingType | null;
  warning?: string | null;
  /** 价格落在点差内等无法挂单的情况 */
  disabled?: boolean;
}

export interface QuickActionContext {
  price: number;
  symbol: string;
  volume: number;
  digits: number;
  step: number;
  quote: Quote | null;
  info?: SymbolInfo;
}

/** 三个动作的完整描述，覆盖层菜单与右键菜单共用 */
export function buildQuickActionItems({
  price,
  symbol,
  volume,
  digits,
  step,
  quote,
  info,
}: QuickActionContext): QuickActionItem[] {
  const priceText = fmtPrice(price, digits);
  const volumeText = fmtVolume(volume, step);
  const items: QuickActionItem[] = [
    {
      action: 'alert',
      label: QUICK_ACTION_META.alert.label,
      hint: QUICK_ACTION_META.alert.hint,
      text: `以 ${priceText} 在 ${symbol} 添加警报`,
      price,
      disabled: !(price > 0),
    },
  ];

  for (const action of ['buy', 'sell'] as const) {
    const meta = QUICK_ACTION_META[action];
    const pending = classifyPending({
      side: action,
      price,
      bid: quote?.bid,
      ask: quote?.ask,
      stopsLevelPoints: info?.stopsLevelPoints,
      point: info?.point,
    });
    const typeText = pending.type ? (pending.type === 'limit' ? '限价' : '停损') : '挂单';
    items.push({
      action,
      label: `${meta.label}${typeText}`,
      hint: meta.hint,
      text: `${meta.label} ${volumeText} ${symbol} @ ${priceText} ${typeText}`,
      price,
      type: pending.type,
      warning: pending.warning,
      disabled: pending.type == null,
    });
  }
  return items;
}

/** 快捷键没有十字线价格时的兜底价：买用卖价、卖用买价 */
export function fallbackQuickPrice(
  action: ChartQuickAction,
  quote: Quote | null,
): number | null {
  if (!quote) return null;
  if (action === 'buy') return quote.ask;
  return quote.bid;
}
