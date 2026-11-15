import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import { GOLD_INFO } from '../replay/testUtils';
import type { Position } from '../gateway/types';
import { PositionsPanel } from './PositionsPanel';

function makePosition(ticket: number, overrides: Partial<Position> = {}): Position {
  return {
    ticket,
    identifier: ticket,
    symbol: 'XAUUSD',
    side: 'buy',
    volume: 0.2,
    openPrice: 3950,
    sl: 3940,
    tp: 3980,
    profit: 12.5,
    swap: 0,
    commission: 0,
    magic: 0,
    comment: '',
    openTime: 1763200000,
    trailing: null,
    ...overrides,
  };
}

const POSITIONS: Position[] = [
  makePosition(101),
  makePosition(102, { symbol: 'EURUSD', side: 'sell', openPrice: 1.1, profit: -4 }),
];

function mockGateway(closeAllResults: { results?: { error?: string }[] } = {
  results: [{}, {}],
}) {
  return vi.spyOn(gateway, 'call').mockImplementation((async (method: string) => {
    if (method === 'position.closeAll') return closeAllResults;
    if (method === 'position.close') return {};
    throw new Error(`未预置的方法：${method}`);
  }) as typeof gateway.call);
}

let notify: ReturnType<typeof vi.fn>;
type Notify = (kind: 'info' | 'error' | 'success', text: string) => void;

function resetStore() {
  notify = vi.fn();
  useApp.setState({
    page: 'trade',
    positions: POSITIONS,
    symbols: [GOLD_INFO],
    quote: null,
    notify: notify as unknown as Notify,
  });
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  resetStore();
});

describe('PositionsPanel', () => {
  it('「全部平仓」第一次只进入确认态，第二次才发请求', async () => {
    const call = mockGateway();

    render(<PositionsPanel />);
    await userEvent.click(screen.getByRole('button', { name: '全部平仓' }));

    expect(screen.getByRole('button', { name: '确认全平？' })).toBeInTheDocument();
    expect(call).not.toHaveBeenCalledWith('position.closeAll', {});

    await userEvent.click(screen.getByRole('button', { name: '确认全平？' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('position.closeAll', {});
    });
    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith('success', '已平掉 2 个仓位');
    });
  });

  it('全部平仓请求期间按钮显示「平仓中…」且禁用', async () => {
    let resolveRequest!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveRequest = resolve;
    });
    vi.spyOn(gateway, 'call').mockImplementation((async (method: string) => {
      if (method === 'position.closeAll') return pending;
      throw new Error(`未预置的方法：${method}`);
    }) as typeof gateway.call);

    render(<PositionsPanel />);
    await userEvent.click(screen.getByRole('button', { name: '全部平仓' }));
    await userEvent.click(screen.getByRole('button', { name: '确认全平？' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '平仓中…' })).toBeDisabled();
    });

    await act(async () => {
      resolveRequest({ results: [{}, {}] });
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '全部平仓' })).not.toBeDisabled();
    });
  });

  it('全部平仓结果含失败时提示失败数量', async () => {
    mockGateway({ results: [{}, { error: '拒单' }] });

    render(<PositionsPanel />);
    await userEvent.click(screen.getByRole('button', { name: '全部平仓' }));
    await userEvent.click(screen.getByRole('button', { name: '确认全平？' }));

    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith('error', '已平 1 个，1 个失败');
    });
  });

  it('单仓平仓需要二次确认，确认后按持仓号发请求', async () => {
    const call = mockGateway();

    render(<PositionsPanel />);
    const closeButtons = screen.getAllByRole('button', { name: '平仓' });
    expect(closeButtons).toHaveLength(2);

    await userEvent.click(closeButtons[0]);
    expect(screen.getByRole('button', { name: '确认平仓' })).toBeInTheDocument();
    expect(call).not.toHaveBeenCalledWith('position.close', { ticket: 101 });

    await userEvent.click(screen.getByRole('button', { name: '确认平仓' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('position.close', { ticket: 101 });
    });
  });

  it('止损止盈面板可以通过「取消」收起', async () => {
    mockGateway();

    render(<PositionsPanel />);
    const stopButtons = screen.getAllByRole('button', { name: '止损止盈' });
    await userEvent.click(stopButtons[0]);

    expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
  });
});
