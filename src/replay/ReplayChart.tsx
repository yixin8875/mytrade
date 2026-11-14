import { useEffect, useRef, useState } from 'react';
import { Lock } from 'lucide-react';
import { PriceLineLayer, type PriceLineSpec } from '../chart/tv/priceLines';
import { useApp, type Theme } from '../store/useApp';
import { aggregateBars, ReplayDatafeed } from './datafeed';
import { replayBars, sourceFor } from './source';
import { useReplay } from './store';
import type {
  ChartingLibraryWidgetOptions,
  ChartPropertiesOverrides,
  IChartingLibraryWidget,
  IChartWidgetApi,
  ResolutionString,
} from '../../public/charting_library/charting_library';

const UP = '#0f7a55';
const DOWN = '#c2413a';
const ACCENT = '#1f5fd6';

function chartTheme(theme: Theme): 'light' | 'dark' {
  return theme === 'dark' ? 'dark' : 'light';
}

function chartOverrides(theme: Theme): Partial<ChartPropertiesOverrides> {
  const dark = theme === 'dark';
  return {
    'paneProperties.background': dark ? '#211c16' : theme === 'white' ? '#ffffff' : '#fffdf8',
    'paneProperties.backgroundType': 'solid',
    'paneProperties.vertGridProperties.color': dark ? '#2a241c' : '#efe9dd',
    'paneProperties.horzGridProperties.color': dark ? '#2a241c' : '#efe9dd',
    'scalesProperties.textColor': dark ? '#a29888' : '#6f675b',
    'scalesProperties.lineColor': dark ? '#332c23' : '#e5dfd4',
    'mainSeriesProperties.candleStyle.upColor': dark ? '#4cc79a' : UP,
    'mainSeriesProperties.candleStyle.downColor': dark ? '#f07d74' : DOWN,
    'mainSeriesProperties.candleStyle.borderUpColor': dark ? '#4cc79a' : UP,
    'mainSeriesProperties.candleStyle.borderDownColor': dark ? '#f07d74' : DOWN,
    'mainSeriesProperties.candleStyle.wickUpColor': dark ? '#4cc79a' : UP,
    'mainSeriesProperties.candleStyle.wickDownColor': dark ? '#f07d74' : DOWN,
  };
}

type TvGlobal = {
  TradingView?: {
    widget: new (options: ChartingLibraryWidgetOptions) => IChartingLibraryWidget;
  };
};

