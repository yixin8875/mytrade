import { beforeEach, describe, expect, it } from 'vitest';
import { migratePineTemplate, pineIndicators, pinePlotValues } from './pineStudies';
import { savePineScript } from '../../lib/pineScripts';

interface MetainfoShape {
  plots: { id: string; type: string; palette?: string; target?: string }[];
  styles: Record<string, { title: string; isHidden?: boolean }>;
  palettes?: Record<string, { colors: { name: string }[]; addDefaultColor?: boolean }>;
  defaults: {
    styles: Record<
      string,
      {
        visible: boolean;
        plottype?: number;
        linewidth?: number;
        color?: string;
        transparency?: number;
      }
    >;
    palettes?: Record<string, { colors: { color: string; width?: number; style?: number }[] }>;
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

  it('maps Pine sessions, timeframes and symbols to native library inputs', async () => {
    await savePineScript(`//@version=6
indicator('原生输入', shorttitle='NATIVE', overlay=true)
grp = '时段'
ses = input.session('0930-1600', '时段', group=grp)
tf = input.timeframe('D', '周期', group=grp)
sym = input.symbol('NQ', '品种', group=grp)
note = input.text_area('x', '备注')
plot(close)
`);

    const metainfo = metainfoOf(0);
    const inputs = metainfo.inputs as {
      id: string;
      type: string;
      defval?: unknown;
      group?: string;
      isHidden?: boolean;
    }[];

    // 图表库有原生的时段选择器，session 不能退化成文本框
    expect(inputs.find((input) => input.id === '时段')).toMatchObject({
      type: 'session',
      defval: '0930-1600',
      group: '时段',
    });
    // Pine 的日线写作 D，图表库的分辨率必须是 1D
    expect(inputs.find((input) => input.id === '周期')).toMatchObject({
      type: 'resolution',
      defval: '1D',
    });
    expect(inputs.find((input) => input.id === '品种')).toMatchObject({ type: 'symbol' });
    expect(inputs.find((input) => input.id === '备注')).toMatchObject({ type: 'text_area' });
    // 自动刷新输入只是内部机制，不该出现在设置里
    expect(inputs.find((input) => input.id === 'in_refresh')).toMatchObject({ isHidden: true });
  });

  it('uses the Pine shorttitle as the indicator display name', async () => {
    await savePineScript(`//@version=6
indicator('完整标题', shorttitle='SHORT', overlay=true)
plot(close)
`);

    const indicator = pineIndicators({} as never, 'ctx')[0];
    const metainfo = indicator.metainfo as unknown as {
      description: string;
      shortDescription: string;
    };
    // TradingView 的图例与设置标题都用 shorttitle
    expect(metainfo.description).toBe('SHORT');
    expect(metainfo.shortDescription).toBe('SHORT');
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

  it('declares styles titles so the settings dialog can render', async () => {
    await savePineScript(`//@version=6
indicator('有标题', overlay=true)
plot(close, '收盘')
`);

    const metainfo = metainfoOf(0);
    // 对话框样式页用 metaInfo.styles[id].title，缺失会抛 Value is undefined
    expect(metainfo.styles.plot_0).toEqual({ title: '收盘', isHidden: false });
  });

  it('maps Pine plot styles and per-bar colors to library plot metadata', async () => {
    await savePineScript(`//@version=6
indicator('样式映射', overlay=false)
plot(ta.sma(close, 3), '阶梯', style=plot.style_stepline, linewidth=2)
plot(close - open, '柱', style=plot.style_histogram, color=close > open ? color.green : color.red)
plot(close, '面积', style=plot.style_area, color=color.new(color.purple, 70))
`);

    const metainfo = metainfoOf(0);
    // plottype 是数值枚举：Line=0, Histogram=1, Area=4, StepLine=9
    expect(metainfo.defaults.styles.plot_0).toMatchObject({ plottype: 9, linewidth: 2 });
    expect(metainfo.defaults.styles.plot_1).toMatchObject({ plottype: 1 });
    // 单色带透明度：直接用 transparency，不再叠调色板
    expect(metainfo.defaults.styles.plot_2).toMatchObject({ plottype: 4, transparency: 70 });

    // 逐 bar 两种颜色的曲线后面要跟一条 colorer 曲线，由它返回调色板下标
    expect(metainfo.plots).toEqual([
      { id: 'plot_0', type: 'line' },
      { id: 'plot_1', type: 'line' },
      { id: 'plot_1_color', type: 'colorer', palette: 'palette_1', target: 'plot_1' },
      { id: 'plot_2', type: 'line' },
    ]);
    expect(metainfo.palettes?.palette_1.colors).toHaveLength(2);
    expect(metainfo.palettes?.palette_1.addDefaultColor).toBe(true);
    // 调色板颜色是图表库认识的 rgba（Piner 的 8 位 hex 会被设置对话框拒绝）
    expect(metainfo.defaults.palettes?.palette_1.colors[0].color).toMatch(/^rgba\(/);
  });

  it('maps colorer slots to palette indexes at each bar', () => {
    const result = {
      byTime: new Map([[100, [1.5, 2.5]]]),
      colorsByTime: new Map([[100, [0, 1]]]),
    };
    const slots = [
      { metaIndex: 0, colorer: false },
      { metaIndex: 0, colorer: true },
      { metaIndex: 1, colorer: false },
    ];

    expect(pinePlotValues(result, 100, slots)).toEqual([1.5, 0, 2.5]);
    // 还没有结果时返回 NaN，避免把上一根 bar 的值留在图上
    expect(pinePlotValues(undefined, 100, slots).every(Number.isNaN)).toBe(true);
  });

  it('declares a styles title for the hidden placeholder plot', async () => {
    await savePineScript(`//@version=6
indicator('仅绘图二', overlay=true)
box.new(bar_index - 1, high, bar_index, low)
`);

    const metainfo = metainfoOf(0);
    expect(metainfo.styles.plot_0.title).toBeTruthy();
  });
});
