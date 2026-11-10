import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import { fmtPrice, fmtVolume } from '../lib/format';
import type { ExecutionRow, ExecutionStats } from '../gateway/types';

const RANGES = [7, 30, 90];

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

export function ExecutionModal() {
  const open = useApp((s) => s.executionOpen);
  const setOpen = useApp((s) => s.setExecutionOpen);
  const symbols = useApp((s) => s.symbols);
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<ExecutionStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    gateway
      .call<ExecutionStats>('executions.stats', { days })
      .then((result) => {
        if (!alive) return;
        setStats(result);
        setError(null);
      })
      .catch((err: Error) => alive && setError(err.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open, days]);

  if (!open) return null;

  const summary = stats?.summary;
  const digitsFor = (symbol: string) =>
    symbols.find((item) => item.name === symbol)?.digits ?? 5;

  return (
    <div
      data-modal="executions"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="flex max-h-[90vh] w-[min(1080px,96vw)] flex-col rounded border border-tv-border bg-tv-panel shadow-2xl">
        <div className="flex items-center gap-2 border-b border-tv-border px-4 py-2.5">
          <span className="text-sm font-medium text-tv-text">执行质量</span>
          <div className="flex gap-1">
            {RANGES.map((value) => (
              <button
                key={value}
                onClick={() => setDays(value)}
                className={clsx(
                  'h-6 rounded px-2 text-[10px] transition-colors',
                  days === value
                    ? 'bg-tv-border text-tv-text'
                    : 'text-tv-muted hover:text-tv-text',
                )}
              >
                {value} 天
              </button>
            ))}
          </div>
          {loading && <span className="text-[10px] text-tv-muted">加载中…</span>}
          {error && <span className="text-[10px] text-tv-down">{error}</span>}
          <span className="flex-1" />
          <span className="text-[10px] text-tv-muted">只统计实际发往 MT5 的下单请求</span>
          <button
            onClick={() => setOpen(false)}
            className="h-6 w-6 rounded text-tv-muted hover:bg-tv-hover hover:text-tv-text"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="grid grid-cols-6 gap-2">
            <Card
              label="请求"
              value={summary ? String(summary.total) : '—'}
              hint={summary ? `成交 ${summary.filled}` : ''}
            />
            <Card label="平均点差" value={fmtNumber(summary?.avgSpread, 1, ' 点')} hint="发出时的点差" />
            <Card
              label="平均滑点"
              value={fmtNumber(summary?.avgSlippage, 2, ' 点')}
              hint={summary?.slipPositivePct != null ? `不利占比 ${summary.slipPositivePct}%` : '仅市价成交'}
              tone={
                summary?.avgSlippage != null && summary.avgSlippage > 0
                  ? 'text-amber-400'
                  : undefined
              }
            />
            <Card label="延迟 P50" value={fmtNumber(summary?.p50Latency, 0, ' ms')} hint="下单 → 回执" />
            <Card
              label="延迟 P90"
              value={fmtNumber(summary?.p90Latency, 0, ' ms')}
              hint={summary?.maxLatency != null ? `最慢 ${summary.maxLatency} ms` : ''}
            />
            <Card
              label="拒单"
              value={summary ? String(summary.rejected + summary.unknown) : '—'}
              hint={summary ? `未知 ${summary.unknown}` : ''}
              tone={summary && summary.rejected > 0 ? 'text-tv-down' : undefined}
            />
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="rounded border border-tv-border">
              <div className="border-b border-tv-border px-2 py-1 text-[10px] text-tv-muted">按品种</div>
              <table className="w-full text-[10px]">
                <thead className="text-tv-muted">
                  <tr>
                    <th className="px-2 py-1 text-left font-normal">品种</th>
                    <th className="px-2 py-1 text-right font-normal">请求</th>
                    <th className="px-2 py-1 text-right font-normal">拒单</th>
                    <th className="px-2 py-1 text-right font-normal">点差</th>
                    <th className="px-2 py-1 text-right font-normal">滑点</th>
                    <th className="px-2 py-1 text-right font-normal">延迟</th>
                  </tr>
                </thead>
                <tbody>
                  {(stats?.bySymbol ?? []).map((row) => (
                    <tr key={row.key} className="border-t border-tv-border/60 font-mono">
                      <td className="px-2 py-1">{row.key}</td>
                      <td className="px-2 py-1 text-right">{row.count}</td>
                      <td className={clsx('px-2 py-1 text-right', row.rejected > 0 && 'text-tv-down')}>
                        {row.rejected}
                      </td>
                      <td className="px-2 py-1 text-right">{fmtNumber(row.avgSpread, 1)}</td>
                      <td className="px-2 py-1 text-right">{fmtNumber(row.avgSlippage, 2)}</td>
                      <td className="px-2 py-1 text-right">{fmtNumber(row.avgLatency, 0)}</td>
                    </tr>
                  ))}
                  {(stats?.bySymbol.length ?? 0) === 0 && (
                    <tr>
                      <td colSpan={6} className="px-2 py-4 text-center text-tv-muted">
                        暂无数据，下一笔下单后开始统计
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="rounded border border-tv-border">
              <div className="border-b border-tv-border px-2 py-1 text-[10px] text-tv-muted">
                拒单原因
              </div>
              <div className="max-h-40 overflow-auto p-2 text-[10px]">
                {(stats?.rejectReasons ?? []).map((item) => (
                  <div key={item.key} className="flex items-start justify-between gap-2 py-0.5">
                    <span className="break-all text-tv-text">{item.key}</span>
                    <span className="shrink-0 font-mono text-tv-muted">{item.count}</span>
                  </div>
                ))}
                {(stats?.rejectReasons.length ?? 0) === 0 && (
                  <div className="py-3 text-center text-tv-muted">没有拒单</div>
                )}
              </div>
            </div>
          </div>

          <div className="mt-4 rounded border border-tv-border">
            <div className="border-b border-tv-border px-2 py-1 text-[10px] text-tv-muted">
              最近请求
            </div>
            <div className="max-h-[38vh] overflow-auto">
              <table className="w-full text-[10px]">
                <thead className="sticky top-0 bg-tv-panel text-tv-muted">
                  <tr>
                    <th className="px-2 py-1 text-left font-normal">时间</th>
                    <th className="px-2 py-1 text-left font-normal">品种</th>
                    <th className="px-2 py-1 text-left font-normal">方向</th>
                    <th className="px-2 py-1 text-left font-normal">类型</th>
                    <th className="px-2 py-1 text-right font-normal">手数</th>
                    <th className="px-2 py-1 text-right font-normal">请求 → 成交</th>
                    <th className="px-2 py-1 text-right font-normal">点差</th>
                    <th className="px-2 py-1 text-right font-normal">滑点</th>
                    <th className="px-2 py-1 text-right font-normal">延迟</th>
                    <th className="px-2 py-1 text-left font-normal">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {(stats?.rows ?? []).map((row) => (
                    <tr key={row.id} className="border-t border-tv-border/60 font-mono">
                      <td className="whitespace-nowrap px-2 py-1 text-tv-muted">{fmtTime(row.created_at)}</td>
                      <td className="px-2 py-1">{row.symbol}</td>
                      <td className={clsx('px-2 py-1', row.side === 'buy' ? 'text-tv-up' : 'text-tv-down')}>
                        {row.side === 'buy' ? '买' : '卖'}
                      </td>
                      <td className="px-2 py-1 text-tv-muted">
                        {row.type === 'market' ? '市价' : row.type === 'limit' ? '限价' : '停损'}
                      </td>
                      <td className="px-2 py-1 text-right">{fmtVolume(row.volume, 0.01)}</td>
                      <td className="px-2 py-1 text-right">
                        {row.requested_price == null
                          ? '—'
                          : fmtPrice(row.requested_price, digitsFor(row.symbol))}
                        {' → '}
                        {row.fill_price == null ? '—' : fmtPrice(row.fill_price, digitsFor(row.symbol))}
                      </td>
                      <td className="px-2 py-1 text-right">{fmtNumber(row.spread_points, 1)}</td>
                      <td
                        className={clsx(
                          'px-2 py-1 text-right',
                          row.slippage_points != null && row.slippage_points > 0 && 'text-amber-400',
                        )}
                      >
                        {row.slippage_points == null ? '—' : row.slippage_points.toFixed(2)}
                      </td>
                      <td className="px-2 py-1 text-right text-tv-muted">
                        {row.latency_ms == null ? '—' : `${row.latency_ms} ms`}
                      </td>
                      <td className="max-w-[220px] px-2 py-1">
                        <span
                          className={clsx(
                            row.state === 'rejected'
                              ? 'text-tv-down'
                              : row.state === 'unknown'
                                ? 'text-amber-400'
                                : 'text-tv-up',
                          )}
                        >
                          {STATE_TEXT[row.state]}
                        </span>
                        {row.reason && (
                          <span className="ml-1 break-all text-tv-muted" title={row.reason}>
                            {row.reason.slice(0, 40)}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {(stats?.rows.length ?? 0) === 0 && (
                    <tr>
                      <td colSpan={10} className="px-2 py-6 text-center text-tv-muted">
                        暂无请求记录
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-3 text-[10px] leading-relaxed text-tv-muted">
            滑点 = 市价成交价相对下单瞬间报价的偏移，正数表示对你不利；延迟是网关发出
            order_send 到拿到券商回执的时间，不含前端和网络往返。
          </div>
        </div>
      </div>
    </div>
  );
}

function Card({
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
    <div className="rounded border border-tv-border bg-tv-bg/60 px-2 py-1.5">
      <div className="text-[9px] text-tv-muted">{label}</div>
      <div className={clsx('mt-0.5 font-mono text-sm', tone ?? 'text-tv-text')}>{value}</div>
      <div className="text-[9px] text-tv-muted">{hint || ' '}</div>
    </div>
  );
}
