import type { Bar, SymbolInfo } from '../gateway/types';

/**
 * 网关离线或该品种没有历史时的合成 M1。
 * 只用于界面演示与本地调试，会话会标记 dataSource = 'demo'，界面上明确写出「演示数据」。
 */

function seedFrom(symbol: string): number {
  let seed = 2166136261;
  for (let i = 0; i < symbol.length; i += 1) {
    seed ^= symbol.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  return seed >>> 0;
}

function basePrice(symbol: string): number {
  const text = symbol.toUpperCase();
  if (text.includes('XAU')) return 3980;
  if (text.includes('XAG')) return 48.2;
  if (text.includes('EUR')) return 1.086;
  if (text.includes('GBP')) return 1.272;
  if (text.includes('JPY')) return 152.4;
  if (text.includes('BTC')) return 96500;
  if (text.includes('US500') || text.includes('SPX')) return 5780;
  if (text.includes('NAS')) return 20300;
  return 100;
}

function isTradable(ts: number): boolean {
  const date = new Date(ts * 1000);
  const day = date.getUTCDay();
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  if (day === 6) return false;
  if (day === 0 && minutes < 21 * 60) return false;
  if (day === 5 && minutes >= 21 * 60) return false;
  return true;
}

export function generateDemoBars(
  symbol: string,
  info: SymbolInfo,
  fromTs: number,
  toTs: number,
): Bar[] {
  let seed = seedFrom(symbol);
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const step = 60;
  const first = Math.ceil(fromTs / step) * step;
  const last = Math.floor(toTs / step) * step;
  const tick = info.tickSize || info.point || 0.01;
  const digits = info.digits || 2;
  const round = (value: number) => Number((Math.round(value / tick) * tick).toFixed(digits));
  const base = basePrice(symbol);
  const volatility = base * (tick > 0.001 ? 0.00035 : 0.00012);

  const bars: Bar[] = [];
  let price = base;
  let drift = 0;
  for (let ts = first; ts <= last; ts += step) {
    if (!isTradable(ts)) continue;
    // 每 4 小时换一次缓慢趋势，让回放里有像样的波段
    if ((ts / step) % 240 === 0) drift = (random() - 0.5) * volatility * 0.18;
    const open = price;
    const move = drift + (random() - 0.5) * volatility * 2;
    const close = round(open + move);
    const wick = volatility * (0.2 + random() * 0.9);
    const high = round(Math.max(open, close) + wick);
    const low = round(Math.min(open, close) - wick);
    bars.push({
      time: ts,
      open: round(open),
      high,
      low,
      close,
      volume: Math.round(40 + random() * 260),
    });
    price = close;
  }
  return bars;
}
