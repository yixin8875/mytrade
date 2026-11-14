import { useMemo } from 'react';
import { ArrowLeft, Download, RotateCcw } from 'lucide-react';
import { clsx } from 'clsx';
import { fmtMoney, fmtPrice, fmtSigned, fmtVolume } from '../lib/format';
import { calculateStats } from './engine';
import { goReplayList, goReplaySession } from './route';
import { useReplay, useReplaySession } from './store';
import { fmtDate, fmtDateTime, fmtShort } from './time';
import type { ReplaySession, ReplayStats } from './types';

function pnlClass(value: number): string {
  return value > 0 ? 'text-console-gain' : value < 0 ? 'text-console-loss' : 'text-console-muted';
}

function closedByText(reason: ReplaySession['trades'][number]['closedBy']): string {
  if (reason === 'sl') return '止损';
  if (reason === 'tp') return '止盈';
  if (reason === 'manual') return '手动';
  if (reason === 'stop_out') return '强平';
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
      <div className="flex h-[240px] items-center justify-center text-[11px] text-console-muted">
        净值点还不够，回放一段后会出现资金曲线
      </div>
    );
  }
  const up = curve[curve.length - 1].v >= initial;
  const stroke = up ? 'var(--color-console-gain)' : 'var(--color-console-loss)';
  const fill = up ? 'var(--color-console-gain-soft)' : 'var(--color-console-loss-soft)';

  return (
    <div className="relative">
      <div className="pointer-events-none absolute left-2 top-0 font-mono text-[10px] text-console-muted">
        {fmtMoney(geometry.max)}
      </div>
      <div className="pointer-events-none absolute bottom-5 left-2 font-mono text-[10px] text-console-muted">
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
      <div className="mt-1 flex justify-between font-mono text-[10px] text-console-muted">
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
          <span className="num font-mono text-[10px] text-console-muted">{bin.count}</span>
          <div
            className={clsx(
              'w-full rounded-t-[3px]',
              bin.negative ? 'bg-console-loss' : 'bg-console-gain',
            )}
            style={{
              height: `${Math.max(bin.count > 0 ? 6 : 2, (bin.count / max) * 132)}px`,
              opacity: bin.count > 0 ? 0.85 : 0.18,
            }}
          />
          <span className="whitespace-nowrap font-mono text-[9px] text-console-muted">
            {bin.label}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ReplayReport({ sessionId }: { sessionId: string }) {
  const session = useReplaySession(sessionId);
  const duplicateSession = useReplay((s) => s.duplicateSession);
  const restart = useReplay((s) => s.restart);

  const stats = useMemo(() => (session ? calculateStats(session) : null), [session]);

  if (!session || !stats) {
    return (
      <div className="flex h-full items-center justify-center bg-console-canvas">
        <div className="text-center">
          <div className="text-[13px] text-console-ink">复盘会话不存在</div>
          <button onClick={goReplayList} className="console-btn console-btn-secondary mt-3">
            返回复盘列表
          </button>
        </div>
      </div>
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
      tone: stats.maxDrawdownPct > 0 ? 'text-console-loss' : '',
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
    <div className="h-full overflow-auto bg-console-canvas">
      <div className="mx-auto w-full max-w-[1180px] px-8 py-7">
        <header className="flex items-start gap-3">
          <button
            onClick={goReplayList}
            className="mt-0.5 grid h-8 w-8 place-items-center rounded-[8px] text-console-muted hover:bg-console-hover hover:text-console-ink"
            title="返回复盘列表"
          >
            <ArrowLeft size={16} strokeWidth={1.5} />
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-[20px] font-medium leading-tight">{session.name}</h1>
              <span className="inline-flex h-[18px] shrink-0 items-center rounded-[4px] border border-console-line-2 px-1.5 text-[10px] text-console-muted">
                模拟复盘
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-console-muted">
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
            <button
              onClick={() => exportCsv(session)}
              disabled={session.trades.length === 0}
              className="console-btn console-btn-secondary disabled:opacity-40"
            >
              <Download size={13} strokeWidth={1.5} />
              导出 CSV
            </button>
            {finished ? (
              <button
                onClick={() => {
                  const id = duplicateSession(session.id);
                  if (id) goReplaySession(id);
                }}
                className="console-btn console-btn-primary"
              >
                <RotateCcw size={13} strokeWidth={1.5} />
                重新挑战
              </button>
            ) : (
              <button
                onClick={() => goReplaySession(session.id)}
                className="console-btn console-btn-primary"
              >
                继续复盘
              </button>
            )}
          </div>
        </header>

        <section className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-[12px] border border-console-line bg-console-line md:grid-cols-3 xl:grid-cols-6">
          {readouts.map((item) => (
            <div key={item.label} className="bg-console-card px-4 py-3.5">
              <div className="text-[10px] text-console-muted">{item.label}</div>
              <div
                className={clsx(
                  'num mt-1.5 font-mono text-[19px] font-medium leading-none',
                  item.tone,
                )}
              >
                {item.value}
              </div>
              <div className="mt-1.5 truncate text-[10px] text-console-muted">{item.sub}</div>
            </div>
          ))}
        </section>

        <section className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="rounded-[12px] border border-console-line bg-console-card p-5">
            <div className="flex items-baseline justify-between">
              <h2 className="text-[12px] font-medium">模拟净值曲线</h2>
              <span className="text-[10px] text-console-muted">
                {session.equityCurve.length.toLocaleString()} 个采样点
              </span>
            </div>
            <div className="mt-3">
              <EquityCurve session={session} />
            </div>
          </div>

          <div className="rounded-[12px] border border-console-line bg-console-card p-5">
            <div className="flex items-baseline justify-between">
              <h2 className="text-[12px] font-medium">R 分布</h2>
              <span className="text-[10px] text-console-muted">按初始风险归一</span>
            </div>
            <div className="mt-3">
              <RHistogram stats={stats} />
            </div>
          </div>
        </section>

        <section className="mt-4 grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
          <div className="rounded-[12px] border border-console-line bg-console-card p-5">
            <h2 className="text-[12px] font-medium">按标签</h2>
            {stats.byTag.length === 0 ? (
              <p className="mt-3 text-[11px] leading-5 text-console-muted">
                交易带上标签后，这里会按标签汇总表现。
              </p>
            ) : (
              <table className="mt-3 w-full text-[11px]">
                <thead>
                  <tr className="text-left text-[10px] text-console-muted">
                    <th className="pb-1.5 font-normal">标签</th>
                    <th className="pb-1.5 text-right font-normal">笔数</th>
                    <th className="pb-1.5 text-right font-normal">总 R</th>
                    <th className="pb-1.5 text-right font-normal">净盈亏</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.byTag.map((item) => (
                    <tr key={item.tag} className="border-t border-console-line">
                      <td className="py-1.5 text-console-ink-2">{item.tag}</td>
                      <td className="num py-1.5 text-right font-mono text-console-muted">
                        {item.trades}
                      </td>
                      <td
                        className={clsx('num py-1.5 text-right font-mono', pnlClass(item.totalR))}
                      >
                        {fmtSigned(item.totalR)}
                      </td>
                      <td className={clsx('num py-1.5 text-right font-mono', pnlClass(item.pnl))}>
                        {fmtSigned(item.pnl)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="min-w-0 rounded-[12px] border border-console-line bg-console-card p-5">
            <div className="flex items-baseline justify-between">
              <h2 className="text-[12px] font-medium">交易明细</h2>
              <span className="text-[10px] text-console-muted">
                共 {session.trades.length} 笔 · 已扣佣金
              </span>
            </div>
            {session.trades.length === 0 ? (
              <p className="mt-3 text-[11px] leading-5 text-console-muted">
                这段回放没有已平仓交易。下次可以先按模板给出一张带止损的单。
              </p>
            ) : (
              <div className="-mx-1 mt-2 overflow-x-auto">
                <table className="w-full min-w-[720px] text-[11px]">
                  <thead>
                    <tr className="text-left text-[10px] text-console-muted">
                      <th className="px-1 pb-1.5 font-normal">#</th>
                      <th className="px-1 pb-1.5 font-normal">方向</th>
                      <th className="px-1 pb-1.5 text-right font-normal">手数</th>
                      <th className="px-1 pb-1.5 font-normal">入场</th>
                      <th className="px-1 pb-1.5 font-normal">出场</th>
                      <th className="px-1 pb-1.5 font-normal">平仓</th>
                      <th className="px-1 pb-1.5 text-right font-normal">R</th>
                      <th className="px-1 pb-1.5 text-right font-normal">净盈亏</th>
                      <th className="px-1 pb-1.5 font-normal">标签</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...session.trades].reverse().map((trade, index) => (
                      <tr key={trade.id} className="border-t border-console-line">
                        <td className="num px-1 py-1.5 font-mono text-console-faint">
                          {session.trades.length - index}
                        </td>
                        <td
                          className={clsx(
                            'px-1 py-1.5',
                            trade.side === 'buy' ? 'text-console-gain' : 'text-console-loss',
                          )}
                        >
                          {trade.side === 'buy' ? '买入' : '卖出'}
                        </td>
                        <td className="num px-1 py-1.5 text-right font-mono text-console-ink-2">
                          {fmtVolume(trade.volume, session.symbolInfo.volumeStep)}
                        </td>
                        <td className="px-1 py-1.5 font-mono text-console-muted">
                          <div>{fmtPrice(trade.entry, digits)}</div>
                          <div className="text-[9px]">{fmtShort(trade.openTs)}</div>
                        </td>
                        <td className="px-1 py-1.5 font-mono text-console-muted">
                          <div>{fmtPrice(trade.exit, digits)}</div>
                          <div className="text-[9px]">{fmtShort(trade.closeTs)}</div>
                        </td>
                        <td className="px-1 py-1.5 text-console-muted">
                          {closedByText(trade.closedBy)}
                        </td>
                        <td
                          className={clsx(
                            'num px-1 py-1.5 text-right font-mono',
                            trade.r == null ? 'text-console-faint' : pnlClass(trade.r),
                          )}
                        >
                          {trade.r == null ? '—' : fmtSigned(trade.r)}
                        </td>
                        <td
                          className={clsx(
                            'num px-1 py-1.5 text-right font-mono font-medium',
                            pnlClass(trade.profit),
                          )}
                        >
                          {fmtSigned(trade.profit)}
                        </td>
                        <td className="px-1 py-1.5 text-console-muted">{trade.tag || '未分类'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        <section className="mt-4 rounded-[12px] border border-console-line bg-console-card p-5">
          <div className="flex items-baseline justify-between">
            <h2 className="text-[12px] font-medium">回放笔记</h2>
            <span className="text-[10px] text-console-muted">{session.notes.length} 条</span>
          </div>
          {session.notes.length === 0 ? (
            <p className="mt-3 text-[11px] leading-5 text-console-muted">
              这次回放没有留下笔记。边看边记，复盘时更容易找到当时为什么下单。
            </p>
          ) : (
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {session.notes.map((note) => (
                <div
                  key={note.id}
                  className="rounded-[8px] border border-console-line bg-console-canvas px-3 py-2.5"
                >
                  <div className="flex items-center gap-2 text-[10px] text-console-muted">
                    <span className="num font-mono">{fmtDateTime(note.time)}</span>
                    {note.tag && (
                      <span className="rounded-[4px] bg-console-hover px-1.5">{note.tag}</span>
                    )}
                  </div>
                  <p className="mt-1.5 text-[11px] leading-5 text-console-ink-2">{note.text}</p>
                </div>
              ))}
            </div>
          )}
        </section>

        <footer className="mt-5 flex items-center justify-between pb-2 text-[10px] text-console-muted">
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
