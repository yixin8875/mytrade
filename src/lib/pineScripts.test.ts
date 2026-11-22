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
