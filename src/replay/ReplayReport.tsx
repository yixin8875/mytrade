import { useMemo } from 'react';
import { ArrowLeft, Download, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { fmtMoney, fmtPrice, fmtSigned, fmtVolume } from '../lib/format';
import { usePrivacyMask } from '../lib/privacy';
import { useApp, type Page } from '../store/useApp';
import { calculateStats } from './engine';
import { goReplayList, goReplaySession } from './route';
import { clearReplayBack, getReplayBack } from './back';
import { useReplay, useReplaySession } from './store';
import { fmtDate, fmtDateTime, fmtShort } from './time';
import type { ReplaySession, ReplayStats } from './types';

function pnlClass(value: number): string {
  return value > 0 ? 'text-success-foreground' : value < 0 ? 'text-destructive-foreground' : 'text-muted-foreground';
}

function closedByText(reason: ReplaySession['trades'][number]['closedBy']): string {
  if (reason === 'sl') return '止损';
  if (reason === 'tp') return '止盈';
  if (reason === 'manual') return '手动';
  if (reason === 'stop_out') return '强平';
  if (reason === 'template') return '模板';
  return '结束';
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportCsv(session: ReplaySession): void {
  const digits = session.symbolInfo.digits;
  const header = [
    '序号',
    '方向',
    '手数',
    '入场时间',
    '入场价',
    '出场时间',
    '出场价',
    '净盈亏',
    'R',
    '平仓方式',
    '模板',
    '标签',
  ];
  const rows = session.trades.map((trade, index) => [
    index + 1,
    trade.side === 'buy' ? '买入' : '卖出',
    trade.volume.toFixed(2),
    fmtDateTime(trade.openTs),
    trade.entry.toFixed(digits),
    fmtDateTime(trade.closeTs),
    trade.exit.toFixed(digits),
    trade.profit.toFixed(2),
    trade.r == null ? '' : trade.r.toFixed(2),
    closedByText(trade.closedBy),
    trade.templateName ?? '',
    trade.tag,
  ]);
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${session.name.replace(/[\\/:*?"<>|]/g, '-')}-复盘.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function EquityCurve({ session }: { session: ReplaySession }) {
  const curve = session.equityCurve;
  const initial = session.settings.initialBalance;
  const geometry = useMemo(() => {
    if (curve.length < 2) return null;
    const values = curve.map((point) => point.v);
    const min = Math.min(...values, initial);
    const max = Math.max(...values, initial);
    const span = max - min || 1;
    const width = 1000;
    const height = 240;
    const pad = 8;
    const points = curve.map((point, index) => {
      const x = (index / (curve.length - 1)) * width;
      const y = height - pad - ((point.v - min) / span) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const baseline = height - pad - ((initial - min) / span) * (height - pad * 2);
    return {
      points: points.join(' '),
      area: `0,${height} ${points.join(' ')} ${width},${height}`,
      baseline,
      width,
      height,
      min,
      max,
    };
  }, [curve, initial]);

  if (!geometry) {
    return (
      <div className="flex h-[240px] items-center justify-center text-[11px] text-muted-foreground">
        净值点还不够，回放一段后会出现资金曲线
      </div>
    );
  }
  const up = curve[curve.length - 1].v >= initial;
  const stroke = up ? 'var(--color-console-gain)' : 'var(--color-console-loss)';
  const fill = up ? 'var(--color-console-gain-soft)' : 'var(--color-console-loss-soft)';

  return (
    <div className="relative">
      <div className="pointer-events-none absolute left-2 top-0 font-mono text-[10px] text-muted-foreground">
        {fmtMoney(geometry.max)}
      </div>
      <div className="pointer-events-none absolute bottom-5 left-2 font-mono text-[10px] text-muted-foreground">
        {fmtMoney(geometry.min)}
      </div>
      <svg
        viewBox={`0 0 ${geometry.width} ${geometry.height}`}
        className="h-[240px] w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label="模拟净值曲线"
      >
        {[0.25, 0.5, 0.75].map((ratio) => (
          <line
            key={ratio}
            x1={0}
            x2={geometry.width}
            y1={geometry.height * ratio}
            y2={geometry.height * ratio}
            stroke="var(--color-console-line)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <polygon points={geometry.area} fill={fill} opacity={0.7} />
        <line
          x1={0}
          x2={geometry.width}
          y1={geometry.baseline}
          y2={geometry.baseline}
          stroke="var(--color-console-line-2)"
          strokeDasharray="4 4"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        <polyline
          points={geometry.points}
          fill="none"
          stroke={stroke}
          strokeWidth={1.6}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>{curve.length ? fmtShort(curve[0].t) : ''}</span>
        <span>初始 {fmtMoney(initial)}</span>
        <span>{curve.length ? fmtShort(curve[curve.length - 1].t) : ''}</span>
      </div>
    </div>
  );
}

function RHistogram({ stats }: { stats: ReplayStats }) {
  const max = Math.max(1, ...stats.rBins.map((bin) => bin.count));
  return (
    <div className="flex h-[168px] items-end gap-2">
      {stats.rBins.map((bin) => (
        <div
          key={bin.label}
          className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1.5"
        >
          <span className="num font-mono text-[10px] text-muted-foreground">{bin.count}</span>
          <div
            className={cn(
              'w-full rounded-t-[3px]',
              bin.negative ? 'bg-destructive' : 'bg-success',
            )}
            style={{
              height: `${Math.max(bin.count > 0 ? 6 : 2, (bin.count / max) * 132)}px`,
              opacity: bin.count > 0 ? 0.85 : 0.18,
            }}
          />
          <span className="whitespace-nowrap font-mono text-[9px] text-muted-foreground">
            {bin.label}
          </span>
        </div>
      ))}
    </div>
  );
}

const JOURNAL_CLOSED_BY: Record<string, string> = {
  sl: '止损',
  tp: '止盈',
  so: '强平',
  stop_out: '强平',
  manual: '手动',
};

function heldText(sec: number): string {
  const minutes = Math.max(0, Math.round(sec / 60));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

/** 实盘 vs 重演：按 referenceRole 找第一笔重演成交，只做过程对照 */
function ReferenceCompare({ session }: { session: ReplaySession }) {
  const reference = session.reference;
  const currentLogin = useApp((s) => s.account?.login ?? null);
  const retry = session.trades.find((trade) => trade.referenceRole === 'retry') ?? null;
  if (!reference) return null;

  const digits = session.symbolInfo.digits;
  const sideText = (side: string) => (side === 'buy' ? '买入' : '卖出');
  const rows: { label: string; real: string; replay: string }[] = [
    {
      label: '方向 / 手数',
      real: `${sideText(reference.side)} ${fmtVolume(reference.volume)}`,
      replay: retry ? `${sideText(retry.side)} ${fmtVolume(retry.volume)}` : '—',
    },
    {
      label: '入场',
      real: `${fmtPrice(reference.entry, digits)} · ${fmtDateTime(reference.openTs).split(' ').pop()}`,
      replay: retry
        ? `${fmtPrice(retry.entry, digits)} · ${fmtDateTime(retry.openTs).split(' ').pop()}`
        : '—',
    },
    {
      label: '出场',
      real: `${fmtPrice(reference.exit, digits)} · ${fmtDateTime(reference.closeTs).split(' ').pop()}`,
      replay: retry
        ? `${fmtPrice(retry.exit, digits)} · ${fmtDateTime(retry.closeTs).split(' ').pop()}`
        : '—',
    },
    {
      label: 'R',
      real: reference.r == null ? '—' : fmtSigned(reference.r),
      replay: retry && retry.r != null ? fmtSigned(retry.r) : '—',
    },
    {
      label: 'MFE / MAE',
      real: `${fmtMoney(reference.mfe)} / ${fmtMoney(reference.mae)}`,
      replay: retry ? `${fmtMoney(retry.mfe)} / ${fmtMoney(retry.mae)}` : '—',
    },
    {
      label: '持仓时长',
      real: heldText(reference.closeTs - reference.openTs),
      replay: retry ? heldText(retry.closeTs - retry.openTs) : '—',
    },
    {
      label: '出场方式',
      real: reference.closedBy
        ? JOURNAL_CLOSED_BY[reference.closedBy] ?? reference.closedBy
        : '—',
      replay: retry ? closedByText(retry.closedBy) : '—',
    },
  ];

  // 只列差异：完全一致的项收成一行，报告不再重复参照面板的信息
  const same = retry ? rows.filter((row) => row.real === row.replay) : [];
  const shown = retry ? rows.filter((row) => row.real !== row.replay) : rows;

  return (
    <section className="mt-4 rounded-[12px] border border-border bg-card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[12px] font-medium">实盘 vs 重演</h2>
        <span className="font-mono text-[10px] text-muted-foreground">
          实盘 #{reference.positionId}
          {currentLogin != null && currentLogin !== reference.login
            ? ` · 账户 ${reference.login} · 当前终端为 ${currentLogin}`
            : ''}
        </span>
      </div>
      {shown.length > 0 ? (
        <Table className="mt-3 text-[11px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-auto px-0 pb-1.5 text-[10px] font-normal text-muted-foreground">
                差异
              </TableHead>
              <TableHead className="h-auto px-0 pb-1.5 pl-3 text-[10px] font-normal text-muted-foreground">
                实盘
              </TableHead>
              <TableHead className="h-auto px-0 pb-1.5 pl-3 text-[10px] font-normal text-muted-foreground">
                重演
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((row) => (
              <TableRow key={row.label}>
                <TableCell className="px-0 py-1.5 text-muted-foreground">{row.label}</TableCell>
                <TableCell className="num px-0 py-1.5 pl-3 font-mono text-foreground/80">
                  {row.real}
                </TableCell>
                <TableCell className="num px-0 py-1.5 pl-3 font-mono text-foreground/80">
                  {row.replay}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : retry ? (
        <p className="mt-3 text-[11px] text-muted-foreground">
          重演与实盘在方向、手数、入场、出场、R、MFE/MAE、持仓时长与出场方式上完全一致。
        </p>
      ) : null}
      {same.length > 0 && shown.length > 0 && (
        <p className="mt-2 text-[10px] text-muted-foreground/60">
          与实盘一致：{same.map((row) => row.label).join('、')}
        </p>
      )}
      {retry ? (
        <p className="mt-2 text-[10px] leading-4 text-muted-foreground/60">
          实盘含真实滑点、隔夜利息；回放按 M1 保守撮合、不含隔夜利息。只用于过程对照，不能据此断言「实盘比回放差」。
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
          还没有重演成交。回到工作台点「重演这笔」，成交后这里会自动出现对照。
          <Button
            variant="link"
            size="xs"
            onClick={() => goReplaySession(session.id)}
            className="h-auto p-0 text-[10px] font-normal text-brand"
          >
            回到工作台
          </Button>
        </div>
      )}
    </section>
  );
}

export function ReplayReport({ sessionId }: { sessionId: string }) {
  usePrivacyMask();
  const session = useReplaySession(sessionId);
  const duplicateSession = useReplay((s) => s.duplicateSession);
  const restart = useReplay((s) => s.restart);
  const setPage = useApp((s) => s.setPage);
  const setJournalFocus = useApp((s) => s.setJournalFocus);
  const back = useMemo(() => getReplayBack(), [sessionId]);
  const goBack = () => {
    if (!back) return;
    if (back.positionId) setJournalFocus(back.positionId);
    clearReplayBack();
    setPage(back.page as Page);
  };

  const stats = useMemo(() => (session ? calculateStats(session) : null), [session]);

  if (!session || !stats) {
    return (
      <Empty className="h-full bg-sidebar">
        <EmptyHeader>
          <EmptyTitle className="text-[13px] font-medium">复盘会话不存在</EmptyTitle>
          <EmptyContent>
            <Button onClick={goReplayList} className="mt-3">
              返回复盘列表
            </Button>
          </EmptyContent>
        </EmptyHeader>
      </Empty>
    );
  }

  const finished = session.status === 'finished' || session.status === 'archived';
  const digits = session.symbolInfo.digits;
  const equity = session.equity;
  const initial = session.settings.initialBalance;
  const readouts: { label: string; value: string; sub: string; tone?: string }[] = [
    {
      label: '净值变化',
      value: fmtSigned(equity - initial),
      sub: `${fmtMoney(equity)} · ${stats.returnPct >= 0 ? '+' : ''}${stats.returnPct.toFixed(2)}%`,
      tone: pnlClass(equity - initial),
    },
    {
      label: '已平仓净盈亏',
      value: fmtSigned(stats.netPnl),
      sub: `毛利 ${fmtMoney(stats.grossProfit)} · 亏损 ${fmtMoney(stats.grossLoss)}`,
      tone: pnlClass(stats.netPnl),
    },
    {
      label: '胜率',
      value: stats.winRate == null ? '—' : `${(stats.winRate * 100).toFixed(1)}%`,
      sub: `${stats.wins} 胜 / ${stats.losses} 负`,
    },
    {
      label: '平均 R',
      value: stats.avgR == null ? '—' : fmtSigned(stats.avgR),
      sub: `总 R ${stats.avgR == null ? '—' : fmtSigned(stats.totalR)}`,
      tone: stats.avgR == null ? '' : pnlClass(stats.avgR),
    },
    {
      label: '最大回撤',
      value: `-${stats.maxDrawdownPct.toFixed(1)}%`,
      sub: '按净值峰值计算',
      tone: stats.maxDrawdownPct > 0 ? 'text-destructive-foreground' : '',
    },
    {
      label: '交易笔数',
      value: String(stats.trades),
      sub:
        stats.expectancy == null
          ? '没有已平仓交易'
          : `每笔期望 ${fmtSigned(stats.expectancy)}`,
    },
  ];

  return (
    <div className="h-full overflow-auto bg-sidebar">
      <div className="mx-auto w-full max-w-[1180px] px-8 py-7">
        <header className="flex items-start gap-3">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={goReplayList}
                  className="mt-0.5"
                  title="返回复盘列表"
                  aria-label="返回复盘列表"
                />
              }
            >
              <ArrowLeft strokeWidth={1.5} />
            </TooltipTrigger>
            <TooltipPopup>返回复盘列表</TooltipPopup>
          </Tooltip>
          {back && (
            <Button
              variant="outline"
              size="xs"
              onClick={goBack}
              className="mt-0.5 shrink-0 text-[11px] text-foreground/80"
              title={`回到${back.label}`}
            >
              返回{back.label}
            </Button>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-[20px] font-medium leading-tight">{session.name}</h1>
              <Badge variant="outline" size="sm" className="shrink-0 text-[10px]">
                模拟复盘
              </Badge>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <span>{session.symbol}</span>
              <span>
                {fmtDate(session.startTs)} — {fmtDate(session.endTs)}
              </span>
              <span>{session.totalBars.toLocaleString()} 根 M1</span>
              <span>{session.dataSource === 'gateway' ? '网关历史行情' : '演示行情'}</span>
              <span>
                初始 {fmtMoney(initial)} {session.settings.currency} · 1:{session.settings.leverage} ·
                点差 {session.settings.spreadPoints}
              </span>
            </div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => exportCsv(session)}
              disabled={session.trades.length === 0}
            >
              <Download strokeWidth={1.5} />
              导出 CSV
            </Button>
            {finished ? (
              <Button
                onClick={() => {
                  const id = duplicateSession(session.id);
                  if (id) goReplaySession(id);
                }}
              >
                <RotateCcw strokeWidth={1.5} />
                重新挑战
              </Button>
            ) : (
              <Button onClick={() => goReplaySession(session.id)}>继续复盘</Button>
            )}
          </div>
        </header>

        <section className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-[12px] border border-border bg-border md:grid-cols-3 xl:grid-cols-6">
          {readouts.map((item) => (
            <div key={item.label} className="bg-card px-4 py-3.5">
              <div className="text-[10px] text-muted-foreground">{item.label}</div>
              <div
                className={cn(
                  'num mt-1.5 font-mono text-[19px] font-medium leading-none',
                  item.tone,
                )}
              >
                {item.value}
              </div>
              <div className="mt-1.5 truncate text-[10px] text-muted-foreground">{item.sub}</div>
            </div>
          ))}
        </section>

        {session.reference && <ReferenceCompare session={session} />}

        <section className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="rounded-[12px] border border-border bg-card p-5">
            <div className="flex items-baseline justify-between">
              <h2 className="text-[12px] font-medium">模拟净值曲线</h2>
              <span className="text-[10px] text-muted-foreground">
                {session.equityCurve.length.toLocaleString()} 个采样点
              </span>
            </div>
            <div className="mt-3">
              <EquityCurve session={session} />
            </div>
          </div>

          <div className="rounded-[12px] border border-border bg-card p-5">
            <div className="flex items-baseline justify-between">
              <h2 className="text-[12px] font-medium">R 分布</h2>
              <span className="text-[10px] text-muted-foreground">按初始风险归一</span>
            </div>
            <div className="mt-3">
              <RHistogram stats={stats} />
            </div>
          </div>
        </section>

        <section className="mt-4 grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
          <div className="rounded-[12px] border border-border bg-card p-5">
            <h2 className="text-[12px] font-medium">按标签</h2>
            {stats.byTag.length === 0 ? (
              <p className="mt-3 text-[11px] leading-5 text-muted-foreground">
                交易带上标签后，这里会按标签汇总表现。
              </p>
            ) : (
              <Table className="mt-3 text-[11px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="h-auto px-0 pb-1.5 text-[10px] font-normal text-muted-foreground">
                      标签
                    </TableHead>
                    <TableHead className="h-auto px-0 pb-1.5 text-right text-[10px] font-normal text-muted-foreground">
                      笔数
                    </TableHead>
                    <TableHead className="h-auto px-0 pb-1.5 text-right text-[10px] font-normal text-muted-foreground">
                      总 R
                    </TableHead>
                    <TableHead className="h-auto px-0 pb-1.5 text-right text-[10px] font-normal text-muted-foreground">
                      净盈亏
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stats.byTag.map((item) => (
                    <TableRow key={item.tag}>
                      <TableCell className="px-0 py-1.5 text-foreground/80">{item.tag}</TableCell>
                      <TableCell className="num px-0 py-1.5 text-right font-mono text-muted-foreground">
                        {item.trades}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'num px-0 py-1.5 text-right font-mono',
                          pnlClass(item.totalR),
                        )}
                      >
                        {fmtSigned(item.totalR)}
                      </TableCell>
                      <TableCell
                        className={cn('num px-0 py-1.5 text-right font-mono', pnlClass(item.pnl))}
                      >
                        {fmtSigned(item.pnl)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          <div className="min-w-0 rounded-[12px] border border-border bg-card p-5">
            <div className="flex items-baseline justify-between">
              <h2 className="text-[12px] font-medium">交易明细</h2>
              <span className="text-[10px] text-muted-foreground">
                共 {session.trades.length} 笔 · 已扣佣金
              </span>
            </div>
            {session.trades.length === 0 ? (
              <p className="mt-3 text-[11px] leading-5 text-muted-foreground">
                这段回放没有已平仓交易。下次可以先按模板给出一张带止损的单。
              </p>
            ) : (
              <div className="-mx-1 mt-2">
                <Table className="min-w-[800px] text-[11px]">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="h-auto pl-3 pr-1 pb-1.5 text-[10px] font-normal text-muted-foreground">
                        #
                      </TableHead>
                      <TableHead className="h-auto px-1 pb-1.5 text-[10px] font-normal text-muted-foreground">
                        方向
                      </TableHead>
                      <TableHead className="h-auto px-1 pb-1.5 text-right text-[10px] font-normal text-muted-foreground">
                        手数
                      </TableHead>
                      <TableHead className="h-auto px-1 pb-1.5 text-[10px] font-normal text-muted-foreground">
                        入场
                      </TableHead>
                      <TableHead className="h-auto px-1 pb-1.5 text-[10px] font-normal text-muted-foreground">
                        出场
                      </TableHead>
                      <TableHead className="h-auto px-1 pb-1.5 text-[10px] font-normal text-muted-foreground">
                        平仓
                      </TableHead>
                      <TableHead className="h-auto px-1 pb-1.5 text-right text-[10px] font-normal text-muted-foreground">
                        R
                      </TableHead>
                      <TableHead className="h-auto px-1 pb-1.5 text-right text-[10px] font-normal text-muted-foreground">
                        净盈亏
                      </TableHead>
                      <TableHead className="h-auto px-1 pb-1.5 text-[10px] font-normal text-muted-foreground">
                        模板
                      </TableHead>
                      <TableHead className="h-auto px-1 pb-1.5 text-[10px] font-normal text-muted-foreground">
                        标签
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...session.trades].reverse().map((trade, index) => (
                      <TableRow key={trade.id}>
                        <TableCell className="num py-1.5 pl-3 pr-1 font-mono text-muted-foreground/60">
                          {session.trades.length - index}
                        </TableCell>
                        <TableCell
                          className={cn(
                            'px-1 py-1.5',
                            trade.side === 'buy'
                              ? 'text-success-foreground'
                              : 'text-destructive-foreground',
                          )}
                        >
                          {trade.side === 'buy' ? '买入' : '卖出'}
                        </TableCell>
                        <TableCell className="num px-1 py-1.5 text-right font-mono text-foreground/80">
                          {fmtVolume(trade.volume, session.symbolInfo.volumeStep)}
                        </TableCell>
                        <TableCell className="px-1 py-1.5 font-mono text-muted-foreground">
                          <div>{fmtPrice(trade.entry, digits)}</div>
                          <div className="text-[9px]">{fmtShort(trade.openTs)}</div>
                        </TableCell>
                        <TableCell className="px-1 py-1.5 font-mono text-muted-foreground">
                          <div>{fmtPrice(trade.exit, digits)}</div>
                          <div className="text-[9px]">{fmtShort(trade.closeTs)}</div>
                        </TableCell>
                        <TableCell className="px-1 py-1.5 text-muted-foreground">
                          {closedByText(trade.closedBy)}
                        </TableCell>
                        <TableCell
                          className={cn(
                            'num px-1 py-1.5 text-right font-mono',
                            trade.r == null ? 'text-muted-foreground/60' : pnlClass(trade.r),
                          )}
                        >
                          {trade.r == null ? '—' : fmtSigned(trade.r)}
                        </TableCell>
                        <TableCell
                          className={cn(
                            'num px-1 py-1.5 text-right font-mono font-medium',
                            pnlClass(trade.profit),
                          )}
                        >
                          {fmtSigned(trade.profit)}
                        </TableCell>
                        <TableCell className="px-1 py-1.5 text-muted-foreground">
                          {trade.templateName || '—'}
                        </TableCell>
                        <TableCell className="px-1 py-1.5 text-muted-foreground">
                          {trade.tag || '未分类'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </section>

        <section className="mt-4 rounded-[12px] border border-border bg-card p-5">
          <div className="flex items-baseline justify-between">
            <h2 className="text-[12px] font-medium">回放笔记</h2>
            <span className="text-[10px] text-muted-foreground">{session.notes.length} 条</span>
          </div>
          {session.notes.length === 0 ? (
            <p className="mt-3 text-[11px] leading-5 text-muted-foreground">
              这次回放没有留下笔记。边看边记，复盘时更容易找到当时为什么下单。
            </p>
          ) : (
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {session.notes.map((note) => (
                <div
                  key={note.id}
                  className="rounded-[8px] border border-border bg-sidebar px-3 py-2.5"
                >
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span className="num font-mono">{fmtDateTime(note.time)}</span>
                    {note.tag && (
                      <span className="rounded-[4px] bg-accent px-1.5">{note.tag}</span>
                    )}
                  </div>
                  <p className="mt-1.5 text-[11px] leading-5 text-foreground/80">{note.text}</p>
                </div>
              ))}
            </div>
          )}
        </section>

        <footer className="mt-5 flex items-center justify-between pb-2 text-[10px] text-muted-foreground">
          <span>
            基于 M1 OHLC 的保守撮合，与真实 tick 成交可能存在差异 · 未计隔夜利息 · 数据只保存在本机
          </span>
          <span>
            结束于{' '}
            {session.finishedAt ? fmtDateTime(Math.floor(session.finishedAt / 1000)) : '进行中'}
          </span>
        </footer>
      </div>
    </div>
  );
}
