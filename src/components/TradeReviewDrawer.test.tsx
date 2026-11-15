import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gateway } from '../gateway/client';
import type { TradeNoteDetail } from '../gateway/types';
import { useApp } from '../store/useApp';
import { TradeReviewDrawer } from './TradeReviewDrawer';

function detail(overrides: Partial<TradeNoteDetail> = {}): TradeNoteDetail {
  return {
    positionId: 11,
    playbookId: null,
    playbookName: null,
    rating: null,
    mistakes: [],
    note: '',
    reviewedAt: null,
    rules: [],
    preTrade: null,
    playbooks: [],
    trade: {
      positionId: 11,
      symbol: 'XAUUSD',
      side: 'buy',
      volume: 0.1,
      openTime: 1_763_190_000,
      closeTime: 1_763_193_600,
      profit: 100,
      r: 1,
    },
    ...overrides,
  };
}

describe('TradeReviewDrawer 复盘标记', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useApp.setState({ health: null, toast: null });
  });

  it('未复盘时点按钮标记已复盘，并通知列表刷新', async () => {
    const onChanged = vi.fn();
    const call = vi.spyOn(gateway, 'call').mockImplementation((async (method: string) => {
      if (method === 'strategy.tradeNote') return detail();
      if (method === 'strategy.tradeNote.reviewed') {
        return { positionId: 11, reviewedAt: 1_763_200_000_000 };
      }
      return {};
    }) as typeof gateway.call);
    render(<TradeReviewDrawer positionId={11} onClose={() => {}} onChanged={onChanged} />);

    await userEvent.click(await screen.findByRole('button', { name: '标记已复盘' }));

    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('strategy.tradeNote.reviewed', {
        positionId: 11,
        reviewed: true,
      }),
    );
    expect(await screen.findByRole('button', { name: '取消标记' })).toBeInTheDocument();
    expect(useApp.getState().toast?.text).toBe('已标记为已复盘');
    expect(onChanged).toHaveBeenCalled();
  });

  it('已复盘时再点一次取消标记', async () => {
    const call = vi.spyOn(gateway, 'call').mockImplementation((async (method: string) => {
      if (method === 'strategy.tradeNote') return detail({ reviewedAt: 1_763_200_000_000 });
      if (method === 'strategy.tradeNote.reviewed') {
        return { positionId: 11, reviewedAt: null };
      }
      return {};
    }) as typeof gateway.call);
    render(<TradeReviewDrawer positionId={11} onClose={() => {}} />);

    await userEvent.click(await screen.findByRole('button', { name: '取消标记' }));

    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('strategy.tradeNote.reviewed', {
        positionId: 11,
        reviewed: false,
      }),
    );
    expect(await screen.findByRole('button', { name: '标记已复盘' })).toBeInTheDocument();
    expect(useApp.getState().toast?.text).toBe('已取消复盘标记');
  });

  it('标记失败时提示错误且状态不变', async () => {
    vi.spyOn(gateway, 'call').mockImplementation((async (method: string) => {
      if (method === 'strategy.tradeNote') return detail();
      if (method === 'strategy.tradeNote.reviewed') throw new Error('网关未连接');
      return {};
    }) as typeof gateway.call);
    render(<TradeReviewDrawer positionId={11} onClose={() => {}} />);

    await userEvent.click(await screen.findByRole('button', { name: '标记已复盘' }));

    await waitFor(() => expect(useApp.getState().toast?.text).toBe('网关未连接'));
    expect(screen.getByRole('button', { name: '标记已复盘' })).toBeInTheDocument();
  });

  it('没有选中交易时不渲染，Esc 触发关闭', async () => {
    const onClose = vi.fn();
    vi.spyOn(gateway, 'call').mockResolvedValue(detail() as never);
    const { rerender } = render(
      <TradeReviewDrawer positionId={null} onClose={onClose} />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();

    rerender(<TradeReviewDrawer positionId={11} onClose={onClose} />);
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});
