import type {
  EntityId,
  IChartWidgetApi,
} from '../../../public/charting_library/charting_library';
import type { Side } from '../../gateway/types';

/**
 * 把一笔实盘交易作为只读参照画在回放图上：
 * 入场/出场箭头、持仓区间底色、持仓期间的止损止盈虚线。
 *
 * 全部用绘图对象实现（disableSave / disableSelection），
 * 不写进图表布局，也不能被拖动；关闭参照层时整组移除。
 */

const UP = '#0f7a55';
const DOWN = '#c2413a';
const RULE = '#9a9286';

export interface ReferenceLayerSpec {
  openTime: number;
  closeTime: number;
  /** 游标处最后一根已回放 M1 的时间 */
  cursorTime: number;
  side: Side;
  entry: number;
  exit: number;
  sl: number | null;
  tp: number | null;
  profit: number;
  volume: number;
  digits: number;
  /** 持仓区间到游标为止的高低价 */
  holdHigh: number;
  holdLow: number;
}

type ShapePoint = { time: number; price: number };
type SingleOptions = Parameters<IChartWidgetApi['createShape']>[1];
type MultiOptions = Parameters<IChartWidgetApi['createMultipointShape']>[1];

interface ShapeSpec {
  key: string;
  kind: 'single' | 'multi';
  points: ShapePoint[];
  options: SingleOptions | MultiOptions;
}

interface DrawnShape {
  id: EntityId;
  points: ShapePoint[];
}

const TIME_EPS = 1;

function samePoints(a: ShapePoint[], b: ShapePoint[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (point, index) =>
      Math.abs(point.time - b[index].time) <= TIME_EPS &&
      Math.abs(point.price - b[index].price) < 1e-9,
  );
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}

function holdingLine(
  key: string,
  from: number,
  to: number,
  price: number,
  color: string,
  text: string,
): ShapeSpec {
  return {
    key,
    kind: 'multi',
    points: [
      { time: from, price },
      { time: to, price },
    ],
    options: {
      shape: 'trend_line',
      text,
      lock: true,
      disableSelection: true,
      disableSave: true,
      disableUndo: true,
      showInObjectsTree: false,
      zOrder: 'top',
      overrides: {
        color,
        textColor: color,
        linestyle: 2,
        linewidth: 1,
        fontSize: 10,
      },
    },
  };
}

function buildShapes(spec: ReferenceLayerSpec): ShapeSpec[] {
  if (spec.cursorTime < spec.openTime) return [];
  const shapes: ShapeSpec[] = [];
  const entryColor = spec.side === 'buy' ? UP : DOWN;
  const sideText = spec.side === 'buy' ? '买入' : '卖出';

  shapes.push({
    key: 'ref:entry',
    kind: 'single',
    points: [{ time: spec.openTime, price: spec.entry }],
    options: {
      shape: spec.side === 'buy' ? 'arrow_up' : 'arrow_down',
      text: `实盘${sideText} ${spec.volume.toFixed(2)} · ${spec.entry.toFixed(spec.digits)}`,
      lock: true,
      disableSelection: true,
      disableSave: true,
      disableUndo: true,
      showInObjectsTree: false,
      zOrder: 'top',
      overrides: { color: entryColor, textColor: entryColor, fontSize: 11 },
    },
  });

  const endTime = Math.min(spec.cursorTime, spec.closeTime);
  if (endTime > spec.openTime) {
    const pad = 1 / 10 ** spec.digits;
    shapes.push({
      key: 'ref:hold',
      kind: 'multi',
      points: [
        { time: spec.openTime, price: spec.holdHigh + pad },
        { time: endTime, price: spec.holdLow - pad },
      ],
      options: {
        shape: 'rectangle',
        lock: true,
        disableSelection: true,
        disableSave: true,
        disableUndo: true,
        showInObjectsTree: false,
        zOrder: 'bottom',
        overrides: {
          color: RULE,
          backgroundColor: RULE,
          transparency: 92,
          fillBackground: true,
          linestyle: 2,
          linewidth: 1,
        },
      },
    });
    if (spec.sl != null && spec.sl > 0) {
      shapes.push(holdingLine('ref:sl', spec.openTime, endTime, spec.sl, DOWN, '实盘止损'));
    }
    if (spec.tp != null && spec.tp > 0) {
      shapes.push(holdingLine('ref:tp', spec.openTime, endTime, spec.tp, UP, '实盘止盈'));
    }
  }

  if (spec.cursorTime >= spec.closeTime) {
    const color = spec.profit >= 0 ? UP : DOWN;
    shapes.push({
      key: 'ref:exit',
      kind: 'single',
      points: [{ time: spec.closeTime, price: spec.exit }],
      options: {
        shape: spec.side === 'buy' ? 'arrow_down' : 'arrow_up',
        text: `实盘出场 ${signed(spec.profit)}`,
        lock: true,
        disableSelection: true,
        disableSave: true,
        disableUndo: true,
        showInObjectsTree: false,
        zOrder: 'top',
        overrides: { color, textColor: color, fontSize: 11 },
      },
    });
  }

  return shapes;
}

export class ReferenceLayer {
  private chart: IChartWidgetApi | null;
  private shapes = new Map<string, DrawnShape>();
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(chart: IChartWidgetApi) {
    this.chart = chart;
  }

  /** 传 null 表示隐藏参照层；只做增量增删/改点 */
  sync(spec: ReferenceLayerSpec | null): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const desired = spec ? buildShapes(spec) : [];
    this.queue = this.queue.then(() => this.apply(desired)).catch(() => {});
    return this.queue;
  }

  dispose(): void {
    this.disposed = true;
    const chart = this.chart;
    for (const shape of this.shapes.values()) {
      try {
        chart?.removeEntity(shape.id);
      } catch {
        /* 图表已销毁 */
      }
    }
    this.shapes.clear();
    this.chart = null;
  }

  private async apply(desired: ShapeSpec[]): Promise<void> {
    const chart = this.chart;
    if (this.disposed || !chart) return;
    const wanted = new Set(desired.map((spec) => spec.key));
    for (const [key, shape] of [...this.shapes]) {
      if (wanted.has(key)) continue;
      try {
        chart.removeEntity(shape.id);
      } catch {
        /* 已被用户或图表删掉 */
      }
      this.shapes.delete(key);
    }
    for (const spec of desired) {
      if (this.disposed || !chart) return;
      const existing = this.shapes.get(spec.key);
      if (existing) {
        if (samePoints(existing.points, spec.points)) continue;
        try {
          chart.getShapeById(existing.id).setPoints(spec.points);
          existing.points = spec.points;
          continue;
        } catch {
          try {
            chart.removeEntity(existing.id);
          } catch {
            /* 图表已销毁 */
          }
          this.shapes.delete(spec.key);
        }
      }
      await this.create(spec);
    }
  }

  private async create(spec: ShapeSpec): Promise<void> {
    const chart = this.chart;
    if (!chart) return;
    let id: EntityId;
    try {
      id =
        spec.kind === 'single'
          ? await chart.createShape(spec.points[0], spec.options as SingleOptions)
          : await chart.createMultipointShape(spec.points, spec.options as MultiOptions);
    } catch {
      return; // 图表已销毁或该形状不可用
    }
    if (this.disposed) {
      try {
        this.chart?.removeEntity(id);
      } catch {
        /* 图表已销毁 */
      }
      return;
    }
    this.shapes.set(spec.key, { id, points: spec.points });
  }
}
