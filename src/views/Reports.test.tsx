import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import type { JournalStats } from '../gateway/types';
import { ReportsView } from './Reports';

/** 合成统计：时间为 2026-11-15 附近，金额为合成数字 */
function makeStats(overrides: Partial<JournalStats> = {}): JournalStats {
  return {
    days: 30,
    summary: {
      trades: 3,
      wins: 2,
      losses: 1,
      winRate: 66.7,
      netPnl: 120.5,
      grossProfit: 150,
      grossLoss: -29.5,
      profitFactor: 5.08,
      expectancy: 40.17,
      avgWin: 75,
      avgLoss: -29.5,
      avgDurationSec: 3600,
      maxDrawdown: 20,
      bestTrade: 100,
      worstTrade: -29.5,
    },
    r: {
      trades: 2,
      coverage: 66.7,
      avgR: 1.1,
      totalR: 2.2,
      bestR: 2,
      worstR: -0.9,
      maxDrawdownR: 0.9,
      hit1R: 50,
      sources: { journal: 0, order: 1, position: 1, intent: 0 },
    },
    template: {
      planned: 2,
      reached1R: 1,
      breakeven: 1,
      held: 1,
      breakevenRate: 50,
      heldRate: 50,
      avgR: 0.8,
    },
    execution: {
      matched: 2,
      wins: { trades: 1, avgSlippage: 0.2, avgSpread: 1.1 },
      losses: { trades: 1, avgSlippage: 0.4, avgSpread: 1.3 },
    },
    bySymbol: [
      {
        key: 'XAUUSD',
        trades: 3,
        wins: 2,
        pnl: 120.5,
        winRate: 66.7,
        expectancy: 40.17,
        avgR: 1.1,
      },
    ],
    byHour: [
      { key: '23:00', trades: 1, wins: 1, pnl: 100, winRate: 100, expectancy: 100, avgR: 2 },
    ],
    byTag: [
      {
        key: '突破',
        trades: 2,
        wins: 1,
        pnl: 90,
        winRate: 50,
        expectancy: 45,
        avgR: 1,
      },
    ],
    byDuration: [
      { key: '1–4 时', trades: 2, wins: 1, pnl: 90, winRate: 50, expectancy: 45, avgR: 1 },
    ],
    curve: [
      { t: 1763200000, pnl: 100, cum: 100 },
      { t: 1763203600, pnl: 20.5, cum: 120.5 },
    ],
    rCurve: [
      { t: 1763200000, r: 2, cum: 2 },
      { t: 1763203600, r: 0.2, cum: 2.2 },
    ],
    ...overrides,
  };
}

const EMPTY_STATS = makeStats({
  summary: {
    ...makeStats().summary,
    trades: 0,
    wins: 0,
    losses: 0,
    winRate: null,
    netPnl: 0,
    grossProfit: 0,
    grossLoss: 0,
    profitFactor: null,
    expectancy: null,
    avgWin: null,
    avgLoss: null,
    bestTrade: null,
    worstTrade: null,
  },
  r: {
    trades: 0,
    coverage: null,
    avgR: null,
    totalR: 0,
    bestR: null,
    worstR: null,
    maxDrawdownR: 0,
    hit1R: null,
    sources: { journal: 0, order: 0, position: 0, intent: 0 },
  },
  template: {
    planned: 0,
    reached1R: 0,
    breakeven: 0,
    held: 0,
    breakevenRate: null,
    heldRate: null,
    avgR: null,
  },
  execution: {
    matched: 0,
    wins: { trades: 0, avgSlippage: null, avgSpread: null },
    losses: { trades: 0, avgSlippage: null, avgSpread: null },
  },
  bySymbol: [],
  byTag: [],
  byHour: [],
  byDuration: [],
  curve: [],
  rCurve: [],
});

function mockStats(stats: JournalStats) {
  return vi.spyOn(gateway, 'call').mockImplementation((async (method: string) => {
    if (method === 'journal.stats') return stats;
    throw new Error(`未预置的方法：${method}`);
  }) as typeof gateway.call);
}

function resetStore() {
  useApp.setState({
    page: 'overview',
    recordsTab: 'list',
    insightsTab: 'reports',
    privacy: false,
    account: null,
    health: null,
    journalFilter: {},
    journalDays: null,
  });
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  resetStore();
});

describe('ReportsView', () => {
  it('点击「按品种」某一行，把品种、当前区间和容器页签写进 store', async () => {
    const call = mockStats(makeStats());
    render(<ReportsView />);

    const row = await screen.findByTitle('在交易日志中查看 XAUUSD');
    await userEvent.click(row);

    expect(useApp.getState().journalFilter.symbol).toBe('XAUUSD');
    expect(useApp.getState().journalDays).toBe(30);
    expect(useApp.getState().page).toBe('records');
    expect(useApp.getState().recordsTab).toBe('list');
    expect(call).toHaveBeenCalledWith('journal.stats', { days: 30 });
  });

  it('点击「按策略标签」某一行，把标签写进 journalFilter.tag', async () => {
    mockStats(makeStats());
    render(<ReportsView />);

    const row = await screen.findByTitle('在交易日志中查看 突破');
    await userEvent.click(row);

    expect(useApp.getState().journalFilter.tag).toBe('突破');
    expect(useApp.getState().journalDays).toBe(30);
    expect(useApp.getState().page).toBe('records');
    expect(useApp.getState().recordsTab).toBe('list');
  });

  it('切换区间按钮会请求对应天数的统计', async () => {
    const call = mockStats(makeStats());
    render(<ReportsView />);

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('journal.stats', { days: 30 });
    });
    call.mockClear();

    await userEvent.click(screen.getByRole('button', { name: '7 天' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('journal.stats', { days: 7 });
    });
  });

  it('没有交易时显示曲线与分组的空态', async () => {
    mockStats(EMPTY_STATS);
    render(<ReportsView />);

    expect(await screen.findByText('这段时间还没有已平仓交易')).toBeInTheDocument();
    expect(screen.getAllByText('暂无数据')).toHaveLength(4);
    expect(screen.getByText('这个区间没有使用分批止盈模板的交易')).toBeInTheDocument();
    expect(screen.getByText('还没有可对照的入场执行记录')).toBeInTheDocument();
  });
});
