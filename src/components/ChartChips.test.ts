import { afterEach, describe, expect, it } from 'vitest';
import type { IChartWidgetApi } from '../../public/charting_library/charting_library';
import { measurePriceAxis } from './ChartChips';

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

const FROM = 0.9471355812805075;
const TO = 0.9538080233993657;
const SPAN = TO - FROM;
const CANVAS_HEIGHT = 856;

/** 价格越高，canvas y 越小 */
const scale = { priceToCoordinate: (price: number) => ((TO - price) / SPAN) * CANVAS_HEIGHT };

const chart = {
  getPanes: () => [{ getMainSourcePriceScale: () => ({ _priceScale: scale }) }],
  getVisiblePriceRange: () => ({ from: FROM, to: TO }),
} as unknown as IChartWidgetApi;

function setup() {
  const host = document.createElement('div');
  const frame = document.createElement('iframe');
  host.append(frame);
  document.body.append(host);
  const doc = frame.contentDocument!;
  const canvas = doc.createElement('canvas');
  doc.body.append(canvas);

  frame.getBoundingClientRect = () => rect(84, 48, 759, 966);
  canvas.getBoundingClientRect = () => rect(56, 42, 643, 857);
  host.getBoundingClientRect = () => rect(84, 48, 759, 966);
  return { host, frame, doc, canvas };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('measurePriceAxis', () => {
  it('换算出绘图区、价格轴与按钮落点', () => {
    const { host } = setup();
    const box = measurePriceAxis(host, chart);

    expect(box).not.toBeNull();
    expect(box!.top).toBe(42);
    expect(box!.height).toBe(857);
    // 价格轴宽 60px，按钮贴轴左侧 4px
    expect(box!.right).toBe(64);
    expect(box!.yFor(TO)).toBeCloseTo(42, 6);
    expect(box!.yFor(FROM)).toBeCloseTo(42 + CANVAS_HEIGHT, 6);
  });

  it('只认价格轴条带内的坐标', () => {
    const { host } = setup();
    const box = measurePriceAxis(host, chart)!;

    expect(box.inAxis(700, 300)).toBe(true);
    expect(box.inAxis(671, 42)).toBe(true);
    // 图内（主图右缘再往左）不算
    expect(box.inAxis(600, 300)).toBe(false);
    // 上下越界
    expect(box.inAxis(700, 20)).toBe(false);
    // 价格轴右侧外溢范围之外
    expect(box.inAxis(800, 300)).toBe(false);
  });

  it('按 canvas 内 y 反推价格', () => {
    const { host } = setup();
    const box = measurePriceAxis(host, chart)!;
    const expected = TO - ((300 - 42) / CANVAS_HEIGHT) * SPAN;

    expect(box.priceAtLocal(300)).toBeCloseTo(expected, 8);
    // 顶部/底部对应区间端点
    expect(box.priceAtLocal(42)).toBeCloseTo(TO, 6);
    expect(box.priceAtLocal(42 + CANVAS_HEIGHT)).toBeCloseTo(FROM, 6);
  });

  it('图表内部结构缺失时返回 null', () => {
    const { host } = setup();
    expect(measurePriceAxis(host, {} as IChartWidgetApi)).toBeNull();
  });

  it('没有可用的 iframe 或大画布时返回 null', () => {
    const host = document.createElement('div');
    document.body.append(host);
    expect(measurePriceAxis(host, chart)).toBeNull();

    const { host: host2, canvas } = setup();
    canvas.getBoundingClientRect = () => rect(0, 0, 100, 100);
    expect(measurePriceAxis(host2, chart)).toBeNull();
  });
});
