import type {
  EntityId,
  IChartWidgetApi,
  IChartingLibraryWidget,
} from '../../../public/charting_library/charting_library';
import type { CalendarEvent } from '../../gateway/types';

const DAY = 86_400;
/** 可视范围两侧各多画一天，滚动时不会突然出现/消失 */
const PAD_SEC = DAY;

const COLORS: Record<string, string> = {
  High: '#e5484d',
  Medium: '#f5a524',
  Low: '#8b93a7',
};

interface Drawn {
  id: EntityId;
  ts: number;
}

/**
 * 在图表上把财经事件画成竖线：只标注与当前品种货币相关的高/中影响事件，
 * 并且只画可视范围附近的，避免一次创建几百个绘图对象。
 */
export class CalendarLayer {
  private chart: IChartWidgetApi;
  private drawn = new Map<string, Drawn>();
  /** 已经发出创建请求、还没拿到 id 的事件；防止滚动时重复画线 */
  private pending = new Set<string>();
  private events: CalendarEvent[] = [];
  private currencies: string[] = [];
  private timer: number | null = null;
  private disposed = false;

  constructor(
    widget: IChartingLibraryWidget,
    private price: () => number,
  ) {
    this.chart = widget.activeChart();
  }

  start(): void {
    this.chart
      .onVisibleRangeChanged()
      .subscribe(this, () => this.schedule());
  }

  setEvents(events: CalendarEvent[], currencies: string[]): void {
    this.events = events;
    this.currencies = currencies;
    this.render();
  }

  private schedule(): void {
    if (this.timer != null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.render();
    }, 400);
  }

  private visible(): { from: number; to: number } | null {
    try {
      const range = this.chart.getVisibleRange();
      return { from: Number(range.from), to: Number(range.to) };
    } catch {
      return null;
    }
  }

  private removeShape(id: EntityId): void {
    try {
      this.chart.removeEntity(id);
    } catch {
      /* 已经不存在 */
    }
  }

  private render(): void {
    if (this.disposed) return;
    const range = this.visible();
    if (!range) return;
    const price = this.price() || 0;
    const wanted = this.events.filter(
      (event) =>
        event.impact !== 'Low' &&
        event.impact !== 'Holiday' &&
        this.currencies.includes(event.country) &&
        event.ts >= range.from - PAD_SEC &&
        event.ts <= range.to + PAD_SEC,
    );
    const keys = new Set(wanted.map((event) => event.id));
    for (const [key, drawn] of this.drawn) {
      if (!keys.has(key)) {
        this.removeShape(drawn.id);
        this.drawn.delete(key);
      }
    }
    for (const event of wanted) {
      if (this.drawn.has(event.id) || this.pending.has(event.id)) continue;
      const color = COLORS[event.impact] ?? COLORS.Medium;
      this.pending.add(event.id);
      // 只用竖线标位置。vertical_line 的 text 在图表里会沿竖线旋转 90°，
      // 多个事件时间接近时叠在一起，既看不清也挡住 K 线；事件名在财经日历面板里看。
      void this.chart
        .createMultipointShape([{ time: event.ts, price }], {
          shape: 'vertical_line',
          lock: true,
          disableSelection: true,
          disableSave: true,
          disableUndo: true,
          showInObjectsTree: false,
          zOrder: 'bottom',
          overrides: {
            linecolor: color,
            linewidth: 1,
            linestyle: 2,
          },
        })
        .then((id: EntityId) => {
          this.pending.delete(event.id);
          if (this.disposed) {
            this.removeShape(id);
            return;
          }
          this.drawn.set(event.id, { id, ts: event.ts });
          // 时间在已加载 K 线之外时，库会把点折叠到当前 bar；删掉等滚动后再画
          try {
            const points = this.chart.getShapeById(id)?.getPoints() ?? [];
            if (!points.length || Math.abs(points[0].time - event.ts) > 2) {
              this.removeShape(id);
              this.drawn.delete(event.id);
            }
          } catch {
            /* 刚创建就读不到坐标时留给下次 */
          }
        })
        .catch(() => {
          this.pending.delete(event.id);
        });
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer != null) window.clearTimeout(this.timer);
    try {
      this.chart.onVisibleRangeChanged().unsubscribeAll(this);
    } catch {
      /* ignore */
    }
    for (const drawn of this.drawn.values()) this.removeShape(drawn.id);
    this.drawn.clear();
    this.pending.clear();
  }
}
