import { gateway } from '../../gateway/client';
import type { Bar } from '../../gateway/types';
import {
  PRO_STUDY_DESCRIPTION,
  SESSION_DEFS,
  chartServerOffset,
  nyWall,
  type NyWall,
} from './studies';
import type {
  EntityId,
  IChartWidgetApi,
  IChartingLibraryWidget,
  IStudyApi,
} from '../../../public/charting_library/charting_library';

/**
 * 把「NQ & GC 专业交易时段与关键位」指标里的时段画成真正的箱体。
 *
 * Charting Library 的自定义指标只能返回折线，画不出带填充/虚框/标签的矩形，
 * 所以这里用绘图对象（createMultipointShape 的 rectangle）复刻原 Pine 的 box：
 * 半透明填充、虚线边框、顶部居中标签、可选中线；时段开关仍然在指标设置里，
 * 本管理器轮询指标输入，按开关增减箱体。
 *
 * 箱体不保存进图表布局（disableSave），指标被删掉时一起清掉。
 */

const HISTORY_COUNT = 5000;
const POLL_MS = 1000;
const LIVE_THROTTLE_MS = 350;
/**
 * 只画可视范围附近多一点的箱子：一是避免老数据上几千个绘图对象，
 * 二是图表库对「已加载 K 线范围之外」的绘图时间会回退成同一个时间点。
 */
const VISIBLE_PAD_SEC = 2 * 24 * 3600;
const DAY_SEC = 86_400;
/** 创建后回读坐标的容差（秒）：超出已加载范围时库会把点折叠到当前 bar */
const POINT_TOLERANCE = 2;

const RECT_OVERRIDES = {
  transparency: 90,
  fillBackground: true,
  linestyle: 2,
  linewidth: 1,
  fontSize: 11,
  bold: true,
  horzLabelsAlign: 'center',
  // 矩形文字的对齐是相对箱体另一端算的：'bottom' 才会把标签放在上沿
  vertLabelsAlign: 'bottom',
} as const;

interface SessionBox {
  /** session 序号 + 纽约日期，用来跟已经画好的箱子对上 */
  key: string;
  session: number;
  start: number;
  end: number;
  high: number;
  low: number;
  live: boolean;
}

interface DrawnBox {
  id: EntityId;
  start: number;
  end: number;
  high: number;
  low: number;
  text: string;
  middleLine: boolean;
}

interface Occurrence {
  start: number;
  end: number;
  high: number;
  low: number;
  firstBar: number;
}

function barSeconds(resolution: string): number {
  return /^\d+$/.test(resolution) ? Number(resolution) * 60 : 0;
}

/**
 * 纽约墙上时间 -> 真正的 UTC 时间戳（秒）。用 nyWall 反推，自动处理夏令时；
 * minutes 可以是 1440（表示次日 00:00）。
 */
function nyToUtc(year: number, month: number, day: number, minutes: number): number {
  const targetMinutes = Date.UTC(year, month - 1, day, 0, 0) / 60_000 + minutes;
  let guess = targetMinutes * 60;
  for (let index = 0; index < 3; index += 1) {
    const wall = nyWall(guess);
    const wallMinutes =
      Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) / 60_000;
    const diff = targetMinutes - wallMinutes;
    if (diff === 0) break;
    guess += diff * 60;
  }
  return guess;
}

function fmtPoints(range: number): string {
  if (range >= 10) return range.toFixed(1);
  if (range >= 1) return range.toFixed(2);
  return range.toFixed(4);
}

function hhmm(minutes: number): string {
  const hour = Math.floor(minutes / 60) % 24;
  const minute = minutes % 60;
  return `${String(hour).padStart(2, '0')}${String(minute).padStart(2, '0')}`;
}

function boxLabel(box: SessionBox): string {
  const def = SESSION_DEFS[box.session];
  if (box.live) return `${def.en} ${hhmm(def.start)}-${hhmm(def.end)}`;
  return `${def.en} ${fmtPoints(box.high - box.low)} pts`;
}

export class SessionBoxManager {
  private readonly widget: IChartingLibraryWidget;

  private pollTimer = 0;
  private redrawTimer = 0;
  private disposed = false;

  private bars: Bar[] | null = null;
  private barSymbol = '';
  private barResolution = '';
  private barOffset = Number.NaN;
  private fetchSeq = 0;

