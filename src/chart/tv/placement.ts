/** 画线下单的点击判定：只有「图表空白处短促点一下」才算落价 */
export interface ClickPlacementInput {
  /** 草稿处于画线下单状态 */
  active: boolean;
  type: 'market' | 'limit' | 'stop';
  /** 按下 / 松开的时间戳（毫秒） */
  downAt: number;
  upAt: number;
  /** 按下 / 松开时相对图表的像素坐标 */
  downX: number;
  downY: number;
  upX: number;
  upY: number;
  /** 松开时是否有选中的绘图或价格线 */
  hasSelection: boolean;
  /** 十字线价格；没取到时不落价 */
  price: number | null;
}

const CLICK_MAX_MS = 1500;
const CLICK_MAX_PX = 4;

/**
 * 图表上点一下就把委托价落到十字线价格，但要排除三种情况：
 * 长按、拖动图表、以及点/拖止损止盈等已有价格线。
 * 点在线上的按下/松开几乎不动，如果不排除，
 * 拖止损会把入场价一起带走，模板还会跟着把止盈重算到错误位置。
 */
export function shouldPlacePrice(input: ClickPlacementInput): boolean {
  if (!input.active || input.type === 'market') return false;
  if (!input.downAt || input.upAt - input.downAt > CLICK_MAX_MS) return false;
  if (Math.abs(input.upX - input.downX) > CLICK_MAX_PX) return false;
  if (Math.abs(input.upY - input.downY) > CLICK_MAX_PX) return false;
  if (input.hasSelection) return false;
  return input.price != null;
}
