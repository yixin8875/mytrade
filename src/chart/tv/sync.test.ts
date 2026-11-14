import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  publishCrosshair,
  publishRange,
  subscribeCrosshair,
  subscribeRange,
  type CrosshairState,
  type RangeState,
} from './sync';

const CROSSHAIR: CrosshairState = { price: 3980.25, time: 1_700_000_000, from: 'chart-1' };

beforeEach(() => {
  // 模块级状态会跟着测试走，先广播 null 清空
  publishCrosshair(null);
  publishRange(null);
});

describe('十字线联动', () => {
  it('广播时通知所有订阅者', () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = subscribeCrosshair(first);
    const offSecond = subscribeCrosshair(second);

    publishCrosshair(CROSSHAIR);

    expect(first).toHaveBeenLastCalledWith(CROSSHAIR);
    expect(second).toHaveBeenLastCalledWith(CROSSHAIR);
    offFirst();
    offSecond();
  });

  it('新订阅者立刻收到当前十字线，取消订阅后不再收到', () => {
    publishCrosshair(CROSSHAIR);
    const late = vi.fn();
    const off = subscribeCrosshair(late);

    expect(late).toHaveBeenCalledWith(CROSSHAIR);

    off();
    publishCrosshair({ ...CROSSHAIR, price: 3981 });
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('广播 null 通知其他图清掉幽灵线', () => {
    const listener = vi.fn();
    const off = subscribeCrosshair(listener);
    publishCrosshair(CROSSHAIR);

    publishCrosshair(null);
    expect(listener).toHaveBeenLastCalledWith(null);
    off();
  });
});

describe('可视区间联动', () => {
  it('广播给当前订阅者', () => {
    const listener = vi.fn();
    const off = subscribeRange(listener);
    const range: RangeState = { from: 1_700_000_000, to: 1_700_003_600, fromSlot: 'chart-2' };

    publishRange(range);
    expect(listener).toHaveBeenLastCalledWith(range);
    off();
  });

  it('不回放旧区间，新建图表不会被旧区间拉走', () => {
    publishRange({ from: 1, to: 2, fromSlot: 'chart-1' });
    const late = vi.fn();
    const off = subscribeRange(late);

    expect(late).not.toHaveBeenCalled();
    off();
  });

  it('取消订阅后不再收到广播', () => {
    const listener = vi.fn();
    const off = subscribeRange(listener);
    off();

    publishRange({ from: 1, to: 2, fromSlot: 'chart-1' });
    expect(listener).not.toHaveBeenCalled();
  });
});