  private inputs: Record<string, unknown> = {};
  private drawn = new Map<string, DrawnBox>();
  private pending = new Set<string>();
  /**
   * 箱体按时间从早到晚创建：某个时间点画不出来，说明它已经在图表已加载的
   * K 线之外，比它更早的也不用再试，等用户平移触发重新加载后再试。
   */
  private skipOlderThan = -Infinity;
  /** 同一根 bar 的纽约时间只算一次（Intl 比较慢） */
  private wallCache = new Map<number, NyWall>();

  private readonly unsubs: (() => void)[] = [];
  private offBar: (() => void) | null = null;

  constructor(widget: IChartingLibraryWidget) {
    this.widget = widget;
  }

  start(): void {
    if (this.disposed) return;
    const chart = this.chart();
    if (chart) {
      const visibleSub = chart.onVisibleRangeChanged();
      const onVisible = () => {
        // 平移/缩放后图表可能补载了更早的 K 线，重新尝试所有箱体
        this.skipOlderThan = -Infinity;
        this.scheduleRedraw();
      };
      visibleSub.subscribe(null, onVisible);
      this.unsubs.push(() => visibleSub.unsubscribe(null, onVisible));

      const symbolSub = chart.onSymbolChanged();
      const onSymbol = () => this.scheduleRedraw();
      symbolSub.subscribe(null, onSymbol);
      this.unsubs.push(() => symbolSub.unsubscribe(null, onSymbol));

      const intervalSub = chart.onIntervalChanged();
      const onInterval = () => this.scheduleRedraw();
      intervalSub.subscribe(null, onInterval);
      this.unsubs.push(() => intervalSub.unsubscribe(null, onInterval));
    }

    const onStudy = () => this.tick();
    this.widget.subscribe('study', onStudy);
    this.unsubs.push(() => this.widget.unsubscribe('study', onStudy));

    this.offBar = gateway.on('bar', (data) => this.onBar(data));
    this.pollTimer = window.setInterval(() => this.tick(), POLL_MS);
    this.tick();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.clearInterval(this.pollTimer);
    window.clearTimeout(this.redrawTimer);
    this.pollTimer = 0;
    this.redrawTimer = 0;
    for (const off of this.unsubs) {
      try {
        off();
      } catch {
        /* 图表已经销毁 */
      }
    }
    this.unsubs.length = 0;
    this.offBar?.();
    this.offBar = null;
    this.clear();
  }

  private chart(): IChartWidgetApi | null {
    try {
      return this.widget.activeChart();
    } catch {
      return null;
    }
  }

  private findStudy(chart: IChartWidgetApi): { id: EntityId; api: IStudyApi } | null {
    let studies;
    try {
      studies = chart.getAllStudies();
    } catch {
      return null;
    }
    const info = studies.find((item) => item.name === PRO_STUDY_DESCRIPTION);
    if (!info) return null;
    try {
      return { id: info.id, api: chart.getStudyById(info.id) };
    } catch {
      return null;
    }
  }

  /** 指标在图上时每秒检查一次：开关、隐藏、删除、品种/周期变化都在这里发现 */
  private tick(): void {
    if (this.disposed) return;
    const chart = this.chart();
    if (!chart) return;
    const study = this.findStudy(chart);
    if (!study) {
      this.clear();
      return;
    }

    let visible = true;
    try {
      visible = study.api.isVisible();
    } catch {
      visible = true;
    }
    if (!visible) {
      this.clear();
      return;
    }

    let resolution = '';
    let symbol = '';
    try {
      resolution = String(chart.resolution());
      symbol = chart.symbol();
    } catch {
      return;
    }
    if (!barSeconds(resolution)) {
      // 日线及以上没有盘内时段
      this.clear();
      return;
    }

    if (!this.readInputs(study.api)) {
      this.clear();
      return;
    }

    if (symbol && resolution && (symbol !== this.barSymbol || resolution !== this.barResolution)) {
      void this.fetchBars(symbol, resolution);
    }
    this.redraw();
  }

  private readInputs(study: IStudyApi): boolean {
    try {
      const values: Record<string, unknown> = {};
      for (const item of study.getInputValues()) values[String(item.id)] = item.value;
      this.inputs = values;
      return true;
    } catch {
      return false;
    }
  }

  private enabledSessions(): boolean[] {
    return SESSION_DEFS.map((_, index) => Boolean(this.inputs[`in_${index}`] ?? true));
  }

  private showMidline(): boolean {
    return Boolean(this.inputs.in_5 ?? true);
  }

