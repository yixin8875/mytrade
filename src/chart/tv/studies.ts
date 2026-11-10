import type {
  CustomIndicator,
  IContext,
  PineJS,
} from '../../../public/charting_library/charting_library';

type Inputs = <T extends string | number | boolean>(index: number) => T;

// 跟随主图品种的报价精度（JPY 3 位、黄金 2 位等）
const PRICE_FORMAT = { type: 'inherit' as const };

/**
 * 自定义指标。
 *
 * Charting Library 不能直接运行 Pine Script 源码，但支持用 JS + PineJS.Std
 * 写同等的指标：init/main 每个 bar 调一次，返回值按 plots 的顺序绘制。
 * 这里放的是应用内置的示例，后续新增指标照抄结构即可；用到的
 * PineJS.Std.sma / ema / rsi / atr / highest / lowest 等见 d.ts 的 PineJSStd。
 */
export function customIndicators(PineJS: PineJS): Promise<readonly CustomIndicator[]> {
  const emaRibbon: CustomIndicator = {
    name: 'MT EMA Ribbon',
    metainfo: {
      _metainfoVersion: 53,
      id: 'mt-ema-ribbon@tv-basicstudies-1',
      scriptId: 'mt-ema-ribbon',
      name: 'mt-ema-ribbon',
      description: 'MT 双 EMA',
      shortDescription: 'MT EMA',
      is_price_study: true,
      isCustomIndicator: true,
      is_hidden_study: false,
      format: PRICE_FORMAT,
      plots: [
        { id: 'plot_0', type: 'line' },
        { id: 'plot_1', type: 'line' },
      ],
      defaults: {
        styles: {
          plot_0: {
            plottype: 2,
            linestyle: 0,
            linewidth: 1,
            trackprice: false,
            transparency: 0,
            visible: true,
            color: '#FF9800',
          },
          plot_1: {
            plottype: 2,
            linestyle: 0,
            linewidth: 1,
            trackprice: false,
            transparency: 0,
            visible: true,
            color: '#2196F3',
          },
        },
        inputs: { in_0: 20, in_1: 50 },
      },
      inputs: [
        { id: 'in_0', name: '快线周期', defval: 20, type: 'integer', min: 1, max: 5000 },
        { id: 'in_1', name: '慢线周期', defval: 50, type: 'integer', min: 1, max: 5000 },
      ],
    } as never,
    constructor: function (this: Record<string, unknown>) {
      this.init = function (this: Record<string, unknown>, ctx: IContext, inputs: Inputs) {
        this._context = ctx;
        this._input = inputs;
      };
      this.main = function (this: Record<string, unknown>, ctx: IContext, inputs: Inputs) {
        this._context = ctx;
        this._input = inputs;
        const close = ctx.new_var(PineJS.Std.close(ctx));
        const fast = PineJS.Std.ema(close, Number(inputs(0)), ctx);
        const slow = PineJS.Std.ema(close, Number(inputs(1)), ctx);
        return [fast, slow];
      };
    } as never,
  };

  return Promise.resolve([emaRibbon]);
}
