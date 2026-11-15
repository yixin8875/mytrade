import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gateway } from '../gateway/client';
import type { Order } from '../gateway/types';
import { useApp } from '../store/useApp';
import { OrdersPanel } from './OrdersPanel';

const ORDER: Order = {
  ticket: 123,
  symbol: 'XAUUSD',
  type: 'limit',
  side: 'buy',
  volume: 0.1,
  initialVolume: 0.1,
  filledVolume: 0,
  price: 2000,
  sl: 1990,
  tp: 2010,
  state: 'placed',
  comment: '',
  magic: 0,
  createdAt: 1_763_200_000,
  expiration: null,
};

describe('OrdersPanel 撤单', () => {
  beforeEach(() => {
    useApp.setState({ orders: [ORDER], symbols: [], toast: null });
    vi.restoreAllMocks();
  });

  it('撤单成功弹撤销提示，点撤销按原参数重挂', async () => {
    const call = vi.spyOn(gateway, 'call').mockResolvedValue({} as never);
    render(<OrdersPanel />);

    await userEvent.click(screen.getByRole('button', { name: '撤单' }));

    await waitFor(() => expect(call).toHaveBeenCalledWith('order.cancel', { ticket: 123 }));
    const toast = useApp.getState().toast;
    expect(toast?.text).toContain('#123');
    expect(toast?.action?.label).toBe('撤销');

    toast?.action?.run();
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'order.place',
        expect.objectContaining({
          symbol: 'XAUUSD',
          side: 'buy',
          type: 'limit',
          volume: 0.1,
          price: 2000,
          sl: 1990,
          tp: 2010,
        }),
      ),
    );
  });

  it('撤单失败只提示错误，不弹撤销', async () => {
    vi.spyOn(gateway, 'call').mockRejectedValue(new Error('订单不存在'));
    render(<OrdersPanel />);

    await userEvent.click(screen.getByRole('button', { name: '撤单' }));

    await waitFor(() => expect(useApp.getState().toast?.text).toBe('订单不存在'));
    expect(useApp.getState().toast?.action).toBeFalsy();
  });

  it('没有挂单时显示空态', () => {
    useApp.setState({ orders: [] });
    render(<OrdersPanel />);
    expect(screen.getByText(/没有|暂无/)).toBeInTheDocument();
  });
});
