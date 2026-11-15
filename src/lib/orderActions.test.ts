import { describe, expect, it, vi } from 'vitest';
import { gateway } from '../gateway/client';
import type { Order, Toast, ToastAction } from '../gateway/types';
import { cancelOrderWithUndo } from './orderActions';

const ORDER: Order = {
  ticket: 12345,
  symbol: 'EURUSD',
  type: 'limit',
  side: 'buy',
  volume: 0.5,
  initialVolume: 0.5,
  filledVolume: 0,
  price: 1.1,
  sl: 1.09,
  tp: 1.12,
  state: 'placed',
  comment: '',
  magic: 0,
  createdAt: 0,
  expiration: null,
};

function makeNotify() {
  return vi.fn<(kind: Toast['kind'], text: string, action?: ToastAction) => void>();
}

describe('cancelOrderWithUndo', () => {
  it('撤单成功后提示带编号的撤销入口，并返回 true', async () => {
    const call = vi.spyOn(gateway, 'call').mockResolvedValueOnce(undefined);
    const notify = makeNotify();

    await expect(cancelOrderWithUndo(ORDER, notify)).resolves.toBe(true);

    expect(call).toHaveBeenCalledWith('order.cancel', { ticket: 12345 });
    expect(notify).toHaveBeenCalledWith(
      'info',
      expect.stringContaining('#12345'),
      expect.objectContaining({ label: '撤销' }),
    );
    expect(notify.mock.calls[0][2]?.label).toBe('撤销');
  });

  it('执行撤销后用原单参数重新挂单并提示成功', async () => {
    const call = vi.spyOn(gateway, 'call').mockResolvedValue(undefined);
    const notify = makeNotify();

    await cancelOrderWithUndo(ORDER, notify);
    const action = notify.mock.calls[0][2];
    expect(action).toBeDefined();
    action!.run();

    await vi.waitFor(() => expect(call).toHaveBeenCalledWith('order.place', expect.anything()));

    const placeParams = call.mock.calls[1][1] as Record<string, unknown>;
    expect(placeParams).toMatchObject({
      symbol: 'EURUSD',
      side: 'buy',
      type: 'limit',
      volume: 0.5,
      price: 1.1,
      sl: 1.09,
      tp: 1.12,
    });
    expect(typeof placeParams.clientOrderId).toBe('string');
    expect(notify).toHaveBeenCalledWith('success', expect.stringContaining('已重新挂上'));
  });

  it('撤单失败时返回 false、提示错误且不给撤销入口', async () => {
    vi.spyOn(gateway, 'call').mockRejectedValueOnce(new Error('订单已成交'));
    const notify = makeNotify();

    await expect(cancelOrderWithUndo(ORDER, notify)).resolves.toBe(false);

    expect(notify).toHaveBeenCalledWith('error', '订单已成交');
    expect(notify.mock.calls.some(([kind]) => kind === 'info')).toBe(false);
  });

  it('重挂失败时提示「重挂失败」并带上原因', async () => {
    vi.spyOn(gateway, 'call')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('价格无效'));
    const notify = makeNotify();

    await cancelOrderWithUndo(ORDER, notify);
    notify.mock.calls[0][2]!.run();

    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith('error', expect.stringContaining('重挂失败')),
    );
    const errorText = notify.mock.calls.find(([kind]) => kind === 'error')?.[1];
    expect(errorText).toContain('价格无效');
  });
});
