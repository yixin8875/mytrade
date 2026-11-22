import type {
  PineBackgroundVisual,
  PineCandleBar,
  PineDrawingVisual,
  PineFillBar,
  PineMarkerVisual,
  PineVisualPoint,
  PineVisuals,
} from './pineEngine';

/**
 * Pine 渲染桥：把引擎输出的视觉 IR 画到图表上。
 *
 * Charting Library 的自定义指标只能返回折线，plotshape/label/line/box/table/bgcolor
 * 这些对象没法通过指标元信息表达，所以这里走绘图 API：
 *  - marker / label / line / box / polyline → createShape / createMultipointShape
 *  - table → 叠在图表容器上的 HTML 层（表格是屏幕锚定的，不需要坐标换算）
 *  - bgcolor → 可视价格区间上的半透明矩形，zOrder=bottom
 *
 * 只画可视范围附近的对象：图表库对「已加载 K 线之外」的绘图时间会折叠到同一根 bar，
 * 而且一次创建几百个绘图对象会明显拖慢滚动。
 *
 * 对象的锚点/颜色变化优先用 getShapeById().setPoints()/setProperties() 原位更新；
 * 只有工具类型变了（例如 plotshape 从箭头变成文字）或点数变了（polyline）才删除重建。
 */

const VISIBLE_PAD_SEC = 2 * 86_400;
const REDRAW_THROTTLE_MS = 350;
const MAX_SHAPES_PER_STUDY = 400;
/** 每根蜡烛要两个绘图对象（实体 + 影线），单独限额，避免把其它对象挤掉 */
const MAX_CANDLE_BARS = 150;
/** fill 每根 bar 一个矩形，同样单独限额 */
const MAX_FILL_BARS = 150;

export interface PineShapePoint {
  time: number;
  price: number;
}

/** getShapeById() 返回的绘图对象；只用到原位更新这几个方法 */
export interface PineShapeHandle {
  setPoints?(points: PineShapePoint[]): void;
  setProperties?(properties: Record<string, unknown>): void;
  getProperties?(): Record<string, unknown>;
}

export interface PineShapeApi {
  createShape(point: PineShapePoint, options: Record<string, unknown>): Promise<string>;
  createMultipointShape(
    points: PineShapePoint[],
    options: Record<string, unknown>,
  ): Promise<string>;
  removeEntity(id: string): void;
  getShapeById?(id: string): PineShapeHandle | null;
  getVisibleRange(): { from: number; to: number };
  getPanes?(): readonly {
    /** 主图高度（像素），用于把文字高度换算成价格偏移 */
    getHeight?(): number;
    getMainSourcePriceScale(): {
      getVisiblePriceRange(): { from: number; to: number } | null;
    } | null;
  }[];
  onVisibleRangeChanged?(): {
    subscribe(context: unknown, callback: () => void): void;
    unsubscribe(context: unknown, callback: () => void): void;
  };
}

interface StudyEntry {
  title: string;
  visuals: PineVisuals;
  visible: boolean;
}

interface DrawnShape {
  id: string;
  sig: string;
  /** 工具标识；不同工具无法原位更新 */
  tool: string;
}

/** 一个绘图对象的完整描述，创建和原位更新共用 */
interface ShapeSpec {
  /** createShape（单点）还是 createMultipointShape（多点） */
  single: boolean;
  points: PineShapePoint[];
  /** 创建参数：shape / text / overrides / zOrder / ownerStudyId 等 */
  options: Record<string, unknown>;
  /** 原位更新时传给 setProperties 的覆盖项（含 text） */
  properties: Record<string, unknown>;
}

interface WantedShape {
  key: string;
  sig: string;
  tool: string;
  spec: ShapeSpec;
}

interface Rgba {
  hex: string;
  alpha: number;
}

const DEFAULT_COLOR = '#787B86';

function parseColor(color?: string): Rgba {
  if (!color) return { hex: DEFAULT_COLOR, alpha: 1 };
  const match = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(color.trim());
  if (!match) return { hex: color, alpha: 1 };
  return {
    hex: `#${match[1]}`,
    alpha: match[2] ? parseInt(match[2], 16) / 255 : 1,
  };
}

/** 图表库绘图对象的 transparency 是 0–100，100 = 全透明 */
function transparency(color?: string): number {
  return Math.round((1 - parseColor(color).alpha) * 100);
}

