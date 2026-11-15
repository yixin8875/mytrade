import { beforeEach, describe, expect, it } from 'vitest';
import { migratePineTemplate, pineIndicators } from './pineStudies';
import { savePineScript } from '../../lib/pineScripts';

interface MetainfoShape {
  plots: { id: string; type: string }[];
  defaults: {
    styles: Record<string, { visible: boolean }>;
    inputs: Record<string, unknown>;
  };
  inputs: { id: string; defval?: unknown }[];
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

  it('converts 8-digit colors to rgba for the library settings dialog', async () => {
    await savePineScript(`//@version=6
indicator('颜色输入', overlay=true)
fillCol = input.color(color.new(#4CAF50, 80), '填充色')
plot(close, 'Close', color=fillCol)
`);

    const metainfo = metainfoOf(0);
    const input = metainfo.inputs.find((item) => item.id === '填充色');
    // 图表库解析不了 #RRGGBBAA，会让「设置」对话框直接抛错
    expect(input?.defval).toBe('rgba(76, 175, 80, 0.2)');
    expect(metainfo.defaults.inputs['填充色']).toBe('rgba(76, 175, 80, 0.2)');
  });

  it('migrates 8-digit colors saved in old chart templates', () => {
    const state = {
      panes: [
        {
          sources: [
            {
              metaInfo: {
                name: 'mt-pine-abc',
                inputs: [{ id: '填充色', type: 'color', defval: '#4CAF5033' }],
                defaults: { inputs: { 填充色: '#4CAF5033' } },
              },
              state: { inputs: { 填充色: '#4CAF5033', 周期: 5 } },
            },
            {
              metaInfo: { name: 'mt-ema-ribbon' },
              state: { inputs: { 颜色: '#4CAF5033' } },
            },
          ],
        },
      ],
    };

    migratePineTemplate(state);
    expect(state.panes[0].sources[0].state.inputs).toEqual({
      填充色: 'rgba(76, 175, 80, 0.2)',
      周期: 5,
    });
    // 元信息快照里的默认值也要一起迁移，否则恢复出来的指标依旧打不开设置
    expect(state.panes[0].sources[0].metaInfo?.inputs?.[0]?.defval).toBe('rgba(76, 175, 80, 0.2)');
    expect(state.panes[0].sources[0].metaInfo?.defaults?.inputs?.填充色).toBe(
      'rgba(76, 175, 80, 0.2)',
    );
    // 非 Pine 指标不动
    expect(state.panes[0].sources[1].state.inputs.颜色).toBe('#4CAF5033');
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
