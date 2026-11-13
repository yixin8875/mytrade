import { useEffect, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { ShieldCheck } from 'lucide-react';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import { fmtMoney, fmtSigned, signedClass } from '../lib/format';
import type {
  JournalBreakdown,
  JournalExecutionCross,
  JournalRStats,
  JournalStats,
  JournalTemplateStats,
} from '../gateway/types';

const RANGES = [7, 30, 90];

type CurveMode = 'pnl' | 'r';

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

function fmtR(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}R`;
}

function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(1)}%`;
}

function fmtPoints(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)} 点`;
}

/** 统计报表页：区间汇总、盈亏 / R 曲线、模板执行与分组表现 */
export function ReportsView() {
  const setPage = useApp((s) => s.setPage);
  const activeLogin = useApp((s) => s.account?.login ?? 0);

  const [days, setDays] = useState(30);
  const [mode, setMode] = useState<CurveMode>('pnl');
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
  const r: JournalRStats | undefined = stats?.r;
  const curve = stats?.curve ?? [];
  const rCurve = stats?.rCurve ?? [];
  const points = useMemo(
    () =>
      (mode === 'pnl' ? curve : rCurve).map((point) => ({ t: point.t, value: point.cum })),
    [mode, curve, rCurve],
  );
  const empty = !loading && (!summary || summary.trades === 0);
  const noR = !loading && rCurve.length === 0;

  return (
    <div className="console-scope h-full min-h-0 overflow-auto bg-console-canvas">
      <div className="mx-auto w-full max-w-[1240px] px-8 py-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-medium tracking-[-0.01em]">统计报表</h1>
            <p className="mt-1.5 text-[13px] text-console-muted">
              以已平仓交易为准，按区间汇总胜率、盈亏、R 与模板执行
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

        <div className="readout mt-3 grid-cols-2 lg:grid-cols-4">
          <Metric
            label="平均 R"
            value={fmtR(r?.avgR)}
            tone={r?.avgR != null ? signedClass(r.avgR) : undefined}
            hint={
              r && r.trades > 0
                ? `${r.trades} 笔可折算 · 覆盖 ${fmtPct(r.coverage)}`
                : '下单带止损后自动统计'
            }
          />
          <Metric
            label="累计 R"
            value={fmtR(r?.totalR)}
            tone={r && r.trades > 0 ? signedClass(r.totalR) : undefined}
            hint={r && r.trades > 0 ? `最好 ${fmtR(r.bestR)} / 最差 ${fmtR(r.worstR)}` : undefined}
          />
          <Metric
            label="R 回撤"
            value={r ? `${r.maxDrawdownR.toFixed(2)}R` : '—'}
            tone={r && r.maxDrawdownR > 0 ? 'text-console-loss' : undefined}
            hint="按累计 R 的峰值回落"
          />
          <Metric
            label="1R 到达率"
            value={fmtPct(r?.hit1R)}
            hint="最高浮盈 ≥ 初始风险的占比"
          />
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(280px,1fr)]">
          <section className="console-card overflow-hidden">
            <div className="flex items-baseline justify-between gap-4 border-b border-console-line px-5 py-4">
              <div>
                <div className="flex items-center gap-2.5">
                  <span className="text-[13px] font-semibold">
                    {mode === 'pnl' ? '累计盈亏曲线' : '累计 R 曲线'}
                  </span>
                  <div className="flex items-center gap-0.5 rounded-md border border-console-line p-0.5">
                    {(
                      [
                        ['pnl', '盈亏'],
                        ['r', 'R'],
                      ] as [CurveMode, string][]
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        onClick={() => setMode(value)}
                        className={clsx(
                          'rounded px-2 py-0.5 text-[11px] transition-colors',
                          mode === value
                            ? 'bg-console-hover font-medium text-console-ink'
                            : 'text-console-muted hover:text-console-ink',
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="mt-1 text-[12px] text-console-muted">
                  {mode === 'pnl' ? '按平仓顺序累计' : '按初始风险折算，仅统计带止损的交易'}
                </div>
              </div>
              <div className="flex items-baseline gap-4 text-[12px] text-console-muted">
                <span>
                  最大回撤
                  <span className="num ml-1.5 font-mono text-console-ink-2">
                    {mode === 'pnl'
                      ? summary
                        ? fmtMoney(summary.maxDrawdown)
                        : '—'
                      : `${(r?.maxDrawdownR ?? 0).toFixed(2)}R`}
                  </span>
                </span>
                <span
                  className={clsx(
                    'num font-mono text-[13px] font-medium',
                    mode === 'pnl'
                      ? summary
                        ? signedClass(summary.netPnl)
                        : ''
                      : r
                        ? signedClass(r.totalR)
                        : '',
                  )}
                >
                  {mode === 'pnl'
                    ? summary
                      ? fmtSigned(summary.netPnl)
                      : ''
                    : fmtR(r?.totalR)}
                </span>
              </div>
            </div>

            <div className="px-5 pb-4 pt-4">
              {(mode === 'pnl' ? empty : noR) ? (
                <div className="flex h-[260px] items-center justify-center px-8 text-center text-[12px] text-console-faint">
                  {loading
                    ? '读取中…'
                    : mode === 'pnl'
                      ? '这段时间还没有已平仓交易'
                      : '还没有可用的 R 数据：下单时带止损的交易会自动折算 R'}
                </div>
              ) : (
                <CurveChart points={points} mode={mode} loading={loading} />
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

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <TemplateCard data={stats?.template} loading={loading} />
          <ExecutionCrossCard data={stats?.execution} loading={loading} />
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
          <BreakdownCard title="按品种" rows={stats?.bySymbol ?? []} loading={loading} />
          <BreakdownCard title="按时段" rows={stats?.byHour ?? []} loading={loading} />
          <BreakdownCard title="按策略标签" rows={stats?.byTag ?? []} loading={loading} />
          <BreakdownCard title="按持仓时长" rows={stats?.byDuration ?? []} loading={loading} />
        </div>

        <p className="mt-4 text-[11px] text-console-faint">
          统计区间按平仓时间计算；未标记策略的交易归入「未标记」。R 用下单时的止损距离折算，
          没有记录止损的交易不计入 R 与模板执行统计。
        </p>
      </div>
    </div>
  );
}

function CurveChart({
  points,
  mode,
  loading,
}: {
  points: { t: number; value: number }[];
  mode: CurveMode;
  loading: boolean;
}) {
  const W = 900;
  const H = 260;
  const PAD = 16;

  const geometry = useMemo(() => {
    if (points.length === 0) return null;
    const values = points.map((point) => point.value);
    const min = Math.min(0, ...values);
    const max = Math.max(0, ...values);
    const span = max - min || 1;
    const stepX = points.length > 1 ? (W - PAD * 2) / (points.length - 1) : 0;
    const y = (value: number) => PAD + (1 - (value - min) / span) * (H - PAD * 2);
    const line = points.map((point, index) => `${PAD + index * stepX},${y(point.value)}`).join(' ');
    const lastX = PAD + (points.length - 1) * stepX;
    const area = `${PAD},${y(0)} ${line} ${lastX},${y(0)}`;
    return {
      line,
      area,
      zeroY: y(0),
      first: points[0]?.t ?? 0,
      end: points[points.length - 1]?.t ?? 0,
      lastValue: values[values.length - 1],
      min,
      max,
    };
  }, [points]);

  const show = (value: number) => (mode === 'pnl' ? fmtSigned(value) : fmtR(value));

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
        aria-label={mode === 'pnl' ? '累计盈亏曲线' : '累计 R 曲线'}
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
          {mode === 'pnl' ? '最高' : '最好'} {show(geometry.max)} ·{' '}
          {mode === 'pnl' ? '最低' : '最差'} {show(geometry.min)}
        </span>
        <span className={clsx('num font-mono font-medium', signedClass(geometry.lastValue))}>
          {show(geometry.lastValue)}
        </span>
        <span className="font-mono">{fmtDay(geometry.end)}</span>
      </div>
    </div>
  );
}

function TemplateCard({
  data,
  loading,
}: {
  data: JournalTemplateStats | undefined;
  loading: boolean;
}) {
  const planned = data?.planned ?? 0;

  return (
    <section className="console-card flex flex-col overflow-hidden">
      <div className="flex items-baseline justify-between gap-4 border-b border-console-line px-5 py-4">
        <div>
          <div className="text-[13px] font-semibold">模板执行</div>
          <div className="mt-1 text-[12px] text-console-muted">分批止盈计划实际走到了哪一步</div>
        </div>
        <span className="num font-mono text-[11px] text-console-faint">{planned} 笔计划</span>
      </div>
      {planned === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 py-10 text-center text-[12px] text-console-faint">
          {loading ? '读取中…' : '这个区间没有使用分批止盈模板的交易'}
        </div>
      ) : (
        <div className="flex-1 divide-y divide-console-line/70 px-5">
          <InfoRow label="到达 1R" value={`${data?.reached1R ?? 0} 笔`} />
          <InfoRow
            label="1R 后移保本"
            value={
              data?.breakevenRate != null
                ? `${data.breakeven} 笔 · ${fmtPct(data.breakevenRate)}`
                : `${data?.breakeven ?? 0} 笔`
            }
          />
          <InfoRow
            label="移保本后未亏"
            value={
              data?.heldRate != null
                ? `${data.held} 笔 · ${fmtPct(data.heldRate)}`
                : `${data?.held ?? 0} 笔`
            }
            tone={data?.heldRate != null && data.heldRate >= 50 ? 'text-console-gain' : undefined}
          />
          <InfoRow
            label="计划交易平均 R"
            value={fmtR(data?.avgR)}
            tone={data?.avgR != null ? signedClass(data.avgR) : undefined}
          />
        </div>
      )}
      <p className="px-5 pb-4 pt-3 text-[11px] text-console-faint">
        来自下单时的分批止盈计划与模板执行事件；未带止损的交易不计入。
      </p>
    </section>
  );
}

function ExecutionCrossCard({
  data,
  loading,
}: {
  data: JournalExecutionCross | undefined;
  loading: boolean;
}) {
  const matched = data?.matched ?? 0;

  return (
    <section className="console-card flex flex-col overflow-hidden">
      <div className="flex items-baseline justify-between gap-4 border-b border-console-line px-5 py-4">
        <div>
          <div className="text-[13px] font-semibold">执行成本</div>
          <div className="mt-1 text-[12px] text-console-muted">入场点差 / 滑点与输赢的对照</div>
        </div>
        <span className="num font-mono text-[11px] text-console-faint">{matched} 笔可对照</span>
      </div>
      {matched === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 py-10 text-center text-[12px] text-console-faint">
          {loading ? '读取中…' : '还没有可对照的入场执行记录'}
        </div>
      ) : (
        <div className="flex-1 divide-y divide-console-line/70 px-5">
          <InfoRow
            label={`盈利单 · ${data?.wins.trades ?? 0} 笔`}
            value={`滑点 ${fmtPoints(data?.wins.avgSlippage)} · 点差 ${fmtPoints(
              data?.wins.avgSpread,
            )}`}
          />
          <InfoRow
            label={`亏损单 · ${data?.losses.trades ?? 0} 笔`}
            value={`滑点 ${fmtPoints(data?.losses.avgSlippage)} · 点差 ${fmtPoints(
              data?.losses.avgSpread,
            )}`}
          />
          <InfoRow label="对照覆盖" value={`${matched} 笔入场记录`} />
        </div>
      )}
      <p className="px-5 pb-4 pt-3 text-[11px] text-console-faint">
        只统计有入场成交记录的市价单；样本较小时差异不足以说明问题。
      </p>
    </section>
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
            <div className="relative">
              <div className="flex items-center gap-2 text-[12px]">
                <span className="w-16 shrink-0 truncate font-medium text-console-ink">
                  {row.key}
                </span>
                <span className="num w-12 shrink-0 text-right font-mono text-[11px] text-console-muted">
                  {row.trades} 笔
                </span>
                <span className="num w-10 shrink-0 text-right font-mono text-[11px] text-console-muted">
                  {row.winRate.toFixed(0)}%
                </span>
                <span
                  className={clsx(
                    'num flex-1 text-right font-mono font-medium',
                    signedClass(row.pnl),
                  )}
                >
                  {fmtSigned(row.pnl)}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 pl-[72px] text-[10.5px] text-console-faint">
                <span>每笔 {row.expectancy != null ? fmtSigned(row.expectancy) : '—'}</span>
                {row.avgR != null && <span>· 均 {fmtR(row.avgR)}</span>}
              </div>
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
