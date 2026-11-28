import { useEffect, useRef, useState } from 'react';
import { gateway } from '../gateway/client';
import { handleGlobalShortcut, useApp, type Theme } from '../store/useApp';
import { accentForTheme } from '../lib/accent';
import { fmtMoney, fmtPrice, fmtSigned, fmtVolume, snapToLevel } from '../lib/format';
import { requestModify, revertModify } from '../lib/modifyQueue';
import { cancelOrderWithUndo } from '../lib/orderActions';
import { roundToTick } from '../lib/orderPrice';
import { activeSteps, estimateStepLots, stepAtR } from '../lib/plan';
import { classifyPending } from '../lib/pendingOrder';
import { CalendarLayer } from '../chart/tv/calendarLayer';
import { GatewayDatafeed } from '../chart/tv/datafeed';
import { PineRunner } from '../chart/tv/pineRunner';
import { currenciesForSymbol, loadCalendar } from '../lib/calendar';
import { migratePineTemplate } from '../chart/tv/pineStudies';
import { PriceLineLayer, hasSelectedDrawing, type PriceLineSpec } from '../chart/tv/priceLines';
import { shouldPlacePrice } from '../chart/tv/placement';
import { registerWidget, setActiveSlot } from '../chart/tv/registry';
import { SessionBoxManager } from '../chart/tv/sessionBoxes';
import { customIndicators } from '../chart/tv/studies';
import { publishCrosshair, publishRange, subscribeRange, type RangeState } from '../chart/tv/sync';
import { buildQuickActionItems } from '../lib/chartQuickActions';
import {
  ALERT_COLOR,
  alertChipText,
  alertKindFor,
  alertsOnChart,
  drawingAlertPrice,
} from '../lib/chartAlerts';
import {
  chartSaveAdapter,
  deserializeLineTools,
  readSlotLineToolsRaw,
  serializeLineTools,
  writeSlotLineTools,
} from '../chart/tv/lineToolStore';
import { mountFloatingToolbarButtons, templatePanelSpot } from '../chart/tv/floatingTemplates';
import {
  alertPanelSpot,
  mountHeaderAlertButton,
  type HeaderAlertHandle,
} from '../chart/tv/headerAlert';
import { ChartChips, measurePriceAxis, type ChartBand, type ChartChip } from './ChartChips';
import { ChartQuickActions } from './ChartQuickActions';
import { DrawingTemplates } from './DrawingTemplates';
import { makeQuickMenuProcessor } from '../chart/tv/quickMenu';
import type {
  ChartPropertiesOverrides,
  ChartingLibraryWidgetOptions,
  IChartingLibraryWidget,
  IChartWidgetApi,
  LibrarySymbolInfo,
  LineToolsAndGroupsState,
  PineJS,
  ResolutionString,
} from '../../public/charting_library/charting_library';
import type { PriceAlert, SymbolInfo } from '../gateway/types';

const SIDE_BUY = '#0f7a55';
const SIDE_SELL = '#c2413a';
const ENTRY_COLOR = '#1f5fd6';
const STOP_OUT_COLOR = '#a9691a';
// 分批止盈计划线：比券商 TP 略浅的绿 + 虚线，和真正的止盈单区分开
const PLAN_COLOR = '#4db6ac';
// 最终止盈被拖到该档之前：线还在，但不该执行
const PLAN_INVALID_COLOR = '#8a8f98';
// 风险/盈利区间只画 R 刻度线和文字，不铺红绿底色
const BAND_FILL = 'transparent';
// 草稿/挂单的区间：淡色铺底，拖动止损或止盈时加深
const DRAFT_RISK_FILL = 'rgba(239, 83, 80, 0.07)';
const DRAFT_RISK_ACTIVE = 'rgba(239, 83, 80, 0.2)';
const DRAFT_REWARD_FILL = 'rgba(38, 166, 154, 0.07)';
const DRAFT_REWARD_ACTIVE = 'rgba(38, 166, 154, 0.18)';

/**
 * 背景、网格、坐标文字由应用主题决定。库恢复的旧图表属性优先级高于 overrides，
 * 所以创建图表前先把这几个主题相关键清掉；倒计时、指标、时区等设置照常保留。
 */
function dropSavedThemeColors(theme: Theme): void {
  try {
    // 主题没变就保留用户自己调过的背景/网格颜色；变了才清掉旧主题的值
    if (window.localStorage.getItem('tradingview.current_theme.name') === theme) return;
    const raw = window.localStorage.getItem('tradingview.chartproperties');
    if (raw) {
      const saved = JSON.parse(raw) as {
        paneProperties?: {
          background?: unknown;
          backgroundType?: unknown;
          vertGridProperties?: { color?: unknown };
          horzGridProperties?: { color?: unknown };
        };
        scalesProperties?: { textColor?: unknown; lineColor?: unknown };
      };
      const pane = saved.paneProperties;
      if (pane) {
        delete pane.background;
        delete pane.backgroundType;
        if (pane.vertGridProperties) delete pane.vertGridProperties.color;
        if (pane.horzGridProperties) delete pane.horzGridProperties.color;
      }
      if (saved.scalesProperties) {
        delete saved.scalesProperties.textColor;
        delete saved.scalesProperties.lineColor;
      }
      window.localStorage.setItem('tradingview.chartproperties', JSON.stringify(saved));
    }
    window.localStorage.setItem('tradingview.current_theme.name', theme);
  } catch {
    /* 存储坏了就交给 overrides 兜底 */
  }
}

/** 图表库只认 light / dark；白色主题共用浅色的图表底材 */
function chartTheme(theme: Theme): 'light' | 'dark' {
  return theme === 'dark' ? 'dark' : 'light';
}

