import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import { GOLD_INFO } from '../replay/testUtils';
import type { ExecutionStats } from '../gateway/types';
import { ExecutionsView } from './Executions';

/** 合成执行统计：时间为 2026-11-15，金额/点差为合成数字 */
const STATS: ExecutionStats = {
  days: 30,
  summary: {
    total: 1,
    filled: 1,
    rejected: 0,
    unknown: 0,
    avgSpread: 12,
    avgSlippage: 5,
    slipPositivePct: 100,
    maxSlippage: 5,
    avgLatency: 120,
    p50Latency: 120,
    p90Latency: 120,
    maxLatency: 120,
  },
  bySymbol: [
    {
      key: 'XAUUSD',
      count: 1,
      filled: 1,
      rejected: 0,
      avgSpread: 12,
      avgSlippage: 5,
      avgLatency: 120,
    },
  ],
  byHour: [{ key: '12:00', count: 1, rejected: 0 }],
  rejectReasons: [],
  rows: [
    {
      id: 1,
      login: 12345,
      client_id: 'c-1',
      ticket: 101,
      symbol: 'XAUUSD',
      side: 'buy',
      type: 'market',
      volume: 0.1,
      requested_price: 3950,
      fill_price: 3950.5,
      spread_points: 12,
      slippage_points: 5,
      latency_ms: 120,
      retcode: 10009,
      state: 'filled',
      reason: null,
      created_at: 1763200000,
    },
  ],
};

function mockStats() {
  return vi.spyOn(gateway, 'call').mockImplementation((async (method: string) => {
    if (method === 'executions.stats') return STATS;
    throw new Error(`未预置的方法：${method}`);
  }) as typeof gateway.call);
}

function resetStore() {
  useApp.setState({
    page: 'overview',
    conn: 'open',
    symbols: [GOLD_INFO],
    symbol: 'XAUUSD',
    account: {
      login: 12345,
      server: 'Demo-Server',
      company: 'Demo',
      name: '合成账户',
      currency: 'USD',
      leverage: 100,
      balance: 10000,
      equity: 10000,
      margin: 0,
      freeMargin: 10000,
      marginLevel: null,
      marginMode: 'hedging',
      tradeAllowed: true,
      accountType: 'demo',
    },
    journalFilter: {},
    journalDays: null,
  });
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  resetStore();
});

describe('ExecutionsView', () => {
  it('切换区间会按天数重新请求；选「全部」时 days 为 0', async () => {
    const call = mockStats();
    render(<ExecutionsView />);

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('executions.stats', { days: 30 });
    });
    call.mockClear();

    await userEvent.click(screen.getByRole('button', { name: '7 天' }));
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('executions.stats', { days: 7 });
    });

    await userEvent.click(screen.getByRole('button', { name: '全部' }));
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('executions.stats', { days: 0 });
    });
  });

  it('点击品种行把品种和区间带进交易日志', async () => {
    mockStats();
    render(<ExecutionsView />);

    const row = await screen.findByTitle('在交易日志中查看 XAUUSD');
    await userEvent.click(row);

    expect(useApp.getState().journalFilter.symbol).toBe('XAUUSD');
    expect(useApp.getState().journalDays).toBe(30);
    expect(useApp.getState().page).toBe('records');
    expect(useApp.getState().recordsTab).toBe('list');
  });

  it('最近请求表展示成交状态与延迟', async () => {
    mockStats();
    render(<ExecutionsView />);

    expect(await screen.findByText('市价')).toBeInTheDocument();
    expect(screen.getByText('成交')).toBeInTheDocument();
    expect(screen.getAllByText('120 ms').length).toBeGreaterThan(0);
  });
});
