import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, JournalRecord } from '../gateway/types';
import {
  buildReferenceInput,
  findReferenceSession,
  holdingRange,
  referenceFromRecord,
  referenceKey,
  referenceVisible,
  referenceWindow,
  retryTiming,
} from './reference';
import { GOLD_INFO, makeBar, makeSession } from './testUtils';
import type { ReplayReference, ReplaySession } from './types';

const OPEN = 1_700_000_000;

function record(overrides: Partial<JournalRecord> = {}): JournalRecord {
  return {
    login: 123456,
    position_id: 789,
    symbol: 'XAUUSD',
    side: 'buy',
    volume: 0.1,
    entry_price: 2000,
    exit_price: 2010,
    profit: 100,
    swap: 0,
    commission: -1,
    open_time: OPEN,
    close_time: OPEN + 1800,
    duration_sec: 1800,
    mfe: 150,
    mae: -20,
    tag: '突破',
    closed_by: 'manual',
    sl: 1995,
    tp: null,
    risk: 50,
    risk_source: 'sl',
    has_shot: 1,
    recorded_at: OPEN + 1900,
    ...overrides,
  };
}

function reference(overrides: Partial<ReplayReference> = {}): ReplayReference {
  return {
    ...referenceFromRecord(record()),
    ...overrides,
  };
}

const account: Account = {
  login: 123456,
  server: 'Demo',
  company: 'Demo Broker',
  name: 'Test',
  currency: 'CAD',
  leverage: 200,
  balance: 5000,
  equity: 5000,
  margin: 0,
  freeMargin: 5000,
  marginLevel: null,
  marginMode: 'hedging',
  tradeAllowed: true,
  accountType: 'demo',
};

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.resetModules();
});

describe('referenceWindow', () => {
  it('开仓前 30 分钟到平仓后 30 分钟', () => {
    expect(referenceWindow(OPEN, OPEN + 3600)).toEqual({
      startTs: OPEN - 1800,
      endTs: OPEN + 3600 + 1800,
    });
  });

  it('不足 60 分钟的交易至少给 60 分钟', () => {
    expect(referenceWindow(OPEN, OPEN + 120)).toEqual({
      startTs: OPEN - 1800,
      endTs: OPEN + 3600,
    });
  });
});

describe('referenceFromRecord', () => {
  it('带初始风险时折成 R，并生成 login:position 去重键', () => {
    const ref = referenceFromRecord(record());
    expect(ref.key).toBe('123456:789');
    expect(ref.r).toBe(2);
    expect(ref.openTs).toBe(OPEN);
    expect(ref.hasShot).toBe(true);
    expect(ref.closedBy).toBe('manual');
  });

  it('没有初始风险时 R 为空', () => {
    const ref = referenceFromRecord(record({ risk: null, has_shot: 0 }));
    expect(ref.r).toBeNull();
    expect(ref.hasShot).toBe(false);
  });
});

describe('findReferenceSession', () => {
  it('按 key 去重，取最新的未归档会话', () => {
    const key = referenceKey(123456, 789);
    const older = makeSession({
      id: 'older',
      createdAt: 100,
      reference: reference(),
    });
    const newer = makeSession({
      id: 'newer',
      createdAt: 200,
      reference: reference(),
    });
    const other = makeSession({
      id: 'other',
      createdAt: 300,
      reference: reference({ key: '123456:790' }),
    });
    const archived = makeSession({
      id: 'archived',
      createdAt: 400,
      status: 'archived',
      reference: reference(),
    });
    expect(findReferenceSession([older, newer, other, archived], key)?.id).toBe('newer');
  });

  it('没有匹配时返回 undefined', () => {
    expect(findReferenceSession([makeSession()], '123456:789')).toBeUndefined();
  });
});

describe('referenceVisible', () => {
  it('普通会话默认显示参照层', () => {
    expect(referenceVisible(makeSession())).toBe(true);
  });

  it('demo 数据默认隐藏，用户手动设置后以保存值为准', () => {
    expect(referenceVisible(makeSession({ dataSource: 'demo' }))).toBe(false);
    expect(referenceVisible(makeSession({ dataSource: 'demo', referenceVisible: true }))).toBe(
      true,
    );
  });
});

describe('buildReferenceInput', () => {
  it('按账户资金、币种与品种点差生成会话参数', () => {
    const input = buildReferenceInput(record(), GOLD_INFO, account, 0.8);
    expect(input.name).toBe('XAUUSD 实盘复盘 #789');
    expect(input.origin).toBe('journal');
    expect(input.referenceVisible).toBe(true);
    expect(input.reference?.key).toBe('123456:789');
    expect(input.settings.initialBalance).toBe(5000);
    expect(input.settings.currency).toBe('CAD');
    expect(input.settings.spreadPoints).toBe(GOLD_INFO.spreadPoints);
    expect(input.settings.riskPercent).toBe(0.8);
    expect(input.settings.commissionPerLot).toBe(0);
    expect(input.startTs).toBe(OPEN - 1800);
    expect(input.endTs).toBe(OPEN + 1800 + 1800);
  });

  it('账户不可用时退回 10000 / USD', () => {
    const input = buildReferenceInput(record({ risk: null }), GOLD_INFO, null, undefined);
    expect(input.settings.initialBalance).toBe(10_000);
    expect(input.settings.currency).toBe('USD');
    expect(input.settings.riskPercent).toBe(0.5);
  });
});

describe('holdingRange', () => {
  it('只统计开仓到游标之间的 K 线', () => {
    const bars = [
      makeBar(OPEN - 60, 1900, 2100, 1800, 2000),
      makeBar(OPEN, 2000, 2005, 1998, 2002),
      makeBar(OPEN + 60, 2002, 2012, 2001, 2010),
      makeBar(OPEN + 120, 2010, 2020, 2005, 2015),
    ];
    expect(holdingRange(bars, OPEN, OPEN + 60, 2000)).toEqual({ high: 2012, low: 1998 });
  });

  it('还没有持仓 K 线时返回 null', () => {
    const bars = [makeBar(OPEN - 60, 1900, 2100, 1800, 2000)];
    expect(holdingRange(bars, OPEN, OPEN - 60, 2000)).toBeNull();
  });
});

describe('retryTiming', () => {
  it('游标在开仓前需要跳转', () => {
    expect(retryTiming(reference(), OPEN - 600)).toEqual({
      needsSeek: true,
      lateMinutes: 0,
    });
  });

  it('游标已过开仓时给出晚到的分钟数', () => {
    expect(retryTiming(reference(), OPEN + 300)).toEqual({
      needsSeek: false,
      lateMinutes: 5,
    });
  });
});

describe('旧版本会话兼容', () => {
  it('没有 origin / reference 的会话仍能加载，并视为普通会话', async () => {
    const legacy: ReplaySession = makeSession({ id: 'legacy-session' });
    delete legacy.origin;
    delete legacy.reference;
    delete legacy.referenceVisible;
    window.localStorage.setItem('mytrade.replay.sessions', JSON.stringify([legacy]));

    vi.resetModules();
    const { useReplay } = await import('./store');
    const loaded = useReplay.getState().sessions;
    expect(loaded).toHaveLength(1);
    expect(loaded[0].reference).toBeUndefined();
    expect(referenceVisible(loaded[0])).toBe(true);
  });
});