function chartOverrides(theme: Theme): Partial<ChartPropertiesOverrides> {
  const light = theme !== 'dark';
  return {
    'paneProperties.background': light ? '#ffffff' : '#14161b',
    'paneProperties.backgroundType': 'solid',
    'paneProperties.vertGridProperties.color': light ? '#edf0f4' : '#22262e',
    'paneProperties.horzGridProperties.color': light ? '#edf0f4' : '#22262e',
    'scalesProperties.textColor': light ? '#64707f' : '#98a2b0',
    'scalesProperties.lineColor': light ? '#e3e8ee' : '#2a2f38',
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

/** 每张图自动保存的指标组合（key 是 slot：main / c1…） */
const CHART_STATE_KEY = 'mytrade.chartStates';

interface SavedChartState {
  state: object;
  savedAt: number;
}

function readChartStates(): Record<string, SavedChartState> {
  try {
    const raw = window.localStorage.getItem(CHART_STATE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, SavedChartState>) : {};
  } catch {
    return {};
  }
}

function writeChartState(slot: string, state: object): void {
  try {
    const all = readChartStates();
    all[slot] = { state, savedAt: Date.now() };
    window.localStorage.setItem(CHART_STATE_KEY, JSON.stringify(all));
  } catch {
    /* 存储满/被禁用时不影响图表本身 */
  }
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

/**
 * 预览还没回来（或拖动中预览必然过期）时，用券商的 tick 价值和手数估算金额。
 * 只是显示用：和真实盈亏可能有极小差异，所以界面上会带「≈」。
 */
function estimateProfit(
  info: SymbolInfo | undefined,
  volume: number,
  from: number,
  to: number,
): number | null {
  if (!info || !(volume > 0) || !(from > 0) || !(to > 0)) return null;
  const tickSize = info.tickSize || info.point || 0;
  const tickValue = info.tickValue || 0;
  if (!(tickSize > 0) || !(tickValue > 0)) return null;
  return (Math.abs(to - from) / tickSize) * tickValue * volume;
}

/**
 * 拖动松手到券商回执之间，先用本地目标价顶着显示。
 * 改单是停手 320ms 后才发的，如果直接按持仓里的旧 sl/tp 画，
 * 标签会先弹回旧价格、等回报再跳一次；这里让显示先停在用户放下的位置。
 * 收到一致的价格就清掉；改单被拒会立刻清（见 clearOptimistic）。
 * 这里的 12 秒只是兜底（比 8 秒的请求超时更长，慢回执时界面不会先弹回去）。
 */
const optimisticPrices = new Map<string, { price: number; at: number }>();

function resolvePrice(
  key: string,
  actual: number | null | undefined,
  tolerance: number,
): { price: number | null; pending: boolean } {
  const item = optimisticPrices.get(key);
  if (!item) return { price: actual ?? null, pending: false };
  if (Date.now() - item.at > 12000) {
    optimisticPrices.delete(key);
    return { price: actual ?? null, pending: false };
  }
  if (actual != null && Math.abs(actual - item.price) <= tolerance) {
    optimisticPrices.delete(key);
    return { price: actual, pending: false };
  }
  return { price: item.price, pending: true };
}

/** 「  -100.00 USD」这种金额后缀，没有数值就返回空串 */
function moneySuffix(
  amount: number | null | undefined,
  sign: '-' | '+',
  currency: string,
  approx = false,
): string {
  if (amount == null || !Number.isFinite(amount)) return '';
  return `  ${approx ? '≈' : ''}${sign}${fmtMoney(amount)}${currency ? ` ${currency}` : ''}`;
}

/** 持仓止损/止盈的金额是带符号的，直接按金额的正负显示 */
function signedMoney(
  amount: number | null | undefined,
  currency: string,
  approx = false,
): string {
  if (amount == null || !Number.isFinite(amount)) return '';
  return `  ${approx ? '≈' : ''}${fmtSigned(amount)}${currency ? ` ${currency}` : ''}`;
}

/** 止盈相当于几个 1R；没有止损、风险距离为 0 或数值异常时返回 null */
function rewardR(
  entry: number,
  sl: number | null | undefined,
  tp: number | null | undefined,
): number | null {
  if (!(entry > 0) || sl == null || !(sl > 0) || tp == null || !(tp > 0)) return null;
  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return null;
  const ratio = Math.abs(tp - entry) / risk;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

/** 右侧标签追加「 · 8.2R」；没有倍数就不加 */
function rSuffix(ratio: number | null): string {
  return ratio == null ? '' : ` · ${ratio.toFixed(1)}R`;
}

export function ChartPanel({
  slot = 'main',
  symbol: symbolProp,
  resolution: resolutionProp,
  onSymbolChange,
  onIntervalChange,
  syncCrosshair = true,
  syncRange = false,
}: {
  /** 图表 id：main 或 c1~c15，用于十字线联动与主图识别 */
  slot?: string;
  /** 不传则跟随全局品种 */
  symbol?: string;
  /** 不传则跟随全局周期 */
  resolution?: string;
  /** 图表自带品种栏切换后回写；不传则写全局 */
  onSymbolChange?: (symbol: string) => void;
  /** 图表自带周期栏切换后回写；不传则写全局 */
  onIntervalChange?: (resolution: string) => void;
  /** 跟随其他图表的十字线 */
  syncCrosshair?: boolean;
  /** 跟随其他图表的可视时间区间（时间 / 日期范围同步） */
  syncRange?: boolean;
} = {}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<IChartingLibraryWidget | null>(null);
  const datafeedRef = useRef<GatewayDatafeed | null>(null);
  const layerRef = useRef<PriceLineLayer | null>(null);
  /** 专业时段指标的箱体（用绘图对象画，跟指标一起出现/消失） */
  const sessionBoxesRef = useRef<SessionBoxManager | null>(null);
  /** 财经日历事件的竖线标注 */
  const calendarLayerRef = useRef<CalendarLayer | null>(null);
  /** Pine 指标（实验）运行时，同一张图的所有 Pine 指标共用 */
  const pineRunnerRef = useRef<PineRunner | null>(null);
  // 每张图一个上下文 id：同一脚本在多张图上分别计算，结果互不覆盖
  const [pineContextId] = useState(
    () => `pine-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const startedRef = useRef(false);
  const crosshairPrice = useRef<number | null>(null);
  /** 右键菜单用的价格：十字线价，或按下时按鼠标 y 从价格标尺反推 */
  const contextMenuPrice = useRef<number | null>(null);
  const lastCrosshairStore = useRef(0);
  /** 指标自动保存轮询的定时器 */
  const saveTimerRef = useRef(0);
  /** 指标快照的即时落盘：卸载/关闭窗口前补写一次，避免卡在轮询窗口里 */
  const flushStudiesRef = useRef<(() => void) | null>(null);
  /** 画线轮询的定时器与即时落盘 */
  const lineTimerRef = useRef(0);
  const flushLinesRef = useRef<(() => void) | null>(null);
  const flushCleanupRef = useRef<(() => void) | null>(null);

  const [chart, setChart] = useState<IChartWidgetApi | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 浮动工具栏「模板」按钮打开的面板位置（图表容器内坐标） */
  const [templateSpot, setTemplateSpot] = useState<{ left: number; top: number } | null>(null);
  const floatingTemplateRef = useRef<(() => void) | null>(null);
  /** 图表顶栏「指标模板」右侧的告警铃铛 */
  const headerAlertRef = useRef<HeaderAlertHandle | null>(null);

  /**
   * 拖动落点要先体现在界面上，必须触发一次重渲染：
   * 只改模块里的 optimisticPrices 的话，标签要等下一份持仓/行情推送
   * （最多几百毫秒，行情不动时更久）才会从旧位置跳过去，看起来就像拖不动。
   */
  const [, setOptimisticTick] = useState(0);
  /** 图上正在被拖动的价格线（PriceLineLayer 轮询上报），用于加深区间 */
  const [activeLine, setActiveLine] = useState<string | null>(null);
  const markOptimistic = (key: string, price: number) => {
    optimisticPrices.set(key, { price, at: Date.now() });
    setOptimisticTick((tick) => tick + 1);
  };
  /** 改单被券商拒绝时立刻退回真实价格，别让界面继续停在不可能成交的价位 */
  const clearOptimistic = (key: string) => {
    if (optimisticPrices.delete(key)) setOptimisticTick((tick) => tick + 1);
  };

  // 图表事件订阅只建立一次，回调通过 ref 拿最新值
  const onSymbolChangeRef = useRef(onSymbolChange);
  onSymbolChangeRef.current = onSymbolChange;
  const onIntervalChangeRef = useRef(onIntervalChange);
  onIntervalChangeRef.current = onIntervalChange;
  const symbolRef = useRef<string | undefined>(undefined);
  const resolutionRef = useRef<string | undefined>(undefined);
  const syncCrosshairRef = useRef(syncCrosshair);
  syncCrosshairRef.current = syncCrosshair;

  const conn = useApp((s) => s.conn);
  const health = useApp((s) => s.health);
  const storeSymbol = useApp((s) => s.symbol);
  const storeResolution = useApp((s) => s.resolution);
  const symbol = symbolProp ?? storeSymbol;
  const resolution = resolutionProp ?? storeResolution;
  symbolRef.current = symbol;
  resolutionRef.current = resolution;
  // 多图时每个槽位用自己的品种参数取整，不能拿全局 symbol 的 digits / tickSize
  const info = useApp((s) => s.symbols.find((item) => item.name === symbol));
  const quote = useApp((s) => s.quote);
  const draft = useApp((s) => s.draft);
  // 草稿只属于下单时的品种；多图里其他格子不画它的线
  const draftHere = !draft.symbol || draft.symbol === symbol;
  const preview = useApp((s) => s.preview);
  const allPositions = useApp((s) => s.positions);
  const allOrders = useApp((s) => s.orders);
  const allAlerts = useApp((s) => s.alerts);
  const patchDraft = useApp((s) => s.patchDraft);
  const resetDraft = useApp((s) => s.resetDraft);
  const setSymbol = useApp((s) => s.setSymbol);
  const setResolution = useApp((s) => s.setResolution);
  const theme = useApp((s) => s.theme);
  const calendarOverlay = useApp((s) => s.calendarOverlay);
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
  // 只标注这张图自己的品种，多图时不把别的品种的告警画过来
  const alerts = alertsOnChart(allAlerts, symbol);
  // 顶栏铃铛的角标跟着当前图表上启用中的告警数量走
  const alertCount = alerts.length;
  useEffect(() => {
    headerAlertRef.current?.setCount(alertCount);
  }, [alertCount]);
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

  /**
   * 拖动止盈/止损/挂单价：先按本地目标价显示，停手后才真正改单。
   * 拖回券商当前价时不算一次新改动，只把没发出去的撤掉、在飞的补回原价。
   */
  const moveTo = (
    key: string,
    actual: number | null | undefined,
    raw: number,
    send: (price: number) => Promise<unknown>,
  ) => {
    const next = roundPrice(raw);
    const base = actual ?? 0;
    const fail = (err: Error) => {
      clearOptimistic(key);
      notify('error', err.message);
    };
    if (Math.abs(next - base) <= tol) {
      clearOptimistic(key);
      revertModify(key, base, send, fail, tol);
      return;
    }
    markOptimistic(key, next);
    requestModify(key, next, send, fail, tol);
  };

  /**
   * 保存告警拖动结果：价格变了，上穿/下穿也要按买价重算。
   * 方向必须在拖动落点那一刻定下来，不能等 320ms 节流后再算——
   * 行情在这段时间里冲过告警价，会把方向翻到用户看到的相反一侧，
   * 触发时的提醒内容就会和图表上刚拖出来的方向对不上。
   * 图上虚线和右侧小块共用这一套逻辑。
   */
  const saveAlertPrice = (alert: PriceAlert) => (price: number) => {
    const state = useApp.getState();
    const bid = state.quote && state.quote.symbol === alert.symbol ? state.quote.bid : null;
    const kind = alertKindFor(roundPrice(price), bid);
    moveTo(`alert:${alert.id}`, alert.price, price, async (value) => {
      const updated = await gateway.call<PriceAlert>('alerts.update', {
        id: alert.id,
        price: value,
        ...(kind ? { kind } : {}),
      });
      const next = useApp.getState();
      next.setAlerts(
        next.alerts.map((item) => (item.id === alert.id ? { ...item, ...updated } : item)),
      );
    });
  };

  /** 打开告警面板前记录铃铛位置，让面板贴着顶栏铃铛展开 */
  const anchorAlerts = () => {
    useApp.getState().setAlertsAnchor(alertPanelSpot(hostRef.current));
  };

  const chips: ChartChip[] = [];
  // 市价草稿的基准价跟随现价：图上那条虚线要一直贴在市场价上
  const liveEntry = (draft.side === 'buy' ? quote?.ask : quote?.bid) ?? 0;
  const draftAnchor = draft.type === 'market' ? liveEntry || draft.price : draft.price;
  // 挂单类型由方向 + 价格推导，图上标签与面板保持同一套文案
  const pendingInfo = classifyPending({
    side: draft.side,
    price: draft.price,
    bid: quote?.bid,
    ask: quote?.ask,
    stopsLevelPoints: info?.stopsLevelPoints,
    point: info?.point,
  });
  const draftSlSet = draft.sl != null && draft.sl > 0;
  const draftTpSet = draft.tp != null && draft.tp > 0;

  /**
   * 入口标签上的 TP/SL 徽标：按住向上/向下拉出虚线预览，松手才写入草稿；
   * 只点一下不拖不生成任何线。
   */
  const entryTags = (): NonNullable<ChartChip['tags']> => [
    {
      text: 'TP',
      color: SIDE_BUY,
      muted: !draftTpSet,
      pull: draftTpSet
        ? undefined
        : {
            color: SIDE_BUY,
            format: (price: number) => fmtPrice(price, digits),
            onPull: (price: number) => patchDraft({ tp: roundPrice(price) }),
          },
      title: draftTpSet ? undefined : '按住向上/向下拖动设置止盈',
    },
    {
      text: 'SL',
      color: STOP_OUT_COLOR,
      muted: !draftSlSet,
      pull: draftSlSet
        ? undefined
        : {
            color: STOP_OUT_COLOR,
            format: (price: number) => fmtPrice(price, digits),
            onPull: (price: number) => patchDraft({ sl: roundPrice(price) }),
          },
      title: draftSlSet ? undefined : '按住向上/向下拖动设置止损',
    },
  ];

  // 预览回来之前先用 tick 价值估算，拖动时金额不会凭空消失
  const draftRiskEstimate = estimateProfit(info, draft.volume, draftAnchor, draft.sl ?? 0);
  const draftRewardEstimate = estimateProfit(info, draft.volume, draftAnchor, draft.tp ?? 0);
  const draftRisk = previewMatched ? (preview?.riskAmount ?? draftRiskEstimate) : draftRiskEstimate;
  const draftReward = previewMatched
    ? (preview?.rewardAmount ?? draftRewardEstimate)
    : draftRewardEstimate;
  const draftRiskApprox = !previewMatched || preview?.riskAmount == null;
  const draftRewardApprox = !previewMatched || preview?.rewardAmount == null;

  if (draftHere && draft.active && draftAnchor > 0) {
    // 挂单：入场线落在委托价上；市价：一条跟着现价走的虚线
    if (draft.type !== 'market') {
      const invalid = !pendingInfo.type;
      chips.push({
        key: 'draft:entry',
        price: draft.price,
        color: invalid ? STOP_OUT_COLOR : sideColor(draft.side),
        text: `${invalid ? '待定价' : pendingInfo.label} ${volume(
          draft.volume,
        )} @ ${fmtPrice(draft.price, digits)}`,
        tags: entryTags(),
        onMove: (price) => patchDraft({ price: roundPrice(price) }),
        onRemove: () => resetDraft(),
      });
    } else if (liveEntry > 0) {
      // 当前价平仓的浮亏（点差成本），让市价线右侧有个可读的数字
      const exit = (draft.side === 'buy' ? quote?.bid : quote?.ask) ?? 0;
      const spreadLoss = estimateProfit(info, draft.volume, liveEntry, exit);
      const floating = spreadLoss == null ? null : -spreadLoss;
      chips.push({
        key: 'draft:market',
        price: liveEntry,
        color: sideColor(draft.side),
        fixed: true,
        drawLine: true,
        tags: entryTags(),
        text: `${volume(draft.volume)}${signedMoney(floating, currency, true)}`,
        onRemove: () => resetDraft(),
      });
    }
    if (draft.sl != null && draft.sl > 0) {
      chips.push({
        key: 'draft:sl',
        price: draft.sl,
        color: SIDE_SELL,
        tags: [{ text: 'SL', color: STOP_OUT_COLOR }],
        text: `${fmtPrice(draft.sl, digits)}${moneySuffix(
          draftRisk,
          '-',
          currency,
          draftRiskApprox,
        )} · 1R`,
        onMove: (price) => patchDraft({ sl: roundPrice(price) }),
        onRemove: () => patchDraft({ sl: null }),
      });
    }
    if (draft.tp != null && draft.tp > 0) {
      chips.push({
        key: 'draft:tp',
        price: draft.tp,
        color: SIDE_BUY,
        tags: [{ text: 'TP', color: SIDE_BUY }],
        text: `${fmtPrice(draft.tp, digits)}${moneySuffix(
          draftReward,
          '+',
          currency,
          draftRewardApprox,
        )}${rSuffix(rewardR(draftAnchor, draft.sl, draft.tp))}`,
        onMove: (price) => patchDraft({ tp: roundPrice(price) }),
        onRemove: () => patchDraft({ tp: null }),
      });
    }
  }

  // ---- 图上风险区间：只画 R 刻度线；金额与 R 倍数统一放在右边缘标签里 ----
  const bands: ChartBand[] = [];

  const addBands = (
    prefix: string,
    entry: number,
    sl: number | null | undefined,
    tp: number | null | undefined,
    style?: {
      riskFill?: string;
      riskActive?: string;
      rewardFill?: string;
      rewardActive?: string;
      slKey?: string;
      tpKey?: string;
      highlightSl?: boolean;
      highlightTp?: boolean;
    },
  ) => {
    const hasSl = sl != null && sl > 0 && Math.abs(entry - sl) > 0;
    const hasTp = tp != null && tp > 0 && Math.abs(tp - entry) > 0;
    const risk = hasSl ? Math.abs(entry - (sl as number)) : 0;
    if (hasSl) {
      bands.push({
        key: `${prefix}:risk`,
        from: entry,
        to: sl as number,
        color: style?.riskFill ?? BAND_FILL,
        activeColor: style?.riskActive,
        keys: style?.slKey ? [style.slKey] : undefined,
        highlight: style?.highlightSl,
        labelColor: 'rgba(239, 83, 80, 0.9)',
      });
    }
    if (hasTp) {
      const target = tp as number;
      const reward = Math.abs(target - entry);
      const marks =
        risk > 0
          ? Array.from(
              { length: Math.min(10, Math.floor(reward / risk + 1e-9)) },
              (_, index) => {
                const price = roundPrice(
                  entry + Math.sign(target - entry) * risk * (index + 1),
                );
                return {
                  price,
                  text: `${index + 1}R`,
                  // 刻度旁直接给出价位，拖动止盈时能确定具体价格
                  priceText: fmtPrice(price, digits),
                };
              },
            )
          : [];
      bands.push({
        key: `${prefix}:reward`,
        from: entry,
        to: target,
        color: style?.rewardFill ?? BAND_FILL,
        activeColor: style?.rewardActive,
        keys: style?.tpKey ? [style.tpKey] : undefined,
        highlight: style?.highlightTp,
        labelColor: 'rgba(38, 166, 154, 0.95)',
        marks,
      });
    }
  };

  if (draftHere && draft.active && draftAnchor > 0) {
    // 区间从计价基准画起：挂单用委托价，市价用现价；拖动时加深对应一侧
    addBands('draft', draftAnchor, draft.sl, draft.tp, {
      riskFill: DRAFT_RISK_FILL,
      riskActive: DRAFT_RISK_ACTIVE,
      rewardFill: DRAFT_REWARD_FILL,
      rewardActive: DRAFT_REWARD_ACTIVE,
      slKey: 'draft:sl',
      tpKey: 'draft:tp',
      highlightSl: activeLine === 'draft:sl',
      highlightTp: activeLine === 'draft:tp',
    });
  }

  for (const order of orders) {
    addBands(`order:${order.ticket}`, order.price, order.sl, order.tp);
  }

  for (const order of orders) {
    const kind = order.type === 'limit' ? '限价' : '停损';
    const side = order.side === 'buy' ? '买入' : '卖出';
    const key = `order:${order.ticket}`;
    const shown = resolvePrice(key, order.price, tol).price ?? order.price;
    chips.push({
      key,
      price: shown,
      color: sideColor(order.side),
      text: `${kind}${side} ${volume(order.volume)} @ ${fmtPrice(shown, digits)}`,
      onMove: (price) =>
        moveTo(key, order.price, price, (value) =>
          gateway.call('order.modify', { ticket: order.ticket, price: value }),
        ),
      onRemove: () => {
        void cancelOrderWithUndo(order, notify);
      },
    });
    // 挂单的止损/止盈金额与 R 倍数也放在右侧标签里，左侧不再写字
    if (order.sl) {
      const slKey = `order:${order.ticket}:sl`;
      const slShown = resolvePrice(slKey, order.sl, tol).price ?? order.sl;
      chips.push({
        key: slKey,
        price: slShown,
        color: SIDE_SELL,
        text: `${volume(order.volume)}${signedMoney(
          estimateProfit(info, order.volume, order.price, slShown),
          currency,
          true,
        )} · 1R`,
        onMove: (price) =>
          moveTo(slKey, order.sl, price, (value) =>
            gateway.call('order.modify', { ticket: order.ticket, sl: value }),
          ),
      });
    }
    if (order.tp) {
      const tpKey = `order:${order.ticket}:tp`;
      const tpShown = resolvePrice(tpKey, order.tp, tol).price ?? order.tp;
      chips.push({
        key: tpKey,
        price: tpShown,
        color: SIDE_BUY,
        text: `${volume(order.volume)}${signedMoney(
          estimateProfit(info, order.volume, order.price, tpShown),
          currency,
          true,
        )}${rSuffix(rewardR(order.price, order.sl, tpShown))}`,
        onMove: (price) =>
          moveTo(tpKey, order.tp, price, (value) =>
            gateway.call('order.modify', { ticket: order.ticket, tp: value }),
          ),
      });
    }
  }

  for (const position of positions) {
    const side = position.side === 'buy' ? '多' : '空';
    const slKey = `position:${position.ticket}:sl`;
    const tpKey = `position:${position.ticket}:tp`;
    // 松手到回执之间先按本地目标价显示，否则标签会先弹回旧价、回报到了再跳
    const slShown = resolvePrice(slKey, position.sl, tol);
    const tpShown = resolvePrice(tpKey, position.tp, tol);
    // 网关偶尔算不出打到止损/止盈的金额；改单未回执时也先用 tick 价值估算
    const slEstimate = slShown.price
      ? estimateProfit(info, position.volume, position.openPrice, slShown.price)
      : null;
    const tpEstimate = tpShown.price
      ? estimateProfit(info, position.volume, position.openPrice, tpShown.price)
      : null;
    const slAmount = slShown.pending
      ? (slEstimate ?? position.slProfit)
      : (position.slProfit ?? slEstimate);
    const tpAmount = tpShown.pending
      ? (tpEstimate ?? position.tpProfit)
      : (position.tpProfit ?? tpEstimate);
    const slApprox = slShown.pending
      ? slEstimate != null
      : position.slProfit == null && slEstimate != null;
    const tpApprox = tpShown.pending
      ? tpEstimate != null
      : position.tpProfit == null && tpEstimate != null;
    addBands(
      `position:${position.ticket}`,
      position.openPrice,
      slShown.price,
      tpShown.price,
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
        price: slShown.price ?? position.sl,
        color: SIDE_SELL,
        text: `${volume(position.volume)}${signedMoney(slAmount, currency, slApprox)} · 1R`,
        onMove: (price) =>
          moveTo(slKey, position.sl, price, (value) =>
            gateway.call('position.modify', { ticket: position.ticket, sl: value }),
          ),
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
        price: tpShown.price ?? position.tp,
        color: SIDE_BUY,
        text: `${volume(position.volume)}${signedMoney(tpAmount, currency, tpApprox)}${rSuffix(
          rewardR(position.openPrice, slShown.price, tpShown.price),
        )}`,
        onMove: (price) =>
          moveTo(tpKey, position.tp, price, (value) =>
            gateway.call('position.modify', { ticket: position.ticket, tp: value }),
          ),
        onRemove: () => {
          gateway
            .call('position.modify', { ticket: position.ticket, tp: 0 })
            .catch((err: Error) => notify('error', err.message));
        },
      });
    }
    // 分批止盈：每档一个绿色小块，可直接上下拖动或点 ✕ 删除
    const planSteps = activeSteps(position.plan);
    if (planSteps.length > 0) {
      const lots = estimateStepLots(
        position.volume,
        planSteps,
        info,
        position.side,
        position.plan,
      );
      const lotsById = new Map(lots.rows.map((row) => [row.id, row]));
      for (const planStep of planSteps) {
        const key = `plan:${position.ticket}:${planStep.id}`;
        const beyondTp =
          position.tp != null &&
          (position.side === 'buy' ? planStep.price >= position.tp : planStep.price <= position.tp);
        const row = lotsById.get(planStep.id);
        const percent = planStep.closePercent != null ? `${planStep.closePercent}%` : '移保本';
        const lotsText = row && row.lots > 0 ? ` · ${volume(row.lots)}手` : '';
        const r = stepAtR(planStep, position, position.plan);
        const rText = r != null ? ` · ${r.toFixed(1)}R` : '';
        chips.push({
          key,
          price: resolvePrice(key, planStep.price, tol).price ?? planStep.price,
          color: beyondTp ? PLAN_INVALID_COLOR : PLAN_COLOR,
          text: `${percent}${lotsText}${rText}${beyondTp ? ' · 超出止盈' : ''}`,
          onMove: beyondTp
            ? undefined
            : (price) =>
                moveTo(key, planStep.price, price, (value) =>
                  gateway.call('position.plan.update', {
                    ticket: position.ticket,
                    stepId: planStep.id,
                    price: value,
                  }),
                ),
          onRemove: () => {
            gateway
              .call('position.plan.remove', {
                ticket: position.ticket,
                stepId: planStep.id,
              })
              .then(() => notify('info', '已删除该分批档位'))
              .catch((err: Error) => notify('error', err.message));
          },
        });
      }
    }
  }

  // 价格告警：右侧小块 + 图上的虚线，标出上穿 / 下穿价位与备注
  for (const alert of alerts) {
    const key = `alert:${alert.id}`;
    chips.push({
      key,
      // 拖动告警线后先按本地目标价显示，等 alerts.update 回执再落到真实数据
      price: resolvePrice(key, alert.price, tol).price ?? alert.price,
      color: ALERT_COLOR,
      text: alertChipText(alert, digits),
      tags: [{ text: '告警', color: ALERT_COLOR }],
      // 右侧小块和图上虚线一样可上下拖动改价，方向跟着重算
      onMove: saveAlertPrice(alert),
    });
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
    if (slot === 'main') dropSavedThemeColors(chartTheme(initialTheme));

    // 右键菜单的价格：优先用按下时记录的位置，其次十字线，最后取现价
    const quickMenuPrice = () => {
      const state = useApp.getState();
      const sym = symbolRef.current ?? state.symbol;
      const symbolInfo = state.symbols.find((item) => item.name === sym);
      const raw =
        contextMenuPrice.current ??
        crosshairPrice.current ??
        (state.quote && state.quote.symbol === sym ? state.quote.bid : null);
      const price = raw == null ? null : roundToTick(raw, symbolInfo);
      return price != null && Number.isFinite(price) && price > 0 ? price : null;
    };
    const quickMenuItems = (price: number) => {
      const state = useApp.getState();
      const sym = symbolRef.current ?? state.symbol;
      const symbolInfo = state.symbols.find((item) => item.name === sym);
      return buildQuickActionItems({
        price,
        symbol: sym,
        volume: state.draft.volume,
        digits: symbolInfo?.digits ?? 5,
        step: symbolInfo?.volumeStep ?? 0.01,
        // 只认这个品种自己的报价；多图时全局 quote 可能属于别的格子
        quote: state.quote?.symbol === sym ? state.quote : null,
        info: symbolInfo,
      });
    };

    try {
      const widget = new tv.widget({
        container: host,
        library_path: '/charting_library/',
        datafeed: datafeedRef.current,
        symbol,
        interval: resolution as ResolutionString,
        locale: 'zh',
        theme: chartTheme(initialTheme),
        autosize: true,
        fullscreen: false,
        loading_screen: {
          backgroundColor: initialTheme === 'dark' ? '#14161b' : '#ffffff',
          foregroundColor: accentForTheme(useApp.getState().accentColor, initialTheme),
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
        // 自定义指标（JS + PineJS.Std），以及用户保存的 Pine 脚本（Piner 本地执行）
        custom_indicators_getter: (PineJS: PineJS) =>
          customIndicators(PineJS, pineContextId),
        // 图表 / 价格轴右键菜单顶部插入「警报 / 买入 / 卖出」，
        // 动作只预填交易台草稿或告警面板，确认窗仍然由用户操作。
        context_menu: {
          items_processor: makeQuickMenuProcessor(quickMenuItems, quickMenuPrice, (action, price) => {
            setActiveSlot(slot);
            if (action === 'alert') anchorAlerts();
            useApp.getState().chartQuickAction(action, price, symbolRef.current);
          }),
        },
        // 画线模板由应用自己的「画线模板」面板负责（见 DrawingTemplates.tsx），
        // 不用库里那个只显示「应用默认」的内置模板菜单。
        // 主图把图表属性（倒计时、坐标、指标等）存进 localStorage，重启后保留；
        // 四图是四个 widget 共用一份存储，读写会互相覆盖，所以整格关掉本地存储。
        // 允许在周期菜单里「添加自定义周期」（如 7 分钟、3 天），
        // 这些周期由图表库按 symbolInfo 的 multipliers 从基础周期合成。
        // custom_resolutions：允许「添加自定义周期」；
        // study_templates：显示库自带的「指标模板」按钮（保存指标模板… / 我的模板），
        // 模板内容由 templateStore 存进 localStorage。
        // 画线（绘图对象）单独按图表保存：每张图一个适配器，库里传的
        // layoutId/chartId 每次启动都会变，适配器改按 slot 落盘。
        save_load_adapter: chartSaveAdapter(slot),
        // custom_resolutions：允许在周期菜单里「添加自定义周期」；
        // study_templates：显示库自带的「指标模板」按钮；
        // saveload_separate_drawings_storage：画线与布局分开存，交给适配器。
        enabled_features: [
          'custom_resolutions',
          'study_templates',
          'saveload_separate_drawings_storage',
        ],
        // 用户改动图表后最多隔多久提示一次自动保存（秒），配合下面的订阅
        auto_save_delay: 1,
        disabled_features:
          slot === 'main'
            ? []
            : ['use_localstorage_for_settings', 'save_chart_properties_to_local_storage'],
      });
      widgetRef.current = widget;
      // 画线、指标参数等可撤销改动不会自己落盘：库只发 onAutoSaveNeeded，
      // 收到后把指标快照和画线状态各补写一次（见 chartReady 里的 persist*）。
      widget.subscribe('onAutoSaveNeeded', () => {
        flushStudiesRef.current?.();
        flushLinesRef.current?.();
      });
      // 关闭窗口前也补写一次，别让最后一次改动卡在轮询窗口里
      const flushOnHide = () => {
        flushStudiesRef.current?.();
        flushLinesRef.current?.();
      };
      window.addEventListener('pagehide', flushOnHide);
      flushCleanupRef.current = () => window.removeEventListener('pagehide', flushOnHide);
      // 模板 / 告警入口跟着选中画线的浮动工具栏出现，和 TradingView 原生位置一致
      floatingTemplateRef.current = mountFloatingToolbarButtons(
        host,
        {
          templates: (button) => {
            const spot = templatePanelSpot(host, button);
            // 再点一次按钮收起菜单；切到别的画线由下面的选择事件关掉
            setTemplateSpot((current) => (current ? null : spot));
          },
          alert: () => {
            setTemplateSpot(null);
            try {
              const active = widget.activeChart();
              const selected = active.selection().allItems();
              const shape = selected.length > 0 ? active.getShapeById(selected[0] as never) : null;
              const points = (shape?.getPoints() ?? []) as Array<{ price: number }>;
              const price = drawingAlertPrice(points);
              if (price == null) {
                useApp.getState().notify('error', '先选中一条画线再创建告警');
                return;
              }
              // 和价格轴「+」同一套预填流程：方向按现价判断，确认后再添加
              anchorAlerts();
              useApp.getState().chartQuickAction('alert', price, symbolRef.current);
            } catch (error) {
              useApp.getState().notify('error', (error as Error).message || '创建告警失败');
            }
          },
        },
        () => setTemplateSpot(null),
      );
      // 顶栏原来的告警按钮迁到图表顶栏：指标模板右侧的铃铛，点一下开合告警面板
      headerAlertRef.current = mountHeaderAlertButton(host, {
        onPick: () => {
          const state = useApp.getState();
          const next = !state.alertsOpen;
          if (next) anchorAlerts();
          state.setAlertsOpen(next);
        },
      });
      registerWidget(slot, widget, host);
      // 旧调试脚本和截图仍从 window.__tv 取主图
      if (slot === 'main') {
        (window as unknown as { __tv?: IChartingLibraryWidget }).__tv = widget;
      }

      widget.chartReady().then(() => {
        // StrictMode 二次挂载或切换账户时，旧 widget 可能已经被替换，别再给它挂事件
        if (widgetRef.current !== widget) return;
        const active = widget.activeChart();
        // 选中别的画线或点空白取消选择时，浮动工具栏里的模板菜单跟着收起
        active
          .selection()
          .onChanged()
          .subscribe(null, () => setTemplateSpot(null));
        // 右键菜单的 items_processor 可能在库的 mouse_down 订阅之前执行，
        // 所以在 iframe 文档的捕获阶段先把按下位置换算成价格。
        host.querySelector('iframe')?.contentDocument?.addEventListener(
          'mousedown',
          (event) => {
            if (event.button !== 2) return;
            try {
              const at = measurePriceAxis(host, active)?.priceAtLocal(event.clientY);
              if (at != null) contextMenuPrice.current = at;
            } catch {
              /* 量不到就沿用十字线价 */
            }
          },
          true,
        );
        // 图表在 same-origin iframe 里，父容器的 pointerdown 收不到图内点击，
        // 所以用库的 mouse_down 事件把「当前操作的图」和下单品种对齐。
        // 落委托价放到 mouse_up 再判断：只有空白处短促点一下才算，
        // 否则拖动图表、点/拖止损止盈线都会把入场价一起带走。
        let downAt = 0;
        let downX = 0;
        let downY = 0;
        widget.subscribe('mouse_down', (params) => {
          downAt = Date.now();
          downX = params.clientX;
          downY = params.clientY;
          // 价格轴上右键时十字线可能停在别处，按鼠标 y 从价格标尺反推价格
          try {
            // 库事件里的 clientY 是 iframe 本地坐标（不是外层视口）
            const at = measurePriceAxis(host, active)?.priceAtLocal(params.clientY);
            if (at != null) contextMenuPrice.current = at;
          } catch {
            /* 量不到就沿用十字线价 */
          }
          setActiveSlot(slot);
          const store = useApp.getState();
          if (symbolRef.current && store.symbol !== symbolRef.current) store.setSymbol(symbolRef.current);
        });
        widget.subscribe('mouse_up', (params) => {
          const current = useApp.getState();
          // 草稿属于别的品种时，这张图的十字光标不能改它的价格
          if (current.draft.symbol && current.draft.symbol !== symbolRef.current) return;
          const price = crosshairPrice.current;
          if (
            !shouldPlacePrice({
              active: current.draft.active,
              type: current.draft.type,
              downAt,
              upAt: Date.now(),
              downX,
              downY,
              upX: params.clientX,
              upY: params.clientY,
              hasSelection: hasSelectedDrawing(active),
              price,
            }) ||
            price == null
          ) {
            return;
          }
          const next = shiftRef.current
            ? snapLevel(price, infoRef.current)
            : roundToTick(price, infoRef.current);
          if (Math.abs(current.draft.price - next) > 1e-9) current.patchDraft({ price: next });
        });
        // 品种 / 周期切换回写：单图直接写全局，多图交给 ChartGrid 决定
        // 是否同步到所有图表。用 ref 比较，避免 setSymbol/setResolution 自己触发的事件回环。
        active.onSymbolChanged().subscribe(null, (next: LibrarySymbolInfo) => {
          if (!next?.name || next.name === symbolRef.current) return;
          symbolRef.current = next.name;
          if (onSymbolChangeRef.current) onSymbolChangeRef.current(next.name);
          else setSymbol(next.name);
        });
        active.onIntervalChanged().subscribe(null, (interval: ResolutionString) => {
          if (interval === resolutionRef.current) return;
          resolutionRef.current = interval;
          if (onIntervalChangeRef.current) onIntervalChangeRef.current(interval);
          else setResolution(interval);
        });
        // 图表属性从 localStorage 恢复后，再用应用主题覆盖一次背景/文字色
        widget.applyOverrides(chartOverrides(useApp.getState().theme));

        // ---- 指标组合持久化：每张图各自保存，换品种/重启后自动恢复 ----
        const readState = (): { json: string; state: object } | null => {
          try {
            const state = active.createStudyTemplate({ saveSymbol: false, saveInterval: false });
            return { json: JSON.stringify(state), state };
          } catch {
            return null;
          }
        };
        const saved = readChartStates()[slot];
        let applying = false;
        let last = '';
        if (saved?.state) {
          applying = true;
          try {
            // 旧版本的 8 位颜色会让指标「设置」对话框打不开，加载前先迁移
            migratePineTemplate(saved.state);
            active.applyStudyTemplate(saved.state);
          } catch {
            /* 旧版本模板不兼容时保留默认指标 */
          }
          window.setTimeout(() => {
            applying = false;
            last = readState()?.json ?? '';
          }, 1200);
        } else {
          last = readState()?.json ?? '';
        }
        // 指标增删/改参数没有稳定的公开事件，轮询快照即可（约 15KB，开销很小）
        const persistStudies = () => {
          if (applying || widgetRef.current !== widget) return;
          const next = readState();
          if (!next || next.json === last) return;
          last = next.json;
          writeChartState(slot, next.state);
        };
        flushStudiesRef.current = persistStudies;
        saveTimerRef.current = window.setInterval(persistStudies, 1500);

        // ---- 画线持久化：库需要布局服务才会调适配器保存，这里按 slot 自己快照 ----
        const readLines = () => {
          try {
            return serializeLineTools(active.getLineToolsState());
          } catch {
            return null;
          }
        };
        const savedLines = readSlotLineToolsRaw(slot);
        if (savedLines) {
          const state = deserializeLineTools(savedLines);
          if (state?.sources && state.sources.size > 0) {
            active
              .applyLineToolsState(state as LineToolsAndGroupsState)
              .catch(() => {
                /* 旧格式/不兼容时从空白图开始 */
              });
          }
        }
        // 恢复期间别把还没贴上的画线当成「用户删光了」写回去
        let applyingLines = true;
        let linesJson = JSON.stringify(readLines());
        window.setTimeout(() => {
          applyingLines = false;
          linesJson = JSON.stringify(readLines());
        }, 800);
        const persistLines = () => {
          if (applyingLines || widgetRef.current !== widget) return;
          const next = readLines();
          if (!next) return;
          const json = JSON.stringify(next);
          if (json === linesJson) return;
          linesJson = json;
          writeSlotLineTools(slot, next);
        };
        flushLinesRef.current = persistLines;
        lineTimerRef.current = window.setInterval(persistLines, 2000);

        active.crossHairMoved().subscribe(null, (params) => {
          if (!params || typeof params.price !== 'number') return;
          crosshairPrice.current = params.price;
          contextMenuPrice.current = params.price;
          if (syncCrosshairRef.current) {
            publishCrosshair({
              price: params.price,
              time: typeof params.time === 'number' ? params.time : null,
              from: slot,
            });
          }
          const now = performance.now();
          if (now - lastCrosshairStore.current > 100) {
            lastCrosshairStore.current = now;
            useApp.getState().setCrosshairPrice(params.price);
          }
        });

        const layer = new PriceLineLayer(
          active,
          (price) =>
            shiftRef.current ? snapLevel(price, infoRef.current) : roundToTick(price, infoRef.current),
          (key) => setActiveLine(key),
        );
        layer.start();
        layerRef.current = layer;

        // 专业时段指标只画关键位，时段箱体由这个管理器按指标设置绘制
        const boxes = new SessionBoxManager(widget);
        boxes.start();
        sessionBoxesRef.current = boxes;

        // 财经日历竖线：价格锚点用当前报价，事件本身按时间定位
        const calendar = new CalendarLayer(widget, () => useApp.getState().quote?.bid ?? 0);
        calendar.start();
        calendarLayerRef.current = calendar;

        // Pine 脚本（实验）：按指标输入和品种/周期重算，再让指标重绘
        const pineRunner = new PineRunner(widget, pineContextId, host, () => {
          const current = infoRef.current;
          return current?.tickSize || current?.point || 0;
        });
        pineRunner.start();
        pineRunnerRef.current = pineRunner;

        setChart(active);
        setError(null);
      });
    } catch (err) {
      startedRef.current = false;
      setError((err as Error).message);
    }
  }, [conn, symbol, quote, resolution, setResolution, setSymbol]);

  // ---- 主题切换：不重建图表，换主题后重新套一遍颜色 ----
  // 必须等 chartReady（chart 非空）再调用，四图同时创建时内部窗口可能还没就绪
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
      /* 图表还在初始化就先交给构造参数里的 theme/overrides */
    }
    return () => {
      cancelled = true;
    };
  }, [theme, chart]);

  // ---- 财经日历标注：当前品种相关的高/中影响事件 ----
  useEffect(() => {
    const layer = calendarLayerRef.current;
    if (!layer || !chart) return;
    if (!calendarOverlay) {
      layer.setEvents([], []);
      return;
    }
    let alive = true;
    const refresh = async () => {
      try {
        const week = await loadCalendar();
        if (!alive || calendarLayerRef.current !== layer) return;
        layer.setEvents(week.events, currenciesForSymbol(symbol));
      } catch {
        /* 网关离线时保留已有标注 */
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5 * 60 * 1000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [calendarOverlay, symbol, chart]);

  // ---- 卸载 ----
  useEffect(
    () => () => {
      window.clearInterval(saveTimerRef.current);
      saveTimerRef.current = 0;
      window.clearInterval(lineTimerRef.current);
      lineTimerRef.current = 0;
      // 卸载（关窗口 / 切账户）前把最新指标组合和画线写一次，别丢在轮询窗口里
      flushCleanupRef.current?.();
      flushCleanupRef.current = null;
      flushStudiesRef.current?.();
      flushStudiesRef.current = null;
      flushLinesRef.current?.();
      flushLinesRef.current = null;
      layerRef.current?.dispose();
      layerRef.current = null;
      sessionBoxesRef.current?.dispose();
      sessionBoxesRef.current = null;
      calendarLayerRef.current?.dispose();
      calendarLayerRef.current = null;
      pineRunnerRef.current?.dispose();
      pineRunnerRef.current = null;
      floatingTemplateRef.current?.();
      floatingTemplateRef.current = null;
      headerAlertRef.current?.dispose();
      headerAlertRef.current = null;
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
    // iframe 里的点击不会冒泡到外层，在这里记下「最近操作的图表」
    const focus = () => setActiveSlot(slot);
    win.addEventListener('keydown', handleGlobalShortcut);
    win.addEventListener('pointerdown', focus, true);
    return () => {
      win.removeEventListener('keydown', handleGlobalShortcut);
      win.removeEventListener('pointerdown', focus, true);
    };
  }, [chart, slot]);

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

  // ---- 可视时间区间同步（时间 / 日期范围开关）----
  useEffect(() => {
    if (!chart || !syncRange) return;
    let lastRange = '';

    const apply = (state: RangeState | null) => {
      if (!state || state.fromSlot === slot) return;
      lastRange = `${state.from}:${state.to}`;
      chart.setVisibleRange({ from: state.from, to: state.to }).catch(() => {});
    };

    const off = subscribeRange(apply);
    const subscription = chart.onVisibleRangeChanged();
    const handler = (range: { from: number; to: number } | null) => {
      if (!range) return;
      const key = `${range.from}:${range.to}`;
      // 刚应用过来的区间不再广播，避免两张图来回互相设置
      if (key === lastRange) return;
      lastRange = key;
      publishRange({ from: range.from, to: range.to, fromSlot: slot });
    };
    subscription.subscribe(null, handler);

    return () => {
      off();
      subscription.unsubscribe(null, handler);
    };
  }, [chart, syncRange, slot]);

  // ---- 图表上的价格线：画线下单 + 挂单 + 持仓 + 持仓止损止盈 ----
  useEffect(() => {
    const layer = layerRef.current;
    if (!chart || !layer) return;

    // 线本身不写字：文字/金额由右边缘的 ChartChips 显示
    const specs = new Map<string, PriceLineSpec>();

    if (draftHere && draft.active && draftAnchor > 0) {
      // 市价单没有可落的入场点：不画入场线，也不允许拖动它
      if (draft.type !== 'market') {
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
      }
      // 止损/止盈只在设置后画线；未设置时点入口标签上的 TP/SL 徽标生成
      if (draft.sl != null && draft.sl > 0) {
        specs.set('draft:sl', {
          price: draft.sl,
          color: SIDE_SELL,
          text: '',
          onMove: (price) => useApp.getState().patchDraft({ sl: price }),
        });
      }
      if (draft.tp != null && draft.tp > 0) {
        specs.set('draft:tp', {
          price: draft.tp,
          color: SIDE_BUY,
          text: '',
          onMove: (price) => useApp.getState().patchDraft({ tp: price }),
        });
      }
    }

    for (const order of orders) {
      const key = `order:${order.ticket}`;
      specs.set(key, {
        price: resolvePrice(key, order.price, tol).price ?? order.price,
        color: sideColor(order.side),
        text: '',
        onMove: (price) =>
          moveTo(key, order.price, price, (value) =>
            gateway.call('order.modify', { ticket: order.ticket, price: value }),
          ),
      });
      // 挂单的止损/止盈：没有时画引导线，松手由后端按最小距离校验
      const slKey = `order:${order.ticket}:sl`;
      specs.set(slKey, {
        price: order.sl
          ? (resolvePrice(slKey, order.sl, tol).price ?? order.sl)
          : guidePrice(chart, order.price, order.side === 'buy', info, 1),
        color: SIDE_SELL,
        text: order.sl ? '' : '拖动设置止损',
        showPrice: !!order.sl,
        onMove: (price) =>
          moveTo(slKey, order.sl, price, (value) =>
            gateway.call('order.modify', { ticket: order.ticket, sl: value }),
          ),
      });
      const tpKey = `order:${order.ticket}:tp`;
      specs.set(tpKey, {
        price: order.tp
          ? (resolvePrice(tpKey, order.tp, tol).price ?? order.tp)
          : guidePrice(chart, order.price, order.side !== 'buy', info, 2),
        color: SIDE_BUY,
        text: order.tp ? '' : '拖动设置止盈',
        showPrice: !!order.tp,
        onMove: (price) =>
          moveTo(tpKey, order.tp, price, (value) =>
            gateway.call('order.modify', { ticket: order.ticket, tp: value }),
          ),
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
        const key = `position:${position.ticket}:sl`;
        specs.set(`protect:${position.ticket}:sl`, {
          price: resolvePrice(key, position.sl, tol).price ?? position.sl,
          color: SIDE_SELL,
          text: '',
          onMove: (price) =>
            moveTo(key, position.sl, price, (value) =>
              gateway.call('position.modify', { ticket: position.ticket, sl: value }),
            ),
        });
      } else {
        const key = `position:${position.ticket}:sl`;
        specs.set(`protect:${position.ticket}:sl`, {
          price: guidePrice(chart, position.openPrice, position.side === 'buy', info, 1),
          color: SIDE_SELL,
          text: '拖动设置止损',
          showPrice: false,
          onMove: (price) =>
            moveTo(key, position.sl, price, (value) =>
              gateway.call('position.modify', { ticket: position.ticket, sl: value }),
            ),
        });
      }
      if (position.tp) {
        const key = `position:${position.ticket}:tp`;
        specs.set(`protect:${position.ticket}:tp`, {
          price: resolvePrice(key, position.tp, tol).price ?? position.tp,
          color: SIDE_BUY,
          text: '',
          onMove: (price) =>
            moveTo(key, position.tp, price, (value) =>
              gateway.call('position.modify', { ticket: position.ticket, tp: value }),
            ),
        });
      } else {
        const key = `position:${position.ticket}:tp`;
        specs.set(`protect:${position.ticket}:tp`, {
          price: guidePrice(chart, position.openPrice, position.side !== 'buy', info, 2),
          color: SIDE_BUY,
          text: '拖动设置止盈',
          showPrice: false,
          onMove: (price) =>
            moveTo(key, position.tp, price, (value) =>
              gateway.call('position.modify', { ticket: position.ticket, tp: value }),
            ),
        });
      }
      // 分批止盈档位：虚线、可拖动；超出最终止盈时画灰线且禁止拖动
      for (const planStep of activeSteps(position.plan)) {
        const key = `plan:${position.ticket}:${planStep.id}`;
        const beyondTp =
          position.tp != null &&
          (position.side === 'buy' ? planStep.price >= position.tp : planStep.price <= position.tp);
        specs.set(key, {
          price: resolvePrice(key, planStep.price, tol).price ?? planStep.price,
          color: beyondTp ? PLAN_INVALID_COLOR : PLAN_COLOR,
          text: '',
          editable: !beyondTp,
          dashed: true,
          onMove: (price) =>
            moveTo(key, planStep.price, price, (value) =>
              gateway.call('position.plan.update', {
                ticket: position.ticket,
                stepId: planStep.id,
                price: value,
              }),
            ),
        });
      }
    }

    // 价格告警：虚线、可直接拖动改价；拖动结果写回网关和本地列表
    for (const alert of alerts) {
      const key = `alert:${alert.id}`;
      specs.set(key, {
        price: resolvePrice(key, alert.price, tol).price ?? alert.price,
        color: ALERT_COLOR,
        text: '',
        dashed: true,
        onMove: saveAlertPrice(alert),
      });
    }

    layer.sync(specs);
    // draftAnchor 不放进依赖：市价草稿每跳都变，会把价格线同步刷爆。
    // 止损/止盈引导线只在开启划线时按当时报价定位，用户拖动后以拖动结果为准。
  }, [chart, draft, draftHere, orders, positions, alerts, symbol, notify]);

  const waiting = conn !== 'open' || !health?.connected || !symbol;

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      onPointerDown={() => {
        setActiveSlot(slot);
        // 多图时下单区跟随刚点的这张图，避免在 A 图上看价、却给 B 品种下单
        const store = useApp.getState();
        if (symbol && store.symbol !== symbol) store.setSymbol(symbol);
      }}
      onMouseLeave={() => {
        if (syncCrosshairRef.current) publishCrosshair(null);
      }}
    >
      <div ref={hostRef} className="absolute inset-0" />
      <ChartChips
        chips={chips}
        bands={bands}
        host={hostRef}
        chart={chart}
        slot={slot}
        syncCrosshair={syncCrosshair}
      />
      {chart && <ChartQuickActions host={hostRef} chart={chart} symbol={symbol} />}
      {chart && (
        <DrawingTemplates
          chart={chart}
          slot={slot}
          open={!!templateSpot}
          onClose={() => setTemplateSpot(null)}
          anchor={templateSpot}
        />
      )}
      {error && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-background/90 px-6 text-center text-sm text-destructive-foreground">
          {error}
        </div>
      )}
      {waiting && !error && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-1 bg-background/60 text-center">
          <div className="text-sm text-foreground">
            {conn !== 'open'
              ? '正在连接本地网关…'
              : !health?.connected
                ? '等待 MT5 终端…'
                : '请选择品种'}
          </div>
          <div className="max-w-md text-[11px] text-muted-foreground">
            {conn !== 'open'
              ? '正在自动启动网关；若持续失败，请查看 %LOCALAPPDATA%\\MyTrade\\gateway\\gateway.log'
              : (health?.lastError?.message ?? '请打开并登录 MetaTrader 5')}
          </div>
        </div>
      )}
      {draftHere && draft.active && (
        <button
          onClick={() => patchDraft({ active: false })}
          className="absolute right-3 top-14 z-30 rounded-lg border border-border bg-card/95 px-2.5 py-1.5 text-[11px] text-foreground shadow-sm transition-colors hover:bg-accent"
        >
          清除划线
        </button>
      )}
    </div>
  );
}
