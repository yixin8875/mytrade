import type {
  Bar as TvBar,
  DatafeedConfiguration,
  DatafeedErrorCallback,
  HistoryCallback,
  IDatafeedChartApi,
  LibrarySymbolInfo,
  PeriodParams,
  ResolutionString,
  ResolveCallback,
  SearchSymbolsCallback,
  SubscribeBarsCallback,
  Timezone,
} from '../../public/charting_library/charting_library';
import type { Bar } from '../gateway/types';
import { replayBars, sourceFor } from './source';
import { useReplay } from './store';

export const REPLAY_RESOLUTIONS = [
  '1',
  '5',
  '15',
  '30',
  '60',
  '240',
  '1D',
  '1W',
  '1M',
] as ResolutionString[];

const MINUTE_SECONDS: Record<string, number> = {
  '1': 60,
  '5': 300,
  '15': 900,
  '30': 1800,
  '60': 3600,
  '240': 14400,
};

const MAX_HISTORY = 5000;

function toTvBar(bar: Bar): TvBar {
  return {
    time: bar.time * 1000,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  };
}

export function bucketStart(ts: number, resolution: string): number {
  // MINUTE_SECONDS 存的是每个周期的秒数，不要再乘 60
  const seconds = MINUTE_SECONDS[resolution];
  if (seconds) return Math.floor(ts / seconds) * seconds;
  const date = new Date(ts * 1000);
  if (resolution === '1D') {
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000;
  }
  if (resolution === '1W') {
    const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000;
    const offset = (date.getUTCDay() + 6) % 7;
    return dayStart - offset * 86400;
  }
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000;
}

/** 把已揭示的 M1 聚合成目标周期；只处理 bars[0..endIndex-1] */
export function aggregateBars(bars: Bar[], resolution: string, endIndex: number): Bar[] {
  const limit = Math.max(0, Math.min(endIndex, bars.length));
  if (!limit) return [];
  const out: Bar[] = [];
  let current: Bar | null = null;
  let bucket = 0;
  for (let index = 0; index < limit; index += 1) {
    const bar = bars[index];
    const start = bucketStart(bar.time, resolution);
    if (!current || start !== bucket) {
      if (current) out.push(current);
      bucket = start;
      current = {
        time: start,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      };
    } else {
      current.high = Math.max(current.high, bar.high);
      current.low = Math.min(current.low, bar.low);
      current.close = bar.close;
      current.volume += bar.volume;
    }
  }
  if (current) out.push(current);
  return out;
}

/** 只算游标所在的那一根，逐根推送用，避免每次重算整段历史 */
export function aggregateLast(
  bars: Bar[],
  resolution: string,
  endIndex: number,
): Bar | null {
  const limit = Math.max(0, Math.min(endIndex, bars.length));
  if (!limit) return null;
  const last = bars[limit - 1];
  const start = bucketStart(last.time, resolution);
  let index = limit - 1;
  while (index > 0 && bucketStart(bars[index - 1].time, resolution) === start) index -= 1;
  const slice = bars.slice(index, limit);
  return {
    time: start,
    open: slice[0].open,
    high: Math.max(...slice.map((bar) => bar.high)),
    low: Math.min(...slice.map((bar) => bar.low)),
    close: slice[slice.length - 1].close,
    volume: slice.reduce((sum, bar) => sum + bar.volume, 0),
  };
}

interface Listener {
  resolution: string;
  onTick: SubscribeBarsCallback;
  onReset: () => void;
  off: () => void;
}

export class ReplayDatafeed implements IDatafeedChartApi {
  private sessionId: string;
  private listeners = new Map<string, Listener>();
  private cache = new Map<string, { cursor: number; bars: Bar[] }>();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  private get session() {
    return useReplay.getState().sessions.find((item) => item.id === this.sessionId);
  }

  onReady(callback: (configuration: DatafeedConfiguration) => void): void {
    window.setTimeout(
      () =>
        callback({
          supported_resolutions: REPLAY_RESOLUTIONS,
          exchanges: [{ value: 'REPLAY', name: '本地复盘', desc: '本地历史行情回放' }],
          symbols_types: [{ name: '全部', value: '' }],
          currency_codes: [],
        }),
      0,
    );
  }

