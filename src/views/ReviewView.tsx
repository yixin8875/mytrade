import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { usePrivacyMask } from '../lib/privacy';
import { useApp } from '../store/useApp';
import { AnalysisSection } from './Analysis';
import { TrendsSection } from './Trends';
import { useReviewSeries } from './useReviewSeries';

const RANGES = [90, 180, 365];

/** 复盘：绩效趋势与深度分析共用一次 review.trades 请求和同一区间 */
export function ReviewView() {
  const activeLogin = useApp((s) => s.account?.login ?? 0);
  usePrivacyMask();

  const [days, setDays] = useState(180);
  const { series, loading, error, reload } = useReviewSeries(days);

  return (
    <div className="console-scope h-full min-h-0 overflow-auto bg-sidebar">
      <div className="mx-auto w-full max-w-[1240px] px-8 py-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-medium tracking-[-0.01em]">复盘</h1>
            <p className="mt-1.5 text-[13px] text-muted-foreground">
              绩效趋势与深度分析共用同一区间、同一次取数
              {activeLogin ? ` · 账户 ${activeLogin}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              {RANGES.map((value) => (
                <Button
                  key={value}
                  onClick={() => setDays(value)}
                  size="xs"
                  variant={days === value ? 'default' : 'outline'}
                >
                  {value} 天
                </Button>
              ))}
            </div>
            <Button onClick={() => void reload()} disabled={loading} variant="outline">
              <RefreshCw size={14} strokeWidth={1.5} className={cn(loading && 'animate-spin')} />
              {loading ? '读取中…' : '刷新'}
            </Button>
          </div>
        </header>

        {error && (
          <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive-foreground">
            读取失败：{error}
          </div>
        )}

        <TrendsSection series={series} loading={loading} days={days} />
        <AnalysisSection series={series} loading={loading} days={days} />
      </div>
    </div>
  );
}
