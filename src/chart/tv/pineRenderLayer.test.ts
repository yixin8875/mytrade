import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PineVisuals } from './pineEngine';
import { PineRenderLayer, type PineShapeApi, type PineShapePoint } from './pineRenderLayer';

const START = Date.UTC(2024, 0, 1) / 1000;
const BAR = 300;

function emptyVisuals(): PineVisuals {
  return { markers: [], drawings: [], backgrounds: [], candles: [], fills: [], unsupported: [] };
}

interface CreatedShape {
  point?: PineShapePoint;
  points?: PineShapePoint[];
  options: Record<string, unknown>;
}

class FakeChart implements PineShapeApi {
  shapes = new Map<string, CreatedShape>();
  removed: string[] = [];
  range = { from: START - 1e6, to: START + 1e6 };
  price = { from: 90, to: 110 };
  subscribeCount = 0;
  private seq = 0;

  async createShape(point: PineShapePoint, options: Record<string, unknown>): Promise<string> {
    const id = `s${++this.seq}`;
    this.shapes.set(id, { point, options });
    return id;
  }

  async createMultipointShape(
    points: PineShapePoint[],
    options: Record<string, unknown>,
  ): Promise<string> {
    const id = `m${++this.seq}`;
    this.shapes.set(id, { points, options });
    return id;
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
      },
      {
        id: '3',
        kind: 'box',
        top: { time: START, price: 106 },
        bottom: { time: START + BAR * 4, price: 99 },
        borderColor: '#787B86',
        bgColor: '#787B8619',
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
      transparency: 50,
    });

    const line = created.find((shape) => optionsOf(shape).shape === 'trend_line');
    expect(line?.points).toHaveLength(2);
    expect(optionsOf(line).overrides).toMatchObject({ linecolor: '#2962FF', linewidth: 2 });

    const box = created.find((shape) => optionsOf(shape).shape === 'rectangle');
    expect(box?.points).toEqual([
      { time: START, price: 106 },
      { time: START + BAR * 4, price: 99 },
    ]);
    expect(optionsOf(box).overrides).toMatchObject({
      fillBackground: true,
      transparency: 90,
    });
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
