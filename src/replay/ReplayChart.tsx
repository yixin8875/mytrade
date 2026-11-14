import { useEffect, useRef, useState } from 'react';
import { Lock } from 'lucide-react';
import { PriceLineLayer, type PriceLineSpec } from '../chart/tv/priceLines';
import { useApp, type Theme } from '../store/useApp';
import type { OrderType, Side } from '../gateway/types';
import { aggregateBars, ReplayDatafeed } from './datafeed';
import { replayBars, sourceFor } from './source';
import { useReplay } from './store';
import { roundPrice } from './engine';
import type {
  ChartingLibraryWidgetOptions,
  ChartPropertiesOverrides,
  DrawingToolIdentifier,
  IChartingLibraryWidget,
  IChartWidgetApi,
  ResolutionString,
} from '../../public/charting_library/charting_library';

const UP = '#0f7a55';
const DOWN = '#c2413a';
const ACCENT = '#1f5fd6';

/** 与交易台主图相同的画线工具与周期收藏 */
const DRAWING_TOOLS: DrawingToolIdentifier[] = [
  'LineToolTrendLine',
  'LineToolHorzLine',
  'LineToolVertLine',
  'LineToolRay',
  'LineToolParallelChannel',
  'LineToolFibRetracement',
  'LineToolRectangle',
  'LineToolEllipse',
  'LineToolText',
  'LineToolCallout',
  'LineToolArrow',
];

const FAVORITE_INTERVALS = ['1', '5', '15', '60', '240', '1D'] as ResolutionString[];

export interface ReplayDraft {
  active: boolean;
  side: Side;
  type: OrderType;
  price: number;
  sl: number | null;
  tp: number | null;
  volume: number;
}

export interface ReplayDraftPatch {
  price?: number;
  sl?: number | null;
  tp?: number | null;
}

export interface ReplayChartProps {
  sessionId: string;
  revision: number;
  timeframe: string;
  follow: boolean;
  draft?: ReplayDraft;
  onDraftChange?: (patch: ReplayDraftPatch) => void;
  onTimeframeChange?: (resolution: string) => void;
}

/** 图表状态按会话保存：复盘的画线/指标不会串到交易台，反之亦然 */
function chartStateKey(sessionId: string): string {
  return `mytrade.replay.chart.${sessionId}`;
}

