import type { OrderType, Quote, Side, SymbolInfo } from '../gateway/types';

/** 把价格对齐到最小变动价位；缺失品种信息或 tick 为 0 时按品种小数位取整 */
export function roundToTick(value: number, info?: SymbolInfo): number {
  if (!info) return value;
  const tick = info.tickSize || info.point || 0;
  if (!tick) return Number(value.toFixed(info.digits));
  return Number((Math.round(value / tick) * tick).toFixed(info.digits));
}

/**
 * 新建草稿时的默认委托价：
 * 限价贴对手价，停损离现价 10 个 tick，市价用当前可成交价。
 */
export function defaultPrice(
  side: Side,
  type: OrderType,
  quote: Quote | null,
  info?: SymbolInfo,
): number {
  if (!quote || !info) return 0;
  const tick = info.tickSize || info.point || 0;
  if (type === 'limit') return side === 'buy' ? quote.bid : quote.ask;
  if (type === 'stop') {
    const raw = side === 'buy' ? quote.ask + tick * 10 : quote.bid - tick * 10;
    return roundToTick(raw, info);
  }
  return side === 'buy' ? quote.ask : quote.bid;
}
