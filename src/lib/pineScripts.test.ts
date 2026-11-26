import { beforeEach, describe, expect, it } from 'vitest';
import { readPineScripts, savePineScript } from './pineScripts';

const STORAGE_KEY = 'mytrade.pineScripts';

beforeEach(() => {
  window.localStorage.clear();
});

describe('savePineScript', () => {
  it('scans plots and inputs with Piner', async () => {
    const record = await savePineScript(`//@version=6
indicator('Piner 扫描', overlay=true)
len = input.int(14, 'Len', minval=1)
plot(ta.sma(close, len), 'SMA', color=color.blue, style=plot.style_line)
plot(close, 'Price')
hline(100, 'Mid')
`);

    // Piner 预扫描成功，不应带上回退 warning
    expect(record.warning).toBeUndefined();
    expect(record.overlay).toBe(true);
    expect(record.plots.map((plot) => plot.key)).toEqual(['plot_0', 'plot_1', 'hline_2']);
    expect(record.plots[0].title).toBe('SMA');
    expect(record.plots[0].style).toBe('line');
    // 颜色去掉 Piner 的 alpha 通道
    expect(record.plots[0].color).toBe('#2962FF');
    expect(record.plots[2].style).toBe('hline');
    expect(record.plots[2].color).toMatch(/^#[0-9A-F]{6}$/i);

    expect(record.inputs).toHaveLength(1);
    expect(record.inputs[0]).toMatchObject({
      id: 'Len',
      title: 'Len',
      type: 'int',
      defval: 14,
      minval: 1,
    });

    // 记录写进 localStorage，并且能被读回
    const stored = readPineScripts();
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(record.id);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]')).toHaveLength(1);
  });

  it('captures linebr styles for session plots on multi-day synthetic bars', async () => {
    const record = await savePineScript(`//@version=6
indicator('时段区间', overlay=true)
ses = input.session('0930-1000', '时段')
in_ses = not na(time(timeframe.period, ses, 'America/New_York'))
plot(in_ses ? high : na, '上沿', style=plot.style_linebr, color=color.green)
plot(in_ses ? low : na, '下沿', style=plot.style_linebr, color=color.red)
`);

    // 时段类脚本当天开盘前全是 na；试跑数据不够长就只剩 na，样式会退化回折线，
    // 图上各时段之间就会连起来（TradingView 是断开的）
    expect(record.warning).toBeUndefined();
    expect(record.plots.map((plot) => plot.title)).toEqual(['上沿', '下沿']);
    expect(record.plots.map((plot) => plot.style)).toEqual(['linebr', 'linebr']);
  });

  it('keeps plot styles when falling back to source parsing', async () => {
    const record = await savePineScript(`//@version=6
indicator('全空曲线', overlay=true)
plot(na, '空曲线', style=plot.style_linebr, color=color.new(color.green, 70))
`);

    // 试跑扫不出数值时退回源码解析，样式/颜色也必须从源码里带出来；
    // color.new(color.green, 70) 不能被当成颜色名 "new"
    expect(record.plots[0]).toMatchObject({
      title: '空曲线',
      style: 'linebr',
      color: '#089981',
    });
  });

  it('repairs plot styles in records saved before multi-day scanning', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          id: 'legacy01',
          title: 'IVB',
          source: `//@version=6
indicator('IVB', overlay=true)
plot(close, '上沿', style=plot.style_linebr, color=color.new(color.green, 40))
plot(close, '下沿', style=plot.style_linebr, color=color.new(color.red, 40))
`,
          savedAt: 1700000000000,
          overlay: true,
          plots: [
            { key: '上沿', title: '上沿', color: '#2962FF' },
            { key: '下沿', title: '下沿', color: '#FF6D00' },
          ],
          inputs: [],
        },
      ]),
    );

    const [record] = readPineScripts();
    expect(record.plots.map((plot) => plot.style)).toEqual(['linebr', 'linebr']);
    // 兜底调色板的颜色也要换回源码声明的颜色
    expect(record.plots.map((plot) => plot.color)).toEqual(['#089981', '#F23645']);
    // 修复结果写回存储，别每次读取都重算
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]');
    expect(stored[0].plots[0].style).toBe('linebr');
  });

  it('leaves records alone when the source declares no plot style', () => {
    const raw = JSON.stringify([
      {
        id: 'plain001',
        title: 'SMA',
        source: `//@version=6
indicator('SMA')
plot(close, 'Close')
`,
        savedAt: 1700000000000,
        overlay: false,
        plots: [{ key: 'plot_0', title: 'Close', color: '#2962FF' }],
        inputs: [],
      },
    ]);
    window.localStorage.setItem(STORAGE_KEY, raw);

    // 普通 plot 本来就没有 style，不能被反复当成「待修复」写回
    expect(readPineScripts()[0].plots[0].style).toBeUndefined();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(raw);
  });

  it('keeps plot styles, widths and per-bar colors from the scan', async () => {
    const record = await savePineScript(`//@version=6
indicator('样式扫描', overlay=false)
plot(ta.sma(close, 3), '阶梯', style=plot.style_stepline, linewidth=2)
plot(close - open, '柱', style=plot.style_histogram, color=close > open ? color.green : color.red)
plot(close, '面积', style=plot.style_area, color=color.new(color.purple, 70))
`);

    // 图表库的曲线样式/线宽要跟着 Pine 的 plot 声明走
    expect(record.plots[0]).toMatchObject({ style: 'stepline', width: 2 });
    expect(record.plots[1].style).toBe('histogram');
    // 逐 bar 两种颜色要存成调色板，运行期才能按 bar 上色
    expect(record.plots[1].colorPalette).toEqual(
      expect.arrayContaining(['#4CAF50FF', '#F23645FF']),
    );
    // 单色曲线只需透明度，不必建调色板
    expect(record.plots[2]).toMatchObject({ style: 'area', transparency: 70 });
    expect(record.plots[2].colorPalette).toBeUndefined();
  });

  it('keeps shorttitle, groups and tooltips from the declaration', async () => {
    const record = await savePineScript(`//@version=6
indicator('完整标题', shorttitle='SHORT', overlay=true)
grp = '时段'
ses = input.session('2000-0000', '时间', group=grp)
len = input.int(3, 'Len', group=grp, tooltip='说明')
plot(close)
`);

    // Piner 的 metadata 不含 shorttitle，必须从 indicator() 声明里解析
    expect(record.shortTitle).toBe('SHORT');
    expect(record.inputs.find((input) => input.id === '时间')).toMatchObject({
      type: 'session',
      defval: '2000-0000',
      group: '时段',
    });
    expect(record.inputs.find((input) => input.id === 'Len')).toMatchObject({
      group: '时段',
      tooltip: '说明',
    });
    expect(readPineScripts()[0].shortTitle).toBe('SHORT');
  });

  it('saves drawing-only scripts without plots', async () => {
    const record = await savePineScript(`//@version=6
indicator('仅绘图', overlay=true)
box.new(bar_index - 1, high, bar_index, low, border_color=color.green, bgcolor=color.new(color.green, 85))
`);

    // FVG 这类脚本只有 box，没有 plot/hline：曲线列表为空，但记录仍要保存
    expect(record.plots).toEqual([]);
    expect(record.overlay).toBe(true);
    expect(record.warning).toBeUndefined();
    expect(readPineScripts()).toHaveLength(1);
  });

  it('rejects strategy scripts', async () => {
    await expect(savePineScript('//@version=6\nstrategy("x")\n')).rejects.toThrow(
      '暂不支持 strategy',
    );
  });

  it('rejects scripts without indicator()', async () => {
    await expect(savePineScript('//@version=6\nplot(close)\n')).rejects.toThrow(
      'indicator()',
    );
  });

  it('reports a single Piner error when the script cannot compile', async () => {
    let message = '';
    try {
      await savePineScript(`//@version=6
indicator('bad')
plot(close +)
`);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('脚本无法运行：');
    expect(message).toContain('当前引擎尚不支持的语法');
    expect(message).not.toContain('PineTS');
    expect(readPineScripts()).toHaveLength(0);
  });
});
