import { create } from 'zustand';
import type { Bar, SymbolInfo } from '../gateway/types';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import { readCachedBars, mergeBars, writeCachedBars } from './cache';
import { generateDemoBars } from './demo';
import {
  accountSummary,
  calculateStats,
  cancelOrder as cancelEngineOrder,
  closePositionNow,
  finishAll,
  replayId,
  roundPrice,
  roundVolume,
  setOrderPrice as setEngineOrderPrice,
  setPositionStops as setEngineStops,
  stepSession,
} from './engine';
import { dropReplaySource, hasReplayBars, replayBars, setReplayBars, sourceFor } from './source';
import type {
  ReplayDataSource,
  ReplayNote,
  ReplayOrder,
  ReplaySession,
  ReplaySettings,
} from './types';
import type { OrderType, Side, TemplateStep } from '../gateway/types';

/** 会话开始前额外载入的 M1，用于指标预热 */
const WARMUP_BARS = 1000;
const SESSION_KEY = 'mytrade.replay.sessions';
const CURVE_POINTS = 1200;
const CHUNK = 5000;

export interface NewSessionInput {
  name: string;
  symbol: string;
  symbolInfo: SymbolInfo;
  startTs: number;
  endTs: number;
  settings: ReplaySettings;
}

export interface OrderInput {
  side: Side;
  type: OrderType;
  volume: number;
  price: number;
  sl: number | null;
  tp: number | null;
  tag: string;
  /** 启用下单模板时随订单保存，成交后由引擎按 R 执行 */
  steps?: TemplateStep[];
  templateName?: string;
}

export interface ReplayLoading {
  id: string;
  progress: number;
  message: string;
}

type Speed = 1 | 2 | 5 | 10 | 30;

interface ReplayStore {
  sessions: ReplaySession[];
  activeId: string | null;
  loading: ReplayLoading | null;
  playing: boolean;
  speed: Speed;
  follow: boolean;
  /** 重新开始时递增，用来重建图表 */
  revision: number;
  lastEvent: string | null;

  createSession: (input: NewSessionInput) => string;
  loadSession: (id: string) => Promise<void>;
  setActive: (id: string | null) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  setSpeed: (speed: Speed) => void;
  setFollow: (follow: boolean) => void;
  step: (count?: number) => void;
  restart: () => void;
  finish: () => void;
  archive: (id: string) => void;
  remove: (id: string) => void;
  rename: (id: string, name: string) => void;
  duplicateSession: (id: string) => string | null;
  submitOrder: (input: OrderInput) => string | null;
  closePosition: (positionId: string, volume?: number) => void;
  modifyStops: (positionId: string, patch: { sl?: number | null; tp?: number | null }) => void;
  modifyOrder: (orderId: string, price: number) => void;
  cancelOrder: (orderId: string) => void;
  addNote: (text: string, tag: string) => void;
  removeNote: (noteId: string) => void;
  setLastEvent: (text: string | null) => void;
}

// ---------------------------------------------------------------- 持久化

function downsampleCurve(session: ReplaySession): ReplaySession {
  if (session.equityCurve.length <= CURVE_POINTS) return session;
  const step = Math.ceil(session.equityCurve.length / CURVE_POINTS);
  const curve = session.equityCurve.filter(
    (_, index) => index === 0 || index === session.equityCurve.length - 1 || index % step === 0,
  );
  return { ...session, equityCurve: curve };
}

function saveSessions(sessions: ReplaySession[]): void {
  try {
    window.localStorage.setItem(
      SESSION_KEY,
      JSON.stringify(sessions.slice(0, 60).map(downsampleCurve)),
    );
  } catch {
    /* 本地存储满了不影响回放；下一次保存再试 */
  }
}

