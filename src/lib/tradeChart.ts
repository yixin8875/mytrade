/** 交易日志 K 线图的纯几何：时间/价格 → SVG 坐标，全部可单测 */

export interface TradeChartBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface TradeChartFill {
  side: 'in' | 'out';
  time: number;
  price: number;
  volume?: number;
}

export interface TradeChartInput {
  bars: TradeChartBar[];
  entry: number;
  exit: number;
  sl?: number | null;
  tp?: number | null;
  openTime: number;
  closeTime: number;
  width: number;
  height: number;
  /** 逐笔成交；没有明细时退回 openTime/closeTime 的单点 */
  fills?: TradeChartFill[] | null;
  /** 服务器时钟与 UTC 的差（秒），时间轴标签按本地时间换算 */
  serverOffset?: number;
}

export interface ChartMarker {
  time: number;
  price: number;
  x: number;
  y: number;
  volume: number | null;
}

export interface ChartCandle {
  time: number;
  /** 实体中心 x */
  x: number;
  width: number;
  openY: number;
  closeY: number;
  highY: number;
  lowY: number;
  up: boolean;
}

export interface TradeChartLayout {
  plot: {
    left: number;
    top: number;
    width: number;
    height: number;
    right: number;
    bottom: number;
  };
  candles: ChartCandle[];
  priceTicks: { price: number; y: number; label: string }[];
  timeTicks: { time: number; x: number; label: string }[];
  entryX: number;
  entryY: number;
  exitX: number;
  exitY: number;
  /** 逐笔入场成交点；没有明细时是 openTime/entry 的单点 */
  entryPoints: ChartMarker[];
  /** 逐笔出场成交点；没有明细时是 closeTime/exit 的单点 */
  exitPoints: ChartMarker[];
  slY: number | null;
  tpY: number | null;
  holdX0: number;
  holdX1: number;
  priceMin: number;
  priceMax: number;
  empty: boolean;
}

/** 可选周期，auto 由持仓时长决定 */
export const CHART_RESOLUTIONS = [
  { value: 'auto', label: '自动' },
  { value: '1', label: '1 分' },
  { value: '5', label: '5 分' },
  { value: '15', label: '15 分' },
  { value: '60', label: '1 时' },
  { value: '240', label: '4 时' },
] as const;

const RESOLUTION_SECONDS: Record<string, number> = {
  '1': 60,
  '5': 300,
  '15': 900,
  '30': 1800,
  '60': 3600,
  '240': 14400,
  '1D': 86400,
  '1W': 604800,
  '1M': 2592000,
};

const PAD_LEFT = 10;
const PAD_TOP = 12;
const PAD_RIGHT = 84;
const PAD_BOTTOM = 24;

export function resolutionSeconds(resolution: string): number {
  return RESOLUTION_SECONDS[resolution] ?? 60;
}

/** 持仓时长决定自动周期：整段持仓大约落在 20–160 根 K 线里 */
export function chooseResolution(durationSec: number): string {
  const duration = Math.max(0, durationSec);
  if (duration <= 90 * 60) return '1';
  if (duration <= 8 * 3600) return '5';
  if (duration <= 2 * 86400) return '15';
  if (duration <= 7 * 86400) return '60';
  return '240';
}

/** 请求的行情窗口：持仓前后各留 25%，且至少留 20 根 K 线的余量 */
export function chartWindow(
  openTime: number,
  closeTime: number,
  resolution: string,
): { from: number; to: number; count: number } {
  const step = resolutionSeconds(resolution);
  const span = Math.max(step, closeTime - openTime);
  const pad = Math.max(step * 20, span * 0.25);
  const from = Math.floor((openTime - pad) / step) * step;
  const to = Math.ceil((closeTime + pad) / step) * step;
  return { from, to, count: Math.ceil((to - from) / step) + 2 };
}

