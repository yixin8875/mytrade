import { gateway } from '../../gateway/client';
import { useApp } from '../../store/useApp';
import type { Bar } from '../../gateway/types';
import {
  readPineScripts,
  type PineInputMeta,
  type PineScriptRecord,
} from '../../lib/pineScripts';
import { clearPineResult, setPineResult } from './pineStudies';
import { runPine, type PineSeriesOutput } from './pineEngine';
import { PineRenderLayer, type PineShapeApi } from './pineRenderLayer';
import type {
  IChartWidgetApi,
  IChartingLibraryWidget,
  IStudyApi,
} from '../../../public/charting_library/charting_library';

/**
 * Pine 指标（实验）运行时。
 *
 * 对每张图上「已添加的 Pine 指标」：
 *  1. 读取指标输入 → 从网关取 K 线（按品种/周期共享缓存）；
 *  2. 调用 Piner 引擎，把整段 K 线喂进去跑一遍原生 Pine 脚本；
 *  3. 把结果写进 pineStudies 的共享表；
 *  4. 有曲线输出时改一次 in_refresh 输入，让图表库重跑 main，把曲线画出来。
 *
 * 计算放在主线程（5000 根 bar 的简单脚本约 75ms），所以只在真正需要时才算：
 * 换品种/周期/参数、新的一根 K 线收盘；纯绘图脚本不会因为盘中每笔报价重算。
 */

const HISTORY_COUNT = 5000;
const POLL_MS = 1200;
const COMPUTE_DELAY_MS = 350;
const BARS_TTL_MS = 60_000;
/** 取数失败后这段时间内不再重试，避免脚本不被支持时每个 tick 都打一次网关 */
const BARS_FAILURE_TTL_MS = 30_000;
/** 输入值变化后至少等这么久再重算，避免拖动参数时连环计算 */
const MIN_RECOMPUTE_GAP_MS = 250;
/**
 * 有曲线输出的指标要跟着最后一根 K 线走；盘中最多这么久重算一次。
 * 绘图型脚本不需要盘中更新，这一项不适用。
 */
const LIVE_REFRESH_MS = 3000;

interface CachedBars {
  bars: Bar[];
  at: number;
}

interface BarsFailure {
  at: number;
  message: string;
}

const barsCache = new Map<string, CachedBars>();
const barsLoading = new Map<string, Promise<Bar[]>>();
const barsFailures = new Map<string, BarsFailure>();

function barsKey(symbol: string, resolution: string): string {
  return `${symbol}|${resolution}`;
}

async function loadBars(symbol: string, resolution: string): Promise<Bar[]> {
  const key = barsKey(symbol, resolution);
  const cached = barsCache.get(key);
  if (cached && Date.now() - cached.at < BARS_TTL_MS) return cached.bars;
  const failure = barsFailures.get(key);
  if (failure && Date.now() - failure.at < BARS_FAILURE_TTL_MS) {
    throw new Error(failure.message);
  }
  const loading = barsLoading.get(key);
  if (loading) return loading;
  const promise = gateway
    .call<{ bars: Bar[] }>('history.get', { symbol, resolution, count: HISTORY_COUNT })
    .then((result) => {
      barsFailures.delete(key);
      barsCache.set(key, { bars: result.bars, at: Date.now() });
      return result.bars;
    })
    .catch((error: unknown) => {
      barsFailures.set(key, {
        at: Date.now(),
        message: (error as Error)?.message || '取 K 线失败',
      });
      throw error;
    })
    .finally(() => barsLoading.delete(key));
  barsLoading.set(key, promise);
  return promise;
}

/**
 * 提醒去重键：只由脚本、品种、周期、输入和提醒文字决定。
 * 不能带上最后一根 K 线的 OHLC——行情每跳一下签名就变，
 * 同一个提醒（例如「不支持 3M」）会每个 tick 重弹一次。
 */
export function noteKey(
  script: PineScriptRecord,
  symbol: string,
  resolution: string,
  inputs: Record<string, unknown>,
  notes: string[],
): string {
  return JSON.stringify([script.id, symbol, resolution, inputs, notes]);
}

function updateLiveBar(payload: { symbol?: string; resolution?: string; bar?: Bar }): void {
  if (!payload.bar || !payload.symbol || !payload.resolution) return;
  const entry = barsCache.get(barsKey(payload.symbol, payload.resolution));
  if (!entry) return;
  const bars = entry.bars;
  const last = bars[bars.length - 1];
  if (last && payload.bar.time === last.time) bars[bars.length - 1] = payload.bar;
  else if (!last || payload.bar.time > last.time) bars.push(payload.bar);
}

