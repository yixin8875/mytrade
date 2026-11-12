import { gateway } from '../../gateway/client';
import { useApp } from '../../store/useApp';
import type { Bar } from '../../gateway/types';
import {
  readPineScripts,
  type PineInputMeta,
  type PineScriptRecord,
} from '../../lib/pineScripts';
import { clearPineResult, setPineResult } from './pineStudies';
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
 *  2. 动态加载 PineTS，把整段 K 线喂进去跑一遍原生 Pine 脚本；
 *  3. 把结果写进 pineStudies 的共享表；
 *  4. 改一次 in_refresh 输入，让图表库重跑 main，把曲线画出来。
 *
 * 计算放在主线程（5000 根 bar 的简单脚本约 75ms）；如果后续脚本更重，
 * 再把 run() 挪到 Web Worker。
 */

const HISTORY_COUNT = 5000;
const POLL_MS = 1200;
const COMPUTE_DELAY_MS = 350;
const BARS_TTL_MS = 60_000;
/** 输入值变化后至少等这么久再重算，避免拖动参数时连环计算 */
const MIN_RECOMPUTE_GAP_MS = 250;

interface CachedBars {
  bars: Bar[];
  at: number;
}

const barsCache = new Map<string, CachedBars>();
const barsLoading = new Map<string, Promise<Bar[]>>();

function barsKey(symbol: string, resolution: string): string {
  return `${symbol}|${resolution}`;
}

async function loadBars(symbol: string, resolution: string): Promise<Bar[]> {
  const key = barsKey(symbol, resolution);
  const cached = barsCache.get(key);
  if (cached && Date.now() - cached.at < BARS_TTL_MS) return cached.bars;
  const loading = barsLoading.get(key);
  if (loading) return loading;
  const promise = gateway
    .call<{ bars: Bar[] }>('history.get', { symbol, resolution, count: HISTORY_COUNT })
    .then((result) => {
      barsCache.set(key, { bars: result.bars, at: Date.now() });
      return result.bars;
    })
    .finally(() => barsLoading.delete(key));
  barsLoading.set(key, promise);
  return promise;
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

function toInputValue(meta: PineInputMeta, value: unknown): unknown {
  switch (meta.type) {
    case 'int':
    case 'float':
      return Number(value);
    case 'bool':
      return Boolean(value);
    default:
      return String(value ?? '');
  }
}

function candlesFrom(bars: Bar[]) {
  return bars
    .filter((bar) => Number.isFinite(bar.time))
    .map((bar) => ({
      openTime: bar.time * 1000,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    }));
}

export class PineRunner {
  private readonly widget: IChartingLibraryWidget;
  private readonly contextId: string;

  private pollTimer = 0;
  private disposed = false;
  private scripts: PineScriptRecord[] = [];
  private scriptsSignature = '';
  private signatures = new Map<string, string>();
  private timers = new Map<string, number>();
  private running = new Set<string>();
  private lastRunAt = new Map<string, number>();
  private refreshCounters = new Map<string, number>();
  private reportedErrors = new Map<string, string>();
  private offBar: (() => void) | null = null;
  private readonly unsubs: (() => void)[] = [];

  constructor(widget: IChartingLibraryWidget, contextId: string) {
    this.widget = widget;
    this.contextId = contextId;
  }

  start(): void {
    if (this.disposed) return;
    this.syncScripts();
    const chart = this.chart();
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
    });
    this.pollTimer = window.setInterval(() => this.tick(), POLL_MS);
    this.tick();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.clearInterval(this.pollTimer);
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
    for (const script of this.scripts) clearPineResult(this.contextId, script.id);
    this.signatures.clear();
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
    const byTitle = new Map(this.scripts.map((script) => [script.title, script]));
    const alive = new Set<string>();

    for (const info of studies) {
      const script = byTitle.get(info.name);
      if (!script) continue;
      alive.add(info.id);
      let api: IStudyApi;
      try {
        api = chart.getStudyById(info.id);
        if (!api.isVisible()) continue;
      } catch {
        continue;
      }

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

      const bars = barsCache.get(barsKey(symbol, resolution));
      const lastBar = bars?.bars.length ? bars.bars[bars.bars.length - 1].time : 0;
      const signature = JSON.stringify([script.id, symbol, resolution, inputs, lastBar]);
      if (this.signatures.get(info.id) === signature) continue;
      if (this.running.has(info.id) || this.timers.has(info.id)) continue;

      const timer = window.setTimeout(() => {
        this.timers.delete(info.id);
        void this.compute(info.id, script, symbol, resolution, inputs, signature);
      }, COMPUTE_DELAY_MS);
      this.timers.set(info.id, timer);
    }

    for (const studyId of [...this.signatures.keys()]) {
      if (alive.has(studyId)) continue;
      this.signatures.delete(studyId);
      this.reportedErrors.delete(studyId);
      this.refreshCounters.delete(studyId);
    }
  }

  private async compute(
    studyId: string,
    script: PineScriptRecord,
    symbol: string,
    resolution: string,
    inputs: Record<string, unknown>,
    signature: string,
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
    clearPineResult(this.contextId, script.id);

    try {
      const bars = await loadBars(symbol, resolution);
      if (bars.length === 0) throw new Error('没有取到 K 线');
      const overrides: Record<string, unknown> = {};
      for (const meta of script.inputs) {
        if (!(meta.id in inputs)) continue;
        overrides[meta.id] = toInputValue(meta, inputs[meta.id]);
      }

      const { PineTS, Indicator } = await import('pinets');
      const pine = new PineTS(candlesFrom(bars));
      const indicator = new Indicator(script.source, overrides);
      const ctx = await pine.run(indicator);
      if (this.disposed) return;

      const byTime = new Map<number, number[]>();
      script.plots.forEach((plot, index) => {
        const data = (ctx.plots[plot.key]?.data ?? []) as { time: number; value: unknown }[];
        for (const point of data) {
          if (!Number.isFinite(point.time)) continue;
          const time = Math.round(point.time / 1000);
          let row = byTime.get(time);
          if (!row) {
            row = new Array(script.plots.length).fill(Number.NaN);
            byTime.set(time, row);
          }
          row[index] = typeof point.value === 'number' ? point.value : Number.NaN;
        }
      });

      setPineResult(this.contextId, script.id, { byTime });
      this.reportedErrors.delete(studyId);
      this.forceRecalc(studyId);
    } catch (error) {
      clearPineResult(this.contextId, script.id);
      this.forceRecalc(studyId);
      const message = (error as Error)?.message || 'Pine 脚本运行失败';
      if (this.reportedErrors.get(studyId) !== signature) {
        this.reportedErrors.set(studyId, signature);
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
