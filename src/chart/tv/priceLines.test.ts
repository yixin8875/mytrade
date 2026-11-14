import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IChartWidgetApi } from '../../../public/charting_library/charting_library';
import { PriceLineLayer, type PriceLineSpec } from './priceLines';

interface FakeShape {
  id: string;
  points: { time: number; price: number }[];
  props: Record<string, unknown>;
  editEnabled: boolean;
  lost: boolean;
}

function fakeChart() {
  let seq = 0;
  const shapes = new Map<string, FakeShape>();

  const chart = {
    createShape: vi.fn(
      async (
        point: { time: number; price: number },
        options: Record<string, unknown>,
      ): Promise<string> => {
        const id = `shape-${(seq += 1)}`;
        shapes.set(id, {
          id,
          points: [{ time: point.time, price: point.price }],
          props: { ...options },
          editEnabled: true,
          lost: false,
        });
        return id;
      },
    ),
    getShapeById: vi.fn((id: string) => {
      const shape = shapes.get(id)!;
      return {
        getPoints: () => {
          if (shape.lost) throw new Error('entity removed');
          return shape.points.map((point) => ({ ...point }));
        },
        setPoints: (points: { time: number; price: number }[]) => {
          if (shape.lost) throw new Error('entity removed');
          shape.points = points.map((point) => ({ ...point }));
        },
        setProperties: (props: Record<string, unknown>) => {
          if (shape.lost) throw new Error('entity removed');
          Object.assign(shape.props, props);
        },
        setUserEditEnabled: (enabled: boolean) => {
          if (shape.lost) throw new Error('entity removed');
          shape.editEnabled = enabled;
        },
      };
    }),
    removeEntity: vi.fn((id: string) => {
      shapes.delete(id);
    }),
  };

  return { chart: chart as unknown as IChartWidgetApi, shapes, calls: chart };
}

function specs(entries: [string, PriceLineSpec][]): Map<string, PriceLineSpec> {
  return new Map(entries);
}

const layers: PriceLineLayer[] = [];

afterEach(() => {
  for (const layer of layers.splice(0)) layer.dispose();
  vi.useRealTimers();
});

describe('PriceLineLayer', () => {
  it('首次同步创建水平线并写入文字与颜色', async () => {
    const { chart, shapes, calls } = fakeChart();
    const layer = new PriceLineLayer(chart, (price) => price);
    layers.push(layer);

    await layer.sync(specs([['entry', { price: 3980, text: '模拟多 1.00', color: '#0f7a55' }]]));

    expect(calls.createShape).toHaveBeenCalledTimes(1);
    const shape = [...shapes.values()][0];
    expect(shape.props.shape).toBe('horizontal_line');
    expect(shape.props.text).toBe('模拟多 1.00');
    expect(shape.props.linecolor).toBe('#0f7a55');
    expect(shape.props.textcolor).toBe('#0f7a55');
    expect(shape.points[0].price).toBe(3980);
    expect(shape.props.showInObjectsTree).toBe(false);
  });

  it('规格变化时更新价格、文字与颜色', async () => {
    const { chart, shapes } = fakeChart();
    const layer = new PriceLineLayer(chart, (price) => price);
    layers.push(layer);

    await layer.sync(specs([['entry', { price: 3980, text: 'SL', color: '#c2413a' }]]));
    const shape = [...shapes.values()][0];

    await layer.sync(specs([['entry', { price: 3975, text: 'SL 3975', color: '#1f5fd6' }]]));

    expect(shape.points[0].price).toBe(3975);
    expect(shape.props.text).toBe('SL 3975');
    expect(shape.props.linecolor).toBe('#1f5fd6');
  });

  it('用户拖走线后不会被旧数据拉回去', async () => {
    const { chart, shapes } = fakeChart();
    const layer = new PriceLineLayer(chart, (price) => price);
    layers.push(layer);

    await layer.sync(specs([['entry', { price: 3980, text: '入场', color: '#0f7a55' }]]));
    const shape = [...shapes.values()][0];
    shape.points = [{ time: shape.points[0].time, price: 3985 }];

    await layer.sync(specs([['entry', { price: 3980, text: '入场', color: '#0f7a55' }]]));

    expect(shape.points[0].price).toBe(3985);
  });

  it('轮询发现拖动后回调 onMove（价格按最小变动取整）', async () => {
    vi.useFakeTimers();
    const { chart, shapes } = fakeChart();
    const onMove = vi.fn();
    const layer = new PriceLineLayer(chart, (price) => Math.round(price * 10) / 10);
    layers.push(layer);

    await layer.sync(
      specs([['entry', { price: 3980, text: '入场', color: '#0f7a55', onMove }]]),
    );
    const shape = [...shapes.values()][0];
    shape.points = [{ time: shape.points[0].time, price: 3982.37 }];

    layer.start();
    await vi.advanceTimersByTimeAsync(200);

    expect(onMove).toHaveBeenCalledWith(3982.4);
  });

  it('可拖动与价格标签开关同步到图表', async () => {
    const { chart, shapes } = fakeChart();
    const layer = new PriceLineLayer(chart, (price) => price);
    layers.push(layer);

    await layer.sync(
      specs([
        [
          'guide',
          { price: 3980, text: '引导', color: '#888888', editable: false, showPrice: false },
        ],
      ]),
    );

    const shape = [...shapes.values()][0];
    expect(shape.editEnabled).toBe(false);
    expect(shape.props.showPrice).toBe(false);
  });

  it('规格表里没有的线会被删除', async () => {
    const { chart, shapes, calls } = fakeChart();
    const layer = new PriceLineLayer(chart, (price) => price);
    layers.push(layer);

    await layer.sync(
      specs([
        ['entry', { price: 3980, text: '入场', color: '#0f7a55' }],
        ['sl', { price: 3970, text: 'SL', color: '#c2413a' }],
      ]),
    );
    expect(shapes.size).toBe(2);

    await layer.sync(specs([['entry', { price: 3980, text: '入场', color: '#0f7a55' }]]));

    expect(shapes.size).toBe(1);
    expect(calls.removeEntity).toHaveBeenCalledTimes(1);
  });

  it('被图表删掉的线会自动重建（有限次）', async () => {
    vi.useFakeTimers();
    const { chart, shapes, calls } = fakeChart();
    const layer = new PriceLineLayer(chart, (price) => price);
    layers.push(layer);

    await layer.sync(specs([['entry', { price: 3980, text: '入场', color: '#0f7a55' }]]));
    const shape = [...shapes.values()][0];
    shape.lost = true;

    layer.start();
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls.createShape).toHaveBeenCalledTimes(2);
    expect(shapes.size).toBe(1);
  });

  it('dispose 清掉所有线和定时器', async () => {
    vi.useFakeTimers();
    const { chart, shapes } = fakeChart();
    const layer = new PriceLineLayer(chart, (price) => price);

    await layer.sync(
      specs([
        ['entry', { price: 3980, text: '入场', color: '#0f7a55' }],
        ['sl', { price: 3970, text: 'SL', color: '#c2413a' }],
      ]),
    );
    layer.start();
    layer.dispose();

    expect(shapes.size).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(shapes.size).toBe(0);
  });
});
