import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
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
import { fmtR } from '../lib/review';
import { fmtSigned, signedClass } from '../lib/format';
import {
  ROLLING_WINDOW,
  durationScale,
  durationTicks,
  rollingAverage,
  sampleNotice,
  scatterPoints,
  winFlags,
} from '../lib/trends';
import { useApp } from '../store/useApp';
import { useTradeReplay } from '../replay/useTradeReplay';
import type { JournalRecord, TrendSeries, TrendTrade } from '../gateway/types';

/** 绩效趋势与交易散点：20 笔滚动胜率 / 期望，以及持仓时长 × R 的分布 */
export function TrendsSection({
  series,
  loading,
  days,
}: {
  series: TrendSeries | null;
  loading: boolean;
  days: number;
}) {
  const activeLogin = useApp((s) => s.account?.login ?? 0);

  const trades = useMemo(() => series?.trades ?? [], [series]);
  const rTrades = useMemo(() => trades.filter((trade) => trade.r != null), [trades]);

  const winSeries = useMemo(
    () => rollingAverage(winFlags(trades), ROLLING_WINDOW),
    [trades],
  );
  const expectancySeries = useMemo(
    () => rollingAverage(trades.map((trade) => trade.profit), ROLLING_WINDOW),
    [trades],
  );
  const rSeries = useMemo(
    () => rollingAverage(rTrades.map((trade) => trade.r as number), ROLLING_WINDOW),
    [rTrades],
  );

  const scatter = useMemo(() => scatterPoints(trades), [trades]);
  const rollingNotice = sampleNotice(trades.length, 'rolling');
  const rNotice = sampleNotice(rTrades.length, 'rollingR');
  const scatterNotice = sampleNotice(scatter.length, 'scatter');

  return (
    <section className="mt-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-[16px] font-medium tracking-[-0.01em]">绩效趋势</h2>
          <p className="mt-1.5 text-[13px] text-muted-foreground">
            最近 {days} 天 · {trades.length} 笔 · 其中 {rTrades.length} 笔有止损可折算 R
            {activeLogin ? ` · 账户 ${activeLogin}` : ''}
          </p>
        </div>
      </header>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
          <RollCard
            title="滚动胜率"
            hint={`最近 ${ROLLING_WINDOW} 笔`}
            series={winSeries}
            format={(value) => `${(value * 100).toFixed(0)}%`}
            notice={rollingNotice}
            loading={loading}
            fixedRange={[0, 1]}
            tone="plain"
          />
          <RollCard
            title="滚动期望"
            hint={`最近 ${ROLLING_WINDOW} 笔平均盈亏`}
            series={expectancySeries}
            format={(value) => fmtSigned(value)}
            notice={rollingNotice}
            loading={loading}
            tone="signed"
          />
          <RollCard
            title="滚动平均 R"
            hint={`最近 ${ROLLING_WINDOW} 笔带止损交易`}
            series={rSeries}
            format={(value) => fmtR(value)}
            notice={rNotice}
            loading={loading}
            tone="signed"
          />
      </div>

      <ScatterCard trades={trades} points={scatter} notice={scatterNotice} loading={loading} />

      <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground/60">
        滚动窗口按平仓时间排序；胜率以盈亏 ±0.005 为分界，期望是窗口内平均每笔盈亏。
        R 只用带止损的交易折算，没有止损的交易不参与 R 曲线与散点。
      </p>
    </section>
  );
}

function RollCard({
  title,
  hint,
  series,
  format,
  notice,
  loading,
  fixedRange,
  tone,
}: {
  title: string;
  hint: string;
  series: { index: number; value: number }[];
  format: (value: number) => string;
  notice: string | null;
  loading: boolean;
  fixedRange?: [number, number];
  tone: 'signed' | 'plain';
}) {
  const last = series.length > 0 ? series[series.length - 1].value : null;

  return (
    <Card className="overflow-hidden">
      <div className="flex items-baseline justify-between border-b border-border px-4 py-3">
        <div>
          <div className="text-[13px] font-medium">{title}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground/60">{hint}</div>
        </div>
        <span
          className={cn(
            'num font-mono text-[15px]',
            tone === 'signed' && last != null ? signedClass(last) : 'text-foreground',
          )}
        >
          {last == null ? '—' : format(last)}
        </span>
      </div>
      {notice ? (
        <div className="flex h-[150px] items-center justify-center px-5 text-center text-[12px] leading-relaxed text-muted-foreground/60">
          {loading ? '读取中…' : notice}
        </div>
      ) : (
        <MiniLine series={series} fixedRange={fixedRange} tone={tone} />
      )}
    </Card>
  );
}

