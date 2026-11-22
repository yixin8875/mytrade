import { describe, expect, it, vi } from 'vitest';
import type { Bar } from '../../gateway/types';
import { runPine } from './pineEngine';

const START = Date.UTC(2024, 0, 1) / 1000;

function bars(count: number, stepSeconds: number, base = 100, slope = 1): Bar[] {
  return Array.from({ length: count }, (_, index) => {
    const open = base + index * slope;
    const close = open + 0.5;
    return {
      time: START + index * stepSeconds,
      open,
      high: close + 0.5,
      low: open - 0.5,
      close,
      volume: 1000 + index,
    };
  });
}

describe('runPine', () => {
  it('computes numeric plots with Piner', async () => {
    const source = `//@version=6
indicator('sma')
plot(ta.sma(close, 5), 'sma5')
`;
    const result = await runPine({
      source,
      bars: bars(40, 300),
      symbol: 'NQ',
      resolution: '5',
    });

    expect(result.engine).toBe('piner');
    const sma = result.series.find((series) => series.title === 'sma5');
    expect(sma).toBeDefined();
    // close = 100.5 + i；最后 5 根是 135.5..139.5，均值 137.5
    expect(sma?.values.at(-1)).toBeCloseTo(137.5, 8);
  });

  it('injects same-symbol higher timeframe bars', async () => {
    const chart = bars(300, 300);
    const htf = bars(25, 3600, 1000, 1);
    const fetchBars = vi.fn(async (symbol: string, resolution: string) => {
      expect(symbol).toBe('NQ');
      expect(resolution).toBe('60');
      return htf;
    });

    const source = `//@version=6
indicator('mtf')
htf = request.security(syminfo.tickerid, '60', close)
plot(htf, 'htf')
`;
    const result = await runPine({
      source,
      bars: chart,
      symbol: 'NQ',
      resolution: '5',
      fetchBars,
    });

    expect(result.engine).toBe('piner');
    expect(fetchBars).toHaveBeenCalled();
    const htfSeries = result.series.find((series) => series.title === 'htf');
    // Piner 按 HTF bar 的收盘时刻对齐：最后一根 chart bar 开在 24:55、收在 25:00，
    // 而 24:00-25:00 这根 1 小时 K 也在 25:00 收盘，所以它已是「最后一根已收盘」的
    // HTF bar，取值 1000+24+0.5 = 1024.5（与 TradingView lookahead_off 一致）。
    expect(htfSeries?.values.at(-1)).toBeCloseTo(1024.5, 8);
    // 早一根 chart bar（收在 24:55）还看不到 24:00 这根，只能拿到 23:00-24:00 的 close。
    expect(htfSeries?.values.at(-2)).toBeCloseTo(1023.5, 8);
  });

  it('injects cross-symbol security bars', async () => {
    const chart = bars(300, 300);
    const btc = bars(25, 3600, 5000, 1);
    const fetchBars = vi.fn(async (symbol: string, resolution: string) => {
      expect(symbol).toBe('BTCUSD');
      expect(resolution).toBe('60');
      return btc;
    });

    const source = `//@version=6
indicator('foreign')
btc = request.security('BTCUSD', '60', close)
plot(btc, 'btc')
`;
    const result = await runPine({
      source,
      bars: chart,
      symbol: 'NQ',
      resolution: '5',
      fetchBars,
    });

    expect(result.engine).toBe('piner');
    expect(fetchBars).toHaveBeenCalled();
    const btcSeries = result.series.find((series) => series.title === 'btc');
    expect(btcSeries?.values.at(-1)).toBeCloseTo(5023.5, 8);
  });

  it('collects plotcandle visuals against bar times', async () => {
    const chart = bars(40, 300);
    const result = await runPine({
      source: `//@version=6
indicator('candles', overlay=true)
plotcandle(open, high, low, close, color=color.green, wickcolor=color.red)
`,
      bars: chart,
      symbol: 'NQ',
      resolution: '5',
    });

    expect(result.visuals.candles).toHaveLength(1);
    const list = result.visuals.candles[0].bars;
    expect(list).toHaveLength(40);
    expect(list[0]).toMatchObject({
      time: chart[0].time,
      to: chart[1].time,
      open: chart[0].open,
      high: chart[0].high,
      low: chart[0].low,
      close: chart[0].close,
    });
    // color.green = #4CAF50，alpha 通道保留给渲染层算透明度
    expect(list[0].color?.toUpperCase()).toBe('#4CAF50FF');
    expect(list[0].wickColor?.toUpperCase()).toBe('#F23645FF');
    expect(result.visuals.unsupported).not.toContain('plotcandle/plotbar');
  });

  it('collects barcolor as colored candles', async () => {
    const chart = bars(20, 300);
    const result = await runPine({
      source: `//@version=6
indicator('barcolor')
barcolor(close > open ? color.green : color.red)
plot(close)
`,
      bars: chart,
      symbol: 'NQ',
      resolution: '5',
    });

    expect(result.visuals.candles).toHaveLength(1);
    const series = result.visuals.candles[0];
    expect(series.id).toBe('barcolor-0');
    expect(series.bars).toHaveLength(20);
    expect(series.bars[0]).toMatchObject({
      time: chart[0].time,
      to: chart[1].time,
      open: chart[0].open,
      close: chart[0].close,
    });
    // 测试数据 close 恒大于 open
    expect(series.bars[0].color?.toUpperCase()).toBe('#4CAF50FF');
    expect(series.bars[0].wickColor).toBe(series.bars[0].color);
    expect(result.visuals.unsupported).not.toContain('barcolor');
  });

  it('collects fill bands from plot edges', async () => {
    const chart = bars(20, 300);
    const result = await runPine({
      source: `//@version=6
indicator('fill')
p1 = plot(close, 'A')
p2 = plot(close + 2, 'B')
fill(p1, p2, color=color.new(color.blue, 80))
`,
      bars: chart,
      symbol: 'NQ',
      resolution: '5',
    });

    expect(result.visuals.fills).toHaveLength(1);
    const list = result.visuals.fills[0].bars;
    expect(list).toHaveLength(20);
    expect(list[0]).toMatchObject({
      time: chart[0].time,
      to: chart[1].time,
      top: chart[0].close + 2,
      bottom: chart[0].close,
    });
    expect(list[0].color?.toUpperCase()).toBe('#2962FF33');
    expect(result.visuals.unsupported).not.toContain('fill');
  });

  it('returns hlines as constant series', async () => {
    const result = await runPine({
      source: `//@version=6
indicator('level')
hline(123.45, 'level')
`,
      bars: bars(10, 300),
      symbol: 'NQ',
      resolution: '5',
    });

    const hline = result.series.find((series) => series.kind === 'hline');
    expect(hline).toBeDefined();
    expect(hline?.values).toHaveLength(10);
    expect(hline?.values.every((value) => value === 123.45)).toBe(true);
  });

  it('runs legacy v5 aliases that the old fallback engine rejected', async () => {
    const result = await runPine({
      source: `//@version=5
indicator('legacy')
v = security(syminfo.tickerid, '60', close)
plot(iff(close > open, 1, 0), 'iff')
plot(cross(close, open) ? 1 : 0, 'cross')
plot(rising(close, 3) ? 1 : 0, 'rising')
plot(falling(close, 3) ? 1 : 0, 'falling')
plot(cum(1), 'cum')
plot(v, 'sec')
`,
      bars: bars(40, 300),
      symbol: 'NQ',
      resolution: '5',
    });

    expect(result.engine).toBe('piner');
    expect(result.series.length).toBeGreaterThanOrEqual(6);
    expect(result.series.map((series) => series.title)).toEqual(
      expect.arrayContaining(['iff', 'cross', 'rising', 'falling', 'cum', 'sec']),
    );
  });

  it('applies overrides by Piner input key when titles repeat', async () => {
    const result = await runPine({
      source: `//@version=6
indicator('dup inputs')
a = input.int(1, 'Len')
b = input.int(2, 'Len')
plot(a, 'a')
plot(b, 'b')
`,
      bars: bars(10, 300),
      symbol: 'NQ',
      resolution: '5',
      inputs: { Len: 10, 'Len (2)': 20 },
      inputMeta: [
        { id: 'Len', title: 'Len', type: 'int', defval: 1 },
        // 重名输入的 key 带 " (2)" 后缀，按 title 映射会让两条输入互相覆盖
        { id: 'Len (2)', title: 'Len', type: 'int', defval: 2 },
      ],
    });

    expect(result.series.find((series) => series.title === 'a')?.values.at(-1)).toBe(10);
    expect(result.series.find((series) => series.title === 'b')?.values.at(-1)).toBe(20);
  });

  it('reports absolute-location markers instead of drawing them at the close', async () => {
    const result = await runPine({
      source: `//@version=6
indicator('absolute markers')
plotshape(close, style=shape.circle, location=location.absolute)
`,
      bars: bars(10, 300),
      symbol: 'NQ',
      resolution: '5',
    });

    expect(result.visuals.markers).toHaveLength(0);
    expect(result.visuals.unsupported.join()).toContain('location.absolute');
  });

  it('reports a single Piner error when the script cannot compile', async () => {
    let message = '';
    try {
      await runPine({
        source: `//@version=6
indicator('bad')
plot(close +)
`,
        bars: bars(10, 300),
        symbol: 'NQ',
        resolution: '5',
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('Pine 运行失败');
    expect(message).not.toContain('PineTS');
  });
});