export function ReplayChart({
  sessionId,
  revision,
  timeframe,
  follow,
}: {
  sessionId: string;
  revision: number;
  timeframe: string;
  follow: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<IChartingLibraryWidget | null>(null);
  const datafeedRef = useRef<ReplayDatafeed | null>(null);
  const layerRef = useRef<PriceLineLayer | null>(null);
  const followRef = useRef(follow);
  followRef.current = follow;

  const [chart, setChart] = useState<IChartWidgetApi | null>(null);
  const [error, setError] = useState<string | null>(null);

  const theme = useApp((s) => s.theme);
  const session = useReplay((s) => s.sessions.find((item) => item.id === sessionId));
  const positions = session?.positions ?? [];
  const orders = session?.orders ?? [];
  const symbolInfo = session?.symbolInfo;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const tv = (window as unknown as TvGlobal).TradingView;
    if (!tv?.widget) {
      setError('Charting Library 未加载，请确认 public/charting_library 存在');
      return;
    }
    const feed = new ReplayDatafeed(sessionId);
    datafeedRef.current = feed;
    const initialTheme = useApp.getState().theme;
    let widget: IChartingLibraryWidget | null = null;

    try {
      widget = new tv.widget({
        container: host,
        library_path: '/charting_library/',
        datafeed: feed,
        symbol: session?.symbol ?? 'XAUUSD',
        interval: timeframe as ResolutionString,
        locale: 'zh',
        theme: chartTheme(initialTheme),
        autosize: true,
        fullscreen: false,
        loading_screen: {
          backgroundColor: initialTheme === 'dark' ? '#211c16' : '#fffdf8',
          foregroundColor: ACCENT,
        },
        overrides: chartOverrides(initialTheme),
        disabled_features: [
          'use_localstorage_for_settings',
          'save_chart_properties_to_local_storage',
          'header_widget',
          'left_toolbar',
          'timeframes_toolbar',
          'symbol_info',
          'legend_widget',
          'border_around_the_chart',
        ],
        enabled_features: ['hide_left_toolbar_by_default'],
      });
      widgetRef.current = widget;

      widget.chartReady().then(() => {
        if (widgetRef.current !== widget || !widget) return;
        const active = widget.activeChart();
        widget.applyOverrides(chartOverrides(useApp.getState().theme));

        const layer = new PriceLineLayer(active, (price) => {
          if (!symbolInfo) return price;
          const tick = symbolInfo.tickSize || symbolInfo.point || 0;
          return tick
            ? Number((Math.round(price / tick) * tick).toFixed(symbolInfo.digits))
            : price;
        });
        layer.start();
        layerRef.current = layer;

        const state = useReplay.getState();
        const current = state.sessions.find((item) => item.id === sessionId);
        if (current) {
          const bars = replayBars(current.id);
          const series = aggregateBars(bars, timeframe, current.cursorIndex);
          const tail = series.slice(-110);
          if (tail.length > 1) {
            active
              .setVisibleRange({
                from: tail[0].time,
                to: tail[tail.length - 1].time + 900,
              })
              .catch(() => {});
          }
        }

        setChart(active);
        setError(null);
      });
    } catch (err) {
      setError((err as Error).message);
    }

    const unsubscribe = sourceFor(sessionId).subscribe((event) => {
      if (event.kind !== 'tick' || !followRef.current) return;
      try {
        widgetRef.current?.activeChart().getTimeScale().setRightOffset(0);
      } catch {
        /* 图表还没准备好 */
      }
    });

    return () => {
      unsubscribe();
      layerRef.current?.dispose();
      layerRef.current = null;
      datafeedRef.current?.resetCache();
      datafeedRef.current = null;
      setChart(null);
      widgetRef.current?.remove();
      widgetRef.current = null;
    };
    // 只在会话 / 重新开始时重建；周期切换走 setResolution
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, revision]);

  // 周期切换：交给图表自己的 datafeed 重新取数
  useEffect(() => {
    if (!chart) return;
    if (chart.resolution() !== (timeframe as ResolutionString)) {
      chart.setResolution(timeframe as ResolutionString).catch(() => {});
    }
  }, [chart, timeframe]);

  useEffect(() => {
    const widget = widgetRef.current;
    if (!widget || !chart) return;
    let cancelled = false;
    try {
      widget
        .changeTheme(chartTheme(theme))
        .then(() => {
          if (!cancelled) widget.applyOverrides(chartOverrides(theme));
        })
        .catch(() => {});
    } catch {
      /* 初始化阶段交给构造参数 */
    }
    return () => {
      cancelled = true;
    };
  }, [theme, chart]);

  // 持仓 / 挂单线：入场线与保护线，拖动保护线直接改模拟止损止盈
  useEffect(() => {
    const layer = layerRef.current;
    if (!chart || !layer || !session) return;
    const specs = new Map<string, PriceLineSpec>();
    for (const position of session.positions) {
      specs.set(`position:${position.id}`, {
        price: position.entry,
        color: ACCENT,
        text: position.side === 'buy' ? '模拟多' : '模拟空',
        editable: false,
      });
      if (position.sl != null) {
        specs.set(`position:${position.id}:sl`, {
          price: position.sl,
          color: DOWN,
          text: 'SL',
          onMove: (price) => useReplay.getState().modifyStops(position.id, { sl: price }),
        });
      }
      if (position.tp != null) {
        specs.set(`position:${position.id}:tp`, {
          price: position.tp,
          color: UP,
          text: 'TP',
          onMove: (price) => useReplay.getState().modifyStops(position.id, { tp: price }),
        });
      }
    }
    for (const order of session.orders) {
      specs.set(`order:${order.id}`, {
        price: order.price,
        color: order.side === 'buy' ? UP : DOWN,
        text: order.type === 'limit' ? '限价' : order.type === 'stop' ? '停损' : '市价',
        onMove: (price) => useReplay.getState().modifyOrder(order.id, price),
      });
    }
    void layer.sync(specs);
  }, [chart, session, positions, orders]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-console-card">
      <div ref={hostRef} className="absolute inset-0" />
      <div className="pointer-events-none absolute bottom-8 right-[72px] z-10 flex items-center gap-1 text-[10px] text-console-faint">
        <Lock size={14} strokeWidth={1.5} />
        复盘 · 模拟
      </div>
      {error && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-console-card/90 px-6 text-center text-[12px] text-console-loss">
          {error}
        </div>
      )}
    </div>
  );
}
