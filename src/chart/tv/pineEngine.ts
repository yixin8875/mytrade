import type { Bar } from '../../gateway/types';
import type { PineInputMeta } from '../../lib/pineScripts';

/**
 * Pine 运行时适配层：统一走 Piner。
 *
 * 输出统一成「按 bar 索引对齐的数值序列」，供 pineRunner 写成
 * PineSeriesResult。绘图对象/marker 的渲染是下一步（PineDrawingLayer），
 * 这里把引擎调用和 request.security 数据注入收在一处。
 */

export type PineEngineName = 'piner';

export interface PineSeriesOutput {
  key: string;
  title: string;
  kind: 'plot' | 'hline';
  /** 与输入 bars 等长；缺失/无效值为 NaN */
  values: number[];
  color?: string;
  /** 逐 bar 颜色（Piner 的 #RRGGBBAA，null 表示沿用默认色） */
  colors?: (string | null)[];
  /** Pine 的 plot style（line/stepline/histogram/...） */
  style?: string;
  /** Pine 的 linewidth= */
  width?: number;
}

export interface PineRunOptions {
  source: string;
  bars: Bar[];
  symbol: string;
  /** 图表周期，如 "5" / "60" / "1D" */
  resolution: string;
  /** 图表库输入值，按 Pine input 的 id 索引 */
  inputs?: Record<string, unknown>;
  /** 品种最小跳动；不传时 Piner 用 0.01，会影响 syminfo.mintick 相关的过滤 */
  mintick?: number;
  /**
   * 券商服务器时间与真 UTC 的差（秒）。图表 bar 时间是「服务器时间当 UTC」，
   * 而 Pine 的 time()/session/dayofweek 都按真 UTC 解释；喂引擎前要减掉它，
   * 绘图对象的时间再加回来，否则带时区的 session 会整体偏移。
   */
  serverOffset?: number;
  /** 保存时记录的输入元信息；用来把 id 映射成 Piner 需要的 title */
  inputMeta?: PineInputMeta[];
  /** 取 HTF/外部品种数据；不传则跳过 request.security 注入 */
  fetchBars?: (symbol: string, resolution: string) => Promise<Bar[]>;
  /** 一次最多注入多少个 security 依赖，防止脚本申请太多品种 */
  maxSecurityFetches?: number;
}

export interface PineVisualPoint {
  /** bar 开盘时间（秒，图表坐标系） */
  time: number;
  price: number;
}

export interface PineMarkerVisual {
  id: string;
  /** shape.triangleup / plotchar 的字符等 */
  glyph: string;
  /**
   * plotshape | plotchar | plotarrow。
   * plotchar 的 text 是悬停提示、显示的字符在 glyph 里；plotshape 的 text 才是要显示的文字。
   */
  kind?: string;
  /** abovebar | belowbar | top | bottom | absolute */
  location: string;
  points: (PineVisualPoint & { color?: string; text?: string })[];
}

export type PineDrawingVisual =
  | {
      id: string;
      kind: 'label';
      time: number;
      price: number;
      text: string;
      color?: string;
      textColor?: string;
      style?: string;
      /** tiny | small | normal | large | huge */
      size?: string;
    }
  | {
      id: string;
      kind: 'line';
      points: [PineVisualPoint, PineVisualPoint];
      color?: string;
      width?: number;
      /** solid | dotted | dashed */
      style?: string;
      /** none | left | right | both */
      extend?: string;
    }
  | {
      id: string;
      kind: 'box';
      top: PineVisualPoint;
      bottom: PineVisualPoint;
      borderColor?: string;
      bgColor?: string;
      borderWidth?: number;
      /** solid | dotted | dashed */
      borderStyle?: string;
    }
  | {
      id: string;
      kind: 'polyline';
      points: PineVisualPoint[];
      color?: string;
      width?: number;
    }
  | {
      id: string;
      kind: 'table';
      position: string;
      rows: number;
      columns: number;
      borderWidth: number;
      cells: {
        row: number;
        column: number;
        text: string;
        textColor?: string;
        bgColor?: string;
      }[];
    };

