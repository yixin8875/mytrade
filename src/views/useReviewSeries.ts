import { useCallback, useEffect, useState } from 'react';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import type { TrendSeries } from '../gateway/types';

/**
 * 复盘的区间数据只取一次：绩效趋势与深度分析共用同一份 review.trades，
 * 切换区间或账户时重新拉取。
 */
export function useReviewSeries(days: number) {
  const activeLogin = useApp((s) => s.account?.login ?? 0);
  const [series, setSeries] = useState<TrendSeries | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await gateway.call<TrendSeries>('review.trades', { days });
      setSeries(data);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load, activeLogin]);

  return { series, loading, error, reload: load };
}
