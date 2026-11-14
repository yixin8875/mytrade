import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestModify, revertModify } from './modifyQueue';

afterEach(() => {
  vi.useRealTimers();
});

describe('requestModify', () => {
  it('连续拖动只发最后一次价格', async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => Promise.resolve());

    requestModify('drag-1', 100, send);
    requestModify('drag-1', 101, send);
    requestModify('drag-1', 102, send);

    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(320);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(102);
  });

  it('已经发过同一个价格就不再重复发送', async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => Promise.resolve());

    requestModify('same-1', 100, send);
    await vi.advanceTimersByTimeAsync(320);
    expect(send).toHaveBeenCalledTimes(1);

    requestModify('same-1', 100, send);
    await vi.advanceTimersByTimeAsync(320);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('容差内的价格视为同一个', async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => Promise.resolve());

    requestModify('tol-1', 100, send, undefined, 0.5);
    await vi.advanceTimersByTimeAsync(320);
    requestModify('tol-1', 100.4, send, undefined, 0.5);
    await vi.advanceTimersByTimeAsync(320);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('请求在飞时只保留最新目标价，落地后再补发', async () => {
    vi.useFakeTimers();
    let finish: (() => void) | null = null;
    const send = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );

    requestModify('flight-1', 100, send);
    await vi.advanceTimersByTimeAsync(320);
    expect(send).toHaveBeenCalledTimes(1);

    requestModify('flight-1', 105, send);
    finish!();
    await vi.advanceTimersByTimeAsync(60);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(105);
  });

  it('发送失败会回调错误，下一次拖动仍会重试', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const send = vi
      .fn<(price: number) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('网关未连接'))
      .mockResolvedValue(undefined);

    requestModify('fail-1', 100, send, onError);
    await vi.advanceTimersByTimeAsync(320);
    expect(onError).toHaveBeenCalledTimes(1);

    requestModify('fail-1', 101, send, onError);
    await vi.advanceTimersByTimeAsync(320);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(101);
  });

  it('发送函数同步抛错也不会卡死通道', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const send = vi.fn(() => {
      throw new Error('boom');
    });

    requestModify('sync-1', 100, send, onError);
    await vi.advanceTimersByTimeAsync(320);
    expect(onError).toHaveBeenCalledTimes(1);

    const retry = vi.fn(() => Promise.resolve());
    requestModify('sync-1', 101, retry);
    await vi.advanceTimersByTimeAsync(320);
    expect(retry).toHaveBeenCalledWith(101);
  });

  it('非法价格直接忽略', async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => Promise.resolve());

    requestModify('bad-1', Number.NaN, send);
    await vi.advanceTimersByTimeAsync(320);

    expect(send).not.toHaveBeenCalled();
  });
});

describe('revertModify', () => {
  it('还没发出去就拖回原价：撤掉这次改单', async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => Promise.resolve());

    requestModify('revert-1', 100, send);
    revertModify('revert-1', 100, send);
    await vi.advanceTimersByTimeAsync(320);

    expect(send).not.toHaveBeenCalled();
  });

  it('从未改过的通道不会白发请求', async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => Promise.resolve());

    revertModify('revert-2', 100, send);
    await vi.advanceTimersByTimeAsync(320);

    expect(send).not.toHaveBeenCalled();
  });

  it('已经发出去后拖回原价：补发一次原价', async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => Promise.resolve());

    requestModify('revert-3', 110, send);
    await vi.advanceTimersByTimeAsync(320);
    expect(send).toHaveBeenLastCalledWith(110);

    revertModify('revert-3', 100, send);
    await vi.advanceTimersByTimeAsync(320);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(100);
  });
});