/**
 * 图表库的颜色输入是 #RRGGBB / rgb() / rgba()，Piner 的绘图颜色统一用 #RRGGBBAA；
 * 不转换的话 FVG 这类脚本拿到的颜色字符串没法直接当绘图颜色用。
 */
export function pineColor(value: unknown): string {
  const text = String(value ?? '').trim();
  const hex = /^#([0-9a-fA-F]{6})$/.exec(text);
  if (hex) return `#${hex[1]}FF`;
  const rgba = /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*([\d.]+)\s*\)$/i.exec(text);
  if (rgba) {
    const alpha = Math.round(Math.max(0, Math.min(1, Number(rgba[4]))) * 255);
    const part = (raw: string) => Math.max(0, Math.min(255, Number(raw))).toString(16).padStart(2, '0');
    return `#${part(rgba[1])}${part(rgba[2])}${part(rgba[3])}${alpha.toString(16).padStart(2, '0')}`.toUpperCase();
  }
  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(text);
  if (rgb) {
    const part = (raw: string) => Math.max(0, Math.min(255, Number(raw))).toString(16).padStart(2, '0');
    return `#${part(rgb[1])}${part(rgb[2])}${part(rgb[3])}FF`.toUpperCase();
  }
  return text;
}

/**
 * 图表库用指标的 description 作为 study.name；Pine 脚本有 shorttitle 时我们把它
 * 当成 description，所以挂载后的指标名可能是 shorttitle，也可能是完整标题
 * （旧图表模板里保存的还是完整标题）。两种名字都要能找回脚本。
 * 同一个名字可能对应多个脚本：保存同名脚本时标题会自动加「(2)」，但 shorttitle
 * 不变，这时由 pickScript 按指标实际输入再挑。
 */
export function scriptsByName(scripts: PineScriptRecord[]): Map<string, PineScriptRecord[]> {
  const byName = new Map<string, PineScriptRecord[]>();
  for (const script of scripts) {
    const names = [...new Set([script.title, script.shortTitle].filter((name): name is string => !!name))];
    for (const name of names) {
      const list = byName.get(name);
      if (list) list.push(script);
      else byName.set(name, [script]);
    }
  }
  return byName;
}

/**
 * 同名脚本里挑出当前指标对应的那一份。
 * 优先输入集合完全吻合的脚本（指标是用它创建的）；多个都吻合时取最新保存的
 * ——那通常是同一个脚本的另一份副本，画哪份结果都一样。
 */
export function pickScript(
  candidates: PineScriptRecord[],
  inputs: Record<string, unknown>,
): PineScriptRecord | undefined {
  if (candidates.length <= 1) return candidates[0];
  const ids = new Set(Object.keys(inputs));
  const matching = candidates.filter((script) =>
    script.inputs.length > 0
      ? script.inputs.every((meta) => ids.has(meta.id))
      : ids.size === 0,
  );
  // 输入集合完全相等最可靠；子集只能说「可能」，没把握时再看保存时间
  const exact = matching.filter((script) => script.inputs.length === ids.size);
  const pool = exact.length > 0 ? exact : matching.length > 0 ? matching : candidates;
  return [...pool].sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0))[0];
}

/**
 * 重算签名：这里变化了才需要重新跑一遍引擎。
 *
 * 最后一根 K 线是正在跳动的「未收盘」bar。绘图型脚本（关键价位、PDH/PDL 这类）
 * 的价位一天才变一次，没必要每笔报价都重算 5000 根 bar，所以默认只用
 * 「已收盘的那根」和 K 线数量做签名；有曲线输出的脚本盘中也要更新，
 * 由 tick() 给它们额外带上最后一根，并按 LIVE_REFRESH_MS 限速。
 */
export function studySignature(args: {
  scriptId: string;
  symbol: string;
  resolution: string;
  inputs: Record<string, unknown>;
  bars: Bar[] | undefined;
  live: boolean;
}): string {
  const bars = args.bars ?? [];
  // 只有一根时它就是最后一根，没有已收盘的可用
  const closed = bars.length >= 2 ? bars[bars.length - 2] : bars[bars.length - 1];
  const last = args.live ? bars[bars.length - 1] : undefined;
  return JSON.stringify([
    args.scriptId,
    args.symbol,
    args.resolution,
    args.inputs,
    bars.length,
    closed?.time,
    closed?.open,
    closed?.high,
    closed?.low,
    closed?.close,
    last?.time,
    last?.open,
    last?.high,
    last?.low,
    last?.close,
  ]);
}