  private async fetchBars(symbol: string, resolution: string): Promise<void> {
    if (this.disposed) return;
    const seq = ++this.fetchSeq;
    this.barSymbol = symbol;
    this.barResolution = resolution;
    this.bars = null;
    this.clear();
    try {
      const result = await gateway.call<{ bars: Bar[] }>('history.get', {
        symbol,
        resolution,
        count: HISTORY_COUNT,
      });
      if (this.disposed || seq !== this.fetchSeq) return;
      this.bars = result.bars;
      this.wallCache.clear();
      this.barOffset = chartServerOffset();
      this.redraw();
    } catch {
      if (this.disposed || seq !== this.fetchSeq) return;
      this.bars = [];
      this.barOffset = chartServerOffset();
    }
  }

  private onBar(data: unknown): void {
    if (this.disposed || !this.bars) return;
    const payload = data as { symbol?: string; resolution?: string; bar?: Bar };
    if (!payload.bar) return;
    if (payload.symbol !== this.barSymbol || payload.resolution !== this.barResolution) return;
    const bar = payload.bar;
    const last = this.bars[this.bars.length - 1];
    if (last && bar.time === last.time) this.bars[this.bars.length - 1] = bar;
    else if (!last || bar.time > last.time) this.bars.push(bar);
    else return;
    this.scheduleRedraw();
  }

  private scheduleRedraw(): void {
    if (this.disposed || this.redrawTimer) return;
    this.redrawTimer = window.setTimeout(() => {
      this.redrawTimer = 0;
      this.redraw();
    }, LIVE_THROTTLE_MS);
  }

  private wall(time: number): NyWall {
    const utc = time - this.barOffset;
    let value = this.wallCache.get(utc);
    if (!value) {
      value = nyWall(utc);
      if (this.wallCache.size > 20_000) this.wallCache.clear();
      this.wallCache.set(utc, value);
    }
    return value;
  }

  /** 从 K 线里统计每个时段的开高低，生成要画的箱体 */
  private computeBoxes(bars: Bar[], enabled: boolean[], chart: IChartWidgetApi): SessionBox[] {
    if (bars.length === 0) return [];
    const barSec = barSeconds(this.barResolution);
    const last = bars[bars.length - 1];
    const first = bars[0];

    let visibleFrom = last.time - 2 * DAY_SEC;
    let visibleTo = last.time + DAY_SEC;
    try {
      const range = chart.getVisibleRange();
      visibleFrom = range.from - VISIBLE_PAD_SEC;
      visibleTo = range.to + DAY_SEC;
    } catch {
      /* 图表还没准备好 */
    }

    const found = new Map<string, Occurrence>();
    for (const bar of bars) {
      const wall = this.wall(bar.time);
      const minutes = wall.hour * 60 + wall.minute;
      const dateKey = `${wall.year}-${wall.month}-${wall.day}`;
      for (let index = 0; index < SESSION_DEFS.length; index += 1) {
        if (!enabled[index]) continue;
        const def = SESSION_DEFS[index];
        if (minutes < def.start || minutes >= def.end) continue;
        const key = `${index}:${dateKey}`;
        const slot = found.get(key);
        if (!slot) {
          found.set(key, {
            start: nyToUtc(wall.year, wall.month, wall.day, def.start),
            end: nyToUtc(wall.year, wall.month, wall.day, def.end),
            high: bar.high,
            low: bar.low,
            firstBar: bar.time,
          });
        } else {
          slot.high = Math.max(slot.high, bar.high);
          slot.low = Math.min(slot.low, bar.low);
        }
      }
    }

    const boxes: SessionBox[] = [];
    for (const [key, slot] of found) {
      if (!Number.isFinite(this.barOffset)) continue;
      const session = Number(key.slice(0, key.indexOf(':')));
      const start = slot.start + this.barOffset;
      const end = slot.end + this.barOffset;
      // 取到的第一根 K 线就在时段中间：左边是残缺的，不画
      if (slot.firstBar === first.time && start < first.time) continue;
      if (end < visibleFrom || start > visibleTo) continue;

      const live = last.time >= start && last.time < end;
      boxes.push({
        key,
        session,
        start,
        end: live ? Math.min(last.time + barSec, end) : end,
        high: slot.high,
        low: slot.low,
        live,
      });
    }
    return boxes;
  }

