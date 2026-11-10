import type {
  EntityId,
  IChartWidgetApi,
  ILineDataSourceApi,
} from '../../../public/charting_library/charting_library';

export interface PriceLineSpec {
  price: number;
  text: string;
  color: string;
  /** 允许用户用鼠标上下拖动，默认 true */
  editable?: boolean;
  /** 是否在价格轴上显示价格标签，默认 true；引导线设为 false */
  showPrice?: boolean;
  /** 用户拖动结束后回调（价格已按最小变动价位取整） */
  onMove?: (price: number) => void;
}

interface Entry {
  key: string;
  id: EntityId;
  api: ILineDataSourceApi;
  price: number;
  text: string;
  color: string;
  editable: boolean;
  showPrice: boolean;
  time: number;
  /** 用户刚拖过线，在这之前不要用旧数据把它拉回去（等券商回执） */
  holdUntil: number;
  onMove?: (price: number) => void;
}

const EPS = 1e-9;
const POLL_MS = 200;

/**
 * 这个 Charting Library 包里的 createOrderLine/createPositionLine 会直接抛
 * “only available on Trading Platform”（券商版才有），所以下单线改用绘图层实现：
 * 一条 horizontal_line + 价格标签，用户照样可以上下拖动。
 *
 * 拖动结束没有回调，只能轮询 getPoints() 来发现用户把线拖到了哪里。
 */
export class PriceLineLayer {
  private entries = new Map<string, Entry>();
  private specs = new Map<string, PriceLineSpec>();
  private queue: Promise<void> = Promise.resolve();
  private timer: number | null = null;
  private disposed = false;
  private lastResync = 0;
  private lostCount = 0;
  /** 拖完线后取消选中，否则图表会在线上画「添加文字」占位 */
  private deselectAt = 0;

  constructor(
    private chart: IChartWidgetApi,
    private round: (price: number) => number,
  ) {}

  start(): void {
    if (this.timer != null || this.disposed) return;
    this.timer = window.setInterval(() => this.poll(), POLL_MS);
  }