export function toInputValue(meta: PineInputMeta, value: unknown): unknown {
  switch (meta.type) {
    case 'int':
    case 'float':
      return Number(value);
    case 'bool':
      return Boolean(value);
    case 'color':
      return pineColor(value);
    default:
      return String(value ?? '');
  }
}

/**
 * 把引擎输出对齐到保存时记录的 plot 列表。
 * 优先按 key/title 匹配；Piner 的标题可能为空，这时退回同类型的第一条。
 */
function alignSeries(
  series: PineSeriesOutput[],
  plots: PineScriptRecord['plots'],
): (PineSeriesOutput | undefined)[] {
  const used = new Set<number>();
  return plots.map((meta) => {
    const wantHline = meta.style === 'hline' || /^hline/i.test(meta.key);
    const kindMatches = (candidate: PineSeriesOutput) =>
      !meta.style || (wantHline ? candidate.kind === 'hline' : candidate.kind === 'plot');
    let index = series.findIndex(
      (candidate, candidateIndex) =>
        !used.has(candidateIndex) &&
        kindMatches(candidate) &&
        (candidate.key === meta.key ||
          candidate.title === meta.title ||
          candidate.title === meta.key),
    );
    if (index < 0) {
      index = series.findIndex(
        (candidate, candidateIndex) => !used.has(candidateIndex) && kindMatches(candidate),
      );
    }
    if (index < 0) {
      index = series.findIndex((_, candidateIndex) => !used.has(candidateIndex));
    }
    if (index >= 0) used.add(index);
    return index >= 0 ? series[index] : undefined;
  });
}

export class PineRunner {
  private readonly widget: IChartingLibraryWidget;
  private readonly contextId: string;
  private readonly host: HTMLElement | null;
  private readonly getTickSize: () => number;
  private renderer: PineRenderLayer | null = null;

  private pollTimer = 0;
  private disposed = false;
  private scripts: PineScriptRecord[] = [];
  private scriptsSignature = '';
  private signatures = new Map<string, string>();
  /** 只由已收盘 bar 决定的签名：用来判断「刚收盘了一根」，不受盘中跳动影响 */
  private closedSignatures = new Map<string, string>();
  private timers = new Map<string, number>();
  private running = new Set<string>();
  private lastRunAt = new Map<string, number>();
  private refreshCounters = new Map<string, number>();
  private reportedErrors = new Map<string, string>();
  private reportedWarnings = new Map<string, string>();
  private barTickTimer = 0;
  private offBar: (() => void) | null = null;
  private readonly unsubs: (() => void)[] = [];

  constructor(
    widget: IChartingLibraryWidget,
    contextId: string,
    host: HTMLElement | null = null,
    getTickSize: () => number = () => 0,
  ) {
    this.widget = widget;
    this.contextId = contextId;
    this.host = host;
    this.getTickSize = getTickSize;
  }

  start(): void {
    if (this.disposed) return;
    this.syncScripts();
    const chart = this.chart();
    if (chart) {
      // 渲染桥只用到绘图/可视范围这几项，IChartWidgetApi 的类型比这宽
      this.renderer = new PineRenderLayer(chart as unknown as PineShapeApi, this.host);
      this.renderer.start();
    }
    if (chart) {
      const symbolSub = chart.onSymbolChanged();
      const onSymbol = () => this.tick();
      symbolSub.subscribe(null, onSymbol);
      this.unsubs.push(() => symbolSub.unsubscribe(null, onSymbol));
    }
    const onStudy = () => this.tick();
    this.widget.subscribe('study', onStudy);
    this.unsubs.push(() => this.widget.unsubscribe('study', onStudy));

    const onScripts = () => {
      this.syncScripts();
      this.tick();
    };
    window.addEventListener('mytrade:pine-scripts', onScripts);
    this.unsubs.push(() => window.removeEventListener('mytrade:pine-scripts', onScripts));

    this.offBar = gateway.on('bar', (data) => {
      updateLiveBar(data as { symbol?: string; resolution?: string; bar?: Bar });
      this.scheduleTick();
    });
    this.pollTimer = window.setInterval(() => this.tick(), POLL_MS);
    this.tick();
  }

