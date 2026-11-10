import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { clsx } from 'clsx';
import { gateway } from '../gateway/client';
import { handleGlobalShortcut, useApp, type Theme } from '../store/useApp';
import { fmtMoney, fmtPrice, fmtSigned, fmtVolume, snapToLevel } from '../lib/format';
import { GatewayDatafeed } from '../chart/tv/datafeed';
import { PriceLineLayer, type PriceLineSpec } from '../chart/tv/priceLines';
import { registerWidget } from '../chart/tv/registry';
import { customIndicators } from '../chart/tv/studies';
import { publishCrosshair } from '../chart/tv/sync';
import { ChartChips, type ChartBand, type ChartChip } from './ChartChips';
import { DrawingTemplates } from './DrawingTemplates';
import type {
  ChartPropertiesOverrides,
  ChartingLibraryWidgetOptions,
  IChartingLibraryWidget,
  IChartWidgetApi,
  LibrarySymbolInfo,
  ResolutionString,
} from '../../public/charting_library/charting_library';
import type { SymbolInfo } from '../gateway/types';

const SIDE_BUY = '#26a69a';
const SIDE_SELL = '#ef5350';
const ENTRY_COLOR = '#2962ff';
const STOP_OUT_COLOR = '#f59e0b';
const RISK_FILL = 'rgba(239, 83, 80, 0.10)';
const REWARD_FILL = 'rgba(38, 166, 154, 0.10)';

function chartOverrides(theme: Theme): Partial<ChartPropertiesOverrides> {
  const light = theme === 'light';
  return {
    'paneProperties.background': light ? '#ffffff' : '#131722',
    'paneProperties.backgroundType': 'solid',
    'paneProperties.vertGridProperties.color': light ? '#e6e9ef' : '#1e222d',
    'paneProperties.horzGridProperties.color': light ? '#e6e9ef' : '#1e222d',
    'scalesProperties.textColor': light ? '#131722' : '#d1d4dc',
    'scalesProperties.lineColor': light ? '#d1d4dc' : '#2a2e39',
    'mainSeriesProperties.candleStyle.upColor': SIDE_BUY,
    'mainSeriesProperties.candleStyle.downColor': SIDE_SELL,
    'mainSeriesProperties.candleStyle.borderUpColor': SIDE_BUY,
    'mainSeriesProperties.candleStyle.borderDownColor': SIDE_SELL,
    'mainSeriesProperties.candleStyle.wickUpColor': SIDE_BUY,
    'mainSeriesProperties.candleStyle.wickDownColor': SIDE_SELL,
  };
}

type TvGlobal = {
  TradingView?: {
    widget: new (options: ChartingLibraryWidgetOptions) => IChartingLibraryWidget;
  };
};

function roundToTick(value: number, info?: SymbolInfo): number {
  if (!info) return value;
  const tick = info.tickSize || info.point || 0;
  if (!tick) return Number(value.toFixed(info.digits));
  return Number((Math.round(value / tick) * tick).toFixed(info.digits));
}

/** 按住 Shift 拖动时吸附到整数点位：FX 取 10 个点、黄金取 0.1、日元取 0.01 */
function snapLevel(value: number, info?: SymbolInfo): number {
  if (!info) return value;
  const point = info.point || info.tickSize || 0;
  return point ? snapToLevel(value, info.digits, point) : roundToTick(value, info);
}

function sideColor(side: string): string {
  return side === 'buy' ? SIDE_BUY : SIDE_SELL;
}

/**
 * 草稿还没设置止损/止盈时，在可视价格区间内放一条可拖动的引导线。
 * 它只用于拖动设价，不会写进订单；真正拖动后 draft.sl / draft.tp 才会被填上。
 */
function guidePrice(
  chart: IChartWidgetApi,
  entry: number,
  below: boolean,
  info: SymbolInfo | undefined,
  multiple: number,
): number {
  let low = entry * 0.998;
  let high = entry * 1.002;
  try {
    const pane = chart.getPanes()[0];
    const scale = pane?.getMainSourcePriceScale() ?? pane?.getRightPriceScales()[0];
    const range = scale?.getVisiblePriceRange();
    if (range) {
      low = Math.min(range.from, range.to);
      high = Math.max(range.from, range.to);
    }
  } catch {
    /* 拿不到可视区间就用 0.2% 兜底 */
  }
  const span = high - low;
  const point = info?.point || info?.tickSize || 0;
  const minDist = Math.max((info?.stopsLevelPoints ?? 0) + 5, 10) * (point || 1e-9);
  // 引导线要留在可视区间内，否则用户看不到也拖不到；
  // 同时至少给券商最小止损距离留出空间。
  const room = Math.max((below ? entry - low : high - entry) * 0.7, 0);
  const base = span > 0 ? span * 0.15 : entry * 0.002;
  const dist = Math.min(base * multiple, Math.max(room, minDist));
  return roundToTick(below ? entry - dist : entry + dist, info);
}

