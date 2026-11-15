import { beforeEach, describe, expect, it } from 'vitest';
import { pineIndicators } from './pineStudies';
import { savePineScript } from '../../lib/pineScripts';

interface MetainfoShape {
  plots: { id: string; type: string }[];
  defaults: { styles: Record<string, { visible: boolean }> };
  inputs: { id: string }[];
  is_price_study: boolean;
}

function metainfoOf(recordIndex: number): MetainfoShape {
  // main 才会用到 PineJS，构建元信息时传空对象即可
  const indicators = pineIndicators({} as never, 'ctx');
  return indicators[recordIndex].metainfo as unknown as MetainfoShape;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('pineIndicators', () => {
  it('adds a hidden placeholder plot for drawing-only scripts', async () => {
    await savePineScript(`//@version=6
indicator('仅绘图', overlay=true)
box.new(bar_index - 1, high, bar_index, low)
`);

    const metainfo = metainfoOf(0);
    // 图表库要求指标至少有一条 plot，0 曲线脚本靠隐藏占位满足
    expect(metainfo.plots).toEqual([{ id: 'plot_0', type: 'line' }]);
    expect(metainfo.defaults.styles.plot_0.visible).toBe(false);
    expect(metainfo.is_price_study).toBe(true);
    expect(metainfo.inputs.map((item) => item.id)).toContain('in_refresh');
  });

  it('keeps one plot per curve for normal scripts', async () => {
    await savePineScript(`//@version=6
indicator('两条曲线', overlay=false)
plot(close, 'Close')
plot(open, 'Open')
`);

    const metainfo = metainfoOf(0);
    expect(metainfo.plots).toHaveLength(2);
    expect(metainfo.defaults.styles.plot_0.visible).toBe(true);
    expect(metainfo.is_price_study).toBe(false);
  });
});