  searchSymbols(
    _userInput: string,
    _exchange: string,
    _symbolType: string,
    onResult: SearchSymbolsCallback,
  ): void {
    const session = this.session;
    if (!session) {
      onResult([]);
      return;
    }
    onResult([
      {
        symbol: session.symbol,
        description: session.symbolInfo.description || session.symbol,
        exchange: 'REPLAY',
        ticker: session.symbol,
        type: 'commodity',
      },
    ]);
  }

  resolveSymbol(
    symbolName: string,
    onResolve: ResolveCallback,
    onError: DatafeedErrorCallback,
  ): void {
    const session = this.session;
    if (!session) {
      onError('回放会话不存在');
      return;
    }
    const info = session.symbolInfo;
    const symbolInfo: LibrarySymbolInfo = {
      name: session.symbol,
      ticker: session.symbol,
      description: info.description || session.symbol,
      type: 'commodity',
      session: '24x7',
      timezone: 'Etc/UTC' as Timezone,
      exchange: 'REPLAY',
      listed_exchange: 'REPLAY',
      format: 'price',
      pricescale: 10 ** info.digits,
      minmov: 1,
      minmove2: 0,
      has_intraday: true,
      has_daily: true,
      has_weekly_and_monthly: true,
      has_empty_bars: false,
      has_seconds: false,
      supported_resolutions: REPLAY_RESOLUTIONS,
      volume_precision: 0,
      data_status: 'streaming',
      currency_code: info.currency || 'USD',
    };
    // Charting Library 要求 resolveSymbol 异步回调
    window.setTimeout(() => onResolve(symbolInfo), 0);
  }

  getBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    periodParams: PeriodParams,
    onResult: HistoryCallback,
    onError: DatafeedErrorCallback,
  ): void {
    const session = this.session;
    if (!session) {
      onError('回放会话不存在');
      return;
    }
    try {
      const bars = replayBars(session.id);
      const endIndex = Math.min(session.cursorIndex, bars.length);
      const cached = this.cache.get(resolution);
      let series: Bar[];
      if (cached && cached.cursor === endIndex) {
        series = cached.bars;
      } else {
        series = aggregateBars(bars, resolution, endIndex);
        this.cache.set(resolution, { cursor: endIndex, bars: series });
      }

      const asSeconds = (value: number) => (value > 1e11 ? Math.floor(value / 1000) : value);
      const to = periodParams.to ? asSeconds(periodParams.to) : 0;
      let visible = series;
      if (to) visible = visible.filter((bar) => bar.time <= to);
      // 不从 from 硬截断：跨周末时图表会认为左侧没有数据而停止翻页
      const countBack = periodParams.countBack || 0;
      if (countBack > 0) {
        const minCount = countBack + Math.min(300, countBack);
        if (visible.length > minCount) visible = visible.slice(visible.length - minCount);
      }
      if (visible.length > MAX_HISTORY) visible = visible.slice(visible.length - MAX_HISTORY);
      onResult(visible.map(toTvBar), { noData: visible.length === 0 });
    } catch (error) {
      onError((error as Error).message);
    }
  }

  subscribeBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    onTick: SubscribeBarsCallback,
    listenerGuid: string,
    onResetCacheNeededCallback: () => void,
  ): void {
    const off = sourceFor(this.sessionId).subscribe((event) => {
      if (event.kind === 'reset') {
        // 行情刚载入或会话重开：让图表按当前游标重新取数
        this.cache.clear();
        onResetCacheNeededCallback();
        return;
      }
      if (event.kind !== 'tick') return;
      const session = this.session;
      if (!session) return;
      const bars = replayBars(session.id);
      const bar = aggregateLast(bars, resolution, session.cursorIndex);
      if (!bar) return;
      onTick(toTvBar(bar));
    });
    this.listeners.set(listenerGuid, {
      resolution,
      onTick,
      onReset: onResetCacheNeededCallback,
      off,
    });
  }

  unsubscribeBars(listenerGuid: string): void {
    const listener = this.listeners.get(listenerGuid);
    if (!listener) return;
    listener.off();
    this.listeners.delete(listenerGuid);
  }

  getServerTime(callback: (serverTime: number) => void): void {
    const session = this.session;
    if (!session) {
      callback(Math.floor(Date.now() / 1000));
      return;
    }
    const bars = replayBars(session.id);
    const last = bars[session.cursorIndex - 1];
    callback(last ? last.time + 60 : session.startTs);
  }

  /** 会话被重新载入后丢掉聚合缓存 */
  resetCache(): void {
    this.cache.clear();
  }
}
