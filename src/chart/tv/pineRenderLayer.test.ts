import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PineVisuals } from './pineEngine';
import { PineRenderLayer, type PineShapeApi, type PineShapePoint } from './pineRenderLayer';

const START = Date.UTC(2024, 0, 1) / 1000;
const BAR = 300;

function emptyVisuals(): PineVisuals {
  return { markers: [], drawings: [], backgrounds: [], candles: [], fills: [], unsupported: [] };
}

interface CreatedShape {
  single: boolean;
  point?: PineShapePoint;
  points?: PineShapePoint[];
  options: Record<string, unknown>;
  /** 图表库绘图对象当前的属性（setProperties 会合并进来） */
  properties: Record<string, unknown>;
  setPointsCalls: PineShapePoint[][];
  setPropsCalls: Record<string, unknown>[];
}

class FakeChart implements PineShapeApi {
  shapes = new Map<string, CreatedShape>();
  removed: string[] = [];
  range = { from: START - 1e6, to: START + 1e6 };
  price = { from: 90, to: 110 };
  subscribeCount = 0;
  private seq = 0;

  private addShape(points: PineShapePoint[], options: Record<string, unknown>): CreatedShape {
    return {
      single: points.length === 1,
      ...(points.length === 1 ? { point: points[0] } : {}),
      ...(points.length > 1 ? { points } : {}),
      options,
      properties: {
        ...((options.overrides as Record<string, unknown> | undefined) ?? {}),
        ...(typeof options.text === 'string' ? { text: options.text } : {}),
      },
      setPointsCalls: [],
      setPropsCalls: [],
    };
  }

  async createShape(point: PineShapePoint, options: Record<string, unknown>): Promise<string> {
    const id = `s${++this.seq}`;
    this.shapes.set(id, this.addShape([point], options));
    return id;
  }

  async createMultipointShape(
    points: PineShapePoint[],
    options: Record<string, unknown>,
  ): Promise<string> {
    const id = `m${++this.seq}`;
    this.shapes.set(id, this.addShape(points, options));
    return id;
  }

  getShapeById(id: string) {
    const shape = this.shapes.get(id);
    if (!shape) throw new Error(`There is no such shape: ${id}`);
    return {
      getProperties: () => ({ ...shape.properties }),
      setPoints: (points: PineShapePoint[]) => {
        const required = shape.single ? 1 : (shape.points?.length ?? 0);
        if (points.length !== required) {
          throw new Error(`Wrong points count. Required: ${required}`);
        }
        shape.setPointsCalls.push(points);
        if (shape.single) shape.point = points[0];
        else shape.points = points;
      },
      setProperties: (properties: Record<string, unknown>) => {
        shape.setPropsCalls.push(properties);
        Object.assign(shape.properties, properties);
      },
    };
  }

  removeEntity(id: string): void {
    this.removed.push(id);
    this.shapes.delete(id);
  }

  getVisibleRange(): { from: number; to: number } {
    return this.range;
  }

  getPanes() {
    return [
      {
        getHeight: () => 200,
        getMainSourcePriceScale: () => ({
          getVisiblePriceRange: () => this.price,
        }),
      },
    ];
  }

  onVisibleRangeChanged() {
    this.subscribeCount += 1;
    return { subscribe: () => {}, unsubscribe: () => {} };
  }
}

function optionsOf(shape: CreatedShape | undefined): Record<string, unknown> {
  return (shape?.options ?? {}) as Record<string, unknown>;
}

async function flush(): Promise<void> {
  await vi.runAllTimersAsync();
}

