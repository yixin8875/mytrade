import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import type { JournalRecord, JournalStats } from '../gateway/types';
import { JournalView } from './Journal';

// 详情弹窗默认页签会挂实时图表；这里只验证弹窗路由与截图页签，用桩替代图表
vi.mock('../components/TradeChart', () => ({
  TradeChart: () => <div>CHART-STUB</div>,
}));

function makeRecord(
  positionId: number,
  overrides: Partial<JournalRecord> = {},
): JournalRecord {
  return {
    login: 12345,
    position_id: positionId,
    symbol: 'XAUUSD',
    side: 'buy',
    volume: 0.1,
    entry_price: 3950,
    exit_price: 3960,
    profit: 120.5,
    swap: 0,
    commission: 0,
    open_time: 1763200000,
    close_time: 1763203600,
    duration_sec: 3600,
    mfe: 130,
    mae: -20,
    tag: '突破',
    closed_by: 'manual',
    sl: 3940,
    tp: 3980,
    risk: 50,
    risk_source: 'order',
    server_offset: 0,
    reviewed_at: null,
    has_shot: 0,
    recorded_at: 1763203600,
    ...overrides,
  };
}

const RECORDS: JournalRecord[] = [
  makeRecord(101, { has_shot: 1 }),
  makeRecord(102, {
    symbol: 'EURUSD',
    side: 'sell',
    entry_price: 1.1,
    exit_price: 1.09,
    profit: -30,
    tag: null,
    risk: 20,
    has_shot: 0,
  }),
];

const STATS: JournalStats = {
  days: 30,
  summary: {
    trades: 2,
    wins: 1,
    losses: 1,
    winRate: 50,
    netPnl: 90.5,
    grossProfit: 120.5,
    grossLoss: -30,
    profitFactor: 4.02,
    expectancy: 45.25,
    avgWin: 120.5,
    avgLoss: -30,
    avgDurationSec: 3600,
    maxDrawdown: 30,
    bestTrade: 120.5,
    worstTrade: -30,
  },
  r: {
    trades: 2,
    coverage: 100,
    avgR: 0.8,
    totalR: 1.6,
    bestR: 2.4,
    worstR: -0.8,
    maxDrawdownR: 0.8,
    hit1R: 100,
    sources: { journal: 0, order: 2, position: 0, intent: 0 },
  },
  template: {
    planned: 1,
    reached1R: 1,
    breakeven: 1,
    held: 1,
    breakevenRate: 100,
    heldRate: 100,
    avgR: 2.4,
  },
  execution: {
    matched: 1,
    wins: { trades: 1, avgSlippage: 1, avgSpread: 12 },
    losses: { trades: 0, avgSlippage: null, avgSpread: null },
  },
  bySymbol: [
    { key: 'XAUUSD', trades: 1, wins: 1, pnl: 120.5, winRate: 100, expectancy: 120.5, avgR: 2.4 },
    { key: 'EURUSD', trades: 1, wins: 0, pnl: -30, winRate: 0, expectancy: -30, avgR: -1.5 },
  ],
  byHour: [],
  byTag: [
    { key: '突破', trades: 1, wins: 1, pnl: 120.5, winRate: 100, expectancy: 120.5, avgR: 2.4 },
    { key: '未标记', trades: 1, wins: 0, pnl: -30, winRate: 0, expectancy: -30, avgR: -1.5 },
  ],
  byDuration: [],
  curve: [{ t: 1763203600, pnl: 90.5, cum: 90.5 }],
  rCurve: [{ t: 1763203600, r: 1.6, cum: 1.6 }],
};

function mockGateway() {
  return vi.spyOn(gateway, 'call').mockImplementation((async (method: string) => {
    if (method === 'journal.stats') return STATS;
    if (method === 'journal.list') return RECORDS;
    if (method === 'journal.tag') return RECORDS[0];
    throw new Error(`未预置的方法：${method}`);
  }) as typeof gateway.call);
}

function lastListParams(call: ReturnType<typeof mockGateway>) {
  const calls = call.mock.calls.filter(([method]) => method === 'journal.list');
  return calls.at(-1)?.[1] as Record<string, unknown> | undefined;
}

function resetStore() {
  useApp.setState({
    page: 'overview',
    recordsTab: 'list',
    privacy: false,
    account: null,
    health: null,
    journalFilter: {},
    journalDays: null,
    journalFocus: null,
  });
}

async function renderReady() {
  const call = mockGateway();
  render(<JournalView />);
  await screen.findByText('+120.50');
  return call;
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
  resetStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('JournalView 筛选语义', () => {
  it('选择标签「未标记」时把 tag 放进 journal.list 的 filters', async () => {
    const call = await renderReady();
    call.mockClear();

    await userEvent.selectOptions(screen.getByLabelText('按标签筛选'), '未标记');

    await waitFor(() => {
      expect(lastListParams(call)).toMatchObject({
        days: 30,
        filters: { tag: '未标记' },
      });
    });
  });

  it('切到「已复盘」时把 reviewed=1 放进 filters', async () => {
    const call = await renderReady();
    call.mockClear();

    await userEvent.click(screen.getByRole('button', { name: '已复盘' }));

    await waitFor(() => {
      expect(lastListParams(call)).toMatchObject({ filters: { reviewed: 1 } });
    });
  });

  it('结果切到「盈利」时把 result=win 放进 filters', async () => {
    const call = await renderReady();
    call.mockClear();

    await userEvent.click(screen.getByRole('button', { name: '盈利' }));

    await waitFor(() => {
      expect(lastListParams(call)).toMatchObject({ filters: { result: 'win' } });
    });
  });

  it('区间选「全部」时按 days=0 请求统计与列表', async () => {
    const call = await renderReady();
    call.mockClear();

    const range = screen.getByRole('button', { name: '7 天' }).parentElement as HTMLElement;
    await userEvent.click(within(range).getByRole('button', { name: '全部' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('journal.stats', { days: 0, filters: {} });
      expect(lastListParams(call)).toMatchObject({ days: 0, filters: {} });
    });
  });
});

describe('JournalView 详情弹窗', () => {
  it('点行内截图按钮直接落在截图页签', async () => {
    await renderReady();

    const shotButtons = screen.getAllByRole('button', { name: '截图' });
    expect(shotButtons).toHaveLength(1);
    await userEvent.click(shotButtons[0]);

    expect(screen.getByAltText('交易 101 的图表截图')).toBeInTheDocument();
    expect(screen.queryByText('CHART-STUB')).toBeNull();
  });

  it('点击数据行打开详情弹窗并默认显示图表页签', async () => {
    await renderReady();

    const rows = screen.getAllByRole('row');
    await userEvent.click(rows[1]);

    expect(await screen.findByText('CHART-STUB')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '关闭' })).toBeInTheDocument();
  });
});