function readChartState(sessionId: string): object | null {
  try {
    const raw = window.localStorage.getItem(chartStateKey(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as object) : null;
  } catch {
    return null;
  }
}

function writeChartState(sessionId: string, state: object): void {
  try {
    window.localStorage.setItem(chartStateKey(sessionId), JSON.stringify(state));
  } catch {
    /* 存储满/被禁用时不影响图表本身 */
  }
}

/** 画线单独存：低层 save() 不含绘图对象，要用 getLineToolsState/applyLineToolsState */
function drawingsKey(sessionId: string): string {
  return `mytrade.replay.drawings.${sessionId}`;
}

function serializeDrawings(chart: IChartWidgetApi): string | null {
  try {
    const state = chart.getLineToolsState();
    return JSON.stringify({
      symbol: state.symbol,
      sources: state.sources ? [...state.sources.entries()] : null,
      groups: [...state.groups.entries()],
    });
  } catch {
    return null;
  }
}

function writeDrawings(sessionId: string, chart: IChartWidgetApi): void {
  const raw = serializeDrawings(chart);
  if (!raw) return;
  try {
    const data = JSON.parse(raw) as {
      sources?: [string, unknown][] | null;
      groups?: unknown[];
    };
    const hasContent =
      (data.sources?.some(([, value]) => value != null) ?? false) ||
      (data.groups?.length ?? 0) > 0;
    // 从没存过画线时不要写空对象；但已经存过就要写空，才能记住「用户删光了」
    if (!hasContent && !window.localStorage.getItem(drawingsKey(sessionId))) return;
    window.localStorage.setItem(drawingsKey(sessionId), raw);
  } catch {
    /* 存储满时忽略 */
  }
}

function applySavedDrawings(chart: IChartWidgetApi, sessionId: string): Promise<void> | null {
  try {
    const raw = window.localStorage.getItem(drawingsKey(sessionId));
    if (!raw) return null;
    const data = JSON.parse(raw) as {
      symbol?: string;
      sources?: [string, unknown][] | null;
      groups?: [string, unknown][];
    };
    return chart.applyLineToolsState({
      symbol: data.symbol,
      sources: data.sources ? new Map(data.sources) : null,
      groups: new Map(data.groups ?? []),
    } as Parameters<IChartWidgetApi['applyLineToolsState']>[0]);
  } catch {
    return null;
  }
}

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
  draft,
  onDraftChange,
  onTimeframeChange,
}: ReplayChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<IChartingLibraryWidget | null>(null);
  const datafeedRef = useRef<ReplayDatafeed | null>(null);
  const layerRef = useRef<PriceLineLayer | null>(null);
  const followRef = useRef(follow);
  followRef.current = follow;
  /** 十字线价格：库的 mouse 事件只给像素坐标，点击图内取价要靠它 */
  const crosshairPrice = useRef<number | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const draftChangeRef = useRef(onDraftChange);
  draftChangeRef.current = onDraftChange;
  const timeframeChangeRef = useRef(onTimeframeChange);
  timeframeChangeRef.current = onTimeframeChange;
  const timeframeRef = useRef(timeframe);
  timeframeRef.current = timeframe;

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
    let saveTimer = 0;
    let drawingsTimer = 0;
    let disposed = false;
    let drawingsReady = false;
    let lastDrawings = '';

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
        // 与交易台一致：左侧画线工具栏、顶部周期栏都保留。
        // 但复盘只能用会话自己的数据：关掉品种搜索/比较品种，避免拉到实时行情；
        // 本地存储整格关掉，改由本文件按 sessionId 自己保存图表状态。
        favorites: {
          drawingTools: DRAWING_TOOLS,
          intervals: FAVORITE_INTERVALS,
        },
        enabled_features: ['saveload_separate_drawings_storage'],
        disabled_features: [
          'use_localstorage_for_settings',
          'save_chart_properties_to_local_storage',
          'header_symbol_search',
          'header_quick_search',
          'symbol_search_hot_key',
          'header_compare',
          'header_saveload',
          'header_screenshot',
          'header_fullscreen_button',
          'symbol_info',
          'border_around_the_chart',
        ],
      });
      widgetRef.current = widget;

      const scheduleSave = () => {
        if (disposed) return;
        window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => {
          const current = widgetRef.current;
          if (!current || disposed) return;
          current
            .save()
            .then((state) => writeChartState(sessionId, state))
            .catch(() => {});
          try {
            writeDrawings(sessionId, current.activeChart());
          } catch {
            /* 图表还没就绪 */
          }
        }, 600);
      };

      // 程序化创建/编辑绘图不一定触发 drawing_event，轮询一次状态更稳
      const saveDrawings = () => {
        if (disposed || !drawingsReady) return;
        const current = widgetRef.current;
        if (!current) return;
        try {
          const raw = serializeDrawings(current.activeChart());
          if (!raw || raw === lastDrawings) return;
          lastDrawings = raw;
          window.localStorage.setItem(drawingsKey(sessionId), raw);
        } catch {
          /* 图表未就绪或存储被禁用 */
        }
      };
      drawingsTimer = window.setInterval(saveDrawings, 1500);

      // 画线/指标的增删改没有统一的回调，直接听库的事件
      widget.subscribe('drawing_event', (_sourceId, eventType) => {
        if (eventType === 'click') return;
        scheduleSave();
      });
      widget.subscribe('study_event', () => scheduleSave());

      widget.chartReady().then(async () => {
        if (widgetRef.current !== widget || !widget) return;
        const active = widget.activeChart();

        // 恢复本会话上次的画线与指标（不影响交易台的 localStorage 布局）
        const saved = readChartState(sessionId);
        if (saved) {
          try {
            await widget.load(saved);
          } catch {
            /* 旧版本状态不兼容时保留默认图表 */
          }
          if (disposed || widgetRef.current !== widget) return;
        }

        widget.applyOverrides(chartOverrides(useApp.getState().theme));

        const drawings = applySavedDrawings(active, sessionId);
        if (drawings) {
          try {
            await drawings;
          } catch {
            /* 旧版本绘图状态不兼容时忽略 */
          }
          if (disposed || widgetRef.current !== widget) return;
        }
        lastDrawings = serializeDrawings(active) ?? '';
        drawingsReady = true;

        const layer = new PriceLineLayer(active, (price) => {
          if (!symbolInfo) return price;
          return roundPrice(price, symbolInfo);
        });
        layer.start();
        layerRef.current = layer;

        active.onIntervalChanged().subscribe(null, (interval) => {
          if (interval === timeframeRef.current) return;
          timeframeChangeRef.current?.(interval);
        });

        active.crossHairMoved().subscribe(null, (params) => {
          if (typeof params?.price === 'number') crosshairPrice.current = params.price;
        });

        // 画线下单：点击图内把入场价放到十字线价格。
        // 图表在 same-origin iframe 里，父容器的 click 收不到，只能听库的鼠标事件；
        // 用按下/松开的位移区分「点一下」和拖动画布。
        let downAt = 0;
        let downX = 0;
        let downY = 0;
        widget.subscribe('mouse_down', (params) => {
          downAt = Date.now();
          downX = params.clientX;
          downY = params.clientY;
        });
        widget.subscribe('mouse_up', (params) => {
          if (!draftRef.current?.active) return;
          if (!downAt || Date.now() - downAt > 1500) return;
          if (Math.abs(params.clientX - downX) > 4 || Math.abs(params.clientY - downY) > 4) {
            return;
          }
          const price = crosshairPrice.current;
          const info = useReplay
            .getState()
            .sessions.find((item) => item.id === sessionId)?.symbolInfo;
          if (price == null || !info) return;
          draftChangeRef.current?.({ price: roundPrice(price, info) });
        });

        // load 可能把区间带回上次的位置；统一按游标尾部重新定位
        const state = useReplay.getState();
        const current = state.sessions.find((item) => item.id === sessionId);
        if (current) {
          const resolution = active.resolution() || (timeframe as ResolutionString);
          const bars = replayBars(current.id);
          const series = aggregateBars(bars, resolution, current.cursorIndex);
          const tail = series.slice(-110);
          if (tail.length > 1) {
            active
              .setVisibleRange({
                from: tail[0].time,
                to: tail[tail.length - 1].time + 900,
              })
              .catch(() => {});
          }
          // 恢复的画布可能停在上次的周期；让工作台标题跟着图表走
          if (active.resolution() !== timeframeRef.current) {
            timeframeChangeRef.current?.(active.resolution());
          }
        }

        if (import.meta.env.DEV) {
          (window as unknown as { __replayTv?: IChartingLibraryWidget }).__replayTv = widget;
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
      disposed = true;
      window.clearTimeout(saveTimer);
      window.clearInterval(drawingsTimer);
      unsubscribe();
      layerRef.current?.dispose();
      layerRef.current = null;
      datafeedRef.current?.resetCache();
      datafeedRef.current = null;
      setChart(null);
      const current = widgetRef.current;
      if (current) {
        // 卸载前再存一次：画线刚改完就切页也不会丢
        if (drawingsReady) {
          try {
            writeDrawings(sessionId, current.activeChart());
          } catch {
            /* 图表已销毁 */
          }
        }
        current
          .save()
          .then((state) => writeChartState(sessionId, state))
          .catch(() => {});
        current.remove();
      }
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

  // 持仓 / 挂单 / 画线下单草稿线
  useEffect(() => {
    const layer = layerRef.current;
    if (!chart || !layer || !session) return;
    const specs = new Map<string, PriceLineSpec>();
    const digits = session.symbolInfo.digits;

    if (draft?.active && draft.price > 0) {
      const kind = draft.type === 'limit' ? '限价' : draft.type === 'stop' ? '停损' : '市价';
      const side = draft.side === 'buy' ? '买入' : '卖出';
      specs.set('draft:entry', {
        price: draft.price,
        color: draft.side === 'buy' ? UP : DOWN,
        text: `${kind}${side} ${draft.volume.toFixed(2)} @ ${draft.price.toFixed(digits)}`,
        onMove: (price) =>
          draftChangeRef.current?.({
            price: roundPrice(price, session.symbolInfo),
          }),
      });
      if (draft.sl != null && draft.sl > 0) {
        specs.set('draft:sl', {
          price: draft.sl,
          color: DOWN,
          text: 'SL',
          onMove: (price) =>
            draftChangeRef.current?.({
              sl: roundPrice(price, session.symbolInfo),
            }),
        });
      }
      if (draft.tp != null && draft.tp > 0) {
        specs.set('draft:tp', {
          price: draft.tp,
          color: UP,
          text: 'TP',
          onMove: (price) =>
            draftChangeRef.current?.({
              tp: roundPrice(price, session.symbolInfo),
            }),
        });
      }
    }

    for (const position of session.positions) {
      specs.set(`position:${position.id}`, {
        price: position.entry,
        color: ACCENT,
        text: `${position.side === 'buy' ? '模拟多' : '模拟空'} ${position.volume.toFixed(2)}`,
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
  }, [chart, session, positions, orders, draft]);

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