export interface PineBackgroundVisual {
  from: number;
  to: number;
  color: string;
}

export interface PineCandleBar {
  time: number;
  /** 下一根 bar 的时间；画箱体宽度用 */
  to: number;
  open: number;
  high: number;
  low: number;
  close: number;
  color?: string;
  wickColor?: string;
  borderColor?: string;
}

export interface PineCandleVisual {
  id: string;
  bars: PineCandleBar[];
}

export interface PineFillBar {
  time: number;
  /** 下一根 bar 的时间；画填充带宽用 */
  to: number;
  top: number;
  bottom: number;
  color?: string;
}

export interface PineFillVisual {
  id: string;
  bars: PineFillBar[];
}

export interface PineVisuals {
  markers: PineMarkerVisual[];
  drawings: PineDrawingVisual[];
  backgrounds: PineBackgroundVisual[];
  candles: PineCandleVisual[];
  fills: PineFillVisual[];
  /** 引擎产出了、但渲染桥暂时还画不了的图层 */
  unsupported: string[];
}

export interface PineRunOutput {
  series: PineSeriesOutput[];
  visuals: PineVisuals;
  warnings: string[];
  engine: PineEngineName;
  durationMs: number;
}

interface PinerBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface SecurityRequestLike {
  symbol: string;
  timeframe: string;
  lowerTf: boolean;
}

const DEFAULT_MAX_SECURITY_FETCHES = 8;

function errorText(error: unknown): string {
  return (error as Error)?.message || String(error);
}

function normalizeResolution(resolution: string): string {
  const raw = String(resolution || '').trim();
  if (!raw || raw.toLowerCase() === 'chart') return '';
  const upper = raw.toUpperCase();
  if (upper === 'D' || upper === '1D') return '1D';
  if (upper === 'W' || upper === '1W') return '1W';
  if (upper === 'M' || upper === '1M') return '1M';
  return upper;
}

function normalizeSymbol(symbol: string): string {
  // TV 脚本可能写 BINANCE:BTCUSDT；MT5 网关通常只认后半段。
  const raw = String(symbol || '').trim();
  const tail = raw.includes(':') ? raw.slice(raw.lastIndexOf(':') + 1) : raw;
  return tail.trim().toUpperCase();
}