/** 「  -100.00 USD」这种金额后缀，没有数值就返回空串 */
function moneySuffix(amount: number | null | undefined, sign: '-' | '+', currency: string): string {
  if (amount == null || !Number.isFinite(amount)) return '';
  return `  ${sign}${fmtMoney(amount)}${currency ? ` ${currency}` : ''}`;
}

/** 持仓止损/止盈的金额是带符号的，直接按金额的正负显示 */
function signedMoney(amount: number | null | undefined, currency: string): string {
  if (amount == null || !Number.isFinite(amount)) return '';
  return `  ${fmtSigned(amount)}${currency ? ` ${currency}` : ''}`;
}

/** 四图模式下每格可选的周期 */
const FRAMES: [string, string][] = [
  ['1', '1m'],
  ['5', '5m'],
  ['15', '15m'],
  ['60', '1h'],
  ['240', '4h'],
  ['1D', '1D'],
];

export function ChartPanel({
  slot = 'main',
  symbol: symbolProp,
  resolution: resolutionProp,
  chrome = false,
  onFrame,
}: {
  /** 图表 id：main 或 q0~q3，用于十字线联动与主图识别 */
  slot?: string;
  /** 不传则跟随全局品种 */
  symbol?: string;
  /** 不传则跟随全局周期 */
  resolution?: string;
  /** 四图模式下显示左上角的周期切换 */
  chrome?: boolean;
  onFrame?: (resolution: string) => void;
} = {}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<IChartingLibraryWidget | null>(null);
  const datafeedRef = useRef<GatewayDatafeed | null>(null);
  const layerRef = useRef<PriceLineLayer | null>(null);
  const startedRef = useRef(false);
  const crosshairPrice = useRef<number | null>(null);
  const lastCrosshairStore = useRef(0);

  const [chart, setChart] = useState<IChartWidgetApi | null>(null);
  const [error, setError] = useState<string | null>(null);

  const conn = useApp((s) => s.conn);
  const health = useApp((s) => s.health);
  const storeSymbol = useApp((s) => s.symbol);
  const storeResolution = useApp((s) => s.resolution);
  const symbol = symbolProp ?? storeSymbol;
  const resolution = resolutionProp ?? storeResolution;
  const info = useApp((s) => s.symbols.find((item) => item.name === s.symbol));
  const quote = useApp((s) => s.quote);
  const draft = useApp((s) => s.draft);
  const preview = useApp((s) => s.preview);
  const allPositions = useApp((s) => s.positions);
  const allOrders = useApp((s) => s.orders);
  const patchDraft = useApp((s) => s.patchDraft);
  const setSymbol = useApp((s) => s.setSymbol);
  const setResolution = useApp((s) => s.setResolution);
  const theme = useApp((s) => s.theme);
  const notify = useApp((s) => s.notify);

  const infoRef = useRef<SymbolInfo | undefined>(info);
  infoRef.current = info;
  const shiftRef = useRef(false);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === 'Shift') shiftRef.current = true;
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === 'Shift') shiftRef.current = false;
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
    };
  }, []);

  const positions = allPositions.filter((item) => item.symbol === symbol);
  const orders = allOrders.filter((item) => item.symbol === symbol);
  const digits = info?.digits ?? 5;
  const step = info?.volumeStep ?? 0.01;

  // ---- 线右侧的小块：手数 + 亏损/盈利金额 + ✕（线本身不写字，避免两套标签） ----
  // 预演结果要和当前草稿对得上，金额才可信
  const tol = (info?.tickSize || info?.point || 0) / 2 || 1e-9;
  const previewMatched = !!preview &&
    preview.side === draft.side &&
    Math.abs(preview.volume - draft.volume) < 1e-9 &&
    Math.abs((preview.sl ?? 0) - (draft.sl ?? 0)) <= tol &&
    Math.abs((preview.tp ?? 0) - (draft.tp ?? 0)) <= tol;
  const currency = health?.account?.currency ?? '';
  const volume = (value: number) => fmtVolume(value, step);
  /** 拖动图上标签用的价格对齐：按住 Shift 吸附整数位 */
  const roundPrice = (price: number) =>
    shiftRef.current ? snapLevel(price, info) : roundToTick(price, info);

  const chips: ChartChip[] = [];
  if (draft.active && draft.price > 0) {
    const side = draft.side === 'buy' ? '买入' : '卖出';
    const kind = draft.type === 'limit' ? '限价' : draft.type === 'stop' ? '停损' : '市价';
    chips.push({
      key: 'draft:entry',
      price: draft.price,
      color: sideColor(draft.side),
      text: `${kind}${side} ${volume(draft.volume)} @ ${fmtPrice(draft.price, digits)}`,
      onMove: (price) => patchDraft({ price: roundPrice(price) }),
      onRemove: () => patchDraft({ active: false }),
    });
    if (draft.sl != null && draft.sl > 0) {
      chips.push({
        key: 'draft:sl',
        price: draft.sl,
        color: SIDE_SELL,
        text: `${volume(draft.volume)}${moneySuffix(
          previewMatched ? preview?.riskAmount : null,
          '-',
          currency,
        )}`,
        onMove: (price) => patchDraft({ sl: roundPrice(price) }),
        onRemove: () => patchDraft({ sl: null }),
      });
    }
    if (draft.tp != null && draft.tp > 0) {
      chips.push({
        key: 'draft:tp',
        price: draft.tp,
        color: SIDE_BUY,
        text: `${volume(draft.volume)}${moneySuffix(
          previewMatched ? preview?.rewardAmount : null,
          '+',
          currency,
        )}`,
        onMove: (price) => patchDraft({ tp: roundPrice(price) }),
        onRemove: () => patchDraft({ tp: null }),
      });
    }
  }

  // ---- 图上风险区间：止损一侧红色、止盈一侧绿色，止盈一侧标 1R/2R… 刻度 ----
  const bands: ChartBand[] = [];
  const amountText = (value: number | null | undefined) =>
    value == null || !Number.isFinite(value) ? '' : `${fmtMoney(Math.abs(value))}${currency ? ` ${currency}` : ''}`;

  const addBands = (
    prefix: string,
    entry: number,
    sl: number | null | undefined,
    tp: number | null | undefined,
    riskAmount?: number | null,
    rewardAmount?: number | null,
  ) => {
    const hasSl = sl != null && sl > 0 && Math.abs(entry - sl) > 0;
    const hasTp = tp != null && tp > 0 && Math.abs(tp - entry) > 0;
    const risk = hasSl ? Math.abs(entry - (sl as number)) : 0;
    if (hasSl) {
      const text = amountText(riskAmount);
      bands.push({
        key: `${prefix}:risk`,
        from: entry,
        to: sl as number,
        color: RISK_FILL,
        label: text ? `1R = ${text}` : '风险 1R',
        labelColor: 'rgba(239, 83, 80, 0.9)',
      });
    }
    if (hasTp) {
      const target = tp as number;
      const reward = Math.abs(target - entry);
      const ratio = risk > 0 ? reward / risk : null;
      const marks =
        risk > 0
          ? Array.from(
              { length: Math.min(10, Math.floor(reward / risk + 1e-9)) },
              (_, index) => ({
                price: entry + Math.sign(target - entry) * risk * (index + 1),
                text: `${index + 1}R`,
              }),
            )
          : [];
      const text = amountText(rewardAmount);
      bands.push({
        key: `${prefix}:reward`,
        from: entry,
        to: target,
        color: REWARD_FILL,
        label: text
          ? `盈利 ${text}${ratio ? ` · ${ratio.toFixed(1)}R` : ''}`
          : ratio
            ? `目标 ${ratio.toFixed(1)}R`
            : '目标',
        labelColor: 'rgba(38, 166, 154, 0.95)',
        marks,
      });
    }
  };

  if (draft.active && draft.price > 0) {
    addBands(
      'draft',
      draft.price,
      draft.sl,
      draft.tp,
      previewMatched ? preview?.riskAmount : null,
      previewMatched ? preview?.rewardAmount : null,
    );
  }

  for (const order of orders) {
    addBands(`order:${order.ticket}`, order.price, order.sl, order.tp);
  }

  for (const order of orders) {
    const kind = order.type === 'limit' ? '限价' : '停损';
    const side = order.side === 'buy' ? '买入' : '卖出';
    chips.push({
      key: `order:${order.ticket}`,
      price: order.price,
      color: sideColor(order.side),
      text: `${kind}${side} ${volume(order.volume)} @ ${fmtPrice(order.price, digits)}`,
      onMove: (price) => {
        gateway
          .call('order.modify', { ticket: order.ticket, price: roundPrice(price) })
          .catch((err: Error) => notify('error', err.message));
      },
      onRemove: () => {
        gateway.call('order.cancel', { ticket: order.ticket }).catch((err: Error) => notify('error', err.message));
      },
    });
  }

  for (const position of positions) {
    const side = position.side === 'buy' ? '多' : '空';
    addBands(
      `position:${position.ticket}`,
      position.openPrice,
      position.sl,
      position.tp,
      position.slProfit,
      position.tpProfit,
    );
    if (position.stopOutPrice != null && position.stopOutPrice > 0) {
      chips.push({
        key: `stopout:${position.ticket}`,
        price: position.stopOutPrice,
        color: STOP_OUT_COLOR,
        text: `强平估算 ${fmtPrice(position.stopOutPrice, digits)}`,
      });
    }
    chips.push({
      key: `position:${position.ticket}`,
      price: position.openPrice,
      color: ENTRY_COLOR,
      text: `${side} ${volume(position.volume)} @ ${fmtPrice(position.openPrice, digits)}${signedMoney(
        position.profit,
        currency,
      )}`,
    });
    if (position.sl) {
      chips.push({
        key: `protect:${position.ticket}:sl`,
        price: position.sl,
        color: SIDE_SELL,
        text: `${volume(position.volume)}${signedMoney(position.slProfit, currency)}`,
        onMove: (price) => {
          gateway
            .call('position.modify', { ticket: position.ticket, sl: roundPrice(price) })
            .catch((err: Error) => notify('error', err.message));
        },
        onRemove: () => {
          gateway
            .call('position.modify', { ticket: position.ticket, sl: 0 })
            .catch((err: Error) => notify('error', err.message));
        },
      });
    }
    if (position.tp) {
      chips.push({
        key: `protect:${position.ticket}:tp`,
        price: position.tp,
        color: SIDE_BUY,
        text: `${volume(position.volume)}${signedMoney(position.tpProfit, currency)}`,
        onMove: (price) => {
          gateway
            .call('position.modify', { ticket: position.ticket, tp: roundPrice(price) })
            .catch((err: Error) => notify('error', err.message));
        },
        onRemove: () => {
          gateway
            .call('position.modify', { ticket: position.ticket, tp: 0 })
            .catch((err: Error) => notify('error', err.message));
        },
      });
    }
  }

  // ---- 创建 widget（只创建一次，之后靠 setSymbol / setResolution 同步）----
  useEffect(() => {
    if (startedRef.current || conn !== 'open' || !symbol || !quote) return;
    const host = hostRef.current;
    if (!host) return;
    const tv = (window as unknown as TvGlobal).TradingView;
    if (!tv?.widget) {
      setError('Charting Library 未加载，请确认 public/charting_library 存在');
      return;
    }
    startedRef.current = true;
    if (!datafeedRef.current) datafeedRef.current = new GatewayDatafeed();
    const initialTheme = useApp.getState().theme;

    try {
      const widget = new tv.widget({
        container: host,
        library_path: '/charting_library/',
        datafeed: datafeedRef.current,
        symbol,
        interval: resolution as ResolutionString,
        locale: 'zh',
        theme: initialTheme,
        autosize: true,
        fullscreen: false,
        loading_screen: {
          backgroundColor: initialTheme === 'light' ? '#ffffff' : '#131722',
          foregroundColor: '#2962ff',
        },
        overrides: chartOverrides(initialTheme),
        // 收藏画线工具：左侧工具栏里点星标即可收藏，收藏的工具会浮在图上快捷调用
        // 这些是首次使用的默认收藏；之后用户自己的收藏存在 localStorage 里并优先
        favorites: {
          drawingTools: [
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
          ],
          intervals: ['1', '5', '15', '60', '240', '1D'] as ResolutionString[],
        },
        // 自定义指标（JS + PineJS.Std，Pine 源码不能直接运行），见 studies.ts
        custom_indicators_getter: customIndicators,
        // 画线模板由应用自己的「画线模板」面板负责（见 DrawingTemplates.tsx），
        // 不用库里那个只显示「应用默认」的内置模板菜单。
        // 只关图表属性持久化，保留收藏与自选所需的 localStorage
        disabled_features: ['save_chart_properties_to_local_storage'],
      });
      widgetRef.current = widget;
      registerWidget(slot, widget);
      // 旧调试脚本和截图仍从 window.__tv 取主图
      if (slot === 'main') {
        (window as unknown as { __tv?: IChartingLibraryWidget }).__tv = widget;
      }

      widget.chartReady().then(() => {
        const active = widget.activeChart();
        // 四图里每格有独立周期，只有单图（跟随全局）才把图表操作写回 store
        active.onSymbolChanged().subscribe(null, (next: LibrarySymbolInfo) => {
          if (!symbolProp && next?.name && next.name !== useApp.getState().symbol) {
            setSymbol(next.name);
          }
        });
        active.onIntervalChanged().subscribe(null, (interval: ResolutionString) => {
          if (!resolutionProp && interval !== useApp.getState().resolution) setResolution(interval);
        });
        active.crossHairMoved().subscribe(null, (params) => {
          if (!params || typeof params.price !== 'number') return;
          crosshairPrice.current = params.price;
          publishCrosshair({
            price: params.price,
            time: typeof params.time === 'number' ? params.time : null,
            from: slot,
          });
          const now = performance.now();
          if (now - lastCrosshairStore.current > 100) {
            lastCrosshairStore.current = now;
            useApp.getState().setCrosshairPrice(params.price);
          }
        });

        const layer = new PriceLineLayer(active, (price) =>
          shiftRef.current ? snapLevel(price, infoRef.current) : roundToTick(price, infoRef.current),
        );
        layer.start();
        layerRef.current = layer;

        setChart(active);
        setError(null);
      });
    } catch (err) {
      startedRef.current = false;
      setError((err as Error).message);
    }
  }, [conn, symbol, quote, resolution, setResolution, setSymbol]);

  // ---- 主题切换：不重建图表，换主题后重新套一遍颜色 ----
  useEffect(() => {
    const widget = widgetRef.current;
    if (!widget) return;
    let cancelled = false;
    widget
      .changeTheme(theme)
      .then(() => {
        if (!cancelled) widget.applyOverrides(chartOverrides(theme));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [theme]);

  // ---- 卸载 ----
  useEffect(
    () => () => {
      layerRef.current?.dispose();
      layerRef.current = null;
      registerWidget(slot, null);
      widgetRef.current?.remove();
      widgetRef.current = null;
      // StrictMode 会「挂载 → 卸载 → 再挂载」跑一遍：这里不重置，
      // 第二次创建会被 startedRef 挡掉，四图切换后就只剩空容器
      startedRef.current = false;
      datafeedRef.current = null;
    },
    [slot],
  );

  // 图表 iframe 自己收键盘事件，B/S/Esc 在图上操作时也要能用
  useEffect(() => {
    if (!chart) return;
    const win = hostRef.current?.querySelector('iframe')?.contentWindow;
    if (!win) return;
    win.addEventListener('keydown', handleGlobalShortcut);
    return () => win.removeEventListener('keydown', handleGlobalShortcut);
  }, [chart]);

  // ---- store -> chart ----
  useEffect(() => {
    if (!chart || !symbol) return;
    if (chart.symbol() !== symbol) chart.setSymbol(symbol).catch(() => {});
  }, [chart, symbol]);

  useEffect(() => {
    if (!chart || !resolution) return;
    if (chart.resolution() !== (resolution as ResolutionString)) {
      chart.setResolution(resolution as ResolutionString).catch(() => {});
    }
  }, [chart, resolution]);

  // ---- 点击图表设置委托价 ----
  const handleChartClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLCanvasElement)) return;
    const state = useApp.getState();
    if (!state.draft.active || crosshairPrice.current == null) return;
    const current = state.symbols.find((item) => item.name === state.symbol);
    state.patchDraft({
      price: shiftRef.current
        ? snapLevel(crosshairPrice.current, current)
        : roundToTick(crosshairPrice.current, current),
    });
  };

  // ---- 图表上的价格线：画线下单 + 挂单 + 持仓 + 持仓止损止盈 ----
  useEffect(() => {
    const layer = layerRef.current;
    if (!chart || !layer) return;

    // 线本身不写字：文字/金额由右边缘的 ChartChips 显示
    const specs = new Map<string, PriceLineSpec>();

    if (draft.active && draft.price > 0) {
      specs.set('draft:entry', {
        price: draft.price,
        color: sideColor(draft.side),
        text: '',
        onMove: (price) => {
          const state = useApp.getState();
          if (state.draft.active && Math.abs(state.draft.price - price) > 1e-9) {
            state.patchDraft({ price });
          }
        },
      });
      const hasSl = draft.sl != null && draft.sl > 0;
      const hasTp = draft.tp != null && draft.tp > 0;
      specs.set('draft:sl', {
        price: hasSl
          ? (draft.sl as number)
          : guidePrice(chart, draft.price, draft.side === 'buy', info, 1),
        color: SIDE_SELL,
        text: hasSl ? '' : '拖动设置止损',
        showPrice: hasSl,
        onMove: (price) => useApp.getState().patchDraft({ sl: price }),
      });
      specs.set('draft:tp', {
        price: hasTp
          ? (draft.tp as number)
          : guidePrice(chart, draft.price, draft.side !== 'buy', info, 2),
        color: SIDE_BUY,
        text: hasTp ? '' : '拖动设置止盈',
        showPrice: hasTp,
        onMove: (price) => useApp.getState().patchDraft({ tp: price }),
      });
    }

    for (const order of orders) {
      specs.set(`order:${order.ticket}`, {
        price: order.price,
        color: sideColor(order.side),
        text: '',
        onMove: (price) => {
          if (Math.abs(price - order.price) > 1e-9) {
            gateway
              .call('order.modify', { ticket: order.ticket, price })
              .catch((err: Error) => notify('error', err.message));
          }
        },
      });
    }

    for (const position of positions) {
      specs.set(`position:${position.ticket}`, {
        price: position.openPrice,
        color: ENTRY_COLOR,
        text: '',
        editable: false,
      });
      if (position.sl) {
        specs.set(`protect:${position.ticket}:sl`, {
          price: position.sl,
          color: SIDE_SELL,
          text: '',
          onMove: (price) => {
            gateway
              .call('position.modify', { ticket: position.ticket, sl: price })
              .catch((err: Error) => notify('error', err.message));
          },
        });
      }
      if (position.tp) {
        specs.set(`protect:${position.ticket}:tp`, {
          price: position.tp,
          color: SIDE_BUY,
          text: '',
          onMove: (price) => {
            gateway
              .call('position.modify', { ticket: position.ticket, tp: price })
              .catch((err: Error) => notify('error', err.message));
          },
        });
      }
    }

    layer.sync(specs);
  }, [chart, draft, orders, positions, notify]);

  const waiting = conn !== 'open' || !health?.connected || !symbol;

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      onClick={handleChartClick}
      onMouseLeave={() => publishCrosshair(null)}
    >
      <div ref={hostRef} className="absolute inset-0" />
      <ChartChips chips={chips} bands={bands} host={hostRef} chart={chart} slot={slot} />
      {chart && <DrawingTemplates chart={chart} slot={slot} />}
      {chrome && (
        <div className="absolute left-[58px] top-[42px] z-30 flex items-center gap-0.5 rounded border border-tv-border/60 bg-tv-panel/85 px-1 py-0.5 shadow">
          {FRAMES.map(([value, label]) => (
            <button
              key={value}
              onClick={(event) => {
                event.stopPropagation();
                onFrame?.(value);
              }}
              className={clsx(
                'h-5 rounded px-1.5 text-[10px] transition-colors',
                resolution === value
                  ? 'bg-tv-accent text-white'
                  : 'text-tv-muted hover:bg-tv-border/60 hover:text-tv-text',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {error && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-tv-bg/90 px-6 text-center text-sm text-tv-down">
          {error}
        </div>
      )}
      {waiting && !error && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-1 bg-tv-bg/60 text-center">
          <div className="text-sm text-tv-text">
            {conn !== 'open'
              ? '正在连接本地网关…'
              : !health?.connected
                ? '等待 MT5 终端…'
                : '请选择品种'}
          </div>
          <div className="max-w-md text-[11px] text-tv-muted">
            {conn !== 'open'
              ? '请先运行 npm run gateway'
              : (health?.lastError?.message ?? '请打开并登录 MetaTrader 5')}
          </div>
        </div>
      )}
      {draft.active && (
        <button
          onClick={() => patchDraft({ active: false })}
          className="absolute right-3 top-14 z-30 rounded bg-tv-panel/90 px-2 py-1 text-[10px] text-tv-text shadow hover:bg-tv-hover"
        >
          清除划线
        </button>
      )}
    </div>
  );
}
