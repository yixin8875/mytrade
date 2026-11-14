import { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  Database,
  FileText,
  History,
  MoreHorizontal,
  Play,
  Plus,
  Trash2,
} from 'lucide-react';
import { clsx } from 'clsx';
import { fmtMoney, fmtSigned } from '../lib/format';
import { cacheSummary, clearCache } from './cache';
import { goReplayReport, goReplaySession } from './route';
import { sessionStats, useReplay } from './store';
import { Tape } from './Tape';
import { fmtDate, fmtShort, relativeTime } from './time';
import type { ReplaySession, ReplayStatus } from './types';

function statusLabel(status: ReplayStatus): string {
  switch (status) {
    case 'preparing':
      return '准备中';
    case 'ready':
    case 'running':
    case 'paused':
      return '进行中';
    case 'finished':
      return '已完成';
    case 'archived':
      return '已归档';
    case 'error':
      return '数据不足';
    default:
      return status;
  }
}

function statusTone(status: ReplayStatus): string {
  if (status === 'finished') return 'bg-console-gain';
  if (status === 'running' || status === 'paused' || status === 'ready') {
    return 'bg-console-accent';
  }
  if (status === 'error') return 'bg-console-loss';
  return 'bg-console-line-2';
}

function pnlOf(session: ReplaySession): number {
  return session.equity - session.settings.initialBalance;
}

function progressPct(session: ReplaySession): number {
  if (!session.totalBars) return 0;
  return Math.round(((session.cursorIndex - session.startIndex) / session.totalBars) * 100);
}

