import type { Bar, SymbolInfo } from '../gateway/types';
import type { ReplayOrder, ReplaySession, ReplaySettings } from './types';

/** 黄金的品种规格：2 位报价、0.01 点、1 手 = 100 盎司、每 tick 1 美元 */
export const GOLD_INFO: SymbolInfo = {
  name: 'XAUUSD',
  description: 'Gold vs US Dollar',
  digits: 2,
  point: 0.01,
  tickSize: 0.01,
  tickValue: 1,
  contractSize: 100,
  minVolume: 0.01,
  maxVolume: 100,
  volumeStep: 0.01,
  stopsLevelPoints: 0,
  freezeLevelPoints: 0,
  spreadPoints: 20,
  tradeMode: 4,
  fillingMode: 1,
  visible: true,
  currency: 'USD',
  marginMode: 'hedging',
};

export function makeSettings(overrides: Partial<ReplaySettings> = {}): ReplaySettings {
  return {
    initialBalance: 10_000,
    currency: 'USD',
    leverage: 100,
    spreadPoints: 20,
    commissionPerLot: 5,
    timeframe: '15',
    riskPercent: 0.5,
    ...overrides,
  };
}

export function makeBar(
  time: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 100,
): Bar {
  return { time, open, high, low, close, volume };
}

let orderSeq = 0;
export function makeOrder(overrides: Partial<ReplayOrder> = {}): ReplayOrder {
  orderSeq += 1;
  return {
    id: `order-${orderSeq}`,
    side: 'buy',
    type: 'market',
    volume: 1,
    price: 0,
    sl: null,
    tp: null,
    tag: '',
    createdAt: 0,
    atNextOpen: true,
    ...overrides,
  };
}

let sessionSeq = 0;
export function makeSession(overrides: Partial<ReplaySession> = {}): ReplaySession {
  sessionSeq += 1;
  const startTs = 1_700_000_000;
  const settings = overrides.settings ?? makeSettings();
  return {
    id: `test-session-${sessionSeq}`,
    name: '测试复盘',
    symbol: 'XAUUSD',
    symbolInfo: GOLD_INFO,
    startTs,
    endTs: startTs + 100 * 60,
    fetchStartTs: startTs - 600,
    settings,
    status: 'ready',
    dataSource: 'gateway',
    createdAt: 0,
    updatedAt: 0,
    startIndex: 0,
    cursorIndex: 0,
    totalBars: 100,
    cursorTs: startTs,
    balance: settings.initialBalance,
    equity: settings.initialBalance,
    peakEquity: settings.initialBalance,
    maxDrawdownPct: 0,
    equityCurve: [{ t: startTs, v: settings.initialBalance, peak: settings.initialBalance }],
    orders: [],
    positions: [],
    trades: [],
    notes: [],
    ...overrides,
  };
}
