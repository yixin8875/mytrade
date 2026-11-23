import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import { fmtPrice, fmtVolume } from '../lib/format';
import type { ExecutionRow, ExecutionStats } from '../gateway/types';

const STATE_TEXT: Record<ExecutionRow['state'], string> = {
  filled: '成交',
  accepted: '已接受',
  working: '挂单中',
  rejected: '拒单',
  unknown: '未知',
};

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function fmtNumber(value: number | null | undefined, digits = 1, suffix = ''): string {
  return value == null || !Number.isFinite(value) ? '—' : `${value.toFixed(digits)}${suffix}`;
}

/** 执行质量：点差、滑点、成交延迟与拒单原因，区间由报表页统一提供 */
export function ExecutionsSection({ days }: { days: number }) {
  const conn = useApp((s) => s.conn);
  const symbolList = useApp((s) => s.symbols);
  const activeLogin = useApp((s) => s.account?.login ?? 0);
  const setPage = useApp((s) => s.setPage);
  const setJournalFilter = useApp((s) => s.setJournalFilter);
  const setJournalDays = useApp((s) => s.setJournalDays);

  const [stats, setStats] = useState<ExecutionStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (conn !== 'open') return;
    let alive = true;
    setLoading(true);
    gateway
      .call<ExecutionStats>('executions.stats', { days })
      .then((result) => {
        if (!alive) return;
        setStats(result);
        setError(null);
      })
      .catch((err: Error) => {
        if (alive) setError(err.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [conn, days, activeLogin]);

  const summary = stats?.summary;
  const digitsFor = (symbol: string) =>
    symbolList.find((item) => item.name === symbol)?.digits ?? 5;

  return (
    <section className="mt-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-[16px] font-medium tracking-[-0.01em]">执行质量</h2>
          <p className="mt-1.5 text-[13px] text-muted-foreground">
            只统计实际发往 MT5 的下单请求
            {activeLogin ? ` · 当前账户 ${activeLogin}` : ''}
          </p>
        </div>
        {loading && <span className="text-[12px] text-muted-foreground/60">读取中…</span>}
      </header>

      {error && (
          <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive-foreground">
            读取执行质量失败：{error}
          </div>
        )}

        <div className="readout mt-6 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
          <Metric
            label="请求"
            value={summary ? String(summary.total) : '—'}
            hint={summary ? `成交 ${summary.filled}` : undefined}
          />
          <Metric
            label="平均点差"
            value={fmtNumber(summary?.avgSpread, 1, ' 点')}
            hint="发出时的点差"
          />
          <Metric
            label="平均滑点"
            value={fmtNumber(summary?.avgSlippage, 2, ' 点')}
            hint={
              summary?.slipPositivePct != null
                ? `不利占比 ${summary.slipPositivePct}%`
                : '仅市价成交'
            }
            tone={
              summary?.avgSlippage != null && summary.avgSlippage > 0
                ? 'text-warning-foreground'
                : undefined
            }
          />
          <Metric
            label="延迟 P50"
            value={fmtNumber(summary?.p50Latency, 0, ' ms')}
            hint="下单 → 回执"
          />
          <Metric
            label="延迟 P90"
            value={fmtNumber(summary?.p90Latency, 0, ' ms')}
            hint={summary?.maxLatency != null ? `最慢 ${summary.maxLatency} ms` : undefined}
          />
          <Metric
            label="拒单"
            value={summary ? String(summary.rejected + summary.unknown) : '—'}
            hint={summary ? `未知 ${summary.unknown}` : undefined}
            tone={summary && summary.rejected > 0 ? 'text-destructive-foreground' : undefined}
          />
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(280px,1fr)]">
          <Card className="overflow-hidden">
            <div className="flex items-baseline justify-between border-b border-border px-5 py-3.5">
              <span className="text-[13px] font-semibold">按品种</span>
              <span className="num font-mono text-[11px] text-muted-foreground/60">
                {stats?.bySymbol.length ?? 0} 个品种 · 点击行看日志
              </span>
            </div>
            <Table className="w-full border-collapse text-[12px]">
              <TableHeader>
                <TableRow className="border-0 text-left text-[11px] text-muted-foreground/60 hover:bg-transparent">
                  <TableHead className="h-auto px-5 py-2 font-normal">品种</TableHead>
                  <TableHead className="h-auto px-2 py-2 text-right font-normal">请求</TableHead>
                  <TableHead className="h-auto px-2 py-2 text-right font-normal">拒单</TableHead>
                  <TableHead className="h-auto px-2 py-2 text-right font-normal">点差</TableHead>
                  <TableHead className="h-auto px-2 py-2 text-right font-normal">滑点</TableHead>
                  <TableHead className="h-auto px-5 py-2 text-right font-normal">延迟</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(stats?.bySymbol ?? []).map((row) => (
                  <TableRow
                    key={row.key}
                    onClick={() => {
                      setJournalFilter({ symbol: row.key });
                      setJournalDays(days);
                      setPage('journal');
                    }}
                    title={`在交易日志中查看 ${row.key}`}
                    className="cursor-pointer border-t border-border/70 transition-colors hover:bg-accent/50"
                  >
                    <TableCell className="px-5 py-2.5 font-medium">{row.key}</TableCell>
                    <TableCell className="num px-2 py-2.5 text-right font-mono text-foreground/80">
                      {row.count}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'num px-2 py-2.5 text-right font-mono',
                        row.rejected > 0 ? 'text-destructive-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {row.rejected}
                    </TableCell>
                    <TableCell className="num px-2 py-2.5 text-right font-mono text-muted-foreground">
                      {fmtNumber(row.avgSpread, 1)}
                    </TableCell>
                    <TableCell className="num px-2 py-2.5 text-right font-mono text-muted-foreground">
                      {fmtNumber(row.avgSlippage, 2)}
                    </TableCell>
                    <TableCell className="num px-5 py-2.5 text-right font-mono text-muted-foreground">
                      {fmtNumber(row.avgLatency, 0)}
                    </TableCell>
                  </TableRow>
                ))}
                {(stats?.bySymbol.length ?? 0) === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="px-5 py-10 text-center text-[12px] text-muted-foreground/60">
                      {loading ? '读取中…' : '暂无数据，下一笔下单后开始统计'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Card>

          <Card className="overflow-hidden">
            <div className="flex items-baseline justify-between border-b border-border px-5 py-3.5">
              <span className="text-[13px] font-semibold">拒单原因</span>
              <span className="num font-mono text-[11px] text-muted-foreground/60">
                {stats?.rejectReasons.length ?? 0}
              </span>
            </div>
            <div className="divide-y divide-border/70">
              {(stats?.rejectReasons ?? []).map((item) => (
                <div key={item.key} className="flex items-start justify-between gap-3 px-5 py-2.5">
                  <span className="break-all text-[12px] text-foreground/80">{item.key}</span>
                  <span className="num shrink-0 font-mono text-[11px] text-muted-foreground">{item.count}</span>
                </div>
              ))}
              {(stats?.rejectReasons.length ?? 0) === 0 && (
                <div className="px-5 py-10 text-center text-[12px] text-muted-foreground/60">
                  {loading ? '读取中…' : '没有拒单'}
                </div>
              )}
            </div>
          </Card>
        </div>

        <Card className="mt-4 overflow-hidden">
          <div className="flex items-baseline justify-between border-b border-border px-5 py-3.5">
            <span className="text-[13px] font-semibold">最近请求</span>
            <span className="num font-mono text-[11px] text-muted-foreground/60">
              {stats ? `${stats.rows.length} 条` : '—'}
            </span>
          </div>
          <Table className="w-full min-w-[900px] border-collapse text-[12px]">
            <TableHeader>
              <TableRow className="border-0 text-left text-[11px] text-muted-foreground/60 hover:bg-transparent">
                <TableHead className="h-auto px-5 py-2 font-normal">时间</TableHead>
                <TableHead className="h-auto px-2 py-2 font-normal">品种</TableHead>
                <TableHead className="h-auto px-2 py-2 font-normal">方向</TableHead>
                <TableHead className="h-auto px-2 py-2 font-normal">类型</TableHead>
                <TableHead className="h-auto px-2 py-2 text-right font-normal">手数</TableHead>
                <TableHead className="h-auto px-2 py-2 text-right font-normal">请求 → 成交</TableHead>
                <TableHead className="h-auto px-2 py-2 text-right font-normal">点差</TableHead>
                <TableHead className="h-auto px-2 py-2 text-right font-normal">滑点</TableHead>
                <TableHead className="h-auto px-2 py-2 text-right font-normal">延迟</TableHead>
                <TableHead className="h-auto px-5 py-2 font-normal">状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(stats?.rows ?? []).map((row) => (
                <TableRow key={row.id} className="border-t border-border/70">
                  <TableCell className="num whitespace-nowrap px-5 py-2.5 font-mono text-[11px] text-muted-foreground">
                    {fmtTime(row.created_at)}
                  </TableCell>
                  <TableCell className="px-2 py-2.5 font-medium">{row.symbol}</TableCell>
                  <TableCell className="px-2 py-2.5">
                    <span
                      className={cn(
                        'inline-flex items-center gap-1.5 text-[11px]',
                        row.side === 'buy' ? 'text-success-foreground' : 'text-destructive-foreground',
                      )}
                    >
                      <span
                        className={cn(
                          'h-1.5 w-1.5 rounded-full',
                          row.side === 'buy' ? 'bg-success' : 'bg-destructive',
                        )}
                      />
                      {row.side === 'buy' ? '买' : '卖'}
                    </span>
                  </TableCell>
                  <TableCell className="px-2 py-2.5 text-muted-foreground">
                    {row.type === 'market' ? '市价' : row.type === 'limit' ? '限价' : '停损'}
                  </TableCell>
                  <TableCell className="num px-2 py-2.5 text-right font-mono text-muted-foreground">
                    {fmtVolume(row.volume, 0.01)}
                  </TableCell>
                  <TableCell className="num px-2 py-2.5 text-right font-mono text-foreground/80">
                    {row.requested_price == null
                      ? '—'
                      : fmtPrice(row.requested_price, digitsFor(row.symbol))}
                    {' → '}
                    {row.fill_price == null ? '—' : fmtPrice(row.fill_price, digitsFor(row.symbol))}
                  </TableCell>
                  <TableCell className="num px-2 py-2.5 text-right font-mono text-muted-foreground">
                    {fmtNumber(row.spread_points, 1)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'num px-2 py-2.5 text-right font-mono',
                      row.slippage_points != null && row.slippage_points > 0
                        ? 'text-warning-foreground'
                        : 'text-muted-foreground',
                    )}
                  >
                    {row.slippage_points == null ? '—' : row.slippage_points.toFixed(2)}
                  </TableCell>
                  <TableCell className="num px-2 py-2.5 text-right font-mono text-muted-foreground">
                    {row.latency_ms == null ? '—' : `${row.latency_ms} ms`}
                  </TableCell>
                  <TableCell className="max-w-[240px] px-5 py-2.5">
                    <span
                      className={cn(
                        'inline-flex items-center gap-1.5 text-[11px]',
                        row.state === 'rejected'
                          ? 'text-destructive-foreground'
                          : row.state === 'unknown'
                            ? 'text-warning-foreground'
                            : 'text-success-foreground',
                      )}
                    >
                      <span
                        className={cn(
                          'h-1.5 w-1.5 rounded-full',
                          row.state === 'rejected'
                            ? 'bg-destructive'
                            : row.state === 'unknown'
                              ? 'bg-warning'
                              : 'bg-success',
                        )}
                      />
                      {STATE_TEXT[row.state]}
                    </span>
                    {row.reason && (
                      <span className="ml-1 break-all text-muted-foreground" title={row.reason}>
                        {row.reason.slice(0, 40)}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {(stats?.rows.length ?? 0) === 0 && (
                <TableRow>
                  <TableCell colSpan={10} className="px-5 py-10 text-center text-[12px] text-muted-foreground/60">
                    {loading ? '读取中…' : '暂无请求记录'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>

      <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground/60">
        滑点 = 市价成交价相对下单瞬间报价的偏移，正数表示对你不利；延迟是网关发出 order_send
        到拿到券商回执的时间，不含前端和网络往返。
      </p>
    </section>
  );
}

function Metric({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className="readout-cell">
      <div className="text-[12px] text-muted-foreground">{label}</div>
      <div
        className={cn(
          'num mt-1.5 font-mono text-[24px] font-medium leading-none tracking-[-0.01em]',
          tone,
        )}
      >
        {value}
      </div>
      <div className="mt-2 truncate text-[11px] text-muted-foreground/60">{hint ?? ' '}</div>
    </div>
  );
}