export function ReplayList({ onCreate }: { onCreate: () => void }) {
  const sessions = useReplay((s) => s.sessions);
  const archive = useReplay((s) => s.archive);
  const remove = useReplay((s) => s.remove);
  const [cache, setCache] = useState<{ symbol: string; bars: number; bytes: number }[]>([]);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void cacheSummary().then((rows) => {
      if (alive) setCache(rows);
    });
    return () => {
      alive = false;
    };
  }, [sessions.length]);

  const stats = useMemo(() => {
    const active = sessions.filter(
      (item) => item.status !== 'finished' && item.status !== 'archived',
    );
    const finished = sessions.filter((item) => item.status === 'finished');
    const totalPnl = finished.reduce((sum, item) => sum + sessionStats(item).netPnl, 0);
    const trades = finished.reduce((sum, item) => sum + item.trades.length, 0);
    const totalR = finished.reduce((sum, item) => sum + sessionStats(item).totalR, 0);
    const avgR = trades ? totalR / trades : null;
    return { active, finished, totalPnl, trades, avgR };
  }, [sessions]);

  const current =
    [...stats.active].sort((a, b) => b.updatedAt - a.updatedAt)[0] ??
    [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0] ??
    null;

  const openSession = (session: ReplaySession) => {
    if (session.status === 'finished' || session.status === 'archived') {
      goReplayReport(session.id);
    } else {
      goReplaySession(session.id);
    }
  };

  return (
    <div className="h-full overflow-auto bg-console-canvas">
      <div className="mx-auto w-full max-w-[1320px] px-8 py-8">
        <header className="flex items-end justify-between gap-6">
          <div>
            <h1 className="text-[24px] font-medium leading-none tracking-[-0.01em]">复盘</h1>
            <p className="mt-2 text-[13px] text-console-muted">
              用历史行情练习决策，所有成交均为模拟
            </p>
          </div>
          <button onClick={onCreate} className="console-btn console-btn-primary">
            <Plus size={14} strokeWidth={1.5} />
            新建复盘
          </button>
        </header>

        <div className="readout mt-6 grid-cols-2 lg:grid-cols-4">
          <div className="readout-cell">
            <div className="text-[12px] text-console-muted">进行中</div>
            <div className="num mt-1.5 font-mono text-[24px] font-medium leading-none">
              {stats.active.length}
            </div>
            <div className="mt-2 text-[10px] text-console-muted">
              {stats.active.length
                ? `最近更新 ${relativeTime(current?.updatedAt ?? 0)}`
                : '还没有进行中的复盘'}
            </div>
          </div>
          <div className="readout-cell">
            <div className="text-[12px] text-console-muted">累计模拟盈亏</div>
            <div
              className={clsx(
                'num mt-1.5 font-mono text-[24px] font-medium leading-none',
                stats.totalPnl >= 0 ? 'text-console-gain' : 'text-console-loss',
              )}
            >
              {stats.totalPnl >= 0 ? '+' : ''}
              {fmtMoney(stats.totalPnl)}
            </div>
            <div className="mt-2 text-[10px] text-console-muted">已完成会话 · USD</div>
          </div>
          <div className="readout-cell">
            <div className="text-[12px] text-console-muted">交易笔数</div>
            <div className="num mt-1.5 font-mono text-[24px] font-medium leading-none">
              {stats.trades}
            </div>
            <div className="mt-2 text-[10px] text-console-muted">
              已平仓 · {stats.avgR == null ? '暂无 R' : `平均 ${fmtSigned(stats.avgR)}R`}
            </div>
          </div>
          <div className="readout-cell">
            <div className="text-[12px] text-console-muted">已完成复盘</div>
            <div className="num mt-1.5 font-mono text-[24px] font-medium leading-none">
              {stats.finished.length}
            </div>
            <div className="mt-2 text-[10px] text-console-muted">全部数据保存在本机</div>
          </div>
        </div>

        {current && (
          <section className="mt-4 grid overflow-hidden rounded-[16px] border border-console-line bg-console-card md:grid-cols-[minmax(0,1fr)_300px]">
            <div className="px-6 py-5">
              <div className="text-[10px] text-console-muted">
                {current.status === 'finished' ? '最近完成' : '进行中'}
              </div>
              <div className="mt-1.5 text-[15px] font-medium">{current.name}</div>
              <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-console-muted">
                <span>
                  {current.symbol} · {current.settings.timeframe}m
                </span>
                <span>
                  {fmtDate(current.startTs)} ~ {fmtDate(current.endTs)}
                </span>
                <span>
                  游标{' '}
                  <b className="font-mono font-normal text-console-ink-2">
                    {fmtShort(
                      current.cursorTs ??
                        current.startTs +
                          Math.max(0, current.cursorIndex - current.startIndex) * 60,
                    )}
                  </b>
                </span>
              </div>
              <div className="mt-4 flex flex-wrap items-end gap-7">
                <div>
                  <label className="block text-[10px] text-console-muted">模拟盈亏</label>
                  <div
                    className={clsx(
                      'num mt-1 font-mono text-[15px] font-medium',
                      pnlOf(current) >= 0 ? 'text-console-gain' : 'text-console-loss',
                    )}
                  >
                    {pnlOf(current) >= 0 ? '+' : ''}
                    {fmtMoney(pnlOf(current))}
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] text-console-muted">持仓</label>
                  <div className="num mt-1 font-mono text-[15px] font-medium">
                    {current.positions.length}
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] text-console-muted">交易</label>
                  <div className="num mt-1 font-mono text-[15px] font-medium">
                    {current.trades.length}
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] text-console-muted">最大回撤</label>
                  <div className="num mt-1 font-mono text-[15px] font-medium text-console-loss">
                    -{current.maxDrawdownPct.toFixed(1)}%
                  </div>
                </div>
              </div>
            </div>
            <div className="flex flex-col justify-between gap-4 border-t border-console-line px-6 py-5 md:border-l md:border-t-0">
              <Tape session={current} height={18} count={48} className="h-[18px] w-full" />
              <div className="flex items-center justify-between gap-3">
                <span className="text-[10px] text-console-muted">
                  {current.status === 'finished'
                    ? '复盘已结束'
                    : `已回放 ${progressPct(current)}% · ${Math.max(0, current.cursorIndex - current.startIndex).toLocaleString()} 根`}
                </span>
                <button
                  onClick={() => openSession(current)}
                  className="console-btn console-btn-primary"
                >
                  {current.status === 'finished' ? '查看报告' : '继续复盘'}
                </button>
              </div>
            </div>
          </section>
        )}

        <section className="mt-4 overflow-hidden rounded-[12px] border border-console-line bg-console-card">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="text-left text-[10px] text-console-muted">
                  <th className="whitespace-nowrap border-b border-console-line px-4 py-2.5 font-normal">名称</th>
                  <th className="whitespace-nowrap border-b border-console-line px-4 py-2.5 font-normal">品种 / 周期</th>
                  <th className="whitespace-nowrap border-b border-console-line px-4 py-2.5 font-normal">区间</th>
                  <th className="whitespace-nowrap border-b border-console-line px-4 py-2.5 font-normal">进度</th>
                  <th className="whitespace-nowrap border-b border-console-line px-4 py-2.5 font-normal">状态</th>
                  <th className="whitespace-nowrap border-b border-console-line px-4 py-2.5 text-right font-normal">模拟盈亏</th>
                  <th className="whitespace-nowrap border-b border-console-line px-4 py-2.5 text-right font-normal">交易</th>
                  <th className="whitespace-nowrap border-b border-console-line px-4 py-2.5 text-right font-normal">最大回撤</th>
                  <th className="whitespace-nowrap border-b border-console-line px-4 py-2.5 font-normal">更新时间</th>
                  <th className="border-b border-console-line px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => {
                  const pnl = pnlOf(session);
                  const finished = session.status === 'finished' || session.status === 'archived';
                  return (
                    <tr key={session.id} className="group">
                      <td className="border-b border-console-line px-4 py-3">
                        <button
                          onClick={() => openSession(session)}
                          className="text-left text-[12px] font-medium text-console-ink hover:underline"
                        >
                          {session.name}
                        </button>
                      </td>
                      <td className="whitespace-nowrap border-b border-console-line px-4 py-3 font-mono text-[11px] text-console-ink-2">
                        {session.symbol} · {session.settings.timeframe}m
                      </td>
                      <td className="whitespace-nowrap border-b border-console-line px-4 py-3 font-mono text-[11px] text-console-ink-2">
                        {fmtDate(session.startTs)} ~ {fmtDate(session.endTs)}
                      </td>
                      <td className="border-b border-console-line px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Tape session={session} height={10} count={24} className="h-2.5 w-16" />
                          <span className="num font-mono text-[10px] text-console-muted">
                            {finished ? '完成' : `${progressPct(session)}%`}
                          </span>
                        </div>
                      </td>
                      <td className="whitespace-nowrap border-b border-console-line px-4 py-3">
                        <span className="inline-flex items-center gap-1.5 text-[11px] text-console-muted">
                          <span className={clsx('h-1.5 w-1.5 rounded-full', statusTone(session.status))} />
                          {statusLabel(session.status)}
                        </span>
                      </td>
                      <td
                        className={clsx(
                          'num whitespace-nowrap border-b border-console-line px-4 py-3 text-right font-mono text-[11px]',
                          pnl >= 0 ? 'text-console-gain' : 'text-console-loss',
                        )}
                      >
                        {pnl >= 0 ? '+' : ''}
                        {fmtMoney(pnl)}
                      </td>
                      <td className="num whitespace-nowrap border-b border-console-line px-4 py-3 text-right font-mono text-[11px] text-console-ink-2">
                        {session.trades.length}
                      </td>
                      <td className="num whitespace-nowrap border-b border-console-line px-4 py-3 text-right font-mono text-[11px] text-console-loss">
                        -{session.maxDrawdownPct.toFixed(1)}%
                      </td>
                      <td className="whitespace-nowrap border-b border-console-line px-4 py-3 font-mono text-[11px] text-console-muted">
                        {relativeTime(session.updatedAt)}
                      </td>
                      <td className="relative border-b border-console-line px-4 py-3">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => openSession(session)}
                            className="whitespace-nowrap text-[11px] text-console-muted hover:text-console-ink"
                          >
                            {finished ? '报告' : '继续'}
                          </button>
                          <button
                            onClick={() => {
                              setMenuId(menuId === session.id ? null : session.id);
                              setConfirmId(null);
                            }}
                            className="grid h-6 w-6 place-items-center rounded-[6px] text-console-muted hover:bg-console-hover hover:text-console-ink"
                            title="更多"
                          >
                            <MoreHorizontal size={14} strokeWidth={1.5} />
                          </button>
                        </div>
                        {menuId === session.id && (
                          <>
                            <div className="fixed inset-0 z-20" onClick={() => setMenuId(null)} />
                            <div className="absolute right-4 top-10 z-30 w-40 overflow-hidden rounded-[8px] border border-console-line bg-console-card py-1 shadow-[0_12px_28px_-12px_rgba(33,28,22,.35)]">
                              {!finished && (
                                <button
                                  onClick={() => {
                                    setMenuId(null);
                                    goReplaySession(session.id);
                                  }}
                                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-console-ink-2 hover:bg-console-hover"
                                >
                                  <Play size={13} strokeWidth={1.5} />
                                  继续复盘
                                </button>
                              )}
                              <button
                                onClick={() => {
                                  setMenuId(null);
                                  goReplayReport(session.id);
                                }}
                                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-console-ink-2 hover:bg-console-hover"
                              >
                                <FileText size={13} strokeWidth={1.5} />
                                查看报告
                              </button>
                              {session.status !== 'archived' && (
                                <button
                                  onClick={() => {
                                    archive(session.id);
                                    setMenuId(null);
                                  }}
                                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-console-ink-2 hover:bg-console-hover"
                                >
                                  <Archive size={13} strokeWidth={1.5} />
                                  归档
                                </button>
                              )}
                              <button
                                onClick={() => {
                                  if (confirmId !== session.id) {
                                    setConfirmId(session.id);
                                    return;
                                  }
                                  remove(session.id);
                                  setMenuId(null);
                                  setConfirmId(null);
                                }}
                                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-console-loss hover:bg-console-hover"
                              >
                                <Trash2 size={13} strokeWidth={1.5} />
                                {confirmId === session.id ? '再次点击删除' : '删除'}
                              </button>
                            </div>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {sessions.length === 0 && (
            <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
              <History size={30} strokeWidth={1.2} className="text-console-faint" />
              <div className="text-[13px] text-console-ink">还没有复盘会话</div>
              <div className="max-w-md text-[11px] leading-5 text-console-muted">
                选一段历史行情，按真实节奏逐根回放。下单、持仓、止损止盈都在本地模拟，不会触达实盘。
              </div>
              <button onClick={onCreate} className="console-btn console-btn-primary mt-1">
                <Plus size={14} strokeWidth={1.5} />
                新建复盘
              </button>
            </div>
          )}
        </section>

        <section className="mt-4 flex flex-wrap items-center gap-6 rounded-[12px] border border-console-line bg-console-card px-5 py-4">
          <div className="min-w-[190px]">
            <div className="flex items-center gap-1.5 text-[12px] font-medium">
              <Database size={14} strokeWidth={1.5} className="text-console-muted" />
              本地数据
            </div>
            <div className="mt-1 text-[10px] text-console-muted">
              {cache.length
                ? `${cache
                    .map((row) => row.symbol)
                    .slice(0, 4)
                    .join(' · ')} · ${(cache.reduce((sum, row) => sum + row.bytes, 0) / 1024 / 1024).toFixed(1)} MB`
                : '还没有缓存行情'}
            </div>
          </div>
          <div className="flex min-w-[180px] flex-1 gap-0.5">
            {Array.from({ length: 12 }, (_, index) => {
              const filled = cache.length
                ? Math.min(12, Math.round((cache[0].bars / 50000) * 12))
                : 0;
              return (
                <span
                  key={index}
                  className={clsx(
                    'h-1.5 flex-1 rounded-[2px]',
                    index < filled
                      ? 'bg-console-gain'
                      : index === filled && filled > 0
                        ? 'bg-console-warn'
                        : 'bg-console-line',
                  )}
                />
              );
            })}
          </div>
          <span className="whitespace-nowrap text-[10px] text-console-muted">
            复盘数据保存在本机，不进入实盘日志
          </span>
          <button
            onClick={() => {
              if (window.confirm('清空所有本地回放行情缓存？会话记录会保留。')) {
                void clearCache().then(() => setCache([]));
              }
            }}
            className="whitespace-nowrap text-[10px] text-console-muted hover:text-console-ink"
          >
            清理缓存
          </button>
        </section>
      </div>
    </div>
  );
}