  /** bar 事件可能很密；合并成一次 tick，避免每笔都遍历 study。 */
  private scheduleTick(): void {
    if (this.disposed || this.barTickTimer) return;
    this.barTickTimer = window.setTimeout(() => {
      this.barTickTimer = 0;
      this.tick();
    }, 120);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.clearInterval(this.pollTimer);
    window.clearTimeout(this.barTickTimer);
    this.barTickTimer = 0;
    for (const timer of this.timers.values()) window.clearTimeout(timer);
    this.timers.clear();
    for (const off of this.unsubs) {
      try {
        off();
      } catch {
        /* 图表已经销毁 */
      }
    }
    this.unsubs.length = 0;
    this.offBar?.();
    this.offBar = null;
    this.renderer?.dispose();
    this.renderer = null;
    for (const script of this.scripts) clearPineResult(this.contextId, script.id);
    this.signatures.clear();
    this.closedSignatures.clear();
    this.running.clear();
  }

  private chart(): IChartWidgetApi | null {
    try {
      return this.widget.activeChart();
    } catch {
      return null;
    }
  }

  private syncScripts(): void {
    const scripts = readPineScripts();
    const signature = scripts
      .map((script) => `${script.id}:${script.title}:${script.source.length}`)
      .join('|');
    if (signature !== this.scriptsSignature) {
      this.scriptsSignature = signature;
      this.scripts = scripts;
    }
  }

  private tick(): void {
    if (this.disposed) return;
    this.syncScripts();
    if (this.scripts.length === 0) return;
    const chart = this.chart();
    if (!chart) return;

    let symbol = '';
    let resolution = '';
    try {
      symbol = chart.symbol();
      resolution = String(chart.resolution());
    } catch {
      return;
    }
    if (!symbol || !resolution) return;

    let studies;
    try {
      studies = chart.getAllStudies();
    } catch {
      return;
    }
    const byName = scriptsByName(this.scripts);
    const alive = new Set<string>();

    for (const info of studies) {
      const candidates = byName.get(info.name);
      if (!candidates || candidates.length === 0) continue;
      alive.add(info.id);
      let api: IStudyApi;
      try {
        api = chart.getStudyById(info.id);
      } catch {
        continue;
      }
      let visible = true;
      try {
        visible = api.isVisible();
      } catch {
        visible = true;
      }
      // 指标被隐藏时连绘图对象一起收起来，取消隐藏后再重新画
      this.renderer?.setVisible(info.id, visible);
      if (!visible) continue;

      const inputs: Record<string, unknown> = {};
      try {
        for (const item of api.getInputValues()) {
          const id = String(item.id);
          if (id === 'in_refresh') continue;
          inputs[id] = item.value;
        }
      } catch {
        continue;
      }

      // 同 shorttitle 的多份脚本：按指标实际输入挑出创建它的那一份
      const script = pickScript(candidates, inputs);
      if (!script) continue;

      const bars = barsCache.get(barsKey(symbol, resolution))?.bars;
      const closedSignature = studySignature({
        scriptId: script.id,
        symbol,
        resolution,
        inputs,
        bars,
        live: false,
      });
      // 有曲线输出的指标跟着最后一根 K 线走；纯绘图脚本只在收盘后才需要重算
      const signature =
        script.plots.length > 0
          ? studySignature({
              scriptId: script.id,
              symbol,
              resolution,
              inputs,
              bars,
              live: true,
            })
          : closedSignature;
      if (this.signatures.get(info.id) === signature) continue;
      // 盘中逐笔重算 5000 根 bar 太贵：只有刚收盘的那根变了才立刻算，
      // 其余（最后一根还在跳动）按 LIVE_REFRESH_MS 限速
      if (
        this.closedSignatures.get(info.id) === closedSignature &&
        Date.now() - (this.lastRunAt.get(info.id) ?? 0) < LIVE_REFRESH_MS
      ) {
        continue;
      }
      if (this.running.has(info.id) || this.timers.has(info.id)) continue;

      const timer = window.setTimeout(() => {
        this.timers.delete(info.id);
        void this.compute(info.id, script, symbol, resolution, inputs, signature, closedSignature);
      }, COMPUTE_DELAY_MS);
      this.timers.set(info.id, timer);
    }

    for (const studyId of [...this.signatures.keys()]) {
      if (alive.has(studyId)) continue;
      this.signatures.delete(studyId);
      this.closedSignatures.delete(studyId);
      this.reportedErrors.delete(studyId);
      this.reportedWarnings.delete(studyId);
      this.refreshCounters.delete(studyId);
      this.renderer?.removeStudy(studyId);
    }
  }

