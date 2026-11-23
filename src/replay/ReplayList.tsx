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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu';
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
import { fmtMoney, fmtSigned } from '../lib/format';
import { cacheSummary, clearCache } from './cache';
import { goReplayReport, goReplaySession } from './route';
import { sessionStats, SESSION_SOFT_LIMIT, useReplay } from './store';
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
  if (status === 'finished') return 'bg-success';
  if (status === 'running' || status === 'paused' || status === 'ready') {
    return 'bg-brand';
  }
  if (status === 'error') return 'bg-destructive';
  return 'bg-input';
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
  const storageMode = useReplay((s) => s.storageMode);
  const archive = useReplay((s) => s.archive);
  const remove = useReplay((s) => s.remove);
  const [cache, setCache] = useState<{ symbol: string; bars: number; bytes: number }[]>([]);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [source, setSource] = useState<'all' | 'journal' | 'missed' | 'manual'>('all');
  const visibleSessions = useMemo(
    () =>
      sessions.filter(
        (session) => source === 'all' || (session.origin ?? 'manual') === source,
      ),
    [sessions, source],
  );

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
    <div className="h-full overflow-auto bg-sidebar">
      <div className="mx-auto w-full max-w-[1320px] px-8 py-8">
        <header className="flex items-end justify-between gap-6">
          <div>
            <h1 className="text-[24px] font-medium leading-none tracking-[-0.01em]">复盘</h1>
            <p className="mt-2 text-[13px] text-muted-foreground">
              用历史行情练习决策，所有成交均为模拟
            </p>
          </div>
          <Button onClick={onCreate}>
            <Plus className="size-3.5" strokeWidth={1.5} />
            新建复盘
          </Button>
        </header>

        <div className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border lg:grid-cols-4">
          <div className="bg-card px-5 py-4">
            <div className="text-[12px] text-muted-foreground">进行中</div>
            <div className="num mt-1.5 font-mono text-[24px] font-medium leading-none">
              {stats.active.length}
            </div>
            <div className="mt-2 text-[10px] text-muted-foreground">
              {stats.active.length
                ? `最近更新 ${relativeTime(current?.updatedAt ?? 0)}`
                : '还没有进行中的复盘'}
            </div>
          </div>
          <div className="bg-card px-5 py-4">
            <div className="text-[12px] text-muted-foreground">累计模拟盈亏</div>
            <div
              className={cn(
                'num mt-1.5 font-mono text-[24px] font-medium leading-none',
                stats.totalPnl >= 0 ? 'text-success-foreground' : 'text-destructive-foreground',
              )}
            >
              {stats.totalPnl >= 0 ? '+' : ''}
              {fmtMoney(stats.totalPnl)}
            </div>
            <div className="mt-2 text-[10px] text-muted-foreground">已完成会话 · USD</div>
          </div>
          <div className="bg-card px-5 py-4">
            <div className="text-[12px] text-muted-foreground">交易笔数</div>
            <div className="num mt-1.5 font-mono text-[24px] font-medium leading-none">
              {stats.trades}
            </div>
            <div className="mt-2 text-[10px] text-muted-foreground">
              已平仓 · {stats.avgR == null ? '暂无 R' : `平均 ${fmtSigned(stats.avgR)}R`}
            </div>
          </div>
          <div className="bg-card px-5 py-4">
            <div className="text-[12px] text-muted-foreground">已完成复盘</div>
            <div className="num mt-1.5 font-mono text-[24px] font-medium leading-none">
              {stats.finished.length}
            </div>
            <div className="mt-2 text-[10px] text-muted-foreground">
              {storageMode === 'gateway' ? '会话保存在网关数据库' : '网关不可用 · 只读本机快照'}
            </div>
          </div>
        </div>

        {current && (
          <section className="mt-4 grid overflow-hidden rounded-2xl border border-border bg-card md:grid-cols-[minmax(0,1fr)_300px]">
            <div className="px-6 py-5">
              <div className="text-[10px] text-muted-foreground">
                {current.status === 'finished' ? '最近完成' : '进行中'}
              </div>
              <div className="mt-1.5 text-[15px] font-medium">{current.name}</div>
              <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                <span>
                  {current.symbol} · {current.settings.timeframe}m
                </span>
                <span>
                  {fmtDate(current.startTs)} ~ {fmtDate(current.endTs)}
                </span>
                <span>
                  游标{' '}
                  <b className="font-mono font-normal text-foreground/80">
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
                  <span className="block text-[10px] text-muted-foreground">模拟盈亏</span>
                  <div
                    className={cn(
                      'num mt-1 font-mono text-[15px] font-medium',
                      pnlOf(current) >= 0
                        ? 'text-success-foreground'
                        : 'text-destructive-foreground',
                    )}
                  >
                    {pnlOf(current) >= 0 ? '+' : ''}
                    {fmtMoney(pnlOf(current))}
                  </div>
                </div>
                <div>
                  <span className="block text-[10px] text-muted-foreground">持仓</span>
                  <div className="num mt-1 font-mono text-[15px] font-medium">
                    {current.positions.length}
                  </div>
                </div>
                <div>
                  <span className="block text-[10px] text-muted-foreground">交易</span>
                  <div className="num mt-1 font-mono text-[15px] font-medium">
                    {current.trades.length}
                  </div>
                </div>
                <div>
                  <span className="block text-[10px] text-muted-foreground">最大回撤</span>
                  <div className="num mt-1 font-mono text-[15px] font-medium text-destructive-foreground">
                    -{current.maxDrawdownPct.toFixed(1)}%
                  </div>
                </div>
              </div>
            </div>
            <div className="flex flex-col justify-between gap-4 border-t border-border px-6 py-5 md:border-l md:border-t-0">
              <Tape session={current} height={18} count={48} className="h-[18px] w-full" />
              <div className="flex items-center justify-between gap-3">
                <span className="text-[10px] text-muted-foreground">
                  {current.status === 'finished'
                    ? '复盘已结束'
                    : `已回放 ${progressPct(current)}% · ${Math.max(0, current.cursorIndex - current.startIndex).toLocaleString()} 根`}
                </span>
                <Button onClick={() => openSession(current)}>
                  {current.status === 'finished' ? '查看报告' : '继续复盘'}
                </Button>
              </div>
            </div>
          </section>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5">
            {(
              [
                { value: 'all', label: '全部' },
                { value: 'journal', label: '来自实盘' },
                { value: 'missed', label: '来自机会' },
                { value: 'manual', label: '手动新建' },
              ] as const
            ).map((item) => (
              <Button
                key={item.value}
                variant={source === item.value ? 'secondary' : 'ghost'}
                size="xs"
                onClick={() => setSource(item.value)}
                className={cn(
                  'h-6 rounded-md px-2.5 text-[11px]',
                  source === item.value ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {item.label}
              </Button>
            ))}
          </div>
          <span className="text-[10px] text-muted-foreground">
            共 {visibleSessions.length} 个会话
            {sessions.length >= SESSION_SOFT_LIMIT ? ' · 建议归档旧会话' : ''}
            {storageMode === 'local' ? ' · 本机缓存（离线）' : ''}
          </span>
        </div>

        <section className="mt-2 overflow-hidden rounded-xl border border-border bg-card">
          <Table className="text-[12px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-auto px-4 py-2.5 text-[10px] font-normal text-muted-foreground">
                  名称
                </TableHead>
                <TableHead className="h-auto px-4 py-2.5 text-[10px] font-normal text-muted-foreground">
                  品种 / 周期
                </TableHead>
                <TableHead className="h-auto px-4 py-2.5 text-[10px] font-normal text-muted-foreground">
                  区间
                </TableHead>
                <TableHead className="h-auto px-4 py-2.5 text-[10px] font-normal text-muted-foreground">
                  进度
                </TableHead>
                <TableHead className="h-auto px-4 py-2.5 text-[10px] font-normal text-muted-foreground">
                  状态
                </TableHead>
                <TableHead className="h-auto px-4 py-2.5 text-right text-[10px] font-normal text-muted-foreground">
                  模拟盈亏
                </TableHead>
                <TableHead className="h-auto px-4 py-2.5 text-right text-[10px] font-normal text-muted-foreground">
                  交易
                </TableHead>
                <TableHead className="h-auto px-4 py-2.5 text-right text-[10px] font-normal text-muted-foreground">
                  最大回撤
                </TableHead>
                <TableHead className="h-auto px-4 py-2.5 text-[10px] font-normal text-muted-foreground">
                  更新时间
                </TableHead>
                <TableHead className="h-auto px-4 py-2.5" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleSessions.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={10}
                    className="px-4 py-8 text-center text-[11px] whitespace-normal text-muted-foreground/60"
                  >
                    {source === 'journal'
                      ? '还没有从实盘交易创建的会话。到交易日志点「回放」即可。'
                      : source === 'missed'
                        ? '还没有从错过的机会创建的会话。到「错过的机会」点「在回放中看」即可。'
                        : source === 'manual'
                          ? '没有手动新建的会话。'
                          : '还没有复盘会话。'}
                  </TableCell>
                </TableRow>
              )}
              {visibleSessions.map((session) => {
                const pnl = pnlOf(session);
                const finished = session.status === 'finished' || session.status === 'archived';
                const archived = session.status === 'archived';
                return (
                  <TableRow key={session.id} className="group">
                    <TableCell className="px-4 py-3">
                      <Button
                        variant="link"
                        size="xs"
                        onClick={() => openSession(session)}
                        className="h-auto p-0 text-left text-[12px] font-medium text-foreground"
                      >
                        {session.name}
                      </Button>
                      {session.origin === 'journal' && (
                        <Badge variant="outline" size="sm" className="ml-1.5 text-[9px]">
                          来自实盘
                        </Badge>
                      )}
                      {session.origin === 'missed' && (
                        <Badge variant="outline" size="sm" className="ml-1.5 text-[9px]">
                          来自机会
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="px-4 py-3 font-mono text-[11px] text-foreground/80">
                      {session.symbol} · {session.settings.timeframe}m
                    </TableCell>
                    <TableCell className="px-4 py-3 font-mono text-[11px] text-foreground/80">
                      {fmtDate(session.startTs)} ~ {fmtDate(session.endTs)}
                    </TableCell>
                    <TableCell className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Tape session={session} height={10} count={24} className="h-2.5 w-16" />
                        <span className="num font-mono text-[10px] text-muted-foreground">
                          {archived ? '已归档' : finished ? '报告' : `${progressPct(session)}%`}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span
                          className={cn('h-1.5 w-1.5 rounded-full', statusTone(session.status))}
                        />
                        {statusLabel(session.status)}
                      </span>
                    </TableCell>
                    <TableCell
                      className={cn(
                        'num px-4 py-3 text-right font-mono text-[11px]',
                        pnl >= 0 ? 'text-success-foreground' : 'text-destructive-foreground',
                      )}
                    >
                      {pnl >= 0 ? '+' : ''}
                      {fmtMoney(pnl)}
                    </TableCell>
                    <TableCell className="num px-4 py-3 text-right font-mono text-[11px] text-foreground/80">
                      {session.trades.length}
                    </TableCell>
                    <TableCell className="num px-4 py-3 text-right font-mono text-[11px] text-destructive-foreground">
                      -{session.maxDrawdownPct.toFixed(1)}%
                    </TableCell>
                    <TableCell className="px-4 py-3 font-mono text-[11px] text-muted-foreground">
                      {relativeTime(session.updatedAt)}
                    </TableCell>
                    <TableCell className="relative px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="link"
                          size="xs"
                          onClick={() => openSession(session)}
                          className="h-auto p-0 text-[11px] font-normal text-muted-foreground hover:text-foreground hover:no-underline"
                        >
                          {archived ? '查看' : finished ? '报告' : '继续'}
                        </Button>
                        <Menu
                          open={menuId === session.id}
                          onOpenChange={(open) => {
                            setMenuId(open ? session.id : null);
                            setConfirmId(null);
                          }}
                        >
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <MenuTrigger
                                  render={
                                    <Button
                                      variant="ghost"
                                      size="icon-sm"
                                      aria-label="更多"
                                      title="更多"
                                    />
                                  }
                                />
                              }
                            >
                              <MoreHorizontal />
                            </TooltipTrigger>
                            <TooltipPopup>更多</TooltipPopup>
                          </Tooltip>
                          <MenuPopup align="end" className="w-40">
                            {!finished && (
                              <MenuItem
                                onClick={() => {
                                  setMenuId(null);
                                  goReplaySession(session.id);
                                }}
                              >
                                <Play strokeWidth={1.5} />
                                继续复盘
                              </MenuItem>
                            )}
                            <MenuItem
                              onClick={() => {
                                setMenuId(null);
                                goReplayReport(session.id);
                              }}
                            >
                              <FileText strokeWidth={1.5} />
                              查看报告
                            </MenuItem>
                            {session.status !== 'archived' && (
                              <MenuItem
                                onClick={() => {
                                  archive(session.id);
                                  setMenuId(null);
                                }}
                              >
                                <Archive strokeWidth={1.5} />
                                归档
                              </MenuItem>
                            )}
                            <MenuItem
                              variant="destructive"
                              closeOnClick={false}
                              onClick={() => {
                                if (confirmId !== session.id) {
                                  setConfirmId(session.id);
                                  return;
                                }
                                remove(session.id);
                                setMenuId(null);
                                setConfirmId(null);
                              }}
                            >
                              <Trash2 strokeWidth={1.5} />
                              {confirmId === session.id ? '再次点击删除' : '删除'}
                            </MenuItem>
                          </MenuPopup>
                        </Menu>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {sessions.length === 0 && (
            <Empty className="px-6 py-16">
              <EmptyMedia variant="icon">
                <History strokeWidth={1.2} />
              </EmptyMedia>
              <EmptyHeader>
                <EmptyTitle className="text-[13px] font-medium">还没有复盘会话</EmptyTitle>
                <EmptyDescription className="max-w-md text-[11px] leading-5">
                  选一段历史行情，按真实节奏逐根回放。下单、持仓、止损止盈都在本地模拟，不会触达实盘。
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button onClick={onCreate} className="mt-1">
                  <Plus className="size-3.5" strokeWidth={1.5} />
                  新建复盘
                </Button>
              </EmptyContent>
            </Empty>
          )}
        </section>

        <section className="mt-4 flex flex-wrap items-center gap-6 rounded-xl border border-border bg-card px-5 py-4">
          <div className="min-w-[190px]">
            <div className="flex items-center gap-1.5 text-[12px] font-medium">
              <Database className="size-3.5 text-muted-foreground" strokeWidth={1.5} />
              本地行情缓存
            </div>
            <div className="mt-1 text-[10px] text-muted-foreground">
              {cache.length
                ? `${cache.length} 个品种 · ${cache.reduce((sum, row) => sum + row.bars, 0).toLocaleString()} 根 · ${(cache.reduce((sum, row) => sum + row.bytes, 0) / 1024 / 1024).toFixed(1)} MB`
                : '还没有缓存行情'}
            </div>
          </div>
          <div className="flex min-w-[180px] flex-1 gap-0.5">
            {Array.from({ length: 12 }, (_, index) => {
              // 按所有品种的缓存总量画进度，而不是只看第一个品种
              const totalBars = cache.reduce((sum, row) => sum + row.bars, 0);
              const filled = cache.length
                ? Math.min(12, Math.round((totalBars / 50000) * 12))
                : 0;
              return (
                <span
                  key={index}
                  className={cn(
                    'h-1.5 flex-1 rounded-[2px]',
                    index < filled
                      ? 'bg-success'
                      : index === filled && filled > 0
                        ? 'bg-warning'
                        : 'bg-border',
                  )}
                />
              );
            })}
          </div>
          <span className="whitespace-nowrap text-[10px] text-muted-foreground">
            {storageMode === 'gateway'
              ? '行情缓存只在本机 · 会话记录已写入网关'
              : '网关离线 · 复盘会话暂存本机'}
          </span>
          <Button
            variant="link"
            size="xs"
            onClick={() => {
              if (window.confirm('清空所有本地回放行情缓存？会话记录会保留。')) {
                void clearCache().then(() => setCache([]));
              }
            }}
            className="h-auto whitespace-nowrap p-0 text-[10px] font-normal text-muted-foreground hover:text-foreground"
          >
            清理缓存
          </Button>
        </section>
      </div>
    </div>
  );
}
