import type {
  CustomIndicator,
  IContext,
  PineJS,
} from '../../../public/charting_library/charting_library';
import {
  readPineScripts,
  type PineInputMeta,
  type PineScriptRecord,
} from '../../lib/pineScripts';

/**
 * 把用户保存的 Pine 脚本注册成图表库的自定义指标。
 *
 * 图表库的指标只能返回折线，真正的 Pine 计算在 pineRunner.ts 里完成；
 * 这里负责生成指标元信息（曲线数量/颜色、输入参数），main 按 bar 时间
 * 从共享结果里取值。计算完成后由 runner 改一次 in_refresh 输入触发重算。
 *
 * PineTS 的 plot 数据是整段序列，main 只是查表，因此每次重算代价很低。
 */

export interface PineSeriesResult {
  /** bar 时间（秒，图表坐标系） -> 各条曲线值 */
  byTime: Map<number, number[]>;
}

const results = new Map<string, PineSeriesResult>();

function resultKey(contextId: string, scriptId: string): string {
  return `${contextId}|${scriptId}`;
}

export function getPineResult(contextId: string, scriptId: string): PineSeriesResult | undefined {
  return results.get(resultKey(contextId, scriptId));
}

export function setPineResult(
  contextId: string,
  scriptId: string,
  result: PineSeriesResult,
): void {
  results.set(resultKey(contextId, scriptId), result);
}

export function clearPineResult(contextId: string, scriptId: string): void {
  results.delete(resultKey(contextId, scriptId));
}

function libraryInput(meta: PineInputMeta): Record<string, unknown> {
  const base = { id: meta.id, name: meta.title };
  switch (meta.type) {
    case 'int':
      return {
        ...base,
        defval: Number(meta.defval) || 0,
        type: 'integer',
        min: meta.minval ?? -2_147_483_648,
        max: meta.maxval ?? 2_147_483_647,
      };
    case 'float':
      return {
        ...base,
        defval: Number(meta.defval) || 0,
        type: 'float',
        min: meta.minval ?? -1e15,
        max: meta.maxval ?? 1e15,
      };
    case 'bool':
      return { ...base, defval: Boolean(meta.defval), type: 'bool' };
    case 'source':
      return { ...base, defval: String(meta.defval ?? 'close'), type: 'source' };
    case 'color':
      return { ...base, defval: String(meta.defval ?? '#2962FF'), type: 'color' };
    case 'enum':
    case 'string':
    case 'text_area':
      return {
        ...base,
        defval: String(meta.defval ?? ''),
        type: 'text',
        ...(meta.options?.length ? { options: meta.options.map(String) } : {}),
      };
    default:
      // price/time/session/symbol/timeframe 都按文本传递
      return { ...base, defval: String(meta.defval ?? ''), type: 'text' };
  }
}

function buildIndicator(
  script: PineScriptRecord,
  contextId: string,
  PineJS: PineJS,
): CustomIndicator {
  const plots = script.plots.map((_plot, index) => ({
    id: `plot_${index}`,
    type: 'line',
  }));
  const styles: Record<string, unknown> = {};
  script.plots.forEach((plot, index) => {
    styles[`plot_${index}`] = {
      plottype: 2,
      linestyle: 0,
      linewidth: 1,
      trackprice: false,
      transparency: 0,
      visible: true,
      color: plot.color,
    };
  });

  const inputs = [
    ...script.inputs.map(libraryInput),
    // 计算完成后 +1，让图表库重新跑一遍 main 读取新结果
    {
      id: 'in_refresh',
      name: '数据版本（自动）',
      defval: 0,
      type: 'integer',
      min: 0,
      max: 2_147_483_647,
    },
  ];

  const defaults: Record<string, unknown> = { in_refresh: 0 };
  for (const meta of script.inputs) defaults[meta.id] = meta.defval;

  return {
    name: `${script.title}（Pine）`,
    metainfo: {
      _metainfoVersion: 53,
      id: `mt-pine-${script.id}@tv-basicstudies-1`,
      scriptId: `mt-pine-${script.id}`,
      name: `mt-pine-${script.id}`,
      description: script.title,
      shortDescription: script.title.slice(0, 24),
      is_price_study: script.overlay,
      isCustomIndicator: true,
      is_hidden_study: false,
      format: { type: 'inherit' },
      plots,
      defaults: {
        styles,
        inputs: defaults,
        showLabelsOnPriceScale: false,
        showLegendValues: false,
      },
      inputs,
    } as never,
    constructor: function (this: Record<string, unknown>) {
      this.init = function (this: Record<string, unknown>) {
        /* 结果由 runner 按品种/周期重新计算 */
      };
      this.main = function (this: Record<string, unknown>, ctx: IContext) {
        const values: number[] = new Array(script.plots.length).fill(Number.NaN);
        const result = getPineResult(contextId, script.id);
        if (!result) return values;
        const raw = PineJS.Std.time(ctx);
        if (!Number.isFinite(raw)) return values;
        // 库内部时间戳可能是毫秒；PineTS 用 bar.time * 1000 作为 openTime
        const time = raw > 1e11 ? Math.round(raw / 1000) : raw;
        const row = result.byTime.get(time);
        if (!row) return values;
        for (let index = 0; index < values.length; index += 1) {
          const value = row[index];
          if (typeof value === 'number' && Number.isFinite(value)) values[index] = value;
        }
        return values;
      };
    } as never,
  };
}

export function pineIndicators(PineJS: PineJS, contextId: string): CustomIndicator[] {
  return readPineScripts().map((script) => buildIndicator(script, contextId, PineJS));
}
