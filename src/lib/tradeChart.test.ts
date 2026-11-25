import { describe, expect, it } from 'vitest';
import {
  buildTradeChart,
  chartWindow,
  chooseResolution,
  niceStep,
  priceDigits,
  priceTickValues,
  resolutionSeconds,
  spreadLabelY,
  timeTickLabel,
  type TradeChartBar,
} from './tradeChart';

function bar(time: number, open: number, high: number, low: number, close: number): TradeChartBar {
  return { time, open, high, low, close };
}

/** 本地墙钟 → epoch 秒，和图表时间轴标签同一口径 */
function localTime(hour: number, minute = 0, day = 2): number {
  return Math.floor(new Date(2024, 0, day, hour, minute).getTime() / 1000);
}

describe('chooseResolution', () => {
  it('短持仓用 1 分钟，长持仓逐级放大', () => {
    expect(chooseResolution(5 * 60)).toBe('1');
    expect(chooseResolution(90 * 60)).toBe('1');
    expect(chooseResolution(91 * 60)).toBe('5');
    expect(chooseResolution(8 * 3600)).toBe('5');
    expect(chooseResolution(9 * 3600)).toBe('15');
    expect(chooseResolution(2 * 86400)).toBe('15');
    expect(chooseResolution(5 * 86400)).toBe('60');
    expect(chooseResolution(30 * 86400)).toBe('240');
  });

  it('负数和 0 按最短持仓处理', () => {
    expect(chooseResolution(-10)).toBe('1');
    expect(chooseResolution(0)).toBe('1');
  });
});

describe('resolutionSeconds', () => {
  it('认识网关的周期代码，未知周期退回 1 分钟', () => {
    expect(resolutionSeconds('1')).toBe(60);
    expect(resolutionSeconds('60')).toBe(3600);
    expect(resolutionSeconds('1D')).toBe(86400);
    expect(resolutionSeconds('weird')).toBe(60);
  });
});

describe('chartWindow', () => {
  it('前后留 25% 余量并对齐到周期边界', () => {
    const open = 1731000000;
    const close = open + 3600;
    const win = chartWindow(open, close, '1');
    expect(win.from).toBeLessThan(open);
    expect(win.to).toBeGreaterThan(close);
    expect(win.from % 60).toBe(0);
    expect(win.to % 60).toBe(0);
    // 1 小时持仓 → 至少 20 根 K 线的余量
    expect(open - win.from).toBeGreaterThanOrEqual(20 * 60);
  });

  it('余量按周期放大，使窗口里始终有足够 K 线', () => {
    const open = 1731000000;
    const close = open + 300;
    const m1 = chartWindow(open, close, '1');
    const m15 = chartWindow(open, close, '15');
    expect(m15.to - m15.from).toBeGreaterThan(m1.to - m1.from);
    expect(m15.count).toBeGreaterThanOrEqual(40);
  });
});

describe('priceDigits / niceStep / priceTickValues', () => {
  it('按价格量级给小数位', () => {
    expect(priceDigits(2350.5)).toBe(2);
    expect(priceDigits(86.123)).toBe(3);
    expect(priceDigits(1.23456)).toBe(4);
    expect(priceDigits(0.65432)).toBe(5);
    expect(priceDigits(0)).toBe(5);
  });

  it('步长只取 1/2/5 的整十倍', () => {
    expect(niceStep(100, 5)).toBe(20);
    expect(niceStep(10, 5)).toBe(2);
    expect(niceStep(0.5, 5)).toBe(0.1);
  });

  it('刻度不跑出价格区间，且互不重复', () => {
    const ticks = priceTickValues(100, 110, 5);
    expect(ticks.length).toBeGreaterThan(1);
    expect(Math.min(...ticks)).toBeGreaterThanOrEqual(100);
    expect(Math.max(...ticks)).toBeLessThanOrEqual(110);
    expect(new Set(ticks.map((tick) => tick.toFixed(6))).size).toBe(ticks.length);
  });

  it('区间非法时返回空刻度', () => {
    expect(priceTickValues(10, 10)).toEqual([]);
    expect(priceTickValues(Number.NaN, 10)).toEqual([]);
  });
});

