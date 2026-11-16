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
    if (method.startsWith('position.plan.')) return {};
    throw new Error(`未预置的方法：${method}`);
  }) as typeof gateway.call);
}

let notify: ReturnType<typeof vi.fn>;
type Notify = (kind: 'info' | 'error' | 'success', text: string) => void;

function resetStore() {
  notify = vi.fn();
  useApp.setState({
    page: 'trade',
    symbol: 'XAUUSD',
    positions: POSITIONS,
    orders: [],
    symbols: [GOLD_INFO],
    quote: null,
    breakevenOffset: 0,
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

  it('「全清」只清当前品种，第一次确认、第二次发带 symbol 的请求', async () => {
    const call = vi.spyOn(gateway, 'call').mockImplementation((async (method: string) => {
      if (method === 'trade.flatten') {
        return {
          cancelled: [{ ticket: 201 }],
          closed: [{ ticket: 101 }],
          remaining: { positions: 0, orders: 0 },
        };
      }
      throw new Error(`未预置的方法：${method}`);
    }) as typeof gateway.call);

    render(<PositionsPanel />);
    await userEvent.click(screen.getByRole('button', { name: '全清' }));

    expect(screen.getByRole('button', { name: '确认全清？' })).toBeInTheDocument();
    expect(call).not.toHaveBeenCalledWith('trade.flatten', { symbol: 'XAUUSD' });

    await userEvent.click(screen.getByRole('button', { name: '确认全清？' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('trade.flatten', { symbol: 'XAUUSD' });
    });
    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith(
        'success',
        '已清 XAUUSD：平 1 个仓位、撤销 1 个挂单',
      );
    });
  });

  it('全清结果有失败或剩余时提示失败数量', async () => {
    vi.spyOn(gateway, 'call').mockResolvedValue({
      cancelled: [{ ticket: 201 }, { ticket: 202, error: '拒单' }],
      closed: [{ ticket: 101 }],
      remaining: { positions: 0, orders: 1 },
    } as never);

    render(<PositionsPanel />);
    await userEvent.click(screen.getByRole('button', { name: '全清' }));
    await userEvent.click(screen.getByRole('button', { name: '确认全清？' }));

    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith(
        'error',
        'XAUUSD：已平 1/1，撤单 1/2，1 个失败，剩余 0 仓 / 1 单',
      );
    });
  });

  it('当前品种没有持仓和挂单时不显示全清', async () => {
    resetStore();
    useApp.setState({
      symbol: 'EURUSD',
      positions: [makePosition(101)],
      orders: [{ ticket: 201 } as never],
    });

    render(<PositionsPanel />);

    expect(screen.queryByRole('button', { name: '全清' })).toBeNull();
    // 账户级「全部平仓」仍然可用
    expect(screen.getByRole('button', { name: '全部平仓' })).toBeInTheDocument();
  });

  it('亏损时平一半：提示止损保持原值并给出剩余最大亏损', async () => {
    resetStore();
    useApp.setState({
      positions: [
        makePosition(101, { volume: 0.2, openPrice: 3950, sl: 3940, side: 'buy' }),
      ],
    });
    const call = vi.spyOn(gateway, 'call').mockImplementation((async (method: string) => {
      if (method === 'position.close') {
        return {
          volume: 0.1,
          breakeven: {
            ticket: 101,
            sl: 3940,
            changed: false,
            reason: 'not_in_profit',
            price: 3945,
          },
        };
      }
      throw new Error(`未预置的方法：${method}`);
    }) as typeof gateway.call);

    render(<PositionsPanel />);
    await userEvent.click(screen.getByRole('button', { name: '平一半' }));
    await userEvent.click(screen.getByRole('button', { name: '确认平一半' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('position.close', {
        ticket: 101,
        volume: 0.1,
        moveToBe: true,
        beOffsetPoints: 0,
      });
    });
    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith(
        'success',
        '已平 0.1 手，当前未回本，止损保持 3940.00，剩余 0.10 手，剩余最大亏损约 100.00',
      );
    });
  });

  it('回本后平一半：提示止损移到开仓价', async () => {
    resetStore();
    useApp.setState({
      positions: [
        makePosition(101, { volume: 0.2, openPrice: 3950, sl: 3940, side: 'buy' }),
      ],
    });
    vi.spyOn(gateway, 'call').mockImplementation((async (method: string) => {
      if (method === 'position.close') {
        return {
          volume: 0.1,
          breakeven: { ticket: 101, sl: 3950, changed: true },
        };
      }
      throw new Error(`未预置的方法：${method}`);
    }) as typeof gateway.call);

    render(<PositionsPanel />);
    await userEvent.click(screen.getByRole('button', { name: '平一半' }));
    await userEvent.click(screen.getByRole('button', { name: '确认平一半' }));

    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith(
        'success',
        '已平 0.1 手，止损移到开仓价 3950.00，剩余 0.10 手',
      );
    });
  });

  it('离保本太近时平一半：提示还差一点', async () => {
    resetStore();
    useApp.setState({
      positions: [
        makePosition(101, { volume: 0.2, openPrice: 3950, sl: 3940, side: 'buy' }),
      ],
    });
    vi.spyOn(gateway, 'call').mockImplementation((async (method: string) => {
      if (method === 'position.close') {
        return {
          volume: 0.1,
          breakeven: { ticket: 101, sl: 3940, changed: false, reason: 'too_close' },
        };
      }
      throw new Error(`未预置的方法：${method}`);
    }) as typeof gateway.call);

    render(<PositionsPanel />);
    await userEvent.click(screen.getByRole('button', { name: '平一半' }));
    await userEvent.click(screen.getByRole('button', { name: '确认平一半' }));

    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith(
        'success',
        '已平 0.1 手，离保本还差一点，止损保持 3940.00，剩余 0.10 手',
      );
    });
  });

  it('亏损时点保本：提示止损保持原值', async () => {
    resetStore();
    useApp.setState({ positions: [makePosition(101, { sl: 3940 })] });
    vi.spyOn(gateway, 'call').mockImplementation((async (method: string) => {
      if (method === 'position.breakeven') {
        return { ticket: 101, sl: 3940, changed: false, reason: 'not_in_profit' };
      }
      throw new Error(`未预置的方法：${method}`);
    }) as typeof gateway.call);

    render(<PositionsPanel />);
    await userEvent.click(screen.getByRole('button', { name: '保本' }));

    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith('info', '当前未回本，止损保持原值');
    });
  });

  it('保本偏移会随保本与分批请求下发', async () => {
    resetStore();
    useApp.setState({
      breakevenOffset: 5,
      positions: [makePosition(101, { sl: 3940 })],
    });
    const call = vi.spyOn(gateway, 'call').mockImplementation((async (method: string) => {
      if (method === 'position.breakeven') {
        return { ticket: 101, sl: 3945, changed: true };
      }
      if (method === 'position.plan.add') return {};
      throw new Error(`未预置的方法：${method}`);
    }) as typeof gateway.call);

    render(<PositionsPanel />);
    await userEvent.click(screen.getByRole('button', { name: '保本' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('position.breakeven', {
        ticket: 101,
        offsetPoints: 5,
      });
    });

    await userEvent.click(screen.getByRole('button', { name: '分批' }));
    await userEvent.click(screen.getByRole('button', { name: '+ 添加一档' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('position.plan.add', {
        ticket: 101,
        price: 3960,
        closePercent: 50,
        breakevenOffsetPoints: 5,
      });
    });
  });

  it('平一半会带上保本偏移点数', async () => {
    resetStore();
    useApp.setState({
      breakevenOffset: 8,
      positions: [makePosition(101, { volume: 0.2 })],
    });
    const call = vi.spyOn(gateway, 'call').mockResolvedValue({
      volume: 0.1,
      breakeven: { ticket: 101, sl: 3940, changed: false, reason: 'not_in_profit' },
    } as never);

    render(<PositionsPanel />);
    await userEvent.click(screen.getByRole('button', { name: '平一半' }));
    await userEvent.click(screen.getByRole('button', { name: '确认平一半' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('position.close', {
        ticket: 101,
        volume: 0.1,
        moveToBe: true,
        beOffsetPoints: 8,
      });
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

  it('分批编辑器：默认按 1R 添加一档、平 50%', async () => {
    const call = mockGateway();

    render(<PositionsPanel />);
    await userEvent.click(screen.getAllByRole('button', { name: '分批' })[0]);

    expect(screen.getByText('还没有分批止盈。添加一档后可以直接在图上拖动。')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '+ 添加一档' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('position.plan.add', {
        ticket: 101,
        price: 3960,
        closePercent: 50,
        breakevenOffsetPoints: 0,
      });
    });
    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith('success', '已添加分批：3960.00 平 50%');
    });
  });

  it('分批编辑器：改价调用 update，删除调用 remove', async () => {
    resetStore();
    useApp.setState({
      positions: [
        makePosition(101, {
          plan: {
            entry: 3950,
            risk: 10,
            side: 'buy',
            source: 'manual',
            steps: [
              {
                id: 's1',
                price: 3960,
                closePercent: 50,
                moveBreakeven: false,
                done: false,
                skipped: false,
                atR: 1,
              },
            ],
          },
        }),
      ],
    });
    const call = mockGateway();

    render(<PositionsPanel />);
    await userEvent.click(screen.getByRole('button', { name: '分批' }));

    const price = screen.getByLabelText('触发价');
    await userEvent.clear(price);
    await userEvent.type(price, '3970');
    await userEvent.tab();

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('position.plan.update', {
        ticket: 101,
        stepId: 's1',
        price: 3970,
      });
    });

    await userEvent.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('position.plan.remove', {
        ticket: 101,
        stepId: 's1',
      });
    });
  });

  it('分批编辑器：仓位已是最小手数时禁用添加', async () => {
    resetStore();
    useApp.setState({ positions: [makePosition(101, { volume: 0.01 })] });
    mockGateway();

    render(<PositionsPanel />);
    await userEvent.click(screen.getAllByRole('button', { name: '分批' })[0]);

    expect(screen.getByRole('button', { name: '+ 添加一档' })).toBeDisabled();
  });
});
