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

export interface PineShapeApi {
  createShape(point: PineShapePoint, options: Record<string, unknown>): Promise<string>;
  createMultipointShape(
    points: PineShapePoint[],
    options: Record<string, unknown>,
  ): Promise<string>;
  removeEntity(id: string): void;
  getVisibleRange(): { from: number; to: number };
  getPanes?(): readonly {
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
}

interface WantedShape {
  key: string;
  sig: string;
  create: () => Promise<string>;
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

  private redraw(): void {
    if (this.disposed) return;
    const range = this.visibleRange();
    const price = this.priceRange();
    this.desired.clear();

    for (const [studyId, entry] of this.studies) {
      if (!entry.visible) continue;
      this.collectStudy(studyId, entry, range, price, this.desired);
    }

    // 位置/颜色变了或者对象已经不在可视范围：先删掉，下面重新建
    for (const [key, drawn] of [...this.shapes]) {
      const wanted = this.desired.get(key);
      if (wanted && wanted.sig === drawn.sig) continue;
      this.shapes.delete(key);
      this.remove(drawn.id);
    }

    for (const shape of this.desired.values()) {
      if (this.shapes.has(shape.key) || this.pending.has(shape.key)) continue;
      this.pending.add(shape.key);
      shape
        .create()
        .then((id) => {
          this.pending.delete(shape.key);
          const stillWanted = this.desired.get(shape.key);
          if (this.disposed || !stillWanted || stillWanted.sig !== shape.sig) {
            this.remove(id);
            return;
          }
          this.shapes.set(shape.key, { id, sig: shape.sig });
        })
        .catch(() => {
          this.pending.delete(shape.key);
        });
    }

    this.renderTables();
  }

  private collectStudy(
    studyId: string,
    entry: StudyEntry,
    range: { from: number; to: number } | null,
    price: { from: number; to: number } | null,
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
        const key = `${studyId}|m|${marker.id}|${point.time}`;
        out.set(key, {
          key,
          sig: JSON.stringify([point.time, point.price, point.color, point.text, marker.glyph]),
          create: () => this.createMarker(marker, point),
        });
      }
    }

    for (const drawing of entry.visuals.drawings) {
      if (count >= MAX_SHAPES_PER_STUDY) break;
      if (drawing.kind === 'table') continue;
      if (!this.drawingVisible(drawing, inRange)) continue;
      count += 1;
      const key = `${studyId}|d|${drawing.id}`;
      out.set(key, {
        key,
        sig: JSON.stringify(drawing),
        create: () => this.createDrawing(drawing),
      });
    }

