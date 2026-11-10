import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { ShieldCheck } from 'lucide-react';
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

/** 执行质量页：点差、滑点、成交延迟与拒单原因 */
export function ExecutionsView() {
  const conn = useApp((s) => s.conn);
  const symbolList = useApp((s) => s.symbols);
  const activeLogin = useApp((s) => s.account?.login ?? 0);

  const [days, setDays] = useState(30);
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
    <div className="console-scope h-full min-h-0 overflow-auto bg-console-canvas">
      <div className="mx-auto w-full max-w-[1240px] px-8 py-7">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-semibold tracking-tight">执行质量</h1>
            <p className="mt-1 text-[11.5px] text-console-muted">
              只统计实际发往 MT5 的下单请求
              {activeLogin ? ` · 当前账户 ${activeLogin}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {loading && <span className="text-[10.5px] text-console-faint">读取中…</span>}
            <div className="flex items-center gap-1">
              {RANGES.map((value) => (
                <button
                  key={value}
                  onClick={() => setDays(value)}
                  className={clsx('console-chip', days === value && 'console-chip-active')}
                >
                  {value} 天
                </button>
              ))}
            </div>
          </div>
        </header>

        {error && (
          <div className="mt-4 rounded-lg border border-console-loss/30 bg-console-loss-soft px-3 py-2 text-[11px] text-console-loss">
            读取执行质量失败：{error}
          </div>
        )}

        <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
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
                ? 'text-console-warn'
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
            tone={summary && summary.rejected > 0 ? 'text-console-loss' : undefined}
          />
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(280px,1fr)]">
          <section className="console-card overflow-hidden">
            <div className="flex items-center gap-2 border-b border-console-line px-5 py-3">
              <ShieldCheck size={14} className="text-console-muted" />
              <span className="text-[13px] font-semibold">按品种</span>
            </div>
            <table className="w-full border-collapse text-[11px]">
              <thead>
                <tr className="text-left text-[10px] text-console-faint">
                  <th className="px-5 py-2 font-normal">品种</th>
                  <th className="px-2 py-2 text-right font-normal">请求</th>
                  <th className="px-2 py-2 text-right font-normal">拒单</th>
                  <th className="px-2 py-2 text-right font-normal">点差</th>
                  <th className="px-2 py-2 text-right font-normal">滑点</th>
                  <th className="px-5 py-2 text-right font-normal">延迟</th>
                </tr>
              </thead>
              <tbody>
                {(stats?.bySymbol ?? []).map((row) => (
                  <tr key={row.key} className="border-t border-console-line/70">
                    <td className="px-5 py-2 font-medium">{row.key}</td>
                    <td className="num px-2 py-2 text-right text-console-ink-2">{row.count}</td>
                    <td
                      className={clsx(
                        'num px-2 py-2 text-right',
                        row.rejected > 0 ? 'text-console-loss' : 'text-console-muted',
                      )}
                    >
                      {row.rejected}
                    </td>
                    <td className="num px-2 py-2 text-right text-console-muted">
                      {fmtNumber(row.avgSpread, 1)}
                    </td>
                    <td className="num px-2 py-2 text-right text-console-muted">
                      {fmtNumber(row.avgSlippage, 2)}
                    </td>
                    <td className="num px-5 py-2 text-right text-console-muted">
                      {fmtNumber(row.avgLatency, 0)}
                    </td>
                  </tr>
                ))}
                {(stats?.bySymbol.length ?? 0) === 0 && (
                  <tr>
                    <td colSpan={6} className="px-5 py-10 text-center text-[11px] text-console-faint">
                      {loading ? '读取中…' : '暂无数据，下一笔下单后开始统计'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>

          <section className="console-card overflow-hidden">
            <div className="border-b border-console-line px-5 py-3 text-[13px] font-semibold">
              拒单原因
            </div>
            <div className="divide-y divide-console-line/70">
              {(stats?.rejectReasons ?? []).map((item) => (
                <div key={item.key} className="flex items-start justify-between gap-3 px-5 py-2">
                  <span className="break-all text-[10.5px] text-console-ink-2">{item.key}</span>
                  <span className="num shrink-0 text-[10.5px] text-console-muted">{item.count}</span>
                </div>
              ))}
              {(stats?.rejectReasons.length ?? 0) === 0 && (
                <div className="px-5 py-10 text-center text-[11px] text-console-faint">
                  {loading ? '读取中…' : '没有拒单'}
                </div>
              )}
            </div>
          </section>
        </div>

        <section className="console-card mt-4 overflow-hidden">
          <div className="flex items-center justify-between border-b border-console-line px-5 py-3">
            <span className="text-[13px] font-semibold">最近请求</span>
            <span className="text-[10.5px] text-console-faint">
              {stats ? `${stats.rows.length} 条` : '—'}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse text-[11px]">
              <thead>
                <tr className="text-left text-[10px] text-console-faint">
                  <th className="px-5 py-2 font-normal">时间</th>
                  <th className="px-2 py-2 font-normal">品种</th>
                  <th className="px-2 py-2 font-normal">方向</th>
                  <th className="px-2 py-2 font-normal">类型</th>
                  <th className="px-2 py-2 text-right font-normal">手数</th>
                  <th className="px-2 py-2 text-right font-normal">请求 → 成交</th>
                  <th className="px-2 py-2 text-right font-normal">点差</th>
                  <th className="px-2 py-2 text-right font-normal">滑点</th>
                  <th className="px-2 py-2 text-right font-normal">延迟</th>
                  <th className="px-5 py-2 font-normal">状态</th>
                </tr>
              </thead>
              <tbody>
                {(stats?.rows ?? []).map((row) => (
                  <tr key={row.id} className="border-t border-console-line/70">
                    <td className="num whitespace-nowrap px-5 py-2 text-console-muted">
                      {fmtTime(row.created_at)}
                    </td>
                    <td className="px-2 py-2 font-medium">{row.symbol}</td>
                    <td
                      className={clsx(
                        'px-2 py-2',
                        row.side === 'buy' ? 'text-console-gain' : 'text-console-loss',
                      )}
                    >
                      {row.side === 'buy' ? '买' : '卖'}
                    </td>
                    <td className="px-2 py-2 text-console-muted">
                      {row.type === 'market' ? '市价' : row.type === 'limit' ? '限价' : '停损'}
                    </td>
                    <td className="num px-2 py-2 text-right text-console-muted">
                      {fmtVolume(row.volume, 0.01)}
                    </td>
                    <td className="num px-2 py-2 text-right text-console-ink-2">
                      {row.requested_price == null
                        ? '—'
                        : fmtPrice(row.requested_price, digitsFor(row.symbol))}
                      {' → '}
                      {row.fill_price == null ? '—' : fmtPrice(row.fill_price, digitsFor(row.symbol))}
                    </td>
                    <td className="num px-2 py-2 text-right text-console-muted">
                      {fmtNumber(row.spread_points, 1)}
                    </td>
                    <td
                      className={clsx(
                        'num px-2 py-2 text-right',
                        row.slippage_points != null && row.slippage_points > 0
                          ? 'text-console-warn'
                          : 'text-console-muted',
                      )}
                    >
                      {row.slippage_points == null ? '—' : row.slippage_points.toFixed(2)}
                    </td>
                    <td className="num px-2 py-2 text-right text-console-muted">
                      {row.latency_ms == null ? '—' : `${row.latency_ms} ms`}
                    </td>
                    <td className="max-w-[240px] px-5 py-2">
                      <span
                        className={clsx(
                          row.state === 'rejected'
                            ? 'text-console-loss'
                            : row.state === 'unknown'
                              ? 'text-console-warn'
                              : 'text-console-gain',
                        )}
                      >
                        {STATE_TEXT[row.state]}
                      </span>
                      {row.reason && (
                        <span className="ml-1 break-all text-console-muted" title={row.reason}>
                          {row.reason.slice(0, 40)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
                {(stats?.rows.length ?? 0) === 0 && (
                  <tr>
                    <td colSpan={10} className="px-5 py-10 text-center text-[11px] text-console-faint">
                      {loading ? '读取中…' : '暂无请求记录'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <p className="mt-4 text-[10px] leading-relaxed text-console-faint">
          滑点 = 市价成交价相对下单瞬间报价的偏移，正数表示对你不利；延迟是网关发出 order_send
          到拿到券商回执的时间，不含前端和网络往返。
        </p>
      </div>
    </div>
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
    <div className="console-card px-4 py-3.5">
      <div className="text-[10.5px] text-console-muted">{label}</div>
      <div className={clsx('num mt-1 text-[20px] font-semibold tracking-tight', tone)}>{value}</div>
      <div className="mt-0.5 truncate text-[9.5px] text-console-faint">{hint ?? ' '}</div>
    </div>
  );
}