describe('timeTickLabel', () => {
  it('两天内只显示时:分', () => {
    expect(timeTickLabel(localTime(9, 30), 3600)).toBe('09:30');
  });

  it('跨多天时带日期', () => {
    expect(timeTickLabel(localTime(9, 30, 2), 5 * 86400)).toBe('01/02 09:30');
    expect(timeTickLabel(localTime(9, 30, 2), 60 * 86400)).toBe('01/02');
  });

  it('serverOffset 把服务器时钟换算成本地时间', () => {
    const noon = localTime(12);
    expect(timeTickLabel(noon, 3600, 0)).toBe('12:00');
    expect(timeTickLabel(noon, 3600, 3600)).toBe('11:00');
    expect(timeTickLabel(noon, 3600, -1800)).toBe('12:30');
  });
});

describe('spreadLabelY', () => {
  it('价位挤在一起时按顺序拉开，并保留原始顺序', () => {
    const ys = spreadLabelY([100, 104, 106], 0, 300, 18);
    expect(ys[0]).toBe(100);
    expect(ys[1] - ys[0]).toBeGreaterThanOrEqual(18);
    expect(ys[2] - ys[1]).toBeGreaterThanOrEqual(18);
  });

  it('标签本来分开时不动', () => {
    expect(spreadLabelY([100, 200], 0, 300, 18)).toEqual([100, 200]);
  });

  it('贴近底部时整体上移，不越出边界', () => {
    const ys = spreadLabelY([290, 295, 298], 10, 300, 18);
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(10);
      expect(y).toBeLessThanOrEqual(300);
    }
    expect(new Set(ys).size).toBe(3);
  });
});

describe('buildTradeChart', () => {
  const bars = [
    bar(1000, 1.1, 1.2, 1.05, 1.15),
    bar(1060, 1.15, 1.3, 1.12, 1.25),
    bar(1120, 1.25, 1.32, 1.18, 1.22),
  ];

  it('价格越高 y 越小，K 线落在绘图区内', () => {
    const layout = buildTradeChart({
      bars,
      entry: 1.1,
      exit: 1.25,
      openTime: 1000,
      closeTime: 1120,
      width: 800,
      height: 400,
    });
    expect(layout.candles).toHaveLength(3);
    expect(layout.entryY).toBeGreaterThan(layout.exitY);
    for (const candle of layout.candles) {
      expect(candle.x).toBeGreaterThanOrEqual(layout.plot.left);
      expect(candle.x).toBeLessThanOrEqual(layout.plot.right);
      expect(candle.highY).toBeLessThanOrEqual(candle.lowY);
      expect(candle.highY).toBeGreaterThanOrEqual(layout.plot.top);
      expect(candle.lowY).toBeLessThanOrEqual(layout.plot.bottom);
    }
    expect(layout.candles[1].up).toBe(true);
    expect(layout.candles[2].up).toBe(false);
  });

  it('时间越晚 x 越大，持仓区间有序', () => {
    const layout = buildTradeChart({
      bars,
      entry: 1.1,
      exit: 1.25,
      openTime: 1060,
      closeTime: 1120,
      width: 800,
      height: 400,
    });
    expect(layout.candles[0].x).toBeLessThan(layout.candles[1].x);
    expect(layout.candles[1].x).toBeLessThan(layout.candles[2].x);
    expect(layout.holdX0).toBeLessThanOrEqual(layout.holdX1);
    expect(layout.entryX).toBe(layout.holdX0);
    expect(layout.exitX).toBe(layout.holdX1);
  });

  it('止损和止盈进入价格范围并给出 y 坐标', () => {
    const layout = buildTradeChart({
      bars,
      entry: 1.1,
      exit: 1.25,
      sl: 1.05,
      tp: 1.35,
      openTime: 1000,
      closeTime: 1120,
      width: 800,
      height: 400,
    });
    expect(layout.priceMin).toBeLessThan(1.05);
    expect(layout.priceMax).toBeGreaterThan(1.35);
    expect(layout.slY).toBeGreaterThan(layout.entryY);
    expect(layout.tpY).toBeLessThan(layout.exitY);
  });

  it('没有止损止盈时对应 y 为空', () => {
    const layout = buildTradeChart({
      bars,
      entry: 1.1,
      exit: 1.25,
      openTime: 1000,
      closeTime: 1120,
      width: 800,
      height: 400,
    });
    expect(layout.slY).toBeNull();
    expect(layout.tpY).toBeNull();
  });

  it('行情缺失时仍画出入场/出场价位', () => {
    const layout = buildTradeChart({
      bars: [],
      entry: 100,
      exit: 104,
      openTime: 1000,
      closeTime: 4600,
      width: 800,
      height: 400,
    });
    expect(layout.empty).toBe(true);
    expect(layout.candles).toEqual([]);
    expect(layout.entryY).toBeGreaterThan(layout.exitY);
    expect(layout.priceTicks.length).toBeGreaterThan(1);
    expect(layout.timeTicks.length).toBeGreaterThanOrEqual(2);
  });

  it('入出场价格相同也不会除零', () => {
    const layout = buildTradeChart({
      bars: [],
      entry: 50,
      exit: 50,
      openTime: 1000,
      closeTime: 1000,
      width: 800,
      height: 400,
    });
    expect(Number.isFinite(layout.entryY)).toBe(true);
    expect(Number.isFinite(layout.exitY)).toBe(true);
    expect(layout.priceMax).toBeGreaterThan(layout.priceMin);
  });
});

