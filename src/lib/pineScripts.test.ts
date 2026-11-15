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
});