/** 价格小数位：行情接口没给 digits 时的兜底 */
export function priceDigits(value: number): number {
  const abs = Math.abs(value);
  if (!Number.isFinite(abs) || abs === 0) return 5;
  if (abs >= 100) return 2;
  if (abs >= 10) return 3;
  if (abs >= 1) return 4;
  return 5;
}

/** 1/2/5 × 10^k 的顺眼刻度步长 */
export function niceStep(span: number, target: number): number {
  if (!Number.isFinite(span) || span <= 0) return 1;
  const raw = span / Math.max(1, target);
  const power = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / power;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return factor * power;
}

/** 价格轴刻度值，落在 [min, max] 内 */
export function priceTickValues(min: number, max: number, target = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];
  const step = niceStep(max - min, target);
  const first = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let value = first; value <= max + step * 1e-9 && out.length < 20; value += step) {
    // 消掉浮点累加误差，避免 1.2300000000000002 这类刻度
    out.push(Math.round(value / step) * step);
  }
  return out;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 时间轴标签：两天内只给时:分，一个月内带日期；bars 是服务器时钟，展示前换成本地时间 */
export function timeTickLabel(time: number, spanSec: number, serverOffset = 0): string {
  const offset = Number.isFinite(serverOffset) ? serverOffset : 0;
  const date = new Date((time - offset) * 1000);
  const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (spanSec <= 2 * 86400) return clock;
  const day = `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())}`;
  if (spanSec <= 31 * 86400) return `${day} ${clock}`;
  return day;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 价位标签避让：按 y 排序后保证最小间距，且整体不越出绘图区 */
export function spreadLabelY(values: number[], min: number, max: number, gap = 18): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ys = order.map((item) => Math.max(item.value, min));
  for (let index = 1; index < ys.length; index += 1) {
    ys[index] = Math.max(ys[index], ys[index - 1] + gap);
  }
  if (ys.length > 0 && ys[ys.length - 1] > max) {
    ys[ys.length - 1] = max;
    for (let index = ys.length - 2; index >= 0; index -= 1) {
      ys[index] = Math.min(ys[index], ys[index + 1] - gap);
    }
    if (ys[0] < min) {
      const shift = min - ys[0];
      for (let index = 0; index < ys.length; index += 1) ys[index] += shift;
    }
  }
  const out = values.slice();
  order.forEach((item, index) => {
    out[item.index] = ys[index];
  });
  return out;
}

