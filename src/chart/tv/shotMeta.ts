import type { IChartingLibraryWidget } from '../../../public/charting_library/charting_library';

/**
 * 图表截图的价格坐标元数据。
 *
 * 截图由 TradingView 的 takeClientScreenshot 生成，应用本身无法再知道图里
 * 某个价格落在第几行。所以在成交截图时把可视价格区间按比例采样成若干锚点，
 * 存成 sidecar JSON；交易日志查看截图时再用它们把入场/出场价换算成 y 坐标。
 */

export interface ShotAnchor {
  price: number;
  /** 相对截图内容高度的比例，0 = 顶部，1 = 底部 */
  y: number;
}

export interface ShotMeta {
  version: number;
  /** 该品种的价格小数位，用于标签格式化 */
  digits: number;
  symbol?: string;
  interval?: string;
  /** 按价格升序或降序都可以，读取时会重新排序 */
  anchors: ShotAnchor[];
}

export interface ShotPoint {
  y: number;
  /** 价格在截图可视区间之外时标记方向，便于在边缘提示 */
  edge: 'above' | 'below' | null;
}

type ScaleInternals = {
  getVisiblePriceRange?: () => { from: number; to: number } | null;
  _priceScale?: { priceToCoordinate?: (price: number) => number };
};

type PaneInternals = {
  getHeight?: () => number;
  getMainSourcePriceScale?: () => ScaleInternals | null;
};

type ChartInternals = {
  getPanes?: () => PaneInternals[];
  symbol?: () => string;
  resolution?: () => string;
};

const ANCHORS = 5;

/** 在截图前调用：把主图当前可视价格区间换算成截图内的 y 比例 */
export function buildShotMeta(
  widget: IChartingLibraryWidget,
  host: HTMLElement | null,
  digits: number,
): ShotMeta | null {
  try {
    const chart = widget.activeChart() as unknown as ChartInternals;
    const pane = chart.getPanes?.()[0];
    const scale = pane?.getMainSourcePriceScale?.();
    const range = scale?.getVisiblePriceRange?.();
    // 必须保留 this，库内部的坐标换算依赖价格轴实例
    const priceScale = scale?._priceScale;
    if (!range || !priceScale?.priceToCoordinate || !(range.to > range.from)) return null;

    const frame = host?.querySelector('iframe') ?? null;
    const doc = frame?.contentDocument;
    const frameHeight = frame?.getBoundingClientRect().height ?? 0;
    const paneHeight = pane?.getHeight?.() ?? 0;

    // 图表可能由多块叠放的 canvas 组成，选高度最接近主价格面板的那块
    let canvas: HTMLCanvasElement | null = null;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const item of doc?.querySelectorAll('canvas') ?? []) {
      const rect = item.getBoundingClientRect();
      if (rect.width < 200 || rect.height < 200) continue;
      const diff = paneHeight > 0 ? Math.abs(rect.height - paneHeight) : 0;
      if (diff < bestDiff) {
        bestDiff = diff;
        canvas = item;
      }
    }
    if (!canvas) return null;

    const rect = canvas.getBoundingClientRect();
    // 截图覆盖「价格面板 + 底部时间轴」，不含顶部工具栏。
    // 底部高度取画布下沿到 iframe 底部的距离。
    const bottom = frameHeight > rect.height ? Math.max(frameHeight - rect.top - rect.height, 0) : 0;
    const contentHeight = rect.height + bottom;
    if (!(contentHeight > 0)) return null;

    const span = range.to - range.from;
    const anchors: ShotAnchor[] = [];
    for (let index = 0; index < ANCHORS; index += 1) {
      const price = range.from + (span * index) / (ANCHORS - 1);
      const y = priceScale.priceToCoordinate(price);
      if (!Number.isFinite(y)) continue;
      anchors.push({ price, y: Math.min(1, Math.max(0, y / contentHeight)) });
    }
    if (anchors.length < 2) return null;

    return {
      version: 1,
      digits: Number.isFinite(digits) ? Math.max(0, Math.min(8, digits)) : 5,
      symbol: chart.symbol?.(),
      interval: chart.resolution?.(),
      anchors,
    };
  } catch {
    return null;
  }
}

export function isShotMeta(value: unknown): value is ShotMeta {
  if (!value || typeof value !== 'object') return false;
  const meta = value as Partial<ShotMeta>;
  if (!Array.isArray(meta.anchors) || meta.anchors.length < 2) return false;
  return meta.anchors.every(
    (item) =>
      item &&
      typeof item === 'object' &&
      Number.isFinite((item as ShotAnchor).price) &&
      Number.isFinite((item as ShotAnchor).y),
  );
}

/** 价格 → 截图内的 y 比例；超出可视区间时夹到边缘并返回方向 */
export function shotY(price: number, meta: ShotMeta): ShotPoint | null {
  if (!Number.isFinite(price)) return null;
  const anchors = [...meta.anchors].sort((a, b) => a.price - b.price);
  if (anchors.length < 2) return null;

  const clamp = (value: number) => Math.min(0.988, Math.max(0.012, value));
  const low = anchors[0];
  const high = anchors[anchors.length - 1];

  if (price <= low.price) return { y: clamp(low.y), edge: price < low.price ? 'below' : null };
  if (price >= high.price) return { y: clamp(high.y), edge: price > high.price ? 'above' : null };

  for (let index = 1; index < anchors.length; index += 1) {
    const a = anchors[index - 1];
    const b = anchors[index];
    if (price > b.price) continue;
    const ratio = b.price === a.price ? 0 : (price - a.price) / (b.price - a.price);
    return { y: clamp(a.y + (b.y - a.y) * ratio), edge: null };
  }
  return { y: clamp(high.y), edge: null };
}
