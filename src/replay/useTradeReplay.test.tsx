import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gateway } from '../gateway/client';
import type { Account, JournalRecord } from '../gateway/types';
import { useApp } from '../store/useApp';
import { getReplayBack } from './back';
import { SESSION_SOFT_LIMIT, useReplay } from './store';
import { GOLD_INFO, makeSession } from './testUtils';
import { useTradeReplay } from './useTradeReplay';

const OPEN_TS = 1_763_190_000;
const CLOSE_TS = OPEN_TS + 3600;

const RECORD: JournalRecord = {
  login: 1,
  position_id: 9,
  symbol: 'XAUUSD',
  side: 'buy',
  volume: 0.1,
  entry_price: 2000,
  exit_price: 2010,
  profit: 100,
  swap: 0,
  commission: 0,
  open_time: OPEN_TS,
  close_time: CLOSE_TS,
  duration_sec: 3600,
  mfe: 120,
  mae: -20,
  tag: null,
  closed_by: 'tp',
  sl: 1990,
  tp: 2010,
  risk: 100,
  risk_source: 'intent',
  has_shot: 0,
  recorded_at: CLOSE_TS + 60,
};

const ACCOUNT = {
  login: 1,
  server: 'S1',
  company: 'Broker',
  name: 'Demo',
  currency: 'USD',
  leverage: 100,
  balance: 10_000,
  equity: 10_000,
  margin: 0,
  freeMargin: 10_000,
  marginLevel: null,
} as Account;

function mockGateway() {
  return vi.spyOn(gateway, 'call').mockImplementation((async (method: string) => {
    if (method === 'executions.get') return [];
    if (method === 'history.get') return { bars: [] };
    if (method === 'replay.save') return { saved: true };
    return {};
  }) as typeof gateway.call);
}

function setup(symbols = [GOLD_INFO]) {
  useApp.setState({ page: 'journal', symbols, account: ACCOUNT, toast: null });
  useReplay.setState({ sessions: [], activeId: null, hydrated: true, storageMode: 'local' });
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
}

beforeEach(() => {
  vi.restoreAllMocks();
  setup();
  mockGateway();
});

describe('useTradeReplay.start', () => {
  it('没有同 key 会话时新建参照会话并记住返回来源', () => {
    const { result } = renderHook(() => useTradeReplay());

    expect(result.current.start(RECORD)).toBe('opened');

    const state = useReplay.getState();
    const session = state.sessions[0];
    expect(state.sessions).toHaveLength(1);
    expect(session.name).toBe('XAUUSD 实盘复盘 #9');
    expect(session.origin).toBe('journal');
    expect(session.reference?.key).toBe('1:9');
    // 开仓前 30 分钟 → 平仓后 30 分钟
    expect(session.startTs).toBe(OPEN_TS - 1800);
    expect(session.endTs).toBe(CLOSE_TS + 1800);
    expect(session.settings.initialBalance).toBe(10_000);
    expect(window.location.hash).toBe(`#/replay/${session.id}`);
    expect(getReplayBack()).toEqual({ page: 'journal', positionId: 9, label: '交易日志' });
  });

  it('已有同 key 会话时直接打开，不再新建', () => {
    const existing = makeSession({
      id: 'rp-existing',
      status: 'ready',
      createdAt: 1_000,
      reference: {
        kind: 'journal',
        login: 1,
        positionId: 9,
        symbol: 'XAUUSD',
        openTs: OPEN_TS,
        closeTs: CLOSE_TS,
        side: 'buy',
        volume: 0.1,
        entry: 2000,
        exit: 2010,
        sl: 1990,
        tp: 2010,
        profit: 100,
        r: 1,
        mfe: 120,
        mae: -20,
        tag: null,
        closedBy: 'tp',
        hasShot: false,
        key: '1:9',
      },
    });
    useReplay.setState({ sessions: [existing] });
    useApp.setState({ page: 'diary' });
    const { result } = renderHook(() => useTradeReplay());

    expect(result.current.start(RECORD)).toBe('opened');

    expect(useReplay.getState().sessions).toHaveLength(1);
    expect(window.location.hash).toBe('#/replay/rp-existing');
    expect(getReplayBack()?.page).toBe('diary');
    expect(getReplayBack()?.label).toBe('盈亏日历');
  });

  it('行情列表没加载时提示并返回 failed', () => {
    useApp.setState({ symbols: [] });
    const { result } = renderHook(() => useTradeReplay());

    expect(result.current.start(RECORD)).toBe('failed');

    expect(useReplay.getState().sessions).toHaveLength(0);
    expect(useApp.getState().toast?.text).toContain('行情列表还没加载');
    expect(getReplayBack()).toBeNull();
  });

  it('终端没有该品种时提示并返回 failed', () => {
    useApp.setState({ symbols: [GOLD_INFO] });
    const { result } = renderHook(() => useTradeReplay());

    expect(result.current.start({ ...RECORD, symbol: 'EURUSD' })).toBe('failed');

    expect(useReplay.getState().sessions).toHaveLength(0);
    expect(useApp.getState().toast?.text).toContain('没有 EURUSD');
  });

  it('会话数超过软上限时仍创建，只提示建议归档', () => {
    const sessions = Array.from({ length: SESSION_SOFT_LIMIT }, (_, index) =>
      makeSession({ id: `rp-${index}`, createdAt: index }),
    );
    useReplay.setState({ sessions });
    const { result } = renderHook(() => useTradeReplay());

    expect(result.current.start(RECORD)).toBe('opened');

    expect(useReplay.getState().sessions).toHaveLength(SESSION_SOFT_LIMIT + 1);
    expect(useApp.getState().toast?.text).toContain('建议在列表里归档旧会话');
  });
});

describe('useTradeReplay.startWindow', () => {
  const anchorTs = 1_763_200_000;

  it('从错过机会开一段窗口回放，锚点前后各留观察时间', () => {
    const { result } = renderHook(() => useTradeReplay());

    expect(
      result.current.startWindow({ symbol: 'XAUUSD', anchorTs, label: '突破 2000' }),
    ).toBe('opened');

    const session = useReplay.getState().sessions[0];
    expect(session.name).toBe('XAUUSD · 错过的机会 突破 2000');
    expect(session.origin).toBe('missed');
    expect(session.startTs).toBe(anchorTs - 30 * 60);
    expect(session.endTs).toBe(anchorTs + 120 * 60);
    expect(window.location.hash).toBe(`#/replay/${session.id}`);
    expect(getReplayBack()).toEqual({ page: 'missed', label: '错过的机会' });
  });

  it('品种不在终端时提示并返回 failed', () => {
    const { result } = renderHook(() => useTradeReplay());

    expect(
      result.current.startWindow({ symbol: 'EURUSD', anchorTs, label: '反弹' }),
    ).toBe('failed');

    expect(useReplay.getState().sessions).toHaveLength(0);
    expect(useApp.getState().toast?.text).toContain('没有 EURUSD');
  });
});
