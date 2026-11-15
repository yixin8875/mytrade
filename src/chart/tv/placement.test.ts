import { describe, expect, it } from 'vitest';
import { shouldPlacePrice, type ClickPlacementInput } from './placement';

function input(overrides: Partial<ClickPlacementInput> = {}): ClickPlacementInput {
  return {
    active: true,
    type: 'limit',
    downAt: 1_000,
    upAt: 1_150,
    downX: 200,
    downY: 300,
    upX: 201,
    upY: 301,
    hasSelection: false,
    price: 28300,
    ...overrides,
  };
}

describe('画线下单的点击判定', () => {
  it('空白处短促点一下就落价', () => {
    expect(shouldPlacePrice(input())).toBe(true);
  });

  it('市价单没有委托价，点图不落价', () => {
    expect(shouldPlacePrice(input({ type: 'market' }))).toBe(false);
  });

  it('草稿没打开画线下单时不落价', () => {
    expect(shouldPlacePrice(input({ active: false }))).toBe(false);
  });

  it('拖动画布（位移超过阈值）不落价', () => {
    expect(shouldPlacePrice(input({ upX: 260, upY: 340 }))).toBe(false);
  });

  it('长按不落价', () => {
    expect(shouldPlacePrice(input({ upAt: 4_000 }))).toBe(false);
  });

  it('点到已有止损止盈线时不落价，避免入场价被一起带走', () => {
    expect(shouldPlacePrice(input({ hasSelection: true }))).toBe(false);
  });

  it('没有十字线价格时不落价', () => {
    expect(shouldPlacePrice(input({ price: null }))).toBe(false);
  });

  it('没有按下记录时不落价', () => {
    expect(shouldPlacePrice(input({ downAt: 0 }))).toBe(false);
  });
});