function isPositive(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** 把 K 线、成交价和止损止盈压进同一套价格/时间坐标 */
export function buildTradeChart(input: TradeChartInput, digits?: number): TradeChartLayout {
  const width = Math.max(120, input.width);
  const height = Math.max(90, input.height);
  const plot = {
    left: PAD_LEFT,
    top: PAD_TOP,
    width: Math.max(20, width - PAD_LEFT - PAD_RIGHT),
    height: Math.max(20, height - PAD_TOP - PAD_BOTTOM),
    right: width - PAD_RIGHT,
    bottom: height - PAD_BOTTOM,
  };
  const precision = clamp(digits ?? priceDigits(input.entry), 0, 8);
  const bars = Array.isArray(input.bars) ? input.bars : [];
  const fills = (Array.isArray(input.fills) ? input.fills : []).filter(
    (fill) =>
      fill &&
      (fill.side === 'in' || fill.side === 'out') &&
      Number.isFinite(fill.time) &&
      Number.isFinite(fill.price),
  );

  // 价格范围：K 线的最高最低 + 加权成交价 + 每一笔实际成交价
  const prices: number[] = [input.entry, input.exit];
  if (isPositive(input.sl)) prices.push(input.sl);
  if (isPositive(input.tp)) prices.push(input.tp);
  for (const fill of fills) prices.push(fill.price);
  for (const bar of bars) {
    if (Number.isFinite(bar.high)) prices.push(bar.high);
    if (Number.isFinite(bar.low)) prices.push(bar.low);
  }
  let priceMin = Math.min(...prices);
  let priceMax = Math.max(...prices);
  const rawSpan = priceMax - priceMin;
  const span = rawSpan > 0 ? rawSpan : Math.max(Math.abs(priceMax) * 0.002, 1e-6);
  priceMin -= span * 0.06;
  priceMax += span * 0.06;
  const priceSpan = priceMax - priceMin;

  const yForPrice = (price: number) =>
    plot.top + ((priceMax - price) / priceSpan) * plot.height;

  // 时间范围：有 K 线就用 K 线首尾，否则退回持仓起止
  let timeMin = 0;
  let timeMax = 0;
  if (bars.length >= 2) {
    const first = bars[0].time;
    const last = bars[bars.length - 1].time;
    const step = Math.max(1, last - bars[bars.length - 2].time);
    timeMin = first;
    timeMax = last + step;
  } else if (bars.length === 1) {
    timeMin = bars[0].time - 60;
    timeMax = bars[0].time + 60;
  } else {
    timeMin = input.openTime;
    timeMax = input.closeTime > input.openTime ? input.closeTime : input.openTime + 60;
  }
  const timeSpan = Math.max(1, timeMax - timeMin);

  const xForTime = (time: number) =>
    plot.left + clamp((time - timeMin) / timeSpan, 0, 1) * plot.width;

  const slot = plot.width / Math.max(1, bars.length);
  const candleWidth = clamp(slot * 0.62, 1, 14);
  const candles: ChartCandle[] = bars.map((bar) => ({
    time: bar.time,
    x: xForTime(bar.time),
    width: candleWidth,
    openY: yForPrice(bar.open),
    closeY: yForPrice(bar.close),
    highY: yForPrice(bar.high),
    lowY: yForPrice(bar.low),
    up: bar.close >= bar.open,
  }));

  const holdX0 = xForTime(input.openTime);
  const holdX1 = xForTime(input.closeTime);

  const priceTicks = priceTickValues(priceMin, priceMax)
    .filter((price) => price >= priceMin && price <= priceMax)
    .map((price) => ({ price, y: yForPrice(price), label: price.toFixed(precision) }));

  const tickCount = clamp(Math.floor(plot.width / 150), 2, 6);
  const timeTicks: { time: number; x: number; label: string }[] = [];
  for (let index = 0; index < tickCount; index += 1) {
    const time = timeMin + (timeSpan * index) / Math.max(1, tickCount - 1);
    timeTicks.push({
      time,
      x: xForTime(time),
      label: timeTickLabel(time, timeSpan, input.serverOffset ?? 0),
    });
  }

  const marker = (time: number, price: number, volume: number | null): ChartMarker => ({
    time,
    price,
    x: xForTime(time),
    y: yForPrice(price),
    volume,
  });
  const volumeOf = (fill: TradeChartFill) =>
    Number.isFinite(fill.volume) ? Number(fill.volume) : null;
  const entryPoints = fills.some((fill) => fill.side === 'in')
    ? fills
        .filter((fill) => fill.side === 'in')
        .map((fill) => marker(fill.time, fill.price, volumeOf(fill)))
    : [marker(input.openTime, input.entry, null)];
  const exitPoints = fills.some((fill) => fill.side === 'out')
    ? fills
        .filter((fill) => fill.side === 'out')
        .map((fill) => marker(fill.time, fill.price, volumeOf(fill)))
    : [marker(input.closeTime, input.exit, null)];

  return {
    plot,
    candles,
    priceTicks,
    timeTicks,
    entryX: xForTime(input.openTime),
    entryY: yForPrice(input.entry),
    exitX: xForTime(input.closeTime),
    exitY: yForPrice(input.exit),
    entryPoints,
    exitPoints,
    slY: isPositive(input.sl) ? yForPrice(input.sl) : null,
    tpY: isPositive(input.tp) ? yForPrice(input.tp) : null,
    holdX0: Math.min(holdX0, holdX1),
    holdX1: Math.max(holdX0, holdX1),
    priceMin,
    priceMax,
    empty: bars.length === 0,
  };
}