function normalizeColor(color: string | null | undefined): string | undefined {
  if (!color) return undefined;
  // Charting Library 不接受 #RRGGBBAA；Piner 的颜色带 alpha。
  if (/^#[0-9a-fA-F]{8}$/.test(color)) return color.slice(0, 7);
  return color;
}

function firstColor(colors: (string | null)[] | undefined): string | undefined {
  if (!colors) return undefined;
  for (const color of colors) {
    const normalized = normalizeColor(color);
    if (normalized) return normalized;
  }
  return undefined;
}

function toPinerBars(bars: Bar[], serverOffsetSec = 0): PinerBar[] {
  return bars
    .filter((bar) => Number.isFinite(bar.time))
    .map((bar) => ({
      // Piner 的时间轴是 epoch milliseconds；项目 Bar.time 是秒。
      // 图表 bar 是服务器时间，先换成真 UTC 再给 Pine。
      time: Math.round((bar.time - serverOffsetSec) * 1000),
      open: Number(bar.open),
      high: Number(bar.high),
      low: Number(bar.low),
      close: Number(bar.close),
      volume: Number(bar.volume) || 0,
    }));
}

function padValues(values: number[] | undefined, length: number): number[] {
  const out = new Array<number>(length).fill(Number.NaN);
  if (!values) return out;
  const count = Math.min(length, values.length);
  for (let index = 0; index < count; index += 1) {
    const value = values[index];
    if (typeof value === 'number' && Number.isFinite(value)) out[index] = value;
  }
  return out;
}

function coerceInput(meta: PineInputMeta, value: unknown): unknown {
  switch (meta.type) {
    case 'int':
    case 'float': {
      const number = Number(value);
      return Number.isFinite(number) ? number : meta.defval;
    }
    case 'bool':
      return Boolean(value);
    case 'source':
      return String(value ?? 'close');
    case 'color':
      return String(value ?? '#2962FF');
    default:
      return String(value ?? meta.defval ?? '');
  }
}

/**
 * 图表库输入 id -> Piner 的 input key。
 *
 * Piner 的 Engine 按 metadata.key 读取覆盖值，而 key 在重名时带 `" (2)"` 后缀
 * （多个 inline 输入常把 title 留空或写成“名称/时间/颜色”）。若按 title 映射，
 * 同名输入会全部落到同一个 title 上、互相覆盖，脚本就会用错输入值。
 */
function pinerInputs(
  meta: PineInputMeta[] | undefined,
  inputs: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const values = inputs ?? {};
  if (!meta?.length) return { ...values };
  const out: Record<string, unknown> = {};
  for (const item of meta) {
    if (!(item.id in values)) continue;
    out[item.id] = coerceInput(item, values[item.id]);
  }
  return out;
}

function dedupeSecurityRequests(
  requests: readonly SecurityRequestLike[] | undefined,
): SecurityRequestLike[] {
  const seen = new Set<string>();
  const out: SecurityRequestLike[] = [];
  for (const request of requests ?? []) {
    if (!request || !request.symbol || !request.timeframe) continue;
    const key = `${request.symbol}|${request.timeframe}|${request.lowerTf}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(request);
  }
  return out;
}

async function fetchSecurityBars(
  requests: SecurityRequestLike[],
  options: PineRunOptions,
  warnings: string[],
): Promise<Map<string, PinerBar[]>> {
  const injected = new Map<string, PinerBar[]>();
  if (requests.length === 0) return injected;
  if (!options.fetchBars) {
    warnings.push('没有数据源，跳过 request.security 注入');
    return injected;
  }

  const currentSymbol = options.symbol.trim().toUpperCase();
  const max = options.maxSecurityFetches ?? DEFAULT_MAX_SECURITY_FETCHES;
  let fetched = 0;

  for (const request of requests) {
    if (request.lowerTf) {
      warnings.push(
        `request.security_lower_tf(${request.symbol}, ${request.timeframe}) 暂不注入，结果为 na/空`,
      );
      continue;
    }
    if (fetched >= max) {
      warnings.push(`request.security 依赖超过 ${max} 个，已跳过其余请求`);
      break;
    }

    const requestedSymbol = request.symbol.trim();
    const fetchSymbol = normalizeSymbol(requestedSymbol);
    const timeframe = normalizeResolution(request.timeframe || options.resolution);
    if (!fetchSymbol || !timeframe) {
      warnings.push(`无法解析 request.security(${request.symbol}, ${request.timeframe})`);
      continue;
    }

    try {
      const bars = await options.fetchBars(fetchSymbol, timeframe);
      if (bars.length === 0) {
        warnings.push(`request.security 没有取到 ${fetchSymbol} ${timeframe} 的 K 线`);
        continue;
      }
      // Piner 的键：同品种用 SYMBOL@TF；跨品种用原始 symbol。
      const key =
        requestedSymbol.toUpperCase() === currentSymbol
          ? `${requestedSymbol}@${timeframe}`
          : requestedSymbol;
      // 外部周期的 K 线也是服务器时间，和主图一样换成真 UTC，
      // 否则 request.security 里的 session/hour 同样会偏。
      injected.set(key, toPinerBars(bars, Number(options.serverOffset) || 0));
      fetched += 1;
    } catch (error) {
      warnings.push(
        `request.security(${fetchSymbol}, ${timeframe}) 取数失败：${errorText(error)}`,
      );
    }
  }

  return injected;
}

function emptyVisuals(): PineVisuals {
  return {
    markers: [],
    drawings: [],
    backgrounds: [],
    candles: [],
    fills: [],
    unsupported: [],
  };
}

function barStepSeconds(bars: Bar[]): number {
  if (bars.length < 2) return 60;
  const step = bars[bars.length - 1].time - bars[bars.length - 2].time;
  return Number.isFinite(step) && step > 0 ? step : 60;
}

/** 绘图对象保留 alpha：渲染层要靠它算 transparency。 */
function asColor(value: unknown): string | undefined {
  const text = asText(value);
  if (!text) return undefined;
  return /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(text) ? text : undefined;
}

function asNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Pine 的 x 坐标默认是 bar_index；用 xloc.bar_time 创建的对象存的是毫秒时间戳。
 * 超出最后一根 K 线的 bar_index 是脚本有意向未来投影（例如「关键价位」把标签
 * 放在最新一根右边），按最后一根的时间步长外推；只丢弃负下标。
 */
function barTimeAt(
  bars: Bar[],
  value: unknown,
  xloc?: unknown,
  serverOffsetSec = 0,
): number | undefined {
  const number = asNumber(value);
  if (number == null) return undefined;
  if (xloc === 'bar_time') {
    // Pine 看到的 bar_time 是真 UTC；图表坐标要换回服务器时间。
    const seconds = number > 1e11 ? Math.round(number / 1000) : Math.round(number);
    return seconds + serverOffsetSec;
  }
  const index = Math.round(number);
  if (index < 0 || bars.length === 0) return undefined;
  if (index < bars.length) return bars[index].time;
  const last = bars[bars.length - 1].time;
  return last + (index - (bars.length - 1)) * barStepSeconds(bars);
}

/** plotshape 的 y 位置：引擎只给 location，价格要按 K 线补。 */
function markerPrice(location: string, bar: Bar): number {
  switch (location) {
    case 'abovebar':
    case 'top':
      return bar.high;
    case 'belowbar':
    case 'bottom':
      return bar.low;
    default:
      // location.absolute 需要 plotshape 的取值，Piner 的 MarkerPoint 没有带
      return bar.close;
  }
}

function backgroundRuns(
  bars: Bar[],
  layers: Iterable<(string | null)[]>,
  step: number,
): PineBackgroundVisual[] {
  const runs: PineBackgroundVisual[] = [];
  for (const layer of layers) {
    let start = -1;
    let color: string | undefined;
    const flush = (end: number) => {
      if (start < 0 || !color || end < start) return;
      const from = bars[start].time;
      const to = end + 1 < bars.length ? bars[end + 1].time : bars[end].time + step;
      runs.push({ from, to, color });
      start = -1;
      color = undefined;
    };
    for (let index = 0; index < bars.length; index += 1) {
      const value = asColor(layer[index] ?? undefined);
      if (value === color) continue;
      flush(index - 1);
      if (value) {
        start = index;
        color = value;
      }
    }
    flush(bars.length - 1);
  }
  return runs;
}

interface RawMarker {
  id: number;
  kind?: string;
  location: string;
  glyph: string;
  data: ({ color?: string | null; text?: string } | null)[];
}

interface RawDrawObject {
  id: number;
  type: string;
  props: Record<string, unknown>;
}

interface RawFill {
  id: number;
  plot1: number;
  plot2: number;
  color: string | null;
  colors: (string | null)[];
  gradient?: {
    topValue: number[];
    bottomValue: number[];
    topColor: (string | null)[];
    bottomColor: (string | null)[];
  };
}

function normalizeDrawing(
  object: RawDrawObject,
  bars: Bar[],
  unsupported: string[],
  serverOffsetSec = 0,
): PineDrawingVisual | undefined {
  const props = object.props ?? {};
  const id = String(object.id);
  switch (object.type) {
    case 'label': {
      const time = barTimeAt(bars, props.x, props.xloc, serverOffsetSec);
      const price = asNumber(props.y);
      if (time == null || price == null) return undefined;
      return {
        id,
        kind: 'label',
        time,
        price,
        text: String(props.text ?? ''),
        color: asColor(props.color),
        textColor: asColor(props.textcolor),
        style: asText(props.style),
        size: asText(props.size),
      };
    }
    case 'line': {
      const from: PineVisualPoint = {
        time: barTimeAt(bars, props.x1, props.xloc, serverOffsetSec) ?? Number.NaN,
        price: asNumber(props.y1) ?? Number.NaN,
      };
      const to: PineVisualPoint = {
        time: barTimeAt(bars, props.x2, props.xloc, serverOffsetSec) ?? Number.NaN,
        price: asNumber(props.y2) ?? Number.NaN,
      };
      if (!Number.isFinite(from.time) || !Number.isFinite(to.time)) return undefined;
      if (!Number.isFinite(from.price) || !Number.isFinite(to.price)) return undefined;
      return {
        id,
        kind: 'line',
        points: [from, to],
        color: asColor(props.color),
        width: asNumber(props.width),
        style: asText(props.style),
        extend: asText(props.extend),
      };
    }
    case 'box': {
      const leftTime = barTimeAt(bars, props.left, props.xloc, serverOffsetSec);
      const rightTime = barTimeAt(bars, props.right, props.xloc, serverOffsetSec);
      const top = asNumber(props.top);
      const bottom = asNumber(props.bottom);
      if (leftTime == null || rightTime == null) return undefined;
      if (top == null || bottom == null) return undefined;
      return {
        id,
        kind: 'box',
        top: { time: leftTime, price: top },
        bottom: { time: rightTime, price: bottom },
        borderColor: asColor(props.border_color),
        bgColor: asColor(props.bgcolor),
        borderWidth: asNumber(props.border_width),
        borderStyle: asText(props.border_style),
      };
    }
    case 'polyline': {
      const raw = Array.isArray(props.points) ? (props.points as Record<string, unknown>[]) : [];
      const points: PineVisualPoint[] = [];
      for (const point of raw) {
        const time =
          barTimeAt(bars, point.time, 'bar_time', serverOffsetSec) ??
          barTimeAt(bars, point.index, props.xloc, serverOffsetSec);
        const price = asNumber(point.price);
        if (time == null || price == null) continue;
        points.push({ time, price });
      }
      if (points.length < 2) return undefined;
      return {
        id,
        kind: 'polyline',
        points,
        color: asColor(props.line_color),
        width: asNumber(props.line_width),
      };
    }
    case 'table': {
      const cells: { row: number; column: number; text: string; textColor?: string; bgColor?: string }[] =
        [];
      const raw = props.cells;
      if (raw && typeof raw === 'object') {
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
          const [row, column] = key.split(',').map((part) => Number(part));
          if (!Number.isFinite(row) || !Number.isFinite(column)) continue;
          const cell = (value ?? {}) as Record<string, unknown>;
          cells.push({
            row,
            column,
            text: String(cell.text ?? ''),
            textColor: asColor(cell.text_color),
            bgColor: asColor(cell.bgcolor),
          });
        }
      }
      return {
        id,
        kind: 'table',
        position: asText(props.position) ?? 'top_right',
        rows: asNumber(props.rows) ?? 1,
        columns: asNumber(props.columns) ?? 1,
        borderWidth: asNumber(props.border_width) ?? 0,
        cells,
      };
    }
    default:
      if (!unsupported.includes(object.type)) unsupported.push(object.type);
      return undefined;
  }
}

function collectVisuals(
  engine: {
    outputs: {
      markers: Map<number, RawMarker>;
      plots: Map<number, { data: number[] }>;
      hlines: Map<number, { price: number }>;
      bgColors: Map<number, (string | null)[]>;
      barColors: Map<number, (string | null)[]>;
      candles: Map<
        number,
        {
          id: number;
          data: ({ open: number; high: number; low: number; close: number } | null)[];
          colors: (string | null)[];
          wickColors: (string | null)[];
          borderColors: (string | null)[];
        }
      >;
      fills: Map<number, RawFill>;
    };
    drawings: RawDrawObject[];
  },
  bars: Bar[],
  serverOffsetSec = 0,
): PineVisuals {
  const visuals = emptyVisuals();
  const step = barStepSeconds(bars);

  for (const marker of engine.outputs.markers.values()) {
    // plotarrow 的方向藏在系列值的正负里，Piner 的 MarkerPoint 只给了「是否显示」，
    // 画不出上/下箭头；与其画错方向，不如明确报告不支持。
    if (marker.kind === 'arrow') {
      if (!visuals.unsupported.includes('plotarrow')) visuals.unsupported.push('plotarrow');
      continue;
    }
    // location.absolute 需要系列值本身，Piner 的 MarkerPoint 没有带；
    // 之前按 close 画会把标记放在错误的价格上，宁可明确报告不支持。
    if (marker.location === 'absolute') {
      if (!visuals.unsupported.includes('plotshape(location.absolute)')) {
        visuals.unsupported.push('plotshape(location.absolute)');
      }
      continue;
    }
    const points: PineMarkerVisual['points'] = [];
    for (let index = 0; index < marker.data.length && index < bars.length; index += 1) {
      const point = marker.data[index];
      if (!point) continue;
      const bar = bars[index];
      const price = markerPrice(marker.location, bar);
      if (!Number.isFinite(price)) continue;
      points.push({
        time: bar.time,
        price,
        color: asColor(point.color),
        text: point.text,
      });
      if (points.length >= 600) break;
    }
    if (points.length > 0) {
      visuals.markers.push({
        id: String(marker.id),
        glyph: marker.glyph,
        kind: marker.kind,
        location: marker.location,
        points,
      });
    }
  }

  for (const object of engine.drawings) {
    if (visuals.drawings.length >= 600) break;
    const drawing = normalizeDrawing(object, bars, visuals.unsupported, serverOffsetSec);
    if (drawing) visuals.drawings.push(drawing);
  }

  for (const candle of engine.outputs.candles.values()) {
    const list: PineCandleBar[] = [];
    for (let index = 0; index < candle.data.length && index < bars.length; index += 1) {
      const ohlc = candle.data[index];
      if (!ohlc) continue;
      if (![ohlc.open, ohlc.high, ohlc.low, ohlc.close].every(Number.isFinite)) continue;
      const to = index + 1 < bars.length ? bars[index + 1].time : bars[index].time + step;
      list.push({
        time: bars[index].time,
        to,
        open: ohlc.open,
        high: ohlc.high,
        low: ohlc.low,
        close: ohlc.close,
        color: asColor(candle.colors?.[index]),
        wickColor: asColor(candle.wickColors?.[index]),
        borderColor: asColor(candle.borderColors?.[index]),
      });
      if (list.length >= 600) break;
    }
    if (list.length > 0) visuals.candles.push({ id: String(candle.id), bars: list });
  }

  // barcolor 就是「用图上 OHLC + 这根的颜色画蜡烛」，直接复用蜡烛渲染
  for (const [layerId, layer] of engine.outputs.barColors) {
    const list: PineCandleBar[] = [];
    for (let index = 0; index < layer.length && index < bars.length; index += 1) {
      const color = asColor(layer[index] ?? undefined);
      if (!color) continue;
      const bar = bars[index];
      if (![bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)) continue;
      const to = index + 1 < bars.length ? bars[index + 1].time : bar.time + step;
      list.push({
        time: bar.time,
        to,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        color,
        wickColor: color,
        borderColor: color,
      });
      if (list.length >= 600) break;
    }
    if (list.length > 0) visuals.candles.push({ id: `barcolor-${layerId}`, bars: list });
  }

  visuals.backgrounds = backgroundRuns(bars, engine.outputs.bgColors.values(), step);

  // fill 的两条边是 plot/hline 的 id；逐 bar 取上下值，合成可渲染的色带
  const edgeAt = (id: number, index: number): number | undefined => {
    const plot = engine.outputs.plots.get(id);
    if (plot) return asNumber(plot.data[index]);
    const hline = engine.outputs.hlines.get(id);
    return hline ? asNumber(hline.price) : undefined;
  };
  for (const fill of engine.outputs.fills.values()) {
    const list: PineFillBar[] = [];
    for (let index = 0; index < bars.length; index += 1) {
      const first =
        asNumber(fill.gradient?.topValue?.[index]) ?? edgeAt(fill.plot1, index);
      const second =
        asNumber(fill.gradient?.bottomValue?.[index]) ?? edgeAt(fill.plot2, index);
      if (first == null || second == null) continue;
      const color = asColor(
        fill.gradient?.topColor?.[index] ?? fill.colors?.[index] ?? fill.color ?? undefined,
      );
      if (!color) continue;
      const top = Math.max(first, second);
      const bottom = Math.min(first, second);
      if (!(top > bottom)) continue;
      const to = index + 1 < bars.length ? bars[index + 1].time : bars[index].time + step;
      list.push({ time: bars[index].time, to, top, bottom, color });
      if (list.length >= 600) break;
    }
    if (list.length > 0) visuals.fills.push({ id: String(fill.id), bars: list });
  }

  return visuals;
}

async function runPiner(options: PineRunOptions, warnings: string[]): Promise<PineRunOutput> {
  const started = Date.now();
  const { compile, Engine, ArrayFeed } = await import('@heyphat/piner');
  const compiled = compile(options.source);
  const serverOffsetSec = Number(options.serverOffset) || 0;
  const pinerBars = toPinerBars(options.bars, serverOffsetSec);
  if (pinerBars.length === 0) throw new Error('没有可用的 K 线');

  const inputs = pinerInputs(options.inputMeta, options.inputs);
  const run = async (securityBars?: Map<string, PinerBar[]>) => {
    const engine = new Engine(compiled, new ArrayFeed(pinerBars), { inputs });
    if (securityBars) {
      for (const [key, bars] of securityBars) engine.ctx.securityBars.set(key, bars);
    }
    await engine.run({
      symbol: options.symbol,
      timeframe: normalizeResolution(options.resolution),
      ...(options.mintick && options.mintick > 0 ? { mintick: options.mintick } : {}),
    });
    return engine;
  };

  // 有 security 依赖时先跑一遍 discovery，拿到运行期真实请求（能覆盖 input 驱动的
  // 动态 symbol/timeframe），取数注入后再用新 Engine 跑最终结果。
  let engine = await run();
  const dependencies = compiled.metadata.securityDependencies ?? [];
  if (dependencies.length > 0) {
    const requests = dedupeSecurityRequests(engine.outputs.securityRequests);
    if (requests.length > 0) {
      const injected = await fetchSecurityBars(requests, options, warnings);
      if (injected.size > 0) engine = await run(injected);
    }
  }

  const series: PineSeriesOutput[] = [];
  const plots = [...engine.outputs.plots.values()].sort((a, b) => a.id - b.id);
  for (const plot of plots) {
    const style = typeof plot.options?.style === 'string' ? plot.options.style : undefined;
    const width = Number(plot.options?.linewidth);
    series.push({
      key: `plot_${plot.id}`,
      title: plot.title || `Plot ${plot.id + 1}`,
      kind: 'plot',
      values: padValues(plot.data, options.bars.length),
      color:
        firstColor(plot.colors) ??
        normalizeColor(
          typeof plot.options?.color === 'string' ? plot.options.color : undefined,
        ),
      ...(plot.colors?.length ? { colors: plot.colors } : {}),
      ...(style ? { style } : {}),
      ...(Number.isFinite(width) && width > 0 ? { width } : {}),
    });
  }

  const hlines = [...engine.outputs.hlines.values()].sort((a, b) => a.id - b.id);
  for (const hline of hlines) {
    series.push({
      key: `hline_${hline.id}`,
      title: hline.title || `HLine ${hline.id + 1}`,
      kind: 'hline',
      values: new Array<number>(options.bars.length).fill(hline.price),
    });
  }

  return {
    series,
    visuals: collectVisuals(engine, options.bars, serverOffsetSec),
    warnings,
    engine: 'piner',
    durationMs: Date.now() - started,
  };
}

export async function runPine(options: PineRunOptions): Promise<PineRunOutput> {
  try {
    return await runPiner(options, []);
  } catch (error) {
    throw new Error(`Pine 运行失败：${errorText(error)}`);
  }
}
