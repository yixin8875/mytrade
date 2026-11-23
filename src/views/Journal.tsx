import { useEffect, useState, type ReactNode } from 'react';
import { Camera, NotebookPen, Play, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { gateway } from '../gateway/client';
import { RangeChips } from '../components/RangeChips';
import { TradeDetailModal } from '../components/TradeDetailModal';
import { TradeReviewDrawer } from '../components/TradeReviewDrawer';
import { useTradeReplay } from '../replay/useTradeReplay';
import { useApp } from '../store/useApp';
import { fmtPrice, fmtSigned, fmtVolume, signedClass } from '../lib/format';
import { usePrivacyMask } from '../lib/privacy';
import { fmtLocalTime, rowOffset } from '../lib/time';
import { priceDigits } from '../lib/tradeChart';
import type { JournalFilter, JournalRecord, JournalStats } from '../gateway/types';

const PAGE_SIZE = 50;

const CLOSED_BY: Record<string, string> = {
  sl: '止损',
  tp: '止盈',
  so: '强平',
  stop_out: '强平',
  manual: '手动',
};

function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  if (sec < 60) return `${Math.round(sec)}秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)}分`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}时${Math.floor((sec % 3600) / 60)}分`;
  return `${Math.floor(sec / 86400)}天`;
}

/** 交易日志页：统一筛选、统计卡片与已平仓明细 */
export function JournalView() {
  const notify = useApp((s) => s.notify);
  const setPage = useApp((s) => s.setPage);
  const activeLogin = useApp((s) => s.account?.login ?? 0);
  const serverOffset = useApp((s) => s.health?.serverOffset ?? 0);
  const journalFocus = useApp((s) => s.journalFocus);
  const setJournalFocus = useApp((s) => s.setJournalFocus);
  const journalFilter = useApp((s) => s.journalFilter);
  const journalDays = useApp((s) => s.journalDays);
  const setJournalFilter = useApp((s) => s.setJournalFilter);
  const setJournalDays = useApp((s) => s.setJournalDays);
  usePrivacyMask();

  const [days, setDays] = useState(30);
  const [filter, setFilter] = useState<JournalFilter>({});
  const [stats, setStats] = useState<JournalStats | null>(null);
  const [records, setRecords] = useState<JournalRecord[]>([]);
  const [editing, setEditing] = useState<{ id: number; value: string } | null>(null);
  const [shot, setShot] = useState<{ record: JournalRecord; tab: 'chart' | 'shot' } | null>(null);
  const [reviewing, setReviewing] = useState<number | null>(null);
  const replay = useTradeReplay();
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (syncFirst = false) => {
    setLoading(true);
    try {
      if (syncFirst) await gateway.call('journal.sync', {});
      const [nextStats, nextRecords] = await Promise.all([
        gateway.call<JournalStats>('journal.stats', { days, filters: filter }),
        gateway.call<JournalRecord[]>('journal.list', { days, limit: 300, filters: filter }),
      ]);
      setStats(nextStats);
      setRecords(nextRecords);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // load 每次渲染都是新函数，只在区间、筛选或账户变化时重新拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, filter, activeLogin]);

  // 从报表 / 执行质量下钻进来时带上筛选与区间；消费后清空，避免下次进页重复套用
  useEffect(() => {
    const hasFilter = Object.keys(journalFilter).length > 0;
    if (!hasFilter && journalDays == null) return;
    if (hasFilter) setFilter(journalFilter);
    if (journalDays != null) setDays(journalDays);
    setJournalFilter({});
    setJournalDays(null);
  }, [journalFilter, journalDays, setJournalFilter, setJournalDays]);

  // 从回放/参考面板跳进来时直接打开该笔复盘；打开后清空，避免重复触发
  useEffect(() => {
    if (journalFocus == null) return;
    setReviewing(journalFocus);
    setJournalFocus(null);
  }, [journalFocus, setJournalFocus]);

  // 切换账户后关闭上一笔交易的详情，避免把旧账户的图配到新记录上
  useEffect(() => {
    setShot(null);
    setEditing(null);
  }, [activeLogin]);

  // 换区间或账户时回到第一页
  useEffect(() => {
    setVisible(PAGE_SIZE);
  }, [days, activeLogin]);

  const shown = records.slice(0, visible);
  const price = (value: number) => fmtPrice(value, priceDigits(value));

  const summary = stats?.summary;
  const filterActive = Object.keys(filter).length > 0;

  const saveTag = async (record: JournalRecord, value: string) => {
    setEditing(null);
    const tag = value.trim().slice(0, 40);
    if ((record.tag ?? '') === tag) return;
    try {
      const updated = await gateway.call<JournalRecord>('journal.tag', {
        positionId: record.position_id,
        tag,
      });
      setRecords((prev) =>
        prev.map((item) => (item.position_id === record.position_id ? updated : item)),
      );
      // 按标签的统计也要跟着刷新（保持当前筛选口径）
      gateway
        .call<JournalStats>('journal.stats', { days, filters: filter })
        .then(setStats)
        .catch(() => {});
    } catch (err) {
      notify('error', (err as Error).message);
    }
  };

  return (
    <div className="console-scope h-full min-h-0 overflow-auto bg-sidebar">
      <div className="mx-auto w-full max-w-[1240px] px-8 py-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-medium tracking-[-0.01em]">交易日志</h1>
            <p className="mt-1.5 text-[13px] text-muted-foreground">
              已平仓交易自动记录
              {activeLogin ? ` · 账户 ${activeLogin}` : ''} · 点击标签可修改策略
            </p>
          </div>
          <div className="flex items-center gap-2">
            <RangeChips value={days} onChange={setDays} />
            <Button onClick={() => void load(true)} disabled={loading} variant="outline">
              <RefreshCw size={14} strokeWidth={1.5} className={cn(loading && 'animate-spin')} />
              {loading ? '读取中…' : '同步刷新'}
            </Button>
          </div>
        </header>

        {error && (
          <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive-foreground">
            读取日志失败：{error}
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-start gap-3">
          <div className="readout min-w-0 flex-1 grid-cols-1 sm:grid-cols-3">
            <StatCard
              label="交易笔数"
              value={summary ? String(summary.trades) : '—'}
              hint={summary?.truncated ? '仅统计最近 5000 笔' : undefined}
            />
            <StatCard
              label="净盈亏"
              value={summary ? fmtSigned(summary.netPnl) : '—'}
              tone={summary ? signedClass(summary.netPnl) : undefined}
            />
            <StatCard
              label="胜率"
              value={summary?.winRate != null ? `${summary.winRate.toFixed(1)}%` : '—'}
              hint={summary ? `${summary.wins} 胜 / ${summary.losses} 负` : undefined}
            />
          </div>
          <Button
            onClick={() => setPage('reports')}
            variant="outline"
            className="mt-1 whitespace-nowrap"
          >
            查看完整报表
          </Button>
        </div>

        <Card className="mt-4 flex flex-row flex-wrap items-center gap-2 px-3 py-2">
          <span className="text-[11px] text-muted-foreground/60">筛选</span>
          <select
            value={filter.symbol ?? ''}
            onChange={(event) =>
              setFilter((prev) => ({ ...prev, symbol: event.target.value || undefined }))
            }
            className="h-7 w-[116px] rounded-md border border-input bg-background px-2 text-[12px] text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
            aria-label="按品种筛选"
          >
            <option value="">全部品种</option>
            {(stats?.bySymbol ?? []).map((row) => (
              <option key={row.key} value={row.key}>
                {row.key}
              </option>
            ))}
            {filter.symbol &&
              !(stats?.bySymbol ?? []).some((row) => row.key === filter.symbol) && (
                <option value={filter.symbol}>{filter.symbol}</option>
              )}
          </select>
          <select
            value={filter.tag ?? ''}
            onChange={(event) =>
              setFilter((prev) => ({ ...prev, tag: event.target.value || undefined }))
            }
            className="h-7 w-[116px] rounded-md border border-input bg-background px-2 text-[12px] text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
            aria-label="按标签筛选"
          >
            <option value="">全部标签</option>
            {(stats?.byTag ?? []).map((row) => (
              <option key={row.key} value={row.key}>
                {row.key}
              </option>
            ))}
            {filter.tag &&
              !(stats?.byTag ?? []).some((row) => row.key === filter.tag) && (
                <option value={filter.tag}>{filter.tag}</option>
              )}
          </select>
          {(
            [
              { value: undefined, label: '全部' },
              { value: 'win' as const, label: '盈利' },
              { value: 'loss' as const, label: '亏损' },
            ]
          ).map((item) => (
            <Button
              key={item.label}
              onClick={() => setFilter((prev) => ({ ...prev, result: item.value }))}
              size="xs"
              variant={(filter.result ?? undefined) === item.value ? 'default' : 'outline'}
            >
              {item.label}
            </Button>
          ))}
          <span className="mx-1 h-4 w-px bg-border" />
          {(
            [
              { value: undefined, label: '全部复盘' },
              { value: 0 as const, label: '待复盘' },
              { value: 1 as const, label: '已复盘' },
            ]
          ).map((item) => (
            <Button
              key={item.label}
              onClick={() => setFilter((prev) => ({ ...prev, reviewed: item.value }))}
              size="xs"
              variant={filter.reviewed === item.value ? 'default' : 'outline'}
            >
              {item.label}
            </Button>
          ))}
          {filterActive && (
            <Button
              onClick={() => setFilter({})}
              variant="ghost"
              size="xs"
              className="ml-1 text-muted-foreground"
            >
              清除筛选
            </Button>
          )}
          <span className="ml-auto text-[10px] text-muted-foreground/60">
            统计卡与列表按同一筛选口径
          </span>
        </Card>

        <Card className="mt-2 min-w-0 overflow-hidden">
          <div className="max-h-[calc(100vh-320px)] min-h-[240px] overflow-auto">
            <Table className="w-full min-w-[760px] border-collapse text-[12px]">
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow className="border-0 text-left text-[11px] text-muted-foreground/60 shadow-[inset_0_-1px_0_var(--border)] hover:bg-transparent">
                  <TableHead className="h-auto w-[116px] px-4 py-2 font-normal">平仓时间</TableHead>
                  <TableHead className="h-auto w-[96px] px-2 py-2 font-normal">品种 / 方向</TableHead>
                  <TableHead className="h-auto w-[48px] px-2 py-2 text-right font-normal">手数</TableHead>
                  <TableHead className="h-auto w-[150px] px-3 py-2 text-right font-normal">开 → 平</TableHead>
                  <TableHead className="h-auto w-[112px] px-3 py-2 text-right font-normal">盈亏</TableHead>
                  <TableHead className="h-auto w-[62px] px-2 py-2 text-right font-normal">持仓</TableHead>
                  <TableHead className="h-auto w-[110px] px-2 py-2 font-normal">标签</TableHead>
                  <TableHead className="h-auto w-[72px] px-2 py-2 text-right font-normal">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="px-4 py-14 text-center text-[12px] text-muted-foreground/60">
                      {loading
                        ? '读取中…'
                        : filterActive
                          ? '当前筛选下没有已平仓交易'
                          : '这段时间还没有已平仓交易'}
                    </TableCell>
                  </TableRow>
                )}
                {shown.map((record) => {
                  const rMultiple = record.risk && record.risk > 0 ? record.profit / record.risk : null;
                  const closedBy = CLOSED_BY[String(record.closed_by)] ?? null;
                  return (
                    <TableRow
                      key={`${record.login}-${record.position_id}`}
                      onClick={() => setShot({ record, tab: 'chart' })}
                      className="cursor-pointer border-t border-border/70 transition-colors hover:bg-accent/50"
                    >
                      <TableCell
                        className="num whitespace-nowrap px-4 py-1.5 font-mono text-[11px] text-muted-foreground"
                        title="本机时区"
                      >
                        {fmtLocalTime(record.close_time, rowOffset(record, serverOffset))}
                        {closedBy && (
                          <span className="ml-1.5 text-[10px] text-muted-foreground/60">· {closedBy}</span>
                        )}
                        {!record.reviewed_at && (
                          <span className="ml-1.5 text-[10px] text-muted-foreground/60" title="还没有复盘">
                            · 待复盘
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap px-2 py-1.5">
                        <span className="font-medium text-foreground">{record.symbol}</span>
                        <span
                          className={cn(
                            'ml-1.5 inline-flex items-center gap-1 text-[11px]',
                            record.side === 'buy' ? 'text-success-foreground' : 'text-destructive-foreground',
                          )}
                        >
                          <span
                            className={cn(
                              'h-1.5 w-1.5 rounded-full',
                              record.side === 'buy' ? 'bg-success' : 'bg-destructive',
                            )}
                          />
                          {record.side === 'buy' ? '多' : '空'}
                        </span>
                      </TableCell>
                      <TableCell className="num px-2 py-1.5 text-right font-mono text-[11px] text-foreground/80">
                        {fmtVolume(record.volume)}
                      </TableCell>
                      <TableCell className="num whitespace-nowrap px-3 py-1.5 text-right font-mono text-[11px] text-muted-foreground">
                        {price(record.entry_price)} → {price(record.exit_price)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'num whitespace-nowrap px-3 py-1.5 text-right font-mono font-medium',
                          signedClass(record.profit),
                        )}
                      >
                        {fmtSigned(record.profit)}
                        {rMultiple != null && (
                          <span className="ml-1.5 text-[10px] font-normal text-muted-foreground/60">
                            {rMultiple >= 0 ? '+' : ''}
                            {rMultiple.toFixed(2)}R
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="num whitespace-nowrap px-2 py-1.5 text-right font-mono text-[11px] text-muted-foreground">
                        {fmtDuration(record.duration_sec)}
                      </TableCell>
                      <TableCell className="px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
                        {editing?.id === record.position_id ? (
                          <Input
                            autoFocus
                            value={editing.value}
                            maxLength={40}
                            onChange={(event) =>
                              setEditing({ id: record.position_id, value: event.target.value })
                            }
                            onBlur={() => void saveTag(record, editing.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') void saveTag(record, editing.value);
                              if (event.key === 'Escape') setEditing(null);
                            }}
                            size="sm"
                            className="w-24"
                          />
                        ) : (
                          <Button
                            onClick={() =>
                              setEditing({ id: record.position_id, value: record.tag ?? '' })
                            }
                            variant="ghost"
                            size="xs"
                            className="h-6 max-w-[104px] justify-start px-1.5 text-[12px] text-foreground/80"
                            title="点击修改策略标签"
                          >
                            <span className="truncate">
                              {record.tag || <span className="text-muted-foreground/60">未标记</span>}
                            </span>
                          </Button>
                        )}
                      </TableCell>
                      <TableCell className="px-2 py-1.5">
                        <div className="flex items-center justify-end gap-0.5">
                          {!!record.has_shot && (
                            <RowAction
                              label="截图"
                              onClick={() => setShot({ record, tab: 'shot' })}
                            >
                              <Camera size={14} strokeWidth={1.6} />
                            </RowAction>
                          )}
                          <RowAction
                            label="复盘"
                            onClick={() => setReviewing(record.position_id)}
                          >
                            <NotebookPen size={13} strokeWidth={1.6} />
                          </RowAction>
                          <RowAction
                            label="回放"
                            onClick={() => replay.start(record)}
                          >
                            <Play size={13} strokeWidth={1.6} />
                          </RowAction>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            </div>
            {records.length > 0 && (
              <div className="flex items-center justify-between border-t border-border bg-card/60 px-4 py-1.5 text-[11px] text-muted-foreground/60">
                <span>
                  已显示 {shown.length} / {records.length} 条
                </span>
                {shown.length < records.length && (
                  <Button
                    onClick={() => setVisible((value) => value + PAGE_SIZE)}
                    variant="outline"
                    size="xs"
                  >
                    显示更多
                  </Button>
                )}
              </div>
            )}
        </Card>
      </div>

      <TradeReviewDrawer
        positionId={reviewing}
        onClose={() => setReviewing(null)}
        onChanged={() => void load()}
      />

      {shot && (
        <TradeDetailModal
          record={shot.record}
          initialTab={shot.tab}
          onClose={() => setShot(null)}
        />
      )}
    </div>
  );
}
/** 行内图标按钮：拦住行点击，避免看截图/复盘时又弹出图表 */
function RowAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
            title={label}
            aria-label={label}
            size="icon-sm"
            variant="ghost"
            className="text-muted-foreground hover:text-foreground"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

function StatCard({
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
      <div className={cn('num mt-1.5 font-mono text-[20px] font-medium leading-none tracking-[-0.01em]', tone)}>
        {value}
      </div>
      <div className="mt-2 truncate text-[11px] text-muted-foreground/60">{hint ?? ' '}</div>
    </div>
  );
}
