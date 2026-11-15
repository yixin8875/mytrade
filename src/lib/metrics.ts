/** 与 gateway/metrics.py 保持一致的盈亏口径：±0.005 以内视为持平。 */

export const WIN_EPSILON = 0.005;

export function isWin(profit: number): boolean {
  return profit > WIN_EPSILON;
}

export function isLoss(profit: number): boolean {
  return profit < -WIN_EPSILON;
}