function MiniLine({
  series,
  fixedRange,
  tone,
}: {
  series: { index: number; value: number }[];
  fixedRange?: [number, number];
  tone: 'signed' | 'plain';
}) {
  const W = 320;
  const H = 150;
  const PAD = 12;
  const values = series.map((point) => point.value);
  const min = fixedRange ? fixedRange[0] : Math.min(0, ...values);
  const max = fixedRange ? fixedRange[1] : Math.max(0, ...values);
  const span = max - min || 1;
  const stepX = series.length > 1 ? (W - PAD * 2) / (series.length - 1) : 0;
  const y = (value: number) => PAD + (1 - (value - min) / span) * (H - PAD * 2);
  const line = series
    .map((point, index) => `${PAD + index * stepX},${y(point.value)}`)
    .join(' ');
  const lastValue = values[values.length - 1];
  const color =
    tone === 'signed'
      ? lastValue >= 0
        ? 'var(--success-foreground)'
        : 'var(--destructive-foreground)'
      : 'var(--brand)';
  const zero = Math.min(Math.max(0, min), max);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="h-[150px] w-full"
      role="img"
      aria-label="滚动曲线"
    >
      <line
        x1={PAD}
        x2={W - PAD}
        y1={y(zero)}
        y2={y(zero)}
        stroke="var(--input)"
        strokeDasharray="4 4"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function ScatterCard({
  trades,
  points,
  notice,
  loading,
}: {
  trades: TrendTrade[];
  points: { positionId: number; minutes: number; r: number; win: boolean }[];
  notice: string | null;
  loading: boolean;
}) {
  const W = 900;
  const H = 320;
  const PAD_X = 40;
  const PAD_Y = 18;
  const notify = useApp((s) => s.notify);
  const replay = useTradeReplay();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = trades.find((trade) => trade.positionId === selectedId) ?? null;

  const openReplay = async () => {
    if (!selected) return;
    try {
      const record = await gateway.call<JournalRecord>('journal.get', {
        positionId: selected.positionId,
      });
      replay.start(record);
    } catch (err) {
      notify('error', (err as Error).message);
    }
  };

  const geometry = useMemo(() => {
    if (points.length === 0) return null;
    const maxMinutes = Math.max(...points.map((point) => point.minutes));
    const rValues = points.map((point) => point.r);
    const minR = Math.min(0, ...rValues);
    const maxR = Math.max(0, ...rValues);
    const spanR = maxR - minR || 1;
    const maxX = durationScale(maxMinutes) || 1;
    const x = (minutes: number) => PAD_X + (durationScale(minutes) / maxX) * (W - PAD_X * 2);
    const y = (r: number) => PAD_Y + (1 - (r - minR) / spanR) * (H - PAD_Y * 2);
    return { x, y, minR, maxR, maxMinutes };
  }, [points]);

  const recent = trades.filter((trade) => trade.r != null).slice(-12).reverse();

  return (
    <Card className="mt-4 overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-5 py-3">
        <div>
          <h2 className="text-[13px] font-medium">交易散点</h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground/60">
            横轴持仓时长（平方根刻度），纵轴实现 R；绿点盈利，红点亏损
          </p>
        </div>
        <span className="num font-mono text-[11px] text-muted-foreground">{points.length} 个点</span>
      </div>

      {notice ? (
        <div className="px-5 py-6">
          <p className="text-[12px] text-muted-foreground/60">{loading ? '读取中…' : notice}</p>
          {recent.length > 0 && (
            <Table className="mt-3 w-full text-[11px]">
              <TableHeader>
                <TableRow className="border-0 text-left text-muted-foreground/60 hover:bg-transparent">
                  <TableHead className="h-auto py-1 font-normal">交易</TableHead>
                  <TableHead className="h-auto py-1 font-normal">时长</TableHead>
                  <TableHead className="h-auto py-1 text-right font-normal">R</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.map((trade) => (
                  <TableRow key={trade.positionId} className="border-t border-border/50">
                    <TableCell className="py-1">
                      {trade.symbol} · {trade.side === 'buy' ? '多' : '空'}
                    </TableCell>
                    <TableCell className="py-1 font-mono">
                      {formatMinutes(trade.durationSec)}
                    </TableCell>
                    <TableCell
                      className={cn('py-1 text-right font-mono', signedClass(trade.r ?? 0))}
                    >
                      {fmtR(trade.r)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      ) : (
        <div className="px-5 py-4">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="h-[320px] w-full"
            role="img"
            aria-label="持仓时长与 R 的散点图"
          >
            {[0.25, 0.5, 0.75].map((t) => (
              <line
                key={t}
                x1={PAD_X}
                x2={W - PAD_X}
                y1={PAD_Y + t * (H - PAD_Y * 2)}
                y2={PAD_Y + t * (H - PAD_Y * 2)}
                stroke="var(--border)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {geometry && (
              <>
                <line
                  x1={PAD_X}
                  x2={W - PAD_X}
                  y1={geometry.y(0)}
                  y2={geometry.y(0)}
                  stroke="var(--input)"
                  strokeDasharray="4 4"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
                {durationTicks(geometry.maxMinutes).map((tick) => (
                  <line
                    key={tick.minutes}
                    x1={geometry.x(tick.minutes)}
                    x2={geometry.x(tick.minutes)}
                    y1={PAD_Y}
                    y2={H - PAD_Y}
                    stroke="var(--border)"
                    strokeWidth="1"
                    strokeDasharray="2 6"
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                {points.map((point) => (
                  <g
                    key={point.positionId}
                    onClick={() =>
                      setSelectedId((current) =>
                        current === point.positionId ? null : point.positionId,
                      )
                    }
                    style={{ cursor: 'pointer' }}
                  >
                    <circle
                      cx={geometry.x(point.minutes)}
                      cy={geometry.y(point.r)}
                      r={10}
                      fill="transparent"
                    />
                    <circle
                      cx={geometry.x(point.minutes)}
                      cy={geometry.y(point.r)}
                      r={selectedId === point.positionId ? 5 : 3}
                      fill={point.win ? 'var(--success-foreground)' : 'var(--destructive-foreground)'}
                      opacity={selectedId === point.positionId ? 1 : 0.75}
                    />
                  </g>
                ))}
              </>
            )}
          </svg>
          <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground/60">
            <div className="flex gap-3">
              {geometry &&
                durationTicks(geometry.maxMinutes).map((tick) => (
                  <span key={tick.minutes} className="font-mono">
                    {tick.label}
                  </span>
                ))}
            </div>
            <div className="flex gap-3 font-mono">
              <span>{fmtR(geometry?.maxR ?? 0)}</span>
              <span>{fmtR(geometry?.minR ?? 0)}</span>
            </div>
          </div>
          {selected ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-border bg-sidebar px-3 py-2">
              <div className="text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground">
                  {selected.symbol} · {selected.side === 'buy' ? '多' : '空'}
                </span>{' '}
                · 持仓 {formatMinutes(selected.durationSec)} · R {fmtR(selected.r)} ·{' '}
                <span className={signedClass(selected.profit)}>{fmtSigned(selected.profit)}</span>
              </div>
              <div className="flex items-center gap-2">
                <Button onClick={() => setSelectedId(null)} size="xs" variant="outline">
                  收起
                </Button>
                <Button onClick={() => void openReplay()} size="xs" variant="outline">
                  在回放中打开
                </Button>
              </div>
            </div>
          ) : (
            <p className="mt-2 text-[10px] text-muted-foreground/60">
              点一个散点查看这笔交易，并可直接打开当时的回放。
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

function formatMinutes(seconds: number | null): string {
  if (seconds == null || seconds <= 0) return '—';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.round(hours / 24)} 天`;
}
