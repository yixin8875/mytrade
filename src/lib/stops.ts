/**
 * 止损/止盈改单的前端校验：先在本地拦下方向错误和过近距离，
 * 免得出站后拿到券商模糊的 retcode。0 表示清除，不参与校验。
 */

export interface StopCheckOptions {
  /** 券商最小止损距离（点）；没有就给 0 */
  stopsLevel?: number;
  /** 一个点的小数位价格，如 EURUSD 0.00001 */
  point?: number;
}

export function validateStops(
  side: 'buy' | 'sell',
  ref: number,
  sl: number,
  tp: number,
  options: StopCheckOptions = {},
): string | null {
  if (!Number.isFinite(ref) || ref <= 0) return null;
  const stopsLevel = Math.max(0, options.stopsLevel ?? 0);
  const point = options.point ?? 0;

  if (sl > 0) {
    if (side === 'buy' && sl >= ref) return '多单止损必须低于当前价';
    if (side === 'sell' && sl <= ref) return '空单止损必须高于当前价';
    if (stopsLevel > 0 && point > 0 && Math.abs(ref - sl) < stopsLevel * point) {
      return `止损距离至少 ${stopsLevel} 点`;
    }
  }
  if (tp > 0) {
    if (side === 'buy' && tp <= ref) return '多单止盈必须高于当前价';
    if (side === 'sell' && tp >= ref) return '空单止盈必须低于当前价';
    if (stopsLevel > 0 && point > 0 && Math.abs(ref - tp) < stopsLevel * point) {
      return `止盈距离至少 ${stopsLevel} 点`;
    }
  }
  return null;
}