describe('逐笔成交点', () => {
  const bars = [
    bar(1000, 1.1, 1.2, 1.05, 1.15),
    bar(1060, 1.15, 1.3, 1.12, 1.25),
    bar(1120, 1.25, 1.32, 1.18, 1.22),
  ];

  it('每笔入场/出场各画一个点，按成交时间定位', () => {
    const layout = buildTradeChart({
      bars,
      entry: 1.15,
      exit: 1.25,
      openTime: 1000,
      closeTime: 1180,
      width: 800,
      height: 400,
      fills: [
        { side: 'in', time: 1000, price: 1.15, volume: 0.1 },
        { side: 'out', time: 1060, price: 1.2, volume: 0.05 },
        { side: 'out', time: 1180, price: 1.25, volume: 0.05 },
      ],
    });
    expect(layout.entryPoints).toHaveLength(1);
    expect(layout.exitPoints).toHaveLength(2);
    expect(layout.exitPoints[0].time).toBe(1060);
    expect(layout.exitPoints[1].time).toBe(1180);
    expect(layout.exitPoints[0].x).toBeLessThan(layout.exitPoints[1].x);
    expect(layout.exitPoints[0].y).toBeGreaterThan(layout.exitPoints[1].y);
    expect(layout.exitPoints[1].price).toBe(1.25);
    expect(layout.entryPoints[0].volume).toBe(0.1);
  });

  it('每一笔成交价都进入价格范围', () => {
    const layout = buildTradeChart({
      bars: [bar(1000, 1.1, 1.2, 1.05, 1.15)],
      entry: 1.1,
      exit: 1.2,
      openTime: 1000,
      closeTime: 1060,
      width: 800,
      height: 400,
      fills: [{ side: 'out', time: 1060, price: 1.4, volume: 0.1 }],
    });
    expect(layout.priceMax).toBeGreaterThanOrEqual(1.4);
    expect(layout.exitPoints[0].price).toBe(1.4);
    expect(layout.exitPoints[0].y).toBeGreaterThanOrEqual(layout.plot.top);
  });

  it('没有明细时退回单点', () => {
    const layout = buildTradeChart({
      bars,
      entry: 1.15,
      exit: 1.25,
      openTime: 1000,
      closeTime: 1120,
      width: 800,
      height: 400,
    });
    expect(layout.entryPoints).toEqual([
      expect.objectContaining({ time: 1000, price: 1.15 }),
    ]);
    expect(layout.exitPoints).toEqual([
      expect.objectContaining({ time: 1120, price: 1.25 }),
    ]);
  });
});
