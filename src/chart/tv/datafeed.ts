import { gateway } from '../../gateway/client';
import { useApp } from '../../store/useApp';
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
} from '../../../public/charting_library/charting_library';
import type { Bar as GatewayBar, SymbolInfo } from '../../gateway/types';

/** 与网关 TIMEFRAMES 一一对应 */
export const SUPPORTED_RESOLUTIONS = [
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

const HISTORY_LIMIT = 5000;

function symbolType(name: string, description: string): string {
  const text = `${name} ${description}`.toUpperCase();
  if (/(BTC|ETH|SOL|XRP|DOGE|LTC|ADA)/.test(text)) return 'crypto';
  if (/(XAU|XAG|XPT|XPD|GOLD|SILVER|OIL|BRENT|WTI|NGAS)/.test(text)) return 'commodity';
  if (/(US500|US30|NAS100|USTEC|GER40|UK100|JP225|HK50|FRA40|AUS200|SPX|NDX)/.test(text)) {
    return 'index';
  }
  return 'forex';
}

/**
 * MT5 的 K 线时间戳是券商服务器时间，不是 UTC，而且券商时区常常不在
 * TradingView 支持的时区列表里。这里的做法是：把「服务器时间」当成 UTC 整体交给
 * TradingView，同时让 getServerTime 也返回服务器时间。这样坐标轴、日线分组、
 * “现在”三者的参照系一致，界面时间和 MT5 完全一致。
 */
export function exchangeTimezone(): Timezone {
  return 'Etc/UTC';
}

function toTvBar(bar: GatewayBar): TvBar {
  return {
    // v32 的 Bar.time 是毫秒；网关给的是秒
    time: bar.time * 1000,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  };
}

function serverOffset(): number {
  const state = useApp.getState();
  return state.quote?.serverOffset ?? state.health?.serverOffset ?? 0;
}

interface BarListener {
  off: () => void;
  symbol: string;
  resolution: string;
}

export class GatewayDatafeed implements IDatafeedChartApi {
  private listeners = new Map<string, BarListener>();

  onReady(callback: (configuration: DatafeedConfiguration) => void): void {
    // TradingView 要求异步回调
    window.setTimeout(() => callback({
      supported_resolutions: SUPPORTED_RESOLUTIONS,
      exchanges: [{ value: 'MT5', name: 'MetaTrader 5', desc: 'MetaTrader 5 券商' }],
      symbols_types: [
        { name: '全部', value: '' },
        { name: '外汇', value: 'forex' },
        { name: '指数', value: 'index' },
        { name: '商品', value: 'commodity' },
        { name: '加密', value: 'crypto' },
      ],
      currency_codes: [],
    }), 0);
  }

  searchSymbols(
    userInput: string,
    _exchange: string,
    _symbolType: string,
    onResult: SearchSymbolsCallback,
  ): void {
    gateway
      .call<SymbolInfo[]>('symbols.list', { query: userInput, limit: 50 })
      .then((items) => {
        onResult(
          items.map((item) => ({
            symbol: item.name,
            full_name: item.name,
            description: item.description,
            exchange: 'MT5',
            ticker: item.name,
            type: symbolType(item.name, item.description),
          })),
        );
      })
      .catch(() => onResult([]));
  }

  resolveSymbol(
    symbolName: string,
    onResolve: ResolveCallback,
    onError: DatafeedErrorCallback,
  ): void {
    gateway
      .call<SymbolInfo>('symbol.info', { symbol: symbolName })
      .then((info) => {
        const symbolInfo: LibrarySymbolInfo = {
          name: info.name,
          ticker: info.name,
          description: info.description || info.name,
          type: symbolType(info.name, info.description),
          session: '24x7',
          timezone: exchangeTimezone(),
          exchange: 'MT5',
          listed_exchange: 'MT5',
          format: 'price',
          pricescale: 10 ** info.digits,
          minmov: 1,
          minmove2: 0,
          has_intraday: true,
          has_daily: true,
          has_weekly_and_monthly: true,
          has_empty_bars: false,
          has_seconds: false,
          supported_resolutions: SUPPORTED_RESOLUTIONS,
          volume_precision: 0,
          data_status: 'streaming',
          currency_code: info.currency || 'USD',
        };
        onResolve(symbolInfo);
      })
      .catch((error: Error) => onError(error.message));
  }

  getBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    periodParams: PeriodParams,
    onResult: HistoryCallback,
    onError: DatafeedErrorCallback,
  ): void {
    // periodParams 在不同版本里可能是秒也可能是毫秒，统一按秒
    const asSeconds = (value: number) => (value > 1e11 ? Math.floor(value / 1000) : value);
    const to = periodParams.to ? asSeconds(periodParams.to) : 0;
    const from = periodParams.from ? asSeconds(periodParams.from) : 0;
    const count = Math.min(
      HISTORY_LIMIT,
      Math.max(300, Math.ceil(periodParams.countBack || 300) + 200),
    );
    gateway
      .call<{ bars: GatewayBar[] }>('history.get', {
        symbol: symbolInfo.name,
        resolution,
        count,
        // 往左翻页时告诉网关要哪一段；网关用 copy_rates_range 取更早的 K 线
        from: from || undefined,
        to: to || undefined,
      })
      .then((result) => {
        // 网关在休市窗口会返回更早的一段 K 线，所以这里只挡掉晚于 to 的，
        // 不再按 from 截断，否则跨周末时会把补回来的数据丢掉
        const bars = result.bars
          .filter((bar) => !to || bar.time <= to)
          .map(toTvBar);
        onResult(bars, { noData: bars.length === 0 });
      })
      .catch((error: Error) => onError(error.message));
  }

  subscribeBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    onTick: SubscribeBarsCallback,
    listenerGuid: string,
  ): void {
    const off = gateway.on('bar', (data) => {
      const payload = data as { symbol: string; resolution: string; bar: GatewayBar };
      if (payload.symbol !== symbolInfo.name || payload.resolution !== resolution) return;
      onTick(toTvBar(payload.bar));
    });
    this.listeners.set(listenerGuid, {
      off,
      symbol: symbolInfo.name,
      resolution,
    });
    gateway.call('bars.subscribe', { symbol: symbolInfo.name, resolution }).catch(() => {});
  }

  unsubscribeBars(listenerGuid: string): void {
    const listener = this.listeners.get(listenerGuid);
    if (!listener) return;
    listener.off();
    this.listeners.delete(listenerGuid);
    gateway
      .call('bars.unsubscribe', { symbol: listener.symbol, resolution: listener.resolution })
      .catch(() => {});
  }

  getServerTime(callback: (serverTime: number) => void): void {
    // K 线用的是券商服务器时间，这里必须返回同一个参照系，否则“现在”会错位
    callback(Math.floor(Date.now() / 1000) + serverOffset());
  }

  // ---- 画线模板：TradingView 的「模板」菜单会调用这四个方法 ----
  // 存在本机 localStorage，换股票/周期后仍然可用；不经过网关。

  private drawingKey(toolName: string): string {
    return `mytrade.drawingTemplates.${toolName}`;
  }

  private drawingMap(toolName: string): Record<string, string> {
    try {
      const raw = window.localStorage.getItem(this.drawingKey(toolName));
      if (!raw) return {};
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  getDrawingTemplates(toolName: string): Promise<string[]> {
    return Promise.resolve(Object.keys(this.drawingMap(toolName)));
  }

  loadDrawingTemplate(toolName: string, templateName: string): Promise<string> {
    const content = this.drawingMap(toolName)[templateName];
    return typeof content === 'string'
      ? Promise.resolve(content)
      : Promise.reject(new Error('模板不存在'));
  }

  saveDrawingTemplate(toolName: string, templateName: string, content: string): Promise<void> {
    const map = this.drawingMap(toolName);
    map[templateName] = content;
    try {
      window.localStorage.setItem(this.drawingKey(toolName), JSON.stringify(map));
    } catch {
      /* 本地存储满了也不影响绘图 */
    }
    return Promise.resolve();
  }

  removeDrawingTemplate(toolName: string, templateName: string): Promise<void> {
    const map = this.drawingMap(toolName);
    delete map[templateName];
    try {
      window.localStorage.setItem(this.drawingKey(toolName), JSON.stringify(map));
    } catch {
      /* 忽略 */
    }
    return Promise.resolve();
  }
}