describe('PineRenderLayer', () => {
  let chart: FakeChart;
  let host: HTMLDivElement;
  let layer: PineRenderLayer;

  beforeEach(() => {
    vi.useFakeTimers();
    chart = new FakeChart();
    host = document.createElement('div');
    document.body.appendChild(host);
    layer = new PineRenderLayer(chart, host);
    layer.start();
  });

  afterEach(() => {
    layer.dispose();
    host.remove();
    vi.useRealTimers();
  });

  it('renders plotshape markers at the expected price', async () => {
    const visuals = emptyVisuals();
    visuals.markers.push({
      id: '0',
      glyph: 'triangleup',
      location: 'belowbar',
      points: [{ time: START + BAR * 3, price: 98.5, color: '#08998180' }],
    });

    layer.update('study-1', 'My Script', visuals);
    await flush();

    expect(chart.shapes.size).toBe(1);
    const [shape] = [...chart.shapes.values()];
    expect(optionsOf(shape).shape).toBe('arrow_up');
    expect(shape.point).toEqual({ time: START + BAR * 3, price: 98.5 });
    expect(optionsOf(shape).disableSave).toBe(true);
    expect(optionsOf(shape).showInObjectsTree).toBe(false);
  });

  it('renders plotchar characters instead of the tooltip text', async () => {
    const visuals = emptyVisuals();
    visuals.markers.push({
      id: '0',
      // 任意字符串都要原样显示，不能被 shape 图标映射吞掉
      glyph: 'BUY',
      kind: 'char',
      location: 'abovebar',
      points: [{ time: START + BAR, price: 101, text: 'tooltip only' }],
    });

    layer.update('study-1', 'My Script', visuals);
    await flush();

    // plotchar 的 text 是悬停提示，显示的必须是 char
    const [shape] = [...chart.shapes.values()];
    expect(optionsOf(shape).text).toBe('BUY');
    expect(optionsOf(shape).overrides).toMatchObject({ fontsize: 11 });
  });

  it('pins location.top and location.bottom markers to the pane edges', async () => {
    const visuals = emptyVisuals();
    visuals.markers.push(
      {
        id: '0',
        glyph: 'triangleup',
        location: 'top',
        points: [{ time: START + BAR, price: 99 }],
      },
      {
        id: '1',
        glyph: 'triangledown',
        location: 'bottom',
        points: [{ time: START + BAR * 2, price: 99 }],
      },
    );

    layer.update('study-1', 'My Script', visuals);
    await flush();

    // TradingView 的 location.top/bottom 贴在面板上下沿（此处价格区间 90–110）
    const prices = [...chart.shapes.values()].map((shape) => shape.point?.price).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(prices).toEqual([90, 110]);
  });

  it('attaches drawings to the study so pane indicators stay in their own pane', async () => {
    const visuals = emptyVisuals();
    visuals.markers.push({
      id: '0',
      glyph: 'triangleup',
      location: 'belowbar',
      points: [{ time: START + BAR, price: 99 }],
    });

    layer.update('study-1', 'My Script', visuals);
    await flush();

    const [shape] = [...chart.shapes.values()];
    expect(optionsOf(shape).ownerStudyId).toBe('study-1');
  });

  it('does not recreate unchanged objects or draw outside the visible range', async () => {
    const visuals = emptyVisuals();
    visuals.markers.push({
      id: '0',
      glyph: 'circle',
      location: 'abovebar',
      points: [
        { time: START + BAR, price: 101 },
        { time: START + 90 * 86_400, price: 101 },
      ],
    });

    layer.update('study-1', 'My Script', visuals);
    await flush();
    expect(chart.shapes.size).toBe(1);

    layer.update('study-1', 'My Script', visuals);
    await flush();
    expect(chart.shapes.size).toBe(1);
    expect(chart.removed).toHaveLength(0);
  });

  it('moves existing shapes in place when the price range changes', async () => {
    const visuals = emptyVisuals();
    visuals.backgrounds.push({ from: START, to: START + BAR * 5, color: '#08998133' });

    layer.update('study-1', 'My Script', visuals);
    await flush();
    const [id] = [...chart.shapes.keys()];
    const shape = chart.shapes.get(id)!;

    chart.price = { from: 80, to: 120 };
    layer.update('study-1', 'My Script', visuals);
    await flush();

    // 价格区间变化只改矩形上下沿，不需要删掉重建
    expect(chart.removed).toHaveLength(0);
    expect([...chart.shapes.keys()]).toEqual([id]);
    expect(shape.setPointsCalls.at(-1)).toEqual([
      { time: START, price: 120 },
      { time: START + BAR * 5, price: 80 },
    ]);
  });

  it('updates label text and colors in place', async () => {
    const first = emptyVisuals();
    first.drawings.push({
      id: '1',
      kind: 'label',
      time: START + BAR,
      price: 105,
      text: 'BUY',
      color: '#F2364580',
      textColor: '#FFFFFFFF',
      size: 'small',
    });
    layer.update('study-1', 'My Script', first);
    await flush();
    const [id] = [...chart.shapes.keys()];
    const shape = chart.shapes.get(id)!;

    const second = emptyVisuals();
    second.drawings.push({
      id: '1',
      kind: 'label',
      time: START + BAR,
      price: 105,
      text: 'SELL',
      color: '#F2364580',
      textColor: '#FF0000FF',
      size: 'small',
    });
    layer.update('study-1', 'My Script', second);
    await flush();

    // 同一种 text 工具：setProperties 改文字/颜色即可
    expect(chart.removed).toHaveLength(0);
    expect([...chart.shapes.keys()]).toEqual([id]);
    expect(shape.setPropsCalls.at(-1)).toMatchObject({ text: 'SELL', color: '#FF0000' });
  });

  it('recreates a shape when the drawing tool changes', async () => {
    const first = emptyVisuals();
    first.markers.push({
      id: '0',
      glyph: 'triangleup',
      location: 'belowbar',
      points: [{ time: START + BAR, price: 99 }],
    });
    layer.update('study-1', 'My Script', first);
    await flush();
    const [oldId] = [...chart.shapes.keys()];

    const second = emptyVisuals();
    second.markers.push({
      id: '0',
      glyph: 'circle',
      location: 'belowbar',
      points: [{ time: START + BAR, price: 99 }],
    });
    layer.update('study-1', 'My Script', second);
    await flush();

    // 箭头和文字是两种绘图工具，不能原位改
    expect(chart.removed).toEqual([oldId]);
    expect(chart.shapes.size).toBe(1);
    const [shape] = [...chart.shapes.values()];
    expect(optionsOf(shape).shape).toBe('text');
  });

  it('recreates polylines when the point count changes', async () => {
    const first = emptyVisuals();
    first.drawings.push({
      id: '5',
      kind: 'polyline',
      points: [
        { time: START, price: 100 },
        { time: START + BAR, price: 102 },
      ],
      color: '#2962FF',
      width: 1,
    });
    layer.update('study-1', 'My Script', first);
    await flush();
    const [oldId] = [...chart.shapes.keys()];

    const second = emptyVisuals();
    second.drawings.push({
      id: '5',
      kind: 'polyline',
      points: [
        { time: START, price: 100 },
        { time: START + BAR, price: 102 },
        { time: START + BAR * 2, price: 101 },
      ],
      color: '#2962FF',
      width: 1,
    });
    layer.update('study-1', 'My Script', second);
    await flush();

    // setPoints 要求点数不变，点数变了只能删掉重建
    expect(chart.removed).toEqual([oldId]);
    const [shape] = [...chart.shapes.values()];
    expect(shape.points).toHaveLength(3);
  });

  it('renders label, line and box drawings', async () => {
    const visuals = emptyVisuals();
    visuals.drawings.push(
      {
        id: '1',
        kind: 'label',
        time: START + BAR * 2,
        price: 105,
        text: 'BUY',
        color: '#F2364580',
        textColor: '#FFFFFFFF',
        size: 'small',
      },
      {
        id: '2',
        kind: 'line',
        points: [
          { time: START + BAR, price: 100 },
          { time: START + BAR * 3, price: 104 },
        ],
        color: '#2962FF',
        width: 2,
        style: 'dotted',
      },
      {
        id: '3',
        kind: 'box',
        top: { time: START, price: 106 },
        bottom: { time: START + BAR * 4, price: 99 },
        borderColor: '#787B86',
        bgColor: '#787B8619',
        borderStyle: 'dashed',
      },
    );

    layer.update('study-1', 'My Script', visuals);
    await flush();

    const created = [...chart.shapes.values()];
    expect(created).toHaveLength(3);

    const label = created.find((shape) => shape.point?.time === START + BAR * 2);
    expect(optionsOf(label).shape).toBe('text');
    expect(optionsOf(label).text).toBe('BUY');
    expect(optionsOf(label).overrides).toMatchObject({
      backgroundColor: '#F23645',
      color: '#FFFFFF',
      backgroundTransparency: 50,
      fillBackground: true,
      fontsize: 10,
    });

    const line = created.find((shape) => optionsOf(shape).shape === 'trend_line');
    expect(line?.points).toHaveLength(2);
    expect(optionsOf(line).overrides).toMatchObject({
      linecolor: '#2962FF',
      linewidth: 2,
      linestyle: 1,
    });

    const box = created.find((shape) => optionsOf(shape).shape === 'rectangle');
    expect(box?.points).toEqual([
      { time: START, price: 106 },
      { time: START + BAR * 4, price: 99 },
    ]);
    expect(optionsOf(box).overrides).toMatchObject({
      fillBackground: true,
      transparency: 90,
      linestyle: 2,
    });
  });

  it('places label_down text above the anchor like TradingView', async () => {
    const visuals = emptyVisuals();
    visuals.drawings.push({
      id: '4',
      kind: 'label',
      time: START + BAR * 2,
      price: 105,
      text: 'NY AM\n21.4 pts',
      color: '#FFFFFF00',
      textColor: '#00897BFF',
      style: 'label_down',
      size: 'small',
    });

    layer.update('study-1', 'My Script', visuals);
    await flush();

    const [shape] = [...chart.shapes.values()];
    // 价格区间 90–110、主图 200px -> 0.1 价格/px；两行 10px 文字约 29px 高
    // label_down 的文字应在锚点上方，锚点要抬高约 (29 + 2)px * 0.1
    expect(shape.point?.time).toBe(START + BAR * 2);
    expect(shape.point?.price).toBeCloseTo(108.1, 6);
  });

  it('vertically centers label_left text on the anchor', async () => {
    const visuals = emptyVisuals();
    visuals.drawings.push({
      id: '5',
      kind: 'label',
      time: START + BAR * 2,
      price: 105,
      text: 'PDH',
      color: '#FFFFFF00',
      textColor: '#787B86FF',
      style: 'label_left',
      size: 'tiny',
    });

    layer.update('study-1', 'My Script', visuals);
    await flush();

    // 单行 9px 文字约 15.25px 高，垂直居中 -> 抬高约 7.6px * 0.1
    const [shape] = [...chart.shapes.values()];
    expect(shape.point?.price).toBeCloseTo(105.7625, 6);
  });

  it('keeps the time span of horizontal drawings', async () => {
    const visuals = emptyVisuals();
    visuals.drawings.push({
      id: '7',
      kind: 'line',
      points: [
        { time: START + BAR, price: 100 },
        { time: START + BAR * 5, price: 100 },
      ],
      color: '#787B86',
      width: 1,
      style: 'dashed',
    });

    layer.update('study-1', 'My Script', visuals);
    await flush();

    // horizontal_line 会横跨整个图表宽度，Pine 的 line.new 必须保留 x1/x2
    const [shape] = [...chart.shapes.values()];
    expect(optionsOf(shape).shape).toBe('trend_line');
    expect(shape.points).toEqual([
      { time: START + BAR, price: 100 },
      { time: START + BAR * 5, price: 100 },
    ]);
    expect(optionsOf(shape).overrides).toMatchObject({ linestyle: 2 });
  });

  it('renders bgcolor as a bottom-layer rectangle over the visible price range', async () => {
    const visuals = emptyVisuals();
    visuals.backgrounds.push({ from: START, to: START + BAR * 5, color: '#08998133' });

    layer.update('study-1', 'My Script', visuals);
    await flush();

    const [shape] = [...chart.shapes.values()];
    expect(optionsOf(shape).shape).toBe('rectangle');
    expect(optionsOf(shape).zOrder).toBe('bottom');
    expect(shape.points).toEqual([
      { time: START, price: 110 },
      { time: START + BAR * 5, price: 90 },
    ]);
    expect(optionsOf(shape).overrides).toMatchObject({
      backgroundColor: '#089981',
      transparency: 80,
    });
  });

  it('renders plotcandle bodies and wicks', async () => {
    const visuals = emptyVisuals();
    visuals.candles.push({
      id: '0',
      bars: [
        {
          time: START,
          to: START + BAR,
          open: 100,
          high: 105,
          low: 98,
          close: 103,
          color: '#08998133',
          wickColor: '#089981',
        },
      ],
    });

    layer.update('study-1', 'My Script', visuals);
    await flush();

    const created = [...chart.shapes.values()];
    expect(created).toHaveLength(2);

    const body = created.find((shape) => optionsOf(shape).shape === 'rectangle');
    expect(body?.points).toEqual([
      { time: START, price: 103 },
      { time: START + BAR, price: 100 },
    ]);
    expect(optionsOf(body).overrides).toMatchObject({
      backgroundColor: '#089981',
      transparency: 80,
    });

    const wick = created.find((shape) => optionsOf(shape).shape === 'trend_line');
    expect(wick?.points).toEqual([
      { time: START, price: 105 },
      { time: START, price: 98 },
    ]);
  });

  it('renders barcolor layers and shares the candle budget', async () => {
    const visuals = emptyVisuals();
    const makeBars = (offset: number) =>
      Array.from({ length: 100 }, (_, index) => ({
        time: START + offset + index * BAR,
        to: START + offset + (index + 1) * BAR,
        open: 100,
        high: 101,
        low: 99,
        close: 100.5,
        color: '#F23645FF',
        wickColor: '#F23645FF',
      }));

    visuals.candles.push(
      { id: 'barcolor-0', bars: makeBars(0) },
      { id: 'barcolor-1', bars: makeBars(100 * BAR) },
    );

    layer.update('study-1', 'My Script', visuals);
    await flush();

    // 两个序列共享 150 根预算，每根实体+影线 = 2 个对象
    expect(chart.shapes.size).toBe(300);
    const body = [...chart.shapes.values()].find(
      (shape) => optionsOf(shape).shape === 'rectangle',
    );
    expect(optionsOf(body).overrides).toMatchObject({
      backgroundColor: '#F23645',
      transparency: 0,
    });
  });

  it('renders fill bands as bottom rectangles', async () => {
    const visuals = emptyVisuals();
    visuals.fills.push({
      id: '2',
      bars: [{ time: START, to: START + BAR, top: 105, bottom: 100, color: '#2962FF33' }],
    });

    layer.update('study-1', 'My Script', visuals);
    await flush();

    const [shape] = [...chart.shapes.values()];
    expect(optionsOf(shape).shape).toBe('rectangle');
    expect(optionsOf(shape).zOrder).toBe('bottom');
    expect(shape.points).toEqual([
      { time: START, price: 105 },
      { time: START + BAR, price: 100 },
    ]);
    expect(optionsOf(shape).overrides).toMatchObject({
      backgroundColor: '#2962FF',
      transparency: 80,
    });
  });

  it('renders tables as an HTML overlay', async () => {
    const visuals = emptyVisuals();
    visuals.drawings.push({
      id: '9',
      kind: 'table',
      position: 'top_right',
      rows: 1,
      columns: 2,
      borderWidth: 1,
      cells: [
        { row: 0, column: 0, text: 'RSI', bgColor: '#F2364533' },
        { row: 0, column: 1, text: '62.5' },
      ],
    });

    layer.update('study-1', 'My Script', visuals);
    await flush();

    const root = host.lastElementChild as HTMLElement | null;
    expect(root).not.toBeNull();
    const table = root?.firstElementChild as HTMLElement | null;
    expect(table?.textContent).toBe('RSI62.5');
    expect(table?.style.top).toBe('6px');
    expect(table?.style.right).toBe('72px');
  });

  it('removes shapes when the study is hidden or deleted', async () => {
    const visuals = emptyVisuals();
    visuals.markers.push({
      id: '0',
      glyph: 'triangleup',
      location: 'belowbar',
      points: [{ time: START + BAR, price: 99 }],
    });

    layer.update('study-1', 'My Script', visuals);
    await flush();
    const [id] = [...chart.shapes.keys()];

    layer.setVisible('study-1', false);
    await flush();
    expect(chart.removed).toContain(id);
    expect(chart.shapes.size).toBe(0);

    layer.setVisible('study-1', true);
    await flush();
    expect(chart.shapes.size).toBe(1);

    layer.removeStudy('study-1');
    await flush();
    expect(chart.shapes.size).toBe(0);
  });
});