function isSession(value: unknown): value is ReplaySession {
  const item = value as Partial<ReplaySession> | null;
  return (
    !!item &&
    typeof item.id === 'string' &&
    typeof item.symbol === 'string' &&
    typeof item.startTs === 'number' &&
    typeof item.endTs === 'number' &&
    !!item.settings &&
    !!item.symbolInfo
  );
}

function loadSessions(): ReplaySession[] {
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSession).map((session) => ({
      ...session,
      status:
        session.status === 'running' || session.status === 'preparing'
          ? 'paused'
          : session.status,
      equityCurve: Array.isArray(session.equityCurve) ? session.equityCurve : [],
      orders: Array.isArray(session.orders) ? session.orders : [],
      positions: Array.isArray(session.positions) ? session.positions : [],
      trades: Array.isArray(session.trades) ? session.trades : [],
      notes: Array.isArray(session.notes) ? session.notes : [],
    }));
  } catch {
    return [];
  }
}

let persistTimer: number | null = null;
function schedulePersist(): void {
  if (persistTimer != null) return;
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    saveSessions(useReplay.getState().sessions);
  }, 3000);
}

function persistNow(): void {
  if (persistTimer != null) {
    window.clearTimeout(persistTimer);
    persistTimer = null;
  }
  saveSessions(useReplay.getState().sessions);
}

// ---------------------------------------------------------------- 行情加载

async function fetchGatewayM1(
  symbol: string,
  fromTs: number,
  toTs: number,
  onProgress: (progress: number) => void,
): Promise<Bar[]> {
  const chunks: Bar[][] = [];
  let cursor = toTs;
  let guard = 0;
  const span = Math.max(1, toTs - fromTs);
  while (cursor > fromTs && guard < 120) {
    guard += 1;
    const result = await gateway.call<{ bars: Bar[] }>(
      'history.get',
      { symbol, resolution: '1', count: CHUNK, to: cursor },
      20_000,
    );
    const got = result.bars.filter((bar) => bar.time <= cursor);
    if (!got.length) break;
    chunks.push(got);
    const first = got[0].time;
    onProgress(Math.min(0.96, 0.1 + ((toTs - first) / span) * 0.86));
    if (first <= fromTs || first >= cursor) break;
    // 下一次从这一根之前继续往左取
    cursor = first - 60;
  }
  return chunks.reverse().flat();
}

// ---------------------------------------------------------------- 播放循环

let playTimer: number | null = null;
let lastFrame = 0;
let acc = 0;

function stopPlayTimer(): void {
  if (playTimer != null) {
    window.clearInterval(playTimer);
    playTimer = null;
  }
  lastFrame = 0;
  acc = 0;
}

function startPlayTimer(): void {
  if (playTimer != null) return;
  lastFrame = performance.now();
  acc = 0;
  playTimer = window.setInterval(() => {
    const state = useReplay.getState();
    if (!state.playing || !state.activeId) {
      stopPlayTimer();
      return;
    }
    const now = performance.now();
    const elapsed = Math.min((now - lastFrame) / 1000, 1);
    lastFrame = now;
    acc += elapsed * state.speed;
    const count = Math.floor(acc);
    if (count <= 0) return;
    acc -= count;
    state.step(count);
  }, 120);
}

// ---------------------------------------------------------------- 内部工具

function sessionById(sessions: ReplaySession[], id: string | null): ReplaySession | undefined {
  return id ? sessions.find((item) => item.id === id) : undefined;
}

function endIndex(session: ReplaySession): number {
  return session.startIndex + session.totalBars;
}

export function currentBar(session: ReplaySession): Bar | null {
  const bars = replayBars(session.id);
  return bars[session.cursorIndex - 1] ?? null;
}

/** 游标处的参考价（最后一根已揭示 K 线的收盘），没有就退到预热段 */
export function lastPrice(session: ReplaySession): number {
  const bar = currentBar(session);
  if (bar) return bar.close;
  const bars = replayBars(session.id);
  return bars[session.startIndex]?.open ?? bars[bars.length - 1]?.close ?? 0;
}

