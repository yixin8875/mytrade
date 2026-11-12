import type {
  CustomIndicator,
  IContext,
  PineJS,
} from '../../../public/charting_library/charting_library';
import { useApp } from '../../store/useApp';
import { pineIndicators } from './pineStudies';

type Inputs = <T extends string | number | boolean>(index: number) => T;

// 跟随主图品种的报价精度（JPY 3 位、黄金 2 位等）
const PRICE_FORMAT = { type: 'inherit' as const };

/** 专业时段（纽约时间，单位：当天分钟数） */
export interface SessionDef {
  label: string;
  /** 画在箱体上的英文名，和原 Pine 一致 */
  en: string;
  start: number;
  end: number;
  color: string;
}

export const SESSION_DEFS: readonly SessionDef[] = [
  { label: '亚洲', en: 'ASIA', start: 20 * 60, end: 24 * 60, color: '#2962FF' },
  { label: '伦敦', en: 'LONDON', start: 2 * 60, end: 5 * 60, color: '#FF6D00' },
  { label: '纽约盘前', en: 'NY PRE', start: 8 * 60, end: 9 * 60 + 30, color: '#AB47BC' },
  { label: '纽约早盘', en: 'NY AM', start: 9 * 60 + 30, end: 11 * 60 + 30, color: '#00897B' },
  { label: '纽约午盘', en: 'NY PM', start: 13 * 60 + 30, end: 16 * 60, color: '#78909C' },
];

export const PRO_STUDY_DESCRIPTION = 'NQ & GC 专业交易时段与关键位';

/** 关键开盘位：00:00 / 08:30 / 09:30（纽约时间） */
const KEY_OPEN_DEFS = [
  { label: '00:00 开盘', color: '#FFEB3B' },
  { label: '08:30 开盘', color: '#FF00FF' },
  { label: '09:30 开盘', color: '#008080' },
] as const;

const KEY_OPEN_TIMES = [0, 8 * 60 + 30, 9 * 60 + 30] as const;

// 时段箱体由 sessionBoxes.ts 用绘图对象画成真正的矩形（带填充、虚线边框、
// 中线和标签），指标只负责关键开盘位和昨日高/低/中，避免这些线参与价格轴
// 自动缩放把 K 线压扁。
const PLOT_COUNT = KEY_OPEN_DEFS.length + 3;
const PLOT_COLORS: string[] = KEY_OPEN_DEFS.map((key) => key.color);
const PLOT_LINESTYLES: number[] = KEY_OPEN_DEFS.map(() => 2);
PLOT_COLORS.push('#B2B5BE', '#B2B5BE', '#787B86');
PLOT_LINESTYLES.push(2, 2, 1);

const KEY_OPENS_START = 0;
const PD_START = KEY_OPEN_DEFS.length;

const NY_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export interface NyWall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * 图表的 bar 时间是「券商服务器时间当成 UTC」交给图表库的（见 datafeed.ts），
 * 所以要先减去服务器时差才是真正的 UTC，再换算纽约时间。
 */
export function chartServerOffset(): number {
  const state = useApp.getState();
  return state.quote?.serverOffset ?? state.health?.serverOffset ?? 0;
}

/** 把 bar 的 UNIX 时间换成纽约墙上时间（自动处理夏令时） */
export function nyWall(epochSec: number): NyWall {
  const parts = NY_FORMAT.formatToParts(new Date(epochSec * 1000));
  const wall: NyWall = { year: 1970, month: 1, day: 1, hour: 0, minute: 0 };
  for (const part of parts) {
    if (part.type === 'year') wall.year = Number(part.value);
    else if (part.type === 'month') wall.month = Number(part.value);
    else if (part.type === 'day') wall.day = Number(part.value);
    else if (part.type === 'hour') wall.hour = Number(part.value) % 24;
    else if (part.type === 'minute') wall.minute = Number(part.value);
  }
  return wall;
}

/** 纽约日历日（关键开盘位按它重置） */
function calendarKey(wall: NyWall): string {
  return `${wall.year}-${wall.month}-${wall.day}`;
}

/** 交易日：以纽约时间 boundary 点为分界（期货 18 点、外汇 17 点） */
function tradingDayKey(wall: NyWall, boundary: number): string {
  const local = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  return new Date(local - boundary * 3_600_000).toISOString().slice(0, 10);
}

interface LevelsState {
  signature: string;
  lastTime: number;
  calKey: string;
  dayKey: string;
  prevHigh: number;
  prevLow: number;
  dayHigh: number;
  dayLow: number;
  midnightOpen: number;
  preOpen: number;
  openOpen: number;
  gotPre: boolean;
  gotOpen: boolean;
}

