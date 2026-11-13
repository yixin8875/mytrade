import { useEffect, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { ShieldCheck } from 'lucide-react';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import { fmtMoney, fmtSigned, signedClass } from '../lib/format';
import type { JournalBreakdown, JournalStats } from '../gateway/types';

const RANGES = [7, 30, 90];

function fmtDay(ts: number): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  if (sec < 60) return `${Math.round(sec)}秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)}分`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}时${Math.floor((sec % 3600) / 60)}分`;
  return `${Math.floor(sec / 86400)}天`;
}

/** 统计报表页：区间汇总、累计盈亏曲线与分品种 / 时段 / 策略表现 */
export function ReportsView() {
  const setPage = useApp((s) => s.setPage);
  const activeLogin = useApp((s) => s.account?.login ?? 0);

  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<JournalStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    gateway
      .call<JournalStats>('journal.stats', { days })
      .then((next) => {
        if (!alive) return;
        setStats(next);
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
  }, [days, activeLogin]);

  const summary = stats?.summary;
  const curve = stats?.curve ?? [];
  const empty = !loading && (!summary || summary.trades === 0);

  return (
    <div className="console-scope h-full min-h-0 overflow-auto bg-console-canvas">
      <div className="mx-auto w-full max-w-[1240px] px-8 py-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-medium tracking-[-0.01em]">统计报表</h1>
            <p className="mt-1.5 text-[13px] text-console-muted">
              以已平仓交易为准，按区间汇总胜率、盈亏与执行表现
            </p>
          </div>
          <div className="flex items-center gap-2">
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
            <button
              onClick={() => setPage('executions')}
              className="console-btn console-btn-secondary"
            >
              <ShieldCheck size={14} strokeWidth={1.5} />
              执行质量
            </button>
          </div>
        </header>

        {error && (
          <div className="mt-4 rounded-lg border border-console-loss/30 bg-console-loss-soft px-3 py-2 text-[12px] text-console-loss">
            读取统计失败：{error}
          </div>
        )}

        <div className="readout mt-6 grid-cols-2 lg:grid-cols-4">
          <Metric
            label="净盈亏"
            value={summary ? fmtSigned(summary.netPnl) : '—'}
            tone={summary ? signedClass(summary.netPnl) : undefined}
            hint={summary ? `${summary.trades} 笔交易` : undefined}
          />
          <Metric
            label="胜率"
            value={summary?.winRate != null ? `${summary.winRate.toFixed(1)}%` : '—'}
            hint={summary ? `${summary.wins} 胜 / ${summary.losses} 负` : undefined}
          />
          <Metric
            label="盈亏比"
            value={summary?.profitFactor != null ? summary.profitFactor.toFixed(2) : '—'}
            hint={
              summary
                ? `平均盈利 ${fmtMoney(summary.avgWin ?? 0)} / 亏损 ${fmtMoney(summary.avgLoss ?? 0)}`
                : undefined
            }
          />
          <Metric
            label="期望 / 笔"
            value={summary?.expectancy != null ? fmtSigned(summary.expectancy) : '—'}
            tone={summary?.expectancy != null ? signedClass(summary.expectancy) : undefined}
            hint={
              summary
                ? `最好 ${fmtSigned(summary.bestTrade ?? 0)} / 最差 ${fmtSigned(summary.worstTrade ?? 0)}`
                : undefined
            }
          />
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(280px,1fr)]">
          <section className="console-card overflow-hidden">
            <div className="flex items-baseline justify-between gap-4 border-b border-console-line px-5 py-4">
              <div>
                <div className="text-[13px] font-semibold">累计盈亏曲线</div>
                <div className="mt-1 text-[12px] text-console-muted">按平仓顺序累计</div>
              </div>
              <div className="flex items-baseline gap-4 text-[12px] text-console-muted">
                <span>
                  最大回撤
                  <span className="num ml-1.5 font-mono text-console-ink-2">
                    {summary ? fmtMoney(summary.maxDrawdown) : '—'}
                  </span>
                </span>
                <span className={clsx('num font-mono text-[13px] font-medium', summary ? signedClass(summary.netPnl) : '')}>
                  {summary ? fmtSigned(summary.netPnl) : ''}
                </span>
              </div>
            </div>

            <div className="px-5 pb-4 pt-4">
              {empty ? (
                <div className="flex h-[260px] items-center justify-center text-[12px] text-console-faint">
                  {loading ? '读取中…' : '这段时间还没有已平仓交易'}
                </div>
              ) : (
                <EquityCurve curve={curve} loading={loading} />
              )}
            </div>
          </section>

          <section className="console-card flex flex-col overflow-hidden">
            <div className="border-b border-console-line px-5 py-4 text-[13px] font-semibold">
              区间概览
            </div>
            <div className="flex-1 divide-y divide-console-line/70 px-5">
              <InfoRow label="交易笔数" value={summary ? String(summary.trades) : '—'} />
              <InfoRow
                label="毛利 / 毛损"
                value={
                  summary
                    ? `${fmtMoney(summary.grossProfit)} / ${fmtMoney(summary.grossLoss)}`
                    : '—'
                }
              />
              <InfoRow
                label="平均持仓"
                value={summary ? fmtDuration(summary.avgDurationSec) : '—'}
              />
              <InfoRow
                label="平均盈利"
                value={summary?.avgWin != null ? fmtSigned(summary.avgWin) : '—'}
                tone={summary?.avgWin != null ? signedClass(summary.avgWin) : undefined}
              />
              <InfoRow
                label="平均亏损"
                value={summary?.avgLoss != null ? fmtSigned(summary.avgLoss) : '—'}
                tone={summary?.avgLoss != null ? signedClass(summary.avgLoss) : undefined}
              />
              <InfoRow
                label="最大回撤"
                value={summary ? fmtMoney(summary.maxDrawdown) : '—'}
                tone={summary && summary.maxDrawdown > 0 ? 'text-console-loss' : undefined}
              />
            </div>
            <button
              onClick={() => setPage('executions')}
              className="m-3 flex items-center justify-center gap-1.5 rounded-lg border border-console-line bg-console-card py-2 text-[12px] text-console-ink-2 transition-colors hover:bg-console-hover"
            >
              查看执行质量（点差 / 滑点 / 延迟）
            </button>
          </section>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <BreakdownCard title="按品种" rows={stats?.bySymbol ?? []} loading={loading} />
          <BreakdownCard title="按时段" rows={stats?.byHour ?? []} loading={loading} />
          <BreakdownCard title="按策略标签" rows={stats?.byTag ?? []} loading={loading} />
        </div>

        <p className="mt-4 text-[11px] text-console-faint">
          统计区间按平仓时间计算；未标记策略的交易归入「未标记」。
        </p>
      </div>
    </div>
  );
}

function EquityCurve({
  curve,
  loading,
}: {
  curve: { t: number; pnl: number; cum: number }[];
  loading: boolean;
}) {
  const W = 900;
  const H = 260;
  const PAD = 16;

  const geometry = useMemo(() => {
    if (curve.length === 0) return null;
    const values = curve.map((point) => point.cum);
    const min = Math.min(0, ...values);
    const max = Math.max(0, ...values);
    const span = max - min || 1;
    const stepX = curve.length > 1 ? (W - PAD * 2) / (curve.length - 1) : 0;
    const y = (value: number) => PAD + (1 - (value - min) / span) * (H - PAD * 2);
    const points = curve.map((point, index) => `${PAD + index * stepX},${y(point.cum)}`);
    const line = points.join(' ');
    const lastX = PAD + (curve.length - 1) * stepX;
    const area = `${PAD},${y(0)} ${line} ${lastX},${y(0)}`;
    return {
      line,
      area,
      zeroY: y(0),
      first: curve[0]?.t ?? 0,
      end: curve[curve.length - 1]?.t ?? 0,
      lastValue: values[values.length - 1],
      min,
      max,
    };
  }, [curve]);

  if (!geometry) {
    return (
      <div className="flex h-[260px] items-center justify-center text-[12px] text-console-faint">
        {loading ? '读取中…' : '暂无曲线数据'}
      </div>
    );
  }

  const gain = geometry.lastValue >= 0;

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-[260px] w-full"
        role="img"
        aria-label="累计盈亏曲线"
      >
        {[0.25, 0.5, 0.75].map((t) => (
          <line
            key={t}
            x1={PAD}
            x2={W - PAD}
            y1={PAD + t * (H - PAD * 2)}
            y2={PAD + t * (H - PAD * 2)}
            stroke="var(--color-console-line)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <line
          x1={PAD}
          x2={W - PAD}
          y1={geometry.zeroY}
          y2={geometry.zeroY}
          stroke="var(--color-console-line-2)"
          strokeWidth="1"
          strokeDasharray="4 4"
          vectorEffect="non-scaling-stroke"
        />
        <polygon
          points={geometry.area}
          fill={gain ? 'var(--color-console-gain-soft)' : 'var(--color-console-loss-soft)'}
          opacity="0.7"
        />
        <polyline
          points={geometry.line}
          fill="none"
          stroke={gain ? 'var(--color-console-gain)' : 'var(--color-console-loss)'}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="mt-2 flex items-center justify-between text-[11px] text-console-faint">
        <span className="font-mono">{fmtDay(geometry.first)}</span>
        <span className="font-mono">
          最高 {fmtSigned(geometry.max)} · 最低 {fmtSigned(geometry.min)}
        </span>
        <span className={clsx('num font-mono font-medium', signedClass(geometry.lastValue))}>
          {fmtSigned(geometry.lastValue)}
        </span>
        <span className="font-mono">{fmtDay(geometry.end)}</span>
      </div>
    </div>
  );
}

function BreakdownCard({
  title,
  rows,
  loading,
}: {
  title: string;
  rows: JournalBreakdown[];
  loading: boolean;
}) {
  const max = rows.reduce((value, row) => Math.max(value, Math.abs(row.pnl)), 0);

  return (
    <section className="console-card overflow-hidden">
      <div className="flex items-baseline justify-between border-b border-console-line px-5 py-3.5">
        <span className="text-[13px] font-semibold">{title}</span>
        <span className="num font-mono text-[11px] text-console-faint">{rows.length} 组</span>
      </div>
      <div className="p-2">
        {rows.length === 0 && (
          <div className="px-2 py-8 text-center text-[12px] text-console-faint">
            {loading ? '读取中…' : '暂无数据'}
          </div>
        )}
        {rows.map((row) => (
          <div key={row.key} className="relative rounded-lg px-2.5 py-2">
            <div
              className={clsx(
                'absolute inset-y-1 left-0 rounded-sm opacity-70',
                row.pnl >= 0 ? 'bg-console-gain-soft' : 'bg-console-loss-soft',
              )}
              style={{ width: max > 0 ? `${(Math.abs(row.pnl) / max) * 100}%` : '0%' }}
            />
            <div className="relative flex items-center gap-2 text-[12px]">
              <span className="w-16 shrink-0 truncate font-medium text-console-ink">
                {row.key}
              </span>
              <span className="num w-12 shrink-0 text-right font-mono text-[11px] text-console-muted">
                {row.trades} 笔
              </span>
              <span className="num w-10 shrink-0 text-right font-mono text-[11px] text-console-muted">
                {row.winRate.toFixed(0)}%
              </span>
              <span className={clsx('num flex-1 text-right font-mono font-medium', signedClass(row.pnl))}>
                {fmtSigned(row.pnl)}
              </span>
            </div>
          </div>
        ))}
      </div>
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
      <div className="text-[12px] text-console-muted">{label}</div>
      <div
        className={clsx(
          'num mt-1.5 font-mono text-[24px] font-medium leading-none tracking-[-0.01em]',
          tone,
        )}
      >
        {value}
      </div>
      <div className="mt-2 truncate text-[11px] text-console-faint">{hint ?? ' '}</div>
    </div>
  );
}

function InfoRow({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-center justify-between py-3 text-[12px]">
      <span className="text-console-muted">{label}</span>
      <span className={clsx('num font-mono font-medium text-console-ink', tone)}>{value}</span>
    </div>
  );
}