export function sessionProgress(session: ReplaySession): number {
  if (!session.totalBars) return 0;
  return Math.max(0, Math.min(1, (session.cursorIndex - session.startIndex) / session.totalBars));
}

export function sessionStats(session: ReplaySession) {
  return calculateStats(session);
}

export function sessionAccount(session: ReplaySession) {
  return accountSummary(session, lastPrice(session));
}

function finishInternal(session: ReplaySession): void {
  if (session.status === 'finished' || session.status === 'archived') return;
  const bars = replayBars(session.id);
  const bar =
    bars[session.cursorIndex - 1] ??
    bars[session.startIndex - 1] ??
    bars[bars.length - 1] ??
    null;
  if (bar) finishAll(session, bar);
  else {
    session.status = 'finished';
    session.finishedAt = Date.now();
    session.orders = [];
    session.equity = session.balance;
    session.updatedAt = Date.now();
  }
}

// ---------------------------------------------------------------- store

export const useReplay = create<ReplayStore>((set, get) => ({
  sessions: loadSessions(),
  activeId: null,
  loading: null,
  playing: false,
  speed: 5,
  follow: true,
  revision: 0,
  lastEvent: null,

  createSession: (input) => {
    const id = replayId('replay');
    const now = Date.now();
    const session: ReplaySession = {
      id,
      name: input.name.trim() || `${input.symbol} · 复盘`,
      symbol: input.symbol,
      symbolInfo: input.symbolInfo,
      startTs: input.startTs,
      endTs: input.endTs,
      fetchStartTs: input.startTs - WARMUP_BARS * 60,
      settings: input.settings,
      status: 'preparing',
      dataSource: 'gateway',
      createdAt: now,
      updatedAt: now,
      startIndex: 0,
      cursorIndex: 0,
      totalBars: 0,
      cursorTs: input.startTs,
      balance: input.settings.initialBalance,
      equity: input.settings.initialBalance,
      peakEquity: input.settings.initialBalance,
      maxDrawdownPct: 0,
      equityCurve: [
        { t: input.startTs, v: input.settings.initialBalance, peak: input.settings.initialBalance },
      ],
      orders: [],
      positions: [],
      trades: [],
      notes: [],
    };
    set((state) => ({
      sessions: [session, ...state.sessions],
      activeId: id,
      playing: false,
      revision: state.revision + 1,
    }));
    persistNow();
    void get().loadSession(id);
    return id;
  },

  loadSession: async (id) => {
    const session = sessionById(get().sessions, id);
    if (!session) return;
    if (hasReplayBars(id)) {
      const bars = replayBars(id);
      const bar = bars[session.cursorIndex - 1];
      if (bar && session.cursorTs !== bar.time) {
        session.cursorTs = bar.time;
        set((state) => ({
          sessions: state.sessions.map((item) => (item.id === id ? { ...item } : item)),
        }));
        persistNow();
      }
      set({ loading: null });
      return;
    }
    set({ loading: { id, progress: 0.02, message: '读取本地缓存' } });
    const cached = await readCachedBars(session.symbol);
    let bars = cached;
    const covered =
      bars.length > 0 &&
      bars[0].time <= session.fetchStartTs + 300 &&
      bars[bars.length - 1].time >= session.endTs - 300;
    let dataSource: ReplayDataSource = 'gateway';

    if (!covered) {
      try {
        set({ loading: { id, progress: 0.08, message: '从网关读取 M1 行情' } });
        const fetched = await fetchGatewayM1(
          session.symbol,
          session.fetchStartTs,
          session.endTs,
          (progress) => {
            if (get().loading?.id === id) {
              set({ loading: { id, progress, message: '从网关读取 M1 行情' } });
            }
          },
        );
        if (fetched.length) {
          bars = mergeBars(bars, fetched);
          void writeCachedBars(session.symbol, fetched);
        }
      } catch {
        /* 网关离线时继续尝试缓存与演示数据 */
      }
    }

    let clipped = bars.filter(
      (bar) => bar.time >= session.fetchStartTs && bar.time <= session.endTs,
    );
    if (!clipped.length) {
      clipped = generateDemoBars(
        session.symbol,
        session.symbolInfo,
        session.fetchStartTs,
        session.endTs,
      );
      dataSource = 'demo';
    }

    if (!clipped.length) {
      const current = sessionById(get().sessions, id);
      if (current) {
        current.status = 'error';
        current.error = '这段区间没有可用行情';
      }
      set((state) => ({
        loading: null,
        sessions: state.sessions.map((item) => (item.id === id ? { ...item } : item)),
      }));
      persistNow();
      return;
    }

    let start = clipped.findIndex((bar) => bar.time >= session.startTs);
    if (start < 0) start = 0;
    let end = clipped.length - 1;
    while (end >= start && clipped[end].time > session.endTs) end -= 1;
    if (end < start) end = clipped.length - 1;

    setReplayBars(id, clipped);
    const current = sessionById(get().sessions, id);
    if (current) {
      const fresh = current.status === 'preparing' || current.cursorIndex <= 0;
      current.startIndex = start;
      current.totalBars = end - start + 1;
      current.dataSource = dataSource;
      current.error = undefined;
      current.updatedAt = Date.now();
      if (fresh) {
        current.cursorIndex = start;
        current.cursorTs = clipped[start]?.time ?? current.startTs;
        current.balance = current.settings.initialBalance;
        current.equity = current.settings.initialBalance;
        current.peakEquity = current.settings.initialBalance;
        current.maxDrawdownPct = 0;
        current.equityCurve = [
          {
            t: clipped[start]?.time ?? current.startTs,
            v: current.settings.initialBalance,
            peak: current.settings.initialBalance,
          },
        ];
        current.status = 'ready';
      } else {
        // 刷新或重新打开：保留已回放进度、持仓、成交与笔记，只补回行情
        current.cursorIndex = Math.min(Math.max(current.cursorIndex, start), end + 1);
        current.cursorTs =
          current.cursorTs ??
          clipped[current.cursorIndex - 1]?.time ??
          clipped[start]?.time ??
          current.startTs;
        current.status =
          current.status === 'archived'
            ? 'archived'
            : current.finishedAt
              ? 'finished'
              : 'paused';
      }
    }
    set((state) => ({
      loading: null,
      sessions: state.sessions.map((item) => (item.id === id ? { ...item } : item)),
    }));
    sourceFor(id).emit({ kind: 'reset' });
    persistNow();
    if (dataSource === 'demo') {
      useApp.getState().notify('info', '网关没有返回这段行情，已使用合成的演示数据');
    }
  },

  setActive: (activeId) => {
    stopPlayTimer();
    set((state) => ({
      activeId,
      playing: false,
      revision: state.revision + (activeId ? 1 : 0),
      lastEvent: null,
    }));
  },

  play: () => {
    const state = get();
    const session = sessionById(state.sessions, state.activeId);
    if (!session || session.status === 'finished' || session.status === 'archived') return;
    if (!hasReplayBars(session.id)) return;
    if (session.cursorIndex >= endIndex(session)) return;
    session.status = 'running';
    session.updatedAt = Date.now();
    set((current) => ({
      playing: true,
      sessions: current.sessions.map((item) =>
        item.id === session.id ? { ...item, status: 'running' } : item,
      ),
    }));
    startPlayTimer();
    schedulePersist();
  },

  pause: () => {
    stopPlayTimer();
    const session = sessionById(get().sessions, get().activeId);
    if (session && session.status === 'running') session.status = 'paused';
    set((state) => ({
      playing: false,
      sessions: state.sessions.map((item) =>
        session && item.id === session.id ? { ...item } : item,
      ),
    }));
    persistNow();
  },

  toggle: () => {
    if (get().playing) get().pause();
    else get().play();
  },

  setSpeed: (speed) => set({ speed }),

  setFollow: (follow) => set({ follow }),

  step: (count = 1) => {
    const state = get();
    const session = sessionById(state.sessions, state.activeId);
    if (!session) return;
    if (session.status === 'finished' || session.status === 'archived') return;
    const bars = replayBars(session.id);
    if (!bars.length) return;
    const end = endIndex(session);
    let last: Bar | null = null;
    const limit = Math.max(1, Math.floor(count));
    for (let index = 0; index < limit; index += 1) {
      if (session.cursorIndex >= end) break;
      const bar = bars[session.cursorIndex];
      if (!bar || bar.time > session.endTs) break;
      stepSession(session, bar);
      last = bar;
    }
    if (!last) {
      if (session.cursorIndex >= end) {
        session.cursorTs = bars[session.cursorIndex - 1]?.time ?? session.cursorTs;
        finishInternal(session);
        stopPlayTimer();
        set((current) => ({
          playing: false,
          sessions: current.sessions.map((item) =>
            item.id === session.id ? { ...item } : item,
          ),
        }));
        persistNow();
      }
      return;
    }
    session.cursorTs = last.time;
    const finished = session.cursorIndex >= end;
    const busted = !finished && session.equity <= 0;
    if (finished) {
      finishInternal(session);
      stopPlayTimer();
      useApp.getState().notify('info', '已到区间末尾，模拟持仓按最后价格平仓');
    } else if (busted) {
      // PRD：净值归零时不再继续，先让用户看清亏损
      session.status = 'paused';
      stopPlayTimer();
      useApp.getState().notify('error', '模拟账户已爆仓，回放已暂停');
    }
    set((current) => ({
      playing: finished || busted ? false : current.playing,
      sessions: current.sessions.map((item) => (item.id === session.id ? { ...item } : item)),
    }));
    sourceFor(session.id).emit({ kind: 'tick', bar: last, time: last.time });
    schedulePersist();
  },

  restart: () => {
    const session = sessionById(get().sessions, get().activeId);
    if (!session) return;
    stopPlayTimer();
    session.status = session.totalBars > 0 ? 'ready' : 'paused';
    session.cursorIndex = session.startIndex;
    session.cursorTs = replayBars(session.id)[session.startIndex]?.time ?? session.startTs;
    session.balance = session.settings.initialBalance;
    session.equity = session.settings.initialBalance;
    session.peakEquity = session.settings.initialBalance;
    session.maxDrawdownPct = 0;
    session.equityCurve = [
      {
        t: replayBars(session.id)[session.startIndex]?.time ?? session.startTs,
        v: session.settings.initialBalance,
        peak: session.settings.initialBalance,
      },
    ];
    session.orders = [];
    session.positions = [];
    session.trades = [];
    session.notes = [];
    session.finishedAt = undefined;
    session.updatedAt = Date.now();
    set((state) => ({
      playing: false,
      revision: state.revision + 1,
      lastEvent: null,
      sessions: state.sessions.map((item) => (item.id === session.id ? { ...item } : item)),
    }));
    sourceFor(session.id).emit({ kind: 'reset' });
    persistNow();
  },

  finish: () => {
    const session = sessionById(get().sessions, get().activeId);
    if (!session) return;
    stopPlayTimer();
    finishInternal(session);
    set((state) => ({
      playing: false,
      sessions: state.sessions.map((item) => (item.id === session.id ? { ...item } : item)),
    }));
    persistNow();
  },

  archive: (id) => {
    const session = sessionById(get().sessions, id);
    if (!session) return;
    session.status = 'archived';
    session.updatedAt = Date.now();
    set((state) => ({
      sessions: state.sessions.map((item) => (item.id === id ? { ...item } : item)),
    }));
    persistNow();
  },

  remove: (id) => {
    stopPlayTimer();
    dropReplaySource(id);
    set((state) => ({
      sessions: state.sessions.filter((item) => item.id !== id),
      activeId: state.activeId === id ? null : state.activeId,
      playing: state.activeId === id ? false : state.playing,
    }));
    persistNow();
  },

  rename: (id, name) => {
    const session = sessionById(get().sessions, id);
    if (!session) return;
    session.name = name.trim().slice(0, 40) || session.name;
    session.updatedAt = Date.now();
    set((state) => ({
      sessions: state.sessions.map((item) => (item.id === id ? { ...item } : item)),
    }));
    persistNow();
  },

  duplicateSession: (id) => {
    const source = sessionById(get().sessions, id);
    if (!source) return null;
    const newId = replayId('replay');
    const now = Date.now();
    const copy: ReplaySession = {
      ...source,
      id: newId,
      name: `${source.name.replace(/ · 重练\d*$/, '')} · 重练`,
      status: 'preparing',
      createdAt: now,
      updatedAt: now,
      startIndex: 0,
      cursorIndex: 0,
      totalBars: 0,
      cursorTs: source.startTs,
      balance: source.settings.initialBalance,
      equity: source.settings.initialBalance,
      peakEquity: source.settings.initialBalance,
      maxDrawdownPct: 0,
      equityCurve: [
        {
          t: source.startTs,
          v: source.settings.initialBalance,
          peak: source.settings.initialBalance,
        },
      ],
      orders: [],
      positions: [],
      trades: [],
      notes: [],
      error: undefined,
      finishedAt: undefined,
    };
    set((state) => ({
      sessions: [copy, ...state.sessions],
      activeId: newId,
      playing: false,
      revision: state.revision + 1,
    }));
    persistNow();
    void get().loadSession(newId);
    return newId;
  },

  submitOrder: (input) => {
    const session = sessionById(get().sessions, get().activeId);
    if (!session) return '没有打开的回放会话';
    if (session.status === 'finished' || session.status === 'archived') return '复盘已结束';
    if (session.status === 'preparing') return '行情还在准备中';
    const info = session.symbolInfo;
    const volume = roundVolume(input.volume, info);
    if (!(volume > 0)) return '手数无效';
    const spread = session.settings.spreadPoints * info.point;
    const bid = lastPrice(session);
    if (!(bid > 0)) return '还没有可用行情';
    const ask = bid + spread;
    const tick = info.tickSize || info.point || 1e-9;
    const tol = tick / 2;

    let price = 0;
    if (input.type === 'market') {
      price = input.side === 'buy' ? ask : bid;
    } else {
      price = roundPrice(input.price, info);
      if (!(price > 0)) return '请填写委托价';
      if (input.type === 'limit') {
        if (input.side === 'buy' && price >= ask - tol) return '买入限价需要低于当前卖出价';
        if (input.side === 'sell' && price <= bid + tol) return '卖出限价需要高于当前买入价';
      } else {
        if (input.side === 'buy' && price <= ask + tol) return '买入停损需要高于当前卖出价';
        if (input.side === 'sell' && price >= bid - tol) return '卖出停损需要低于当前买入价';
      }
    }

    const sl = input.sl != null ? roundPrice(input.sl, info) : null;
    const tp = input.tp != null ? roundPrice(input.tp, info) : null;
    if (sl != null) {
      if (input.side === 'buy' && sl >= price - tol) return '多头止损需要低于入场价';
      if (input.side === 'sell' && sl <= price + tol) return '空头止损需要高于入场价';
    }
    if (tp != null) {
      if (input.side === 'buy' && tp <= price + tol) return '多头止盈需要高于入场价';
      if (input.side === 'sell' && tp >= price - tol) return '空头止盈需要低于入场价';
    }

    const order: ReplayOrder = {
      id: replayId('order'),
      side: input.side,
      type: input.type,
      volume,
      price,
      sl,
      tp,
      tag: input.tag.trim().slice(0, 16),
      createdAt: Date.now(),
      atNextOpen: true,
      steps: input.steps?.map((step) => ({ ...step })),
      templateName: input.templateName,
    };
    session.orders.push(order);
    session.updatedAt = Date.now();
    set((state) => ({
      sessions: state.sessions.map((item) =>
        item.id === session.id ? { ...item } : item,
      ),
    }));
    persistNow();
    useApp
      .getState()
      .notify(
        'success',
        input.type === 'market'
          ? `模拟${input.side === 'buy' ? '买入' : '卖出'}已提交，下一根 M1 开盘成交`
          : '模拟挂单已提交，等待价格触发',
      );
    return null;
  },

  closePosition: (positionId, volume) => {
    const session = sessionById(get().sessions, get().activeId);
    if (!session) return;
    const bar = currentBar(session) ?? replayBars(session.id)[session.startIndex - 1];
    if (!bar) return;
    const position = session.positions.find((item) => item.id === positionId);
    if (!position) return;
    closePositionNow(session, positionId, volume ?? position.volume, bar, 'manual');
    session.updatedAt = Date.now();
    set((state) => ({
      sessions: state.sessions.map((item) => (item.id === session.id ? { ...item } : item)),
    }));
    persistNow();
  },

  modifyStops: (positionId, patch) => {
    const session = sessionById(get().sessions, get().activeId);
    if (!session) return;
    const info = session.symbolInfo;
    const next: { sl?: number | null; tp?: number | null } = {};
    if (patch.sl !== undefined) next.sl = patch.sl == null ? null : roundPrice(patch.sl, info);
    if (patch.tp !== undefined) next.tp = patch.tp == null ? null : roundPrice(patch.tp, info);
    setEngineStops(session, positionId, next);
    set((state) => ({
      sessions: state.sessions.map((item) => (item.id === session.id ? { ...item } : item)),
    }));
    persistNow();
  },

  modifyOrder: (orderId, price) => {
    const session = sessionById(get().sessions, get().activeId);
    if (!session) return;
    setEngineOrderPrice(session, orderId, roundPrice(price, session.symbolInfo));
    set((state) => ({
      sessions: state.sessions.map((item) => (item.id === session.id ? { ...item } : item)),
    }));
    persistNow();
  },

  cancelOrder: (orderId) => {
    const session = sessionById(get().sessions, get().activeId);
    if (!session) return;
    cancelEngineOrder(session, orderId);
    set((state) => ({
      sessions: state.sessions.map((item) => (item.id === session.id ? { ...item } : item)),
    }));
    persistNow();
  },

  addNote: (text, tag) => {
    const session = sessionById(get().sessions, get().activeId);
    if (!session) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const bar = currentBar(session);
    const note: ReplayNote = {
      id: replayId('note'),
      time: bar ? bar.time + 60 : session.startTs,
      text: trimmed.slice(0, 240),
      tag: tag.trim().slice(0, 16),
    };
    session.notes.push(note);
    session.updatedAt = Date.now();
    set((state) => ({
      sessions: state.sessions.map((item) => (item.id === session.id ? { ...item } : item)),
    }));
    persistNow();
  },

  removeNote: (noteId) => {
    const session = sessionById(get().sessions, get().activeId);
    if (!session) return;
    session.notes = session.notes.filter((note) => note.id !== noteId);
    session.updatedAt = Date.now();
    set((state) => ({
      sessions: state.sessions.map((item) => (item.id === session.id ? { ...item } : item)),
    }));
    persistNow();
  },

  setLastEvent: (lastEvent) => set({ lastEvent }),
}));

/** 会话 id 的简易选择器，避免每个组件都重复 find */
export function useReplaySession(id: string | null): ReplaySession | undefined {
  return useReplay((state) => (id ? state.sessions.find((item) => item.id === id) : undefined));
}