function freshLevelsState(): LevelsState {
  return {
    signature: '',
    lastTime: Number.NaN,
    calKey: '',
    dayKey: '',
    prevHigh: Number.NaN,
    prevLow: Number.NaN,
    dayHigh: Number.NaN,
    dayLow: Number.NaN,
    midnightOpen: Number.NaN,
    preOpen: Number.NaN,
    openOpen: Number.NaN,
    gotPre: false,
    gotOpen: false,
  };
}

const SESSIONS_INPUT_COUNT = 11;

function inputSignature(inputs: Inputs): string {
  const values: string[] = [];
  for (let index = 0; index < SESSIONS_INPUT_COUNT; index += 1) {
    values.push(String(inputs(index)));
  }
  return values.join('|');
}

/**
 * 自定义指标。
 *
 * Charting Library 不能直接运行 Pine Script 源码，但支持用 JS + PineJS.Std
 * 写同等的指标：init/main 每个 bar 调一次，返回值按 plots 的顺序绘制。
 * 这里放的是应用内置的示例，后续新增指标照抄结构即可；用到的
 * PineJS.Std.sma / ema / rsi / atr / highest / lowest 等见 d.ts 的 PineJSStd。
 */
export function customIndicators(
  PineJS: PineJS,
  pineContextId = 'default',
): Promise<readonly CustomIndicator[]> {
  const emaRibbon: CustomIndicator = {
    name: 'MT EMA Ribbon',
    metainfo: {
      _metainfoVersion: 53,
      id: 'mt-ema-ribbon@tv-basicstudies-1',
      scriptId: 'mt-ema-ribbon',
      name: 'mt-ema-ribbon',
      description: 'MT 双 EMA',
      shortDescription: 'MT EMA',
      is_price_study: true,
      isCustomIndicator: true,
      is_hidden_study: false,
      format: PRICE_FORMAT,
      plots: [
        { id: 'plot_0', type: 'line' },
        { id: 'plot_1', type: 'line' },
      ],
      defaults: {
        styles: {
          plot_0: {
            plottype: 2,
            linestyle: 0,
            linewidth: 1,
            trackprice: false,
            transparency: 0,
            visible: true,
            color: '#FF9800',
          },
          plot_1: {
            plottype: 2,
            linestyle: 0,
            linewidth: 1,
            trackprice: false,
            transparency: 0,
            visible: true,
            color: '#2196F3',
          },
        },
        inputs: { in_0: 20, in_1: 50 },
      },
      inputs: [
        { id: 'in_0', name: '快线周期', defval: 20, type: 'integer', min: 1, max: 5000 },
        { id: 'in_1', name: '慢线周期', defval: 50, type: 'integer', min: 1, max: 5000 },
      ],
    } as never,
    constructor: function (this: Record<string, unknown>) {
      this.init = function (this: Record<string, unknown>, ctx: IContext, inputs: Inputs) {
        this._context = ctx;
        this._input = inputs;
      };
      this.main = function (this: Record<string, unknown>, ctx: IContext, inputs: Inputs) {
        this._context = ctx;
        this._input = inputs;
        const close = ctx.new_var(PineJS.Std.close(ctx));
        const fast = PineJS.Std.ema(close, Number(inputs(0)), ctx);
        const slow = PineJS.Std.ema(close, Number(inputs(1)), ctx);
        return [fast, slow];
      };
    } as never,
  };

  const sessionsPlots = Array.from({ length: PLOT_COUNT }, (_, index) => ({
    id: `plot_${index}`,
    type: 'line',
  }));

  const sessionsStyles: Record<string, unknown> = {};
  sessionsPlots.forEach((plot, index) => {
    sessionsStyles[plot.id] = {
      plottype: 2,
      linestyle: PLOT_LINESTYLES[index] ?? 0,
      linewidth: 1,
      trackprice: false,
      transparency: 0,
      visible: true,
      color: PLOT_COLORS[index] ?? '#787B86',
    };
  });

  const sessionsInputs = [
    ...SESSION_DEFS.map((session, index) => ({
      id: `in_${index}`,
      name: `显示${session.label}时段`,
      defval: true,
      type: 'bool',
    })),
    { id: 'in_5', name: '显示时段中线', defval: true, type: 'bool' },
    { id: 'in_6', name: `显示 ${KEY_OPEN_DEFS[0].label}线`, defval: true, type: 'bool' },
    { id: 'in_7', name: `显示 ${KEY_OPEN_DEFS[1].label}线`, defval: true, type: 'bool' },
    { id: 'in_8', name: `显示 ${KEY_OPEN_DEFS[2].label}线`, defval: true, type: 'bool' },
    { id: 'in_9', name: '显示昨日高/低/中', defval: true, type: 'bool' },
    { id: 'in_10', name: '日线分界（纽约时）', defval: 18, type: 'integer', min: 0, max: 23 },
  ];
  const sessionsInputDefaults: Record<string, boolean | number> = {};
  for (const input of sessionsInputs) sessionsInputDefaults[input.id] = input.defval;

  const proSessions: CustomIndicator = {
    name: 'MT 专业交易时段与关键位',
    metainfo: {
      _metainfoVersion: 53,
      id: 'mt-pro-sessions@tv-basicstudies-1',
      scriptId: 'mt-pro-sessions',
      name: 'mt-pro-sessions',
      description: PRO_STUDY_DESCRIPTION,
      shortDescription: '专业时段',
      is_price_study: true,
      isCustomIndicator: true,
      is_hidden_study: false,
      format: PRICE_FORMAT,
      plots: sessionsPlots,
      defaults: {
        styles: sessionsStyles,
        inputs: sessionsInputDefaults,
        // 21 条线如果都在价格轴显示最后值会挤满刻度，图例也只需要标题
        showLabelsOnPriceScale: false,
        showLegendValues: false,
      },
      inputs: sessionsInputs,
    } as never,
    constructor: function (this: Record<string, unknown>) {
      let state = freshLevelsState();
      this.init = function (this: Record<string, unknown>, _ctx: IContext, inputs: Inputs) {
        state = freshLevelsState();
        state.signature = inputSignature(inputs);
      };
      this.main = function (this: Record<string, unknown>, ctx: IContext, inputs: Inputs) {
        const values: number[] = new Array(PLOT_COUNT).fill(Number.NaN);
        if (!PineJS.Std.isintraday(ctx)) return values;

        const raw = PineJS.Std.time(ctx);
        if (!Number.isFinite(raw)) return values;
        // 库内部的时间戳可能是毫秒，统一成秒；再扣掉券商服务器时差得到 UTC
        const time = (raw > 1e11 ? raw / 1000 : raw) - chartServerOffset();

        const signature = inputSignature(inputs);
        if (
          signature !== state.signature ||
          (Number.isFinite(state.lastTime) && time < state.lastTime)
        ) {
          // 修改输入或重新计算历史时，从头开始统计
          state = freshLevelsState();
          state.signature = signature;
        }
        state.lastTime = time;

        const wall = nyWall(time);
        const minutes = wall.hour * 60 + wall.minute;
        const calKey = calendarKey(wall);
        const boundary = Math.max(0, Math.min(23, Math.round(Number(inputs(10)))));
        const dayKey = tradingDayKey(wall, boundary);

        const high = PineJS.Std.high(ctx);
        const low = PineJS.Std.low(ctx);
        const open = PineJS.Std.open(ctx);

        // 关键开盘位按纽约日历日重置：当天第一根 bar 的 open 即 00:00 开盘
        if (calKey !== state.calKey) {
          state.calKey = calKey;
          state.midnightOpen = open;
          state.preOpen = Number.NaN;
          state.openOpen = Number.NaN;
          state.gotPre = false;
          state.gotOpen = false;
        }
        if (!state.gotPre && minutes >= KEY_OPEN_TIMES[1]) {
          state.preOpen = open;
          state.gotPre = true;
        }
        if (!state.gotOpen && minutes >= KEY_OPEN_TIMES[2]) {
          state.openOpen = open;
          state.gotOpen = true;
        }

        // 昨日高/低/中：按交易日分界滚动
        if (dayKey !== state.dayKey) {
          if (state.dayKey !== '') {
            state.prevHigh = state.dayHigh;
            state.prevLow = state.dayLow;
          }
          state.dayKey = dayKey;
          state.dayHigh = high;
          state.dayLow = low;
        } else {
          state.dayHigh = Math.max(state.dayHigh, high);
          state.dayLow = Math.min(state.dayLow, low);
        }

        if (Boolean(inputs(6))) values[KEY_OPENS_START] = state.midnightOpen;
        if (Boolean(inputs(7)) && state.gotPre) values[KEY_OPENS_START + 1] = state.preOpen;
        if (Boolean(inputs(8)) && state.gotOpen) values[KEY_OPENS_START + 2] = state.openOpen;

        if (
          Boolean(inputs(9)) &&
          Number.isFinite(state.prevHigh) &&
          Number.isFinite(state.prevLow)
        ) {
          values[PD_START] = state.prevHigh;
          values[PD_START + 1] = state.prevLow;
          values[PD_START + 2] = (state.prevHigh + state.prevLow) / 2;
        }

        return values;
      };
    } as never,
  };

  // 用户保存的 Pine 脚本（实验）：元信息在图表创建时从 localStorage 生成
  return Promise.resolve([emaRibbon, proSessions, ...pineIndicators(PineJS, pineContextId)]);
}