  /** 用一份完整的规格表同步图表上的线（新增/更新/删除） */
  sync(specs: Map<string, PriceLineSpec>): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.specs = new Map(specs);
    this.lostCount = 0;
    this.queue = this.queue
      .then(() => this.apply(this.specs))
      .catch(() => {});
    return this.queue;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer != null) window.clearInterval(this.timer);
    this.timer = null;
    for (const entry of [...this.entries.values()]) this.remove(entry);
    this.entries.clear();
    this.specs.clear();
  }

  private async apply(specs: Map<string, PriceLineSpec>): Promise<void> {
    if (this.disposed) return;
    for (const entry of [...this.entries.values()]) {
      if (!specs.has(entry.key)) this.remove(entry);
    }
    for (const [key, spec] of specs) {
      if (this.disposed) return;
      const entry = this.entries.get(key);
      if (!entry) {
        await this.create(key, spec);
        continue;
      }
      if (Date.now() >= entry.holdUntil) {
        // 线如果已经被用户拖走，等 poll 去上报，这里不要用旧数据覆盖它
        let live = entry.price;
        try {
          live = entry.api.getPoints()?.[0]?.price ?? entry.price;
        } catch {
          live = entry.price;
        }
        if (Math.abs(live - entry.price) < EPS && Math.abs(entry.price - spec.price) > EPS) {
          this.setPrice(entry, spec.price);
        }
      }
      if (entry.text !== spec.text) this.setText(entry, spec.text);
      if (entry.color !== spec.color) this.setColor(entry, spec.color);
      const editable = spec.editable ?? true;
      if (entry.editable !== editable) this.setEditable(entry, editable);
      const showPrice = spec.showPrice ?? true;
      if (entry.showPrice !== showPrice) this.setShowPrice(entry, showPrice);
      entry.onMove = spec.onMove;
    }
  }

  private async create(key: string, spec: PriceLineSpec): Promise<void> {
    const time = Math.floor(Date.now() / 1000);
    let id: EntityId;
    try {
      id = await this.chart.createShape(
        { time, price: spec.price },
        {
          shape: 'horizontal_line',
          text: spec.text,
          lock: false,
          disableSave: true,
          showInObjectsTree: false,
          zOrder: 'top',
        },
      );
    } catch {
      return; // 图表已销毁或该图层不可用
    }
    if (this.disposed) {
      try {
        this.chart.removeEntity(id);
      } catch {
        /* 图表已销毁 */
      }
      return;
    }

    const api = this.chart.getShapeById(id);
    let price = spec.price;
    let pointTime = time;
    try {
      const points = api.getPoints();
      if (points?.[0]) {
        price = points[0].price;
        pointTime = Number(points[0].time) || time;
      }
    } catch {
      /* 新线还没有点，用创建时的值 */
    }

    const entry: Entry = {
      key,
      id,
      api,
      price,
      text: '',
      color: '',
      editable: true,
      showPrice: true,
      time: pointTime,
      holdUntil: 0,
      onMove: spec.onMove,
    };
    this.entries.set(key, entry);
    this.setColor(entry, spec.color);
    this.setText(entry, spec.text);
    if (spec.editable === false) this.setEditable(entry, false);
    if (spec.showPrice === false) this.setShowPrice(entry, false);
  }

  private setPrice(entry: Entry, price: number): void {
    try {
      entry.api.setPoints([{ time: entry.time, price }]);
      entry.price = price;
    } catch {
      this.remove(entry);
    }
  }

  private setText(entry: Entry, text: string): void {
    try {
      entry.api.setProperties({ text });
      entry.text = text;
    } catch {
      this.remove(entry);
    }
  }

  private setColor(entry: Entry, color: string): void {
    try {
      entry.api.setProperties({
        linecolor: color,
        textcolor: color,
        linewidth: 1,
      });
      entry.color = color;
    } catch {
      this.remove(entry);
    }
  }

  private setShowPrice(entry: Entry, showPrice: boolean): void {
    try {
      entry.api.setProperties({ showPrice });
      entry.showPrice = showPrice;
    } catch {
      this.remove(entry);
    }
  }

  private setEditable(entry: Entry, editable: boolean): void {
    try {
      entry.api.setUserEditEnabled(editable);
      entry.editable = editable;
    } catch {
      this.remove(entry);
    }
  }

  private remove(entry: Entry): void {
    this.entries.delete(entry.key);
    try {
      this.chart.removeEntity(entry.id);
    } catch {
      /* 图表已销毁 */
    }
  }

  /** 用户拖动后没有事件，只能轮询线自己的位置 */
  private poll(): void {
    if (this.disposed || this.entries.size === 0) return;
    let lost = false;
    for (const entry of [...this.entries.values()]) {
      let price: number | null = null;
      try {
        price = entry.api.getPoints()?.[0]?.price ?? null;
      } catch {
        price = null;
      }
      if (price == null) {
        this.remove(entry);
        lost = true;
        continue;
      }
      if (Math.abs(price - entry.price) < EPS) continue;
      entry.price = price;
      entry.holdUntil = Date.now() + 1500;
      this.deselectAt = Date.now() + 700;
      entry.onMove?.(this.round(price));
    }
    if (this.deselectAt && Date.now() >= this.deselectAt) {
      this.deselectAt = 0;
      try {
        const api = this.chart as unknown as {
          selection?: () => { clear?: () => void } | null;
        };
        api.selection?.()?.clear?.();
      } catch {
        /* 接口不存在就算了，只是多一行提示文字 */
      }
    }
    if (lost && !this.disposed) {
      // 被用户删掉了（例如 Ctrl+Z），重建一次；连续失败时不要无限重建
      this.lostCount += 1;
      if (this.lostCount <= 3 && Date.now() - this.lastResync > 2000) {
        this.lastResync = Date.now();
        this.queue = this.queue.then(() => this.apply(this.specs)).catch(() => {});
      }
    }
  }
}