  private redraw(): void {
    if (this.disposed) return;
    const chart = this.chart();
    if (!chart) return;
    const study = this.findStudy(chart);
    if (!study) {
      this.clear();
      return;
    }
    if (!this.bars) return;
    const offset = chartServerOffset();
    if (offset !== this.barOffset) {
      this.barOffset = offset;
      this.wallCache.clear();
    }

    const boxes = this.computeBoxes(this.bars, this.enabledSessions(), chart);
    const showMid = this.showMidline();
    const keep = new Set<string>();

    for (const box of boxes) {
      keep.add(box.key);
      const text = boxLabel(box);
      const existing = this.drawn.get(box.key);
      if (existing) {
        try {
          if (
            existing.start !== box.start ||
            existing.end !== box.end ||
            existing.high !== box.high ||
            existing.low !== box.low
          ) {
            const shape = chart.getShapeById(existing.id);
            if (!shape) throw new Error('gone');
            shape.setPoints([
              { time: box.start, price: box.high },
              { time: box.end, price: box.low },
            ]);
            // 时间落在图表已加载的 K 线之外时，库会把两个点折叠到同一根 bar 上；
            // 回读确认，画不出来就先移除，等用户平移加载数据后重画。
            const points = shape.getPoints();
            if (!this.pointsMatch(points, box)) throw new Error('out of range');
            existing.start = box.start;
            existing.end = box.end;
            existing.high = box.high;
            existing.low = box.low;
          }
          if (existing.text !== text || existing.middleLine !== showMid) {
            const shape = chart.getShapeById(existing.id);
            if (!shape) throw new Error('gone');
            shape.setProperties({
              text,
              middleLine: {
                showLine: showMid,
                lineColor: SESSION_DEFS[box.session].color,
                lineStyle: 1,
                lineWidth: 1,
              },
            });
            existing.text = text;
            existing.middleLine = showMid;
          }
          continue;
        } catch {
          // 布局重载/绘图被清掉了：丢掉引用重新画
          this.drawn.delete(box.key);
          try {
            chart.removeEntity(existing.id);
          } catch {
            /* 已经没了 */
          }
        }
      }
      if (this.pending.has(box.key) || box.end <= this.skipOlderThan) continue;
      this.create(chart, box, text, showMid);
    }

    for (const [key, shape] of this.drawn) {
      if (keep.has(key)) continue;
      this.drawn.delete(key);
      try {
        chart.removeEntity(shape.id);
      } catch {
        /* 已经没了 */
      }
    }
  }

  private pointsMatch(points: { time: number }[], box: SessionBox): boolean {
    return (
      points.length >= 2 &&
      Math.abs(points[0].time - box.start) <= POINT_TOLERANCE &&
      Math.abs(points[1].time - box.end) <= POINT_TOLERANCE
    );
  }

  private create(chart: IChartWidgetApi, box: SessionBox, text: string, showMid: boolean): void {
    const color = SESSION_DEFS[box.session].color;
    this.pending.add(box.key);
    chart
      .createMultipointShape(
        [
          { time: box.start, price: box.high },
          { time: box.end, price: box.low },
        ],
        {
          shape: 'rectangle',
          text,
          lock: true,
          disableSelection: true,
          disableSave: true,
          disableUndo: true,
          showInObjectsTree: false,
          zOrder: 'bottom',
          overrides: {
            ...RECT_OVERRIDES,
            color,
            backgroundColor: color,
            textColor: color,
            middleLine: {
              showLine: showMid,
              lineColor: color,
              lineStyle: 1,
              lineWidth: 1,
            },
          },
        },
      )
      .then((id: EntityId) => {
        this.pending.delete(box.key);
        let points: { time: number }[] | null = null;
        try {
          points = chart.getShapeById(id)?.getPoints() ?? null;
        } catch {
          points = null;
        }
        if (this.disposed || !points || !this.pointsMatch(points, box)) {
          // 画出来是折叠的（时间在已加载 K 线之外），删掉等下次重画
          if (!this.disposed) this.skipOlderThan = Math.max(this.skipOlderThan, box.end);
          try {
            chart.removeEntity(id);
          } catch {
            /* 图表已经销毁 */
          }
          return;
        }
        this.drawn.set(box.key, {
          id,
          start: box.start,
          end: box.end,
          high: box.high,
          low: box.low,
          text,
          middleLine: showMid,
        });
      })
      .catch(() => {
        this.pending.delete(box.key);
      });
  }

  private clear(): void {
    const chart = this.chart();
    for (const shape of this.drawn.values()) {
      if (!chart) break;
      try {
        chart.removeEntity(shape.id);
      } catch {
        /* 图表已经销毁 */
      }
    }
    this.drawn.clear();
    this.pending.clear();
    this.skipOlderThan = -Infinity;
  }
}