    if (price) {
      entry.visuals.backgrounds.forEach((background, index) => {
        if (count >= MAX_SHAPES_PER_STUDY) return;
        if (!this.backgroundVisible(background, range)) return;
        count += 1;
        const key = `${studyId}|bg|${index}`;
        out.set(key, {
          key,
          sig: JSON.stringify([background, price]),
          create: () => this.createBackground(background, price),
        });
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
          out.set(key, {
            key,
            sig: JSON.stringify([bar.time, bar.to, top, bottom, bar.color, bar.borderColor]),
            create: () => this.createCandleBody(bar),
          });
        }
        if (bar.high > bar.low) {
          const key = `${studyId}|c|${candle.id}|${bar.time}|w`;
          out.set(key, {
            key,
            sig: JSON.stringify([bar.time, bar.high, bar.low, bar.wickColor, bar.color]),
            create: () => this.createCandleWick(bar),
          });
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
        out.set(key, {
          key,
          sig: JSON.stringify([bar.time, bar.to, bar.top, bar.bottom, bar.color]),
          create: () => this.createFill(bar),
        });
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

  private baseOptions(): Record<string, unknown> {
    return {
      lock: true,
      disableSelection: true,
      disableSave: true,
      disableUndo: true,
      showInObjectsTree: false,
    };
  }

  private createMarker(
    marker: PineMarkerVisual,
    point: PineVisualPoint & { color?: string; text?: string },
  ): Promise<string> {
    const { shape, text: glyphText } = markerShape(marker.glyph);
    const { hex } = parseColor(point.color);
    const text = point.text ?? glyphText;
    return this.chart.createShape(
      { time: point.time, price: point.price },
      {
        ...this.baseOptions(),
        shape,
        ...(text ? { text } : {}),
        overrides:
          shape === 'text'
            ? { color: hex, fontSize: 11, bold: false }
            : { color: hex, textColor: hex, fontSize: 10 },
      },
    );
  }

  private createDrawing(drawing: PineDrawingVisual): Promise<string> {
    switch (drawing.kind) {
      case 'label': {
        const { hex: background } = parseColor(drawing.color);
        const { hex: textColor } = parseColor(drawing.textColor);
        return this.chart.createShape(
          { time: drawing.time, price: drawing.price },
          {
            ...this.baseOptions(),
            shape: 'text',
            text: drawing.text,
            overrides: {
              color: textColor,
              backgroundColor: background,
              transparency: transparency(drawing.color),
              fontSize: 11,
            },
          },
        );
      }
      case 'line': {
        const { hex } = parseColor(drawing.color);
        const [from, to] = drawing.points;
        const horizontal = Math.abs(from.price - to.price) < 1e-9;
        const overrides = {
          color: hex,
          linecolor: hex,
          linewidth: drawing.width ?? 1,
          linestyle: drawing.dashed ? 2 : 0,
          transparency: transparency(drawing.color),
          extendLeft: drawing.extend === 'left' || drawing.extend === 'both',
          extendRight: drawing.extend === 'right' || drawing.extend === 'both',
        };
        if (horizontal) {
          return this.chart.createShape(
            { time: from.time, price: from.price },
            {
              ...this.baseOptions(),
              shape: 'horizontal_line',
              overrides,
            },
          );
        }
        return this.chart.createMultipointShape([from, to], {
          ...this.baseOptions(),
          shape: 'trend_line',
          overrides,
        });
      }
      case 'box': {
        const { hex: border } = parseColor(drawing.borderColor);
        const { hex: fill } = parseColor(drawing.bgColor);
        return this.chart.createMultipointShape([drawing.top, drawing.bottom], {
          ...this.baseOptions(),
          shape: 'rectangle',
          overrides: {
            color: border,
            backgroundColor: fill,
            fillBackground: Boolean(drawing.bgColor),
            transparency: drawing.bgColor ? transparency(drawing.bgColor) : 0,
            linewidth: drawing.borderWidth ?? 1,
            linestyle: 0,
          },
        });
      }
      case 'polyline': {
        const { hex } = parseColor(drawing.color);
        return this.chart.createMultipointShape(drawing.points, {
          ...this.baseOptions(),
          shape: 'polyline',
          overrides: {
            color: hex,
            linecolor: hex,
            linewidth: drawing.width ?? 1,
          },
        });
      }
      case 'table':
        // 表格走 HTML 覆盖层，见 renderTables()
        return Promise.reject(new Error('table is rendered as HTML'));
    }
  }

  private createBackground(
    background: PineBackgroundVisual,
    price: { from: number; to: number },
  ): Promise<string> {
    const { hex } = parseColor(background.color);
    return this.chart.createMultipointShape(
      [
        { time: background.from, price: price.to },
        { time: background.to, price: price.from },
      ],
      {
        ...this.baseOptions(),
        shape: 'rectangle',
        zOrder: 'bottom',
        overrides: {
          color: hex,
          backgroundColor: hex,
          fillBackground: true,
          transparency: transparency(background.color),
          linewidth: 0,
          linestyle: 0,
        },
      },
    );
  }

  /** plotcandle/plotbar 的实体：图库不允许逐根改蜡烛颜色，用矩形盖在原生蜡烛上 */
  private createCandleBody(bar: PineCandleBar): Promise<string> {
    const { hex: body } = parseColor(bar.color);
    const { hex: border } = parseColor(bar.borderColor ?? bar.color);
    return this.chart.createMultipointShape(
      [
        { time: bar.time, price: Math.max(bar.open, bar.close) },
        { time: bar.to, price: Math.min(bar.open, bar.close) },
      ],
      {
        ...this.baseOptions(),
        shape: 'rectangle',
        overrides: {
          color: border,
          backgroundColor: body,
          fillBackground: true,
          transparency: transparency(bar.color),
          linewidth: 1,
          linestyle: 0,
        },
      },
    );
  }

  private createCandleWick(bar: PineCandleBar): Promise<string> {
    const source = bar.wickColor ?? bar.color;
    const { hex } = parseColor(source);
    return this.chart.createMultipointShape(
      [
        { time: bar.time, price: bar.high },
        { time: bar.time, price: bar.low },
      ],
      {
        ...this.baseOptions(),
        shape: 'trend_line',
        overrides: {
          color: hex,
          linecolor: hex,
          linewidth: 1,
          linestyle: 0,
          transparency: transparency(source),
        },
      },
    );
  }

  /** fill：逐 bar 一条矩形色带，放在底层，不挡住蜡烛和曲线 */
  private createFill(bar: PineFillBar): Promise<string> {
    const { hex } = parseColor(bar.color);
    return this.chart.createMultipointShape(
      [
        { time: bar.time, price: bar.top },
        { time: bar.to, price: bar.bottom },
      ],
      {
        ...this.baseOptions(),
        shape: 'rectangle',
        zOrder: 'bottom',
        overrides: {
          color: hex,
          backgroundColor: hex,
          fillBackground: true,
          transparency: transparency(bar.color),
          linewidth: 0,
          linestyle: 0,
        },
      },
    );
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
