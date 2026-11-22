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
  /** bar 时间 -> 每条曲线的调色板下标；没有逐 bar 颜色的曲线为 null */
  colorsByTime?: Map<number, (number | null)[]>;
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

/**
 * Pine 的时间周期 -> 图表库的 ResolutionString。
 * Pine 用 'D'/'W'/'M'，图表库的日/周/月分辨率要写成 '1D'/'1W'/'1M'。
 */
function libraryResolution(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '1';
  const upper = raw.toUpperCase();
  if (upper === 'D' || upper === '1D') return '1D';
  if (upper === 'W' || upper === '1W') return '1W';
  if (upper === 'M' || upper === '1M') return '1M';
  return raw;
}

/**
 * Pine 的 plot.style_* -> 图表库的 LineStudyPlotStyle 数值。
 * 枚举定义见 charting_library.d.ts：Line=0, Histogram=1, Cross=3, Area=4,
 * Columns=5, Circles=6, LineWithBreaks=7, AreaWithBreaks=8, StepLine=9,
 * StepLineWithDiamonds=10, StepLineWithBreaks=11。
 */
const LIBRARY_PLOT_TYPES: Record<string, number> = {
  line: 0,
  histogram: 1,
  cross: 3,
  area: 4,
  columns: 5,
  circles: 6,
  linebr: 7,
  areabr: 8,
  stepline: 9,
  stepline_diamond: 10,
  steplinebr: 11,
};

function libraryPlotType(style?: string): number {
  return LIBRARY_PLOT_TYPES[style ?? 'line'] ?? 0;
}

/** 图表库的线宽只有 1–4，越界值会让设置对话框报错。 */
function libraryPlotWidth(width?: number): number {
  return Math.min(4, Math.max(1, Math.round(Number(width) || 1)));
}

/** 图表库 main() 返回数组里的一条：真实曲线，或给曲线逐 bar 上色的 colorer。 */
export interface PinePlotSlot {
  /** script.plots 里的下标 */
  metaIndex: number;
  /** true 表示取 colorsByTime 里的调色板下标，而不是曲线数值 */
  colorer: boolean;
}

/**
 * 把一次计算的结果摊平成图表库 main() 需要的数组。
 * 逐 bar 颜色无法直接画在一条曲线上，图表库的做法是紧跟一条 colorer 曲线，
 * 由它返回该 bar 的调色板下标。
 */
export function pinePlotValues(
  result: PineSeriesResult | undefined,
  time: number,
  slots: PinePlotSlot[],
): number[] {
  const values = new Array<number>(slots.length).fill(Number.NaN);
  if (!result) return values;
  const row = result.byTime.get(time);
  if (!row) return values;
  const colors = result.colorsByTime?.get(time);
  slots.forEach((slot, index) => {
    if (slot.colorer) {
      const colorIndex = colors?.[slot.metaIndex];
      if (typeof colorIndex === 'number' && Number.isFinite(colorIndex)) {
        values[index] = colorIndex;
      }
      return;
    }
    const value = row[slot.metaIndex];
    if (typeof value === 'number' && Number.isFinite(value)) values[index] = value;
  });
  return values;
}

