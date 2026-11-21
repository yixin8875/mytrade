import type {
  CustomIndicator,
  IContext,
  PineJS,
} from '../../../public/charting_library/charting_library';
import {
  readPineScripts,
  type PineInputMeta,
  type PinePlotMeta,
  type PineScriptRecord,
} from '../../lib/pineScripts';

/**
 * 把用户保存的 Pine 脚本注册成图表库的自定义指标。
 *
 * 图表库的指标只能返回折线，真正的 Pine 计算在 pineRunner.ts 里完成；
 * 这里负责生成指标元信息（曲线数量/颜色、输入参数），main 按 bar 时间
 * 从共享结果里取值。计算完成后由 runner 改一次 in_refresh 输入触发重算。
 *
 * Pine 引擎的 plot 数据是整段序列，main 只是查表，因此每次重算代价很低。
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

/**
 * 图表库的颜色解析只认 #RGB / #RRGGBB / rgb() / rgba()；8 位 #RRGGBBAA 会让
 * 指标设置对话框抛 "Passed color string does not match..."，整个「设置」打不开。
 * Piner 的颜色默认值带 alpha，这里统一转成 rgba()，运行前再由 pineRunner 转回。
 */
function libraryColor(value: unknown): string {
  const raw = String(value ?? '');
  const match = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(raw);
  if (!match) return raw;
  const alpha = Math.round((parseInt(match[4], 16) / 255) * 100) / 100;
  return `rgba(${parseInt(match[1], 16)}, ${parseInt(match[2], 16)}, ${parseInt(match[3], 16)}, ${alpha})`;
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
      return { ...base, defval: libraryColor(meta.defval ?? '#2962FF'), type: 'color' };
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
  // 只有 box/label/table 的脚本没有曲线；图库要求指标至少有一条 plot，
  // 所以补一条隐藏的占位曲线，真正的对象由 pineRenderLayer 画。
  const metas: PinePlotMeta[] =
    script.plots.length > 0
      ? script.plots
      : [{ key: '__drawing__', title: '（绘图对象）', color: '#787B86', visible: false }];

  const plots = metas.map((_plot, index) => ({
    id: `plot_${index}`,
    type: 'line',
  }));
  const styles: Record<string, unknown> = {};
  metas.forEach((plot, index) => {
    styles[`plot_${index}`] = {
      plottype: 2,
      linestyle: 0,
      linewidth: 1,
      trackprice: false,
      transparency: 0,
      visible: plot.visible !== false,
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

  // 默认值必须和 inputs 里声明的 defval 一致（颜色已经转成 rgba），
  // 否则恢复默认时又会把 8 位颜色写回去
  const defaults: Record<string, unknown> = { in_refresh: 0 };
  for (const input of inputs) {
    const id = String(input.id);
    if (id === 'in_refresh') continue;
    defaults[id] = input.defval;
  }

  // 图表库的「设置」对话框按 metaInfo.styles[plotId].title 渲染样式页，
  // 缺了 styles 会在 ensureDefined 里抛 "Value is undefined"，对话框直接打不开。
  const stylesMeta: Record<string, { title: string; isHidden: boolean }> = {};
  metas.forEach((meta, index) => {
    stylesMeta[`plot_${index}`] = { title: meta.title || `曲线 ${index + 1}`, isHidden: false };
  });

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
      styles: stylesMeta,
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
        const values: number[] = new Array(metas.length).fill(Number.NaN);
        const result = getPineResult(contextId, script.id);
        if (!result) return values;
        const raw = PineJS.Std.time(ctx);
        if (!Number.isFinite(raw)) return values;
        // 库内部时间戳可能是毫秒；Piner 用 bar.time * 1000 作为 openTime
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

function migrateInputColors(inputs: unknown): void {
  if (!inputs || typeof inputs !== 'object') return;
  const values = inputs as Record<string, unknown>;
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string') values[key] = libraryColor(value);
  }
}

/**
 * 旧版本把 Piner 的 #RRGGBBAA 直接存进了指标模板，图表库解析不了会让「设置」打不开。
 * 模板里有三份需要一起改（少改一份，恢复出来的指标仍然打不开设置）：
 *   - state.inputs：当前输入值
 *   - metaInfo.inputs[].defval：保存时的指标元信息快照
 *   - metaInfo.defaults.inputs：快照里的默认值
 * 非 Pine 指标不动。
 */
export function migratePineTemplate(state: unknown): void {
  const panes = (state as { panes?: unknown })?.panes;
  if (!Array.isArray(panes)) return;
  for (const pane of panes) {
    const sources = (pane as { sources?: unknown })?.sources;
    if (!Array.isArray(sources)) continue;
    for (const source of sources) {
      const item = source as {
        metaInfo?: {
          name?: string;
          inputs?: { defval?: unknown }[];
          defaults?: { inputs?: unknown };
        };
        state?: { inputs?: unknown };
      };
      if (!String(item.metaInfo?.name ?? '').startsWith('mt-pine-')) continue;
      migrateInputColors(item.state?.inputs);
      for (const input of item.metaInfo?.inputs ?? []) {
        if (typeof input.defval === 'string') input.defval = libraryColor(input.defval);
      }
      migrateInputColors(item.metaInfo?.defaults?.inputs);
    }
  }
}

export function pineIndicators(PineJS: PineJS, contextId: string): CustomIndicator[] {
  return readPineScripts().map((script) => buildIndicator(script, contextId, PineJS));
}