/** Pine 的 solid/dotted/dashed -> 图表库 LineStyle 枚举（0/1/2） */
function lineStyle(style?: string): number {
  if (style === 'dotted') return 1;
  if (style === 'dashed') return 2;
  return 0;
}

/** Pine label size.* -> 图表库文本字号 */
const LABEL_FONT_SIZE: Record<string, number> = {
  tiny: 9,
  small: 10,
  normal: 12,
  large: 14,
  huge: 18,
};

/**
 * 文字块的大致像素高度。
 * 图表库的 text 对象没有对齐/偏移属性，Pine 的 label.style_label_down 要把文字
 * 放到锚点上方，只能把锚点价格往上抬这么多像素。
 */
function labelHeightPx(size: string | undefined, text: string): number {
  const font = LABEL_FONT_SIZE[size ?? ''] ?? 11;
  const lines = Math.max(1, text.split('\n').length);
  return font * 1.25 * lines + 4;
}

function rgba(color?: string): string {
  const { hex, alpha } = parseColor(color);
  const value = parseInt(hex.slice(1), 16);
  if (!Number.isFinite(value)) return color ?? DEFAULT_COLOR;
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

/** plotshape / plotchar 的图形落到图表库支持的单点绘图上 */
function markerShape(glyph: string): { shape: string; text?: string } {
  switch (glyph) {
    case 'triangleup':
    case 'arrowup':
      return { shape: 'arrow_up' };
    case 'triangledown':
    case 'arrowdown':
      return { shape: 'arrow_down' };
    case 'flag':
      return { shape: 'flag' };
    case 'circle':
      return { shape: 'text', text: '●' };
    case 'square':
      return { shape: 'text', text: '■' };
    case 'diamond':
      return { shape: 'text', text: '◆' };
    case 'cross':
      return { shape: 'text', text: '✕' };
    case 'xcross':
      return { shape: 'text', text: '✖' };
    case 'labelup':
      return { shape: 'text', text: '▲' };
    case 'labeldown':
      return { shape: 'text', text: '▼' };
    default:
      // plotchar 的 glyph 就是字符本身
      return { shape: 'text', text: glyph.length <= 2 ? glyph : '●' };
  }
}

const TABLE_INSETS: Record<string, string> = {
  top_right: 'top:6px;right:72px',
  top_left: 'top:6px;left:6px',
  top_center: 'top:6px;left:50%;transform:translateX(-50%)',
  middle_right: 'top:50%;right:72px;transform:translateY(-50%)',
  middle_left: 'top:50%;left:6px;transform:translateY(-50%)',
  middle_center: 'top:50%;left:50%;transform:translate(-50%,-50%)',
  bottom_right: 'bottom:28px;right:72px',
  bottom_left: 'bottom:28px;left:6px',
  bottom_center: 'bottom:28px;left:50%;transform:translateX(-50%)',
};

export class PineRenderLayer {
  private studies = new Map<string, StudyEntry>();
  private shapes = new Map<string, DrawnShape>();
  private pending = new Set<string>();
  private desired = new Map<string, WantedShape>();
  private tables = new Map<string, HTMLElement>();
  private root: HTMLElement | null = null;
  private timer = 0;
  private disposed = false;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private chart: PineShapeApi,
    private host: HTMLElement | null,
  ) {}

  start(): void {
    if (this.disposed) return;
    try {
      const sub = this.chart.onVisibleRangeChanged?.();
      if (sub) {
        const onVisible = () => this.schedule();
        sub.subscribe(null, onVisible);
        this.unsubscribe = () => {
          try {
            sub.unsubscribe(null, onVisible);
          } catch {
            /* 图表已经销毁 */
          }
        };
      }
    } catch {
      /* 图表还没准备好 */
    }
    this.redraw();
  }

  update(studyId: string, title: string, visuals: PineVisuals): void {
    if (this.disposed) return;
    const previous = this.studies.get(studyId);
    this.studies.set(studyId, { title, visuals, visible: previous?.visible ?? true });
    this.schedule();
  }

  setVisible(studyId: string, visible: boolean): void {
    const entry = this.studies.get(studyId);
    if (!entry || entry.visible === visible) return;
    entry.visible = visible;
    this.schedule();
  }

  removeStudy(studyId: string): void {
    if (!this.studies.delete(studyId)) return;
    const prefix = `${studyId}|`;
    for (const [key, drawn] of [...this.shapes]) {
      if (!key.startsWith(prefix)) continue;
      this.shapes.delete(key);
      this.remove(drawn.id);
    }
    for (const [key, element] of [...this.tables]) {
      if (!key.startsWith(prefix)) continue;
      this.tables.delete(key);
      element.remove();
    }
    this.schedule();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.clearTimeout(this.timer);
    this.timer = 0;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const drawn of this.shapes.values()) this.remove(drawn.id);
    this.shapes.clear();
    this.pending.clear();
    this.desired.clear();
    for (const element of this.tables.values()) element.remove();
    this.tables.clear();
    this.root?.remove();
    this.root = null;
    this.studies.clear();
  }

  private remove(id: string): void {
    try {
      this.chart.removeEntity(id);
    } catch {
      /* 图表已经销毁 */
    }
  }

  private schedule(): void {
    if (this.disposed || this.timer) return;
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.redraw();
    }, REDRAW_THROTTLE_MS);
  }

  private visibleRange(): { from: number; to: number } | null {
    try {
      const range = this.chart.getVisibleRange();
      if (!Number.isFinite(range.from) || !Number.isFinite(range.to)) return null;
      return { from: range.from - VISIBLE_PAD_SEC, to: range.to + VISIBLE_PAD_SEC };
    } catch {
      return null;
    }
  }

  private priceRange(): { from: number; to: number } | null {
    try {
      const pane = this.chart.getPanes?.()[0];
      const range = pane?.getMainSourcePriceScale()?.getVisiblePriceRange();
      if (!range || !Number.isFinite(range.from) || !Number.isFinite(range.to)) return null;
      return { from: range.from, to: range.to };
    } catch {
      return null;
    }
  }

  /** 当前价格缩放下 1 像素对应多少价格；拿不到就返回 null */
  private pricePerPixel(): number | null {
    const range = this.priceRange();
    if (!range) return null;
    try {
      const height = this.chart.getPanes?.()[0]?.getHeight?.();
      if (!height || !Number.isFinite(height) || height <= 0) return null;
      return (range.to - range.from) / height;
    } catch {
      return null;
    }
  }

  /**
   * Pine 的 label.style_* 表示箭头指向，文字落在锚点的另一侧：
   *  - label_down：文字在锚点上方（TradingView 的时段标签、PDH/PDL 都是这种）
   *  - label_up / label_lower_*：文字在锚点下方，与图表库 text 的默认行为一致
   *  - label_left / label_right / label_center：文字垂直居中于锚点
   * 图表库的 text 对象只能从锚点往右下画，所以用价格偏移模拟。
   */
  private labelAnchorPrice(drawing: Extract<PineDrawingVisual, { kind: 'label' }>): number {
    const style = drawing.style ?? '';
    if (!style.startsWith('label_')) return drawing.price;
    const height = labelHeightPx(drawing.size, drawing.text);
    const above = style === 'label_down' || style.startsWith('label_upper');
    const centered =
      style === 'label_center' || style === 'label_left' || style === 'label_right';
    const pixels = above ? height + 2 : centered ? height / 2 : 0;
    if (!pixels) return drawing.price;
    const perPixel = this.pricePerPixel();
    return perPixel == null ? drawing.price : drawing.price + pixels * perPixel;
  }

  private redraw(): void {
    if (this.disposed) return;
    const range = this.visibleRange();
    const price = this.priceRange();
    this.desired.clear();

    for (const [studyId, entry] of this.studies) {
      if (!entry.visible) continue;
      this.collectStudy(studyId, entry, range, price, this.desired);
    }

    // 位置/颜色变了先原地改；工具类型变了、polyline 点数变了或对象已失效才删除重建
    for (const [key, drawn] of [...this.shapes]) {
      const wanted = this.desired.get(key);
      if (!wanted) {
        this.shapes.delete(key);
        this.remove(drawn.id);
        continue;
      }
      if (wanted.sig === drawn.sig) continue;
      if (wanted.tool === drawn.tool && this.updateShape(drawn, wanted)) {
        drawn.sig = wanted.sig;
        continue;
      }
      this.shapes.delete(key);
      this.remove(drawn.id);
    }

    for (const shape of this.desired.values()) {
      if (this.shapes.has(shape.key) || this.pending.has(shape.key)) continue;
      this.pending.add(shape.key);
      const { spec } = shape;
      const creating = spec.single
        ? this.chart.createShape(spec.points[0], spec.options)
        : this.chart.createMultipointShape(spec.points, spec.options);
      creating
        .then((id) => {
          this.pending.delete(shape.key);
          const stillWanted = this.desired.get(shape.key);
          if (this.disposed || !stillWanted || stillWanted.sig !== shape.sig) {
            this.remove(id);
            return;
          }
          this.shapes.set(shape.key, { id, sig: shape.sig, tool: shape.tool });
        })
        .catch(() => {
          this.pending.delete(shape.key);
        });
    }

    this.renderTables();
  }

  private want(key: string, sig: string, spec: ShapeSpec): WantedShape {
    return {
      key,
      sig,
      // 工具类型决定能不能原位更新：单点/多点、shape 名字、点数都是工具的一部分
      tool: `${spec.single ? 'p' : 'm'}:${String(spec.options.shape)}:${spec.points.length}`,
      spec,
    };
  }

  /**
   * 用 setPoints/setProperties 原地更新锚点和样式，避免删除重建造成闪烁。
   * 图表库的 setProperties 会把不认识的键当成新属性加进去，所以只写现有属性里有的键。
   * 对象已失效、点数不匹配（polyline）时返回 false，调用方退回删除重建。
   */
  private updateShape(drawn: DrawnShape, wanted: WantedShape): boolean {
    if (!this.chart.getShapeById) return false;
    let shape: PineShapeHandle | null;
    try {
      shape = this.chart.getShapeById(drawn.id);
    } catch {
      return false;
    }
    if (!shape?.setPoints) return false;
    const entries = Object.entries(wanted.spec.properties);
    try {
      shape.setPoints(wanted.spec.points);
      if (entries.length > 0 && shape.setProperties) {
        const current = shape.getProperties?.();
        if (!current) return false;
        const patch: Record<string, unknown> = {};
        for (const [key, value] of entries) {
          if (key in current) patch[key] = value;
        }
        // 属性名一个都对不上说明工具/接口变了，重建比漏改颜色更安全
        if (Object.keys(patch).length === 0) return false;
        shape.setProperties(patch);
      }
      return true;
    } catch {
      return false;
    }
  }

  private collectStudy(
    studyId: string,
    entry: StudyEntry,
    range: { from: number; to: number } | null,
    priceRange: { from: number; to: number } | null,
    out: Map<string, WantedShape>,
  ): void {
    const inRange = (time: number) => !range || (time >= range.from && time <= range.to);
    let count = 0;

    for (const marker of entry.visuals.markers) {
      let points = marker.points.filter((point) => inRange(point.time));
      if (points.length > MAX_SHAPES_PER_STUDY) points = points.slice(-MAX_SHAPES_PER_STUDY);
      for (const point of points) {
        if (count >= MAX_SHAPES_PER_STUDY) break;
        count += 1;
        // location.top/bottom 在 TradingView 里贴在面板上/下沿，不是 K 线的高/低点
        const price =
          marker.location === 'top'
            ? priceRange?.to ?? point.price
            : marker.location === 'bottom'
              ? priceRange?.from ?? point.price
              : point.price;
        const key = `${studyId}|m|${marker.id}|${point.time}`;
        const sig = JSON.stringify([
          point.time,
          price,
          point.color,
          point.text,
          marker.glyph,
          marker.kind,
        ]);
        out.set(key, this.want(key, sig, this.markerSpec(studyId, marker, point, price)));
      }
    }

    for (const drawing of entry.visuals.drawings) {
      if (count >= MAX_SHAPES_PER_STUDY) break;
      if (drawing.kind === 'table') continue;
      if (!this.drawingVisible(drawing, inRange)) continue;
      count += 1;
      const key = `${studyId}|d|${drawing.id}`;
      out.set(
        key,
        this.want(key, JSON.stringify(drawing), this.drawingSpec(studyId, drawing)),
      );
    }

    if (priceRange) {
      entry.visuals.backgrounds.forEach((background, index) => {
        if (count >= MAX_SHAPES_PER_STUDY) return;
        if (!this.backgroundVisible(background, range)) return;
        count += 1;
        const key = `${studyId}|bg|${index}`;
        const sig = JSON.stringify([background, priceRange]);
        out.set(
          key,
          this.want(key, sig, this.backgroundSpec(studyId, background, priceRange)),
        );
      });
    }

    // plotcandle 和 barcolor 共用同一份蜡烛预算，避免叠加后对象翻倍
    let candleBars = 0;
    for (const candle of entry.visuals.candles) {
      const budget = MAX_CANDLE_BARS - candleBars;
      if (budget <= 0) break;
      let bars = candle.bars.filter((bar) => inRange(bar.time));
      if (bars.length > budget) bars = bars.slice(-budget);
      candleBars += bars.length;
      for (const bar of bars) {
        const top = Math.max(bar.open, bar.close);
        const bottom = Math.min(bar.open, bar.close);
        if (top > bottom) {
          const key = `${studyId}|c|${candle.id}|${bar.time}|b`;
          const sig = JSON.stringify([
            bar.time,
            bar.to,
            top,
            bottom,
            bar.color,
            bar.borderColor,
          ]);
          out.set(key, this.want(key, sig, this.candleBodySpec(studyId, bar)));
        }
        if (bar.high > bar.low) {
          const key = `${studyId}|c|${candle.id}|${bar.time}|w`;
          const sig = JSON.stringify([bar.time, bar.high, bar.low, bar.wickColor, bar.color]);
          out.set(key, this.want(key, sig, this.candleWickSpec(studyId, bar)));
        }
      }
    }

    let fillBars = 0;
    for (const fill of entry.visuals.fills) {
      const budget = MAX_FILL_BARS - fillBars;
      if (budget <= 0) break;
      let bars = fill.bars.filter((bar) => inRange(bar.time));
      if (bars.length > budget) bars = bars.slice(-budget);
      fillBars += bars.length;
      for (const bar of bars) {
        const key = `${studyId}|f|${fill.id}|${bar.time}`;
        const sig = JSON.stringify([bar.time, bar.to, bar.top, bar.bottom, bar.color]);
        out.set(key, this.want(key, sig, this.fillSpec(studyId, bar)));
      }
    }
  }

  private drawingVisible(
    drawing: Exclude<PineDrawingVisual, { kind: 'table' }>,
    inRange: (time: number) => boolean,
  ): boolean {
    switch (drawing.kind) {
      case 'label':
        return inRange(drawing.time);
      case 'line':
        return drawing.points.some((point) => inRange(point.time));
      case 'box':
        return inRange(drawing.top.time) || inRange(drawing.bottom.time);
      case 'polyline':
        return drawing.points.some((point) => inRange(point.time));
      default:
        return false;
    }
  }

  private backgroundVisible(
    background: PineBackgroundVisual,
    range: { from: number; to: number } | null,
  ): boolean {
    if (!range) return true;
    return background.to >= range.from && background.from <= range.to;
  }

  private baseOptions(studyId?: string): Record<string, unknown> {
    return {
      // 把绘图挂到指标上：隐藏/删除指标时一起收走；非 overlay 指标画在自己的面板里
      ...(studyId ? { ownerStudyId: studyId } : {}),
      lock: true,
      disableSelection: true,
      disableSave: true,
      disableUndo: true,
      showInObjectsTree: false,
    };
  }

  private markerSpec(
    studyId: string,
    marker: PineMarkerVisual,
    point: PineVisualPoint & { color?: string; text?: string },
    price: number,
  ): ShapeSpec {
    const mapped = markerShape(marker.glyph);
    // plotchar 的 char 是任意字符串，不能被 shape.* 的图标映射改写；
    // 它的 text 参数是悬停提示，画出来的必须是 char 本身
    const shape = marker.kind === 'char' ? 'text' : mapped.shape;
    const text = marker.kind === 'char' ? marker.glyph : point.text ?? mapped.text;
    const { hex } = parseColor(point.color);
    const overrides =
      shape === 'text'
        ? // 文本对象只认小写 fontsize；写 fontSize 会被忽略、退回默认字号
          { color: hex, fontsize: 11, bold: false }
        : { color: hex };
    return {
      single: true,
      points: [{ time: point.time, price }],
      options: {
        ...this.baseOptions(studyId),
        shape,
        ...(text ? { text } : {}),
        overrides,
      },
      properties: { ...overrides, ...(text ? { text } : {}) },
    };
  }

  private drawingSpec(studyId: string, drawing: PineDrawingVisual): ShapeSpec {
    switch (drawing.kind) {
      case 'label': {
        const { hex: background, alpha } = parseColor(drawing.color);
        const { hex: textColor } = parseColor(drawing.textColor);
        const overrides = {
          color: textColor,
          fontsize: LABEL_FONT_SIZE[drawing.size ?? ''] ?? 11,
          bold: false,
          drawBorder: false,
          // 图表库文本对象用 backgroundTransparency，不认 transparency
          fillBackground: alpha > 0,
          backgroundColor: background,
          backgroundTransparency: transparency(drawing.color),
        };
        return {
          single: true,
          points: [{ time: drawing.time, price: this.labelAnchorPrice(drawing) }],
          options: {
            ...this.baseOptions(studyId),
            shape: 'text',
            text: drawing.text,
            overrides,
          },
          properties: { ...overrides, text: drawing.text },
        };
      }
      case 'line': {
        const { hex } = parseColor(drawing.color);
        const overrides = {
          color: hex,
          linecolor: hex,
          linewidth: drawing.width ?? 1,
          linestyle: lineStyle(drawing.style),
          transparency: transparency(drawing.color),
          extendLeft: drawing.extend === 'left' || drawing.extend === 'both',
          extendRight: drawing.extend === 'right' || drawing.extend === 'both',
        };
        // 水平线也必须画成线段：horizontal_line 会横跨整个图表宽度，
        // 导致 PDH/PDL、时段中线看起来存在于所有历史里。Pine 的 line.new
        // 有明确的起止 bar，用 trend_line 才能保住 x1/x2。
        return {
          single: false,
          points: [drawing.points[0], drawing.points[1]],
          options: { ...this.baseOptions(studyId), shape: 'trend_line', overrides },
          properties: overrides,
        };
      }
      case 'box': {
        const { hex: border } = parseColor(drawing.borderColor);
        const { hex: fill } = parseColor(drawing.bgColor);
        const overrides = {
          color: border,
          backgroundColor: fill,
          fillBackground: Boolean(drawing.bgColor),
          transparency: drawing.bgColor ? transparency(drawing.bgColor) : 0,
          linewidth: drawing.borderWidth ?? 1,
          linestyle: lineStyle(drawing.borderStyle),
        };
        return {
          single: false,
          points: [drawing.top, drawing.bottom],
          options: { ...this.baseOptions(studyId), shape: 'rectangle', overrides },
          properties: overrides,
        };
      }
      case 'polyline': {
        const { hex } = parseColor(drawing.color);
        const overrides = {
          color: hex,
          linecolor: hex,
          linewidth: drawing.width ?? 1,
        };
        return {
          single: false,
          points: drawing.points,
          options: { ...this.baseOptions(studyId), shape: 'polyline', overrides },
          properties: overrides,
        };
      }
      case 'table':
        // 表格走 HTML 覆盖层，见 renderTables()
        throw new Error('table is rendered as HTML');
    }
  }

  private backgroundSpec(
    studyId: string,
    background: PineBackgroundVisual,
    price: { from: number; to: number },
  ): ShapeSpec {
    const { hex } = parseColor(background.color);
    const overrides = {
      color: hex,
      backgroundColor: hex,
      fillBackground: true,
      transparency: transparency(background.color),
      linewidth: 0,
      linestyle: 0,
    };
    return {
      single: false,
      points: [
        { time: background.from, price: price.to },
        { time: background.to, price: price.from },
      ],
      options: {
        ...this.baseOptions(studyId),
        shape: 'rectangle',
        zOrder: 'bottom',
        overrides,
      },
      properties: overrides,
    };
  }

  /** plotcandle/plotbar 的实体：图库不允许逐根改蜡烛颜色，用矩形盖在原生蜡烛上 */
  private candleBodySpec(studyId: string, bar: PineCandleBar): ShapeSpec {
    const { hex: body } = parseColor(bar.color);
    const { hex: border } = parseColor(bar.borderColor ?? bar.color);
    const overrides = {
      color: border,
      backgroundColor: body,
      fillBackground: true,
      transparency: transparency(bar.color),
      linewidth: 1,
      linestyle: 0,
    };
    return {
      single: false,
      points: [
        { time: bar.time, price: Math.max(bar.open, bar.close) },
        { time: bar.to, price: Math.min(bar.open, bar.close) },
      ],
      options: { ...this.baseOptions(studyId), shape: 'rectangle', overrides },
      properties: overrides,
    };
  }

  private candleWickSpec(studyId: string, bar: PineCandleBar): ShapeSpec {
    const source = bar.wickColor ?? bar.color;
    const { hex } = parseColor(source);
    const overrides = {
      color: hex,
      linecolor: hex,
      linewidth: 1,
      linestyle: 0,
      transparency: transparency(source),
    };
    return {
      single: false,
      points: [
        { time: bar.time, price: bar.high },
        { time: bar.time, price: bar.low },
      ],
      options: { ...this.baseOptions(studyId), shape: 'trend_line', overrides },
      properties: overrides,
    };
  }

  /** fill：逐 bar 一条矩形色带，放在底层，不挡住蜡烛和曲线 */
  private fillSpec(studyId: string, bar: PineFillBar): ShapeSpec {
    const { hex } = parseColor(bar.color);
    const overrides = {
      color: hex,
      backgroundColor: hex,
      fillBackground: true,
      transparency: transparency(bar.color),
      linewidth: 0,
      linestyle: 0,
    };
    return {
      single: false,
      points: [
        { time: bar.time, price: bar.top },
        { time: bar.to, price: bar.bottom },
      ],
      options: {
        ...this.baseOptions(studyId),
        shape: 'rectangle',
        zOrder: 'bottom',
        overrides,
      },
      properties: overrides,
    };
  }

  private renderTables(): void {
    const keep = new Set<string>();
    for (const [studyId, entry] of this.studies) {
      if (!entry.visible) continue;
      for (const drawing of entry.visuals.drawings) {
        if (drawing.kind !== 'table') continue;
        const key = `${studyId}|t|${drawing.id}`;
        keep.add(key);
        this.renderTable(key, drawing);
      }
    }
    for (const [key, element] of [...this.tables]) {
      if (keep.has(key)) continue;
      this.tables.delete(key);
      element.remove();
    }
  }

  private renderTable(key: string, table: Extract<PineDrawingVisual, { kind: 'table' }>): void {
    const root = this.ensureRoot();
    if (!root) return;
    let element = this.tables.get(key);
    if (!element) {
      element = document.createElement('div');
      root.appendChild(element);
      this.tables.set(key, element);
    }
    element.style.cssText = [
      'position:absolute',
      'display:grid',
      `grid-template-columns:repeat(${Math.max(1, table.columns)},minmax(0,auto))`,
      'font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace',
      'pointer-events:none',
      'white-space:nowrap',
      TABLE_INSETS[table.position] ?? TABLE_INSETS.top_right,
    ].join(';');

    const cells = new Map<string, (typeof table.cells)[number]>();
    for (const cell of table.cells) cells.set(`${cell.row},${cell.column}`, cell);

    const children: HTMLElement[] = [];
    for (let row = 0; row < table.rows; row += 1) {
      for (let column = 0; column < table.columns; column += 1) {
        const cell = cells.get(`${row},${column}`);
        const div = document.createElement('div');
        div.textContent = cell?.text ?? '';
        div.style.cssText = [
          'padding:1px 6px',
          `border:${table.borderWidth > 0 ? `${table.borderWidth}px solid rgba(128,128,128,0.45)` : '0'}`,
          `background:${cell?.bgColor ? rgba(cell.bgColor) : 'transparent'}`,
          `color:${cell?.textColor ? rgba(cell.textColor) : '#d1d4dc'}`,
        ].join(';');
        children.push(div);
      }
    }
    element.replaceChildren(...children);
  }

  private ensureRoot(): HTMLElement | null {
    if (this.root) return this.root;
    if (!this.host) return null;
    const root = document.createElement('div');
    root.style.cssText =
      'position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:5';
    this.host.appendChild(root);
    this.root = root;
    return root;
  }
}