  private async compute(
    studyId: string,
    script: PineScriptRecord,
    symbol: string,
    resolution: string,
    inputs: Record<string, unknown>,
    signature: string,
    closedSignature: string,
  ): Promise<void> {
    if (this.disposed) return;
    const now = Date.now();
    const lastRun = this.lastRunAt.get(studyId) ?? 0;
    if (now - lastRun < MIN_RECOMPUTE_GAP_MS) {
      // 刚算完又变了：稍后再来一次
      window.setTimeout(() => this.tick(), MIN_RECOMPUTE_GAP_MS);
      return;
    }
    this.lastRunAt.set(studyId, now);
    this.running.add(studyId);
    this.signatures.set(studyId, signature);
    this.closedSignatures.set(studyId, closedSignature);
    clearPineResult(this.contextId, script.id);

    try {
      const bars = await loadBars(symbol, resolution);
      if (bars.length === 0) throw new Error('没有取到 K 线');
      const overrides: Record<string, unknown> = {};
      for (const meta of script.inputs) {
        if (!(meta.id in inputs)) continue;
        overrides[meta.id] = toInputValue(meta, inputs[meta.id]);
      }

      const result = await runPine({
        source: script.source,
        bars,
        symbol,
        resolution,
        inputs: overrides,
        inputMeta: script.inputs,
        fetchBars: loadBars,
        mintick: this.getTickSize(),
      });
      if (this.disposed) return;

      const aligned = alignSeries(result.series, script.plots);
      // 试跑时记录的调色板 -> 下标；运行期出现没见过的颜色时退回曲线默认色
      const palettes = script.plots.map(
        (plot) =>
          new Map((plot.colorPalette ?? []).map((color, index) => [color.toUpperCase(), index])),
      );
      const hasPalette = palettes.some((palette) => palette.size > 0);
      const byTime = new Map<number, number[]>();
      const colorsByTime = hasPalette ? new Map<number, (number | null)[]>() : undefined;
      for (let barIndex = 0; barIndex < bars.length; barIndex += 1) {
        const row = new Array(script.plots.length).fill(Number.NaN);
        aligned.forEach((series, plotIndex) => {
          const value = series?.values[barIndex];
          if (typeof value === 'number' && Number.isFinite(value)) row[plotIndex] = value;
        });
        byTime.set(bars[barIndex].time, row);

        if (colorsByTime) {
          const colorRow = new Array<number | null>(script.plots.length).fill(null);
          aligned.forEach((series, plotIndex) => {
            const palette = palettes[plotIndex];
            if (palette.size === 0) return;
            const color = series?.colors?.[barIndex];
            if (typeof color !== 'string' || !color) return;
            colorRow[plotIndex] = palette.get(color.toUpperCase()) ?? null;
          });
          colorsByTime.set(bars[barIndex].time, colorRow);
        }
      }

      setPineResult(
        this.contextId,
        script.id,
        colorsByTime ? { byTime, colorsByTime } : { byTime },
      );
      this.renderer?.update(studyId, script.title, result.visuals);
      this.reportedErrors.delete(studyId);

      const unsupported = result.visuals.unsupported;
      const notes = [
        ...result.warnings,
        ...(unsupported.length > 0 ? [`暂不渲染 ${unsupported.join('、')}`] : []),
      ];
      if (notes.length > 0) {
        const key = noteKey(script, symbol, resolution, inputs, notes);
        if (this.reportedWarnings.get(studyId) !== key) {
          this.reportedWarnings.set(studyId, key);
          useApp.getState().notify('info', `${script.title}：${notes.slice(0, 2).join('；')}`);
        }
      } else {
        this.reportedWarnings.delete(studyId);
      }
      // 纯绘图脚本没有曲线可刷新：改 in_refresh 只会让图表库白白重算一遍
      if (script.plots.length > 0) this.forceRecalc(studyId);
    } catch (error) {
      clearPineResult(this.contextId, script.id);
      this.renderer?.removeStudy(studyId);
      if (script.plots.length > 0) this.forceRecalc(studyId);
      const message = (error as Error)?.message || 'Pine 脚本运行失败';
      const key = noteKey(script, symbol, resolution, inputs, [message]);
      if (this.reportedErrors.get(studyId) !== key) {
        this.reportedErrors.set(studyId, key);
        useApp.getState().notify('error', `${script.title}：${message}`);
      }
    } finally {
      this.running.delete(studyId);
    }
  }

  private forceRecalc(studyId: string): void {
    if (this.disposed) return;
    const chart = this.chart();
    if (!chart) return;
    const next = (this.refreshCounters.get(studyId) ?? 0) + 1;
    this.refreshCounters.set(studyId, next);
    try {
      chart.getStudyById(studyId as never).setInputValues([
        { id: 'in_refresh', value: next },
      ] as never);
    } catch {
      /* 指标已经被删掉 */
    }
  }
}