function libraryInput(meta: PineInputMeta): Record<string, unknown> {
  // group 是图表库唯一支持的分组排版：同组输入会归到一个标题下
  const base = {
    id: meta.id,
    name: meta.title,
    ...(meta.group ? { group: meta.group } : {}),
  };
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
    case 'price':
      return {
        ...base,
        defval: Number(meta.defval) || 0,
        type: 'price',
        min: meta.minval ?? -1e15,
        max: meta.maxval ?? 1e15,
      };
    case 'bool':
      return { ...base, defval: Boolean(meta.defval), type: 'bool' };
    case 'source':
      return { ...base, defval: String(meta.defval ?? 'close'), type: 'source' };
    case 'color':
      return { ...base, defval: libraryColor(meta.defval ?? '#2962FF'), type: 'color' };
    case 'session':
      // 图表库有原生交易时段控件（带星期/时段选择器）
      return { ...base, defval: String(meta.defval ?? ''), type: 'session' };
    case 'timeframe':
      return { ...base, defval: libraryResolution(meta.defval), type: 'resolution' };
    case 'symbol':
      return { ...base, defval: String(meta.defval ?? ''), type: 'symbol' };
    case 'text_area':
      return { ...base, defval: String(meta.defval ?? ''), type: 'text_area' };
    case 'enum':
    case 'string':
      return {
        ...base,
        defval: String(meta.defval ?? ''),
        type: 'text',
        ...(meta.options?.length ? { options: meta.options.map(String) } : {}),
      };
    default:
      // time 暂按文本传递：图表库的时间控件按秒/毫秒的解释与 Pine 的 timestamp 不一致
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

  // 图表库的一条曲线只有一个颜色；Pine 的逐 bar 颜色靠紧跟的 colorer 曲线实现，
  // 它按调色板下标给目标曲线逐根上色。
  const slots: PinePlotSlot[] = [];
  const plots: { id: string; type: string; palette?: string; target?: string }[] = [];
  const styles: Record<string, Record<string, unknown>> = {};
  const palettesMeta: Record<string, unknown> = {};
  const paletteDefaults: Record<string, unknown> = {};

  metas.forEach((plot, index) => {
    const id = `plot_${index}`;
    const width = libraryPlotWidth(plot.width);
    const palette = plot.colorPalette ?? [];
    const perBar = palette.length > 1;
    plots.push({ id, type: 'line' });
    styles[id] = {
      plottype: libraryPlotType(plot.style),
      linestyle: 0,
      linewidth: width,
      trackprice: false,
      // 调色板里的颜色自带 alpha（转成了 rgba），再叠一层透明度会变得过淡
      transparency: perBar ? 0 : (plot.transparency ?? 0),
      visible: plot.visible !== false,
      color: perBar ? libraryColor(palette[0]) : plot.color,
    };
    slots.push({ metaIndex: index, colorer: false });
    if (!perBar) return;

    const paletteId = `palette_${index}`;
    plots.push({
      id: `${id}_color`,
      type: 'colorer',
      palette: paletteId,
      target: id,
    });
    palettesMeta[paletteId] = {
      colors: palette.map((_, colorIndex) => ({ name: `颜色 ${colorIndex + 1}` })),
      // 没有取到逐 bar 颜色的那几根（例如运行期出现了试跑没见过的颜色）用默认色
      addDefaultColor: true,
    };
    paletteDefaults[paletteId] = {
      colors: palette.map((color) => ({
        color: libraryColor(color),
        style: 0,
        width,
      })),
    };
    slots.push({ metaIndex: index, colorer: true });
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
      // 图表库会把 isHidden 的输入从「设置」里去掉；它不是 Pine 参数，不该出现
      isHidden: true,
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
    const title = meta.title || `曲线 ${index + 1}`;
    stylesMeta[`plot_${index}`] = { title, isHidden: false };
    // colorer 曲线在设置里没有可调样式，但缺 title 会让对话框 ensureDefined 报错
    if ((meta.colorPalette?.length ?? 0) > 1) {
      stylesMeta[`plot_${index}_color`] = { title: `${title} 颜色`, isHidden: false };
    }
  });

  // TradingView 的图例和设置标题显示 shorttitle；没写时才退回完整标题
  const displayName = script.shortTitle || script.title;

  return {
    name: `${script.title}（Pine）`,
    metainfo: {
      _metainfoVersion: 53,
      id: `mt-pine-${script.id}@tv-basicstudies-1`,
      scriptId: `mt-pine-${script.id}`,
      name: `mt-pine-${script.id}`,
      description: displayName,
      shortDescription: displayName.slice(0, 24),
      is_price_study: script.overlay,
      isCustomIndicator: true,
      is_hidden_study: false,
      format: { type: 'inherit' },
      plots,
      styles: stylesMeta,
      ...(Object.keys(palettesMeta).length ? { palettes: palettesMeta } : {}),
      defaults: {
        styles,
        ...(Object.keys(paletteDefaults).length ? { palettes: paletteDefaults } : {}),
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
        const result = getPineResult(contextId, script.id);
        if (!result) return pinePlotValues(undefined, 0, slots);
        const raw = PineJS.Std.time(ctx);
        if (!Number.isFinite(raw)) return pinePlotValues(undefined, 0, slots);
        // 库内部时间戳可能是毫秒；Piner 用 bar.time * 1000 作为 openTime
        const time = raw > 1e11 ? Math.round(raw / 1000) : raw;
        return pinePlotValues(result, time, slots);
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
