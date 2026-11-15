import { useEffect, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { ChartCandlestick, NotebookPen, Play, RefreshCw } from 'lucide-react';
import { gateway } from '../gateway/client';
import { TradeDetailModal } from '../components/TradeDetailModal';
import { TradeReviewDrawer } from '../components/TradeReviewDrawer';
import { ReferenceCapacityDialog, useTradeReplay } from '../replay/useTradeReplay';
import { useApp } from '../store/useApp';
import { fmtMoney, fmtPrice, fmtSigned, fmtVolume, signedClass } from '../lib/format';
import { usePrivacyMask } from '../lib/privacy';
import { priceDigits } from '../lib/tradeChart';
import type { JournalBreakdown, JournalRecord, JournalStats } from '../gateway/types';

const RANGES = [7, 30, 90];
const PAGE_SIZE = 50;

const CLOSED_BY: Record<string, string> = {
  sl: '止损',
  tp: '止盈',
  so: '强平',
  stop_out: '强平',
  manual: '手动',
};

type BreakdownTab = 'symbol' | 'hour' | 'tag';

const BREAKDOWN_TABS: { id: BreakdownTab; label: string }[] = [
  { id: 'symbol', label: '按品种' },
  { id: 'hour', label: '按时段' },
  { id: 'tag', label: '按策略' },
];

function fmtTime(ts: number): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  if (sec < 60) return `${Math.round(sec)}秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)}分`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}时${Math.floor((sec % 3600) / 60)}分`;
  return `${Math.floor(sec / 86400)}天`;
}

/** 交易日志页：区间筛选、统计卡片、分组表现与已平仓明细 */
export function JournalView() {
  const notify = useApp((s) => s.notify);
  const activeLogin = useApp((s) => s.account?.login ?? 0);
  usePrivacyMask();

  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<JournalStats | null>(null);
  const [records, setRecords] = useState<JournalRecord[]>([]);
  const [tab, setTab] = useState<BreakdownTab>('symbol');
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
        gateway.call<JournalStats>('journal.stats', { days }),
        gateway.call<JournalRecord[]>('journal.list', { days, limit: 300 }),
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
    // load 每次渲染都是新函数，只在区间或账户变化时重新拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, activeLogin]);

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
  const breakdown: JournalBreakdown[] =
    tab === 'symbol'
      ? (stats?.bySymbol ?? [])
      : tab === 'hour'
        ? (stats?.byHour ?? [])
        : (stats?.byTag ?? []);
  const breakdownMax = breakdown.reduce((max, row) => Math.max(max, Math.abs(row.pnl)), 0);

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
      // 按标签的统计也要跟着刷新
      gateway
        .call<JournalStats>('journal.stats', { days })
        .then(setStats)
        .catch(() => {});
    } catch (err) {
      notify('error', (err as Error).message);
    }
  };

  return (
    <div className="console-scope h-full min-h-0 overflow-auto bg-console-canvas">
      <div className="mx-auto w-full max-w-[1240px] px-8 py-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-medium tracking-[-0.01em]">交易日志</h1>
            <p className="mt-1.5 text-[13px] text-console-muted">
              已平仓交易自动记录
              {activeLogin ? ` · 账户 ${activeLogin}` : ''} · 点击标签可修改策略
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
              onClick={() => void load(true)}
              disabled={loading}
              className="console-btn console-btn-secondary"
            >
              <RefreshCw size={14} strokeWidth={1.5} className={clsx(loading && 'animate-spin')} />
              {loading ? '读取中…' : '同步刷新'}
            </button>
          </div>
        </header>

        {error && (
          <div className="mt-4 rounded-lg border border-console-loss/30 bg-console-loss-soft px-3 py-2 text-[12px] text-console-loss">
            读取日志失败：{error}
          </div>
        )}

        <div className="readout mt-6 grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
          <StatCard
            label="交易笔数"
            value={summary ? String(summary.trades) : '—'}
            hint={summary?.truncated ? '仅统计最近 5000 笔' : undefined}
          />
          <StatCard
            label="胜率"
            value={summary?.winRate != null ? `${summary.winRate.toFixed(1)}%` : '—'}
            hint={summary ? `${summary.wins} 胜 / ${summary.losses} 负` : undefined}
          />
          <StatCard
            label="净盈亏"
            value={summary ? fmtSigned(summary.netPnl) : '—'}
            tone={summary ? signedClass(summary.netPnl) : undefined}
          />
          <StatCard
            label="盈亏比"
            value={summary?.profitFactor != null ? summary.profitFactor.toFixed(2) : '—'}
            hint={
              summary
                ? `毛利 ${fmtMoney(summary.grossProfit)} · 毛损 ${fmtMoney(summary.grossLoss)}`
                : undefined
            }
          />
          <StatCard
            label="期望 / 笔"
            value={summary?.expectancy != null ? fmtSigned(summary.expectancy) : '—'}
            tone={summary?.expectancy != null ? signedClass(summary.expectancy) : undefined}
            hint={summary ? `平均持仓 ${fmtDuration(summary.avgDurationSec)}` : undefined}
          />
          <StatCard
            label="最大回撤"
            value={summary ? fmtMoney(summary.maxDrawdown) : '—'}
            tone={summary && summary.maxDrawdown > 0 ? 'text-console-loss' : undefined}
            hint={
              summary?.bestTrade != null
                ? `最好 ${fmtSigned(summary.bestTrade)} · 最差 ${fmtSigned(summary.worstTrade ?? 0)}`
                : undefined
            }
          />
        </div>

        <div className="mt-4 grid gap-4">
          <section className="console-card flex flex-col overflow-hidden">
            <div className="flex items-center gap-1 border-b border-console-line px-3 py-2">
              {BREAKDOWN_TABS.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setTab(item.id)}
                  className={clsx(
                    'h-7 rounded-md px-2.5 text-[12px] transition-colors',
                    tab === item.id
                      ? 'bg-console-selected font-medium text-console-ink'
                      : 'text-console-muted hover:bg-console-hover hover:text-console-ink',
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="max-h-[360px] min-h-[120px] flex-1 overflow-auto p-2">
              {breakdown.length === 0 && (
                <div className="px-2 py-8 text-center text-[12px] text-console-faint">
                  {loading ? '读取中…' : '暂无数据'}
                </div>
              )}
              {breakdown.map((row) => (
                <div key={row.key} className="relative rounded-md px-2 py-2">
                  <div
                    className={clsx(
                      'absolute inset-y-1 left-0 rounded-sm opacity-70',
                      row.pnl >= 0 ? 'bg-console-gain-soft' : 'bg-console-loss-soft',
                    )}
                    style={{
                      width:
                        breakdownMax > 0 ? `${(Math.abs(row.pnl) / breakdownMax) * 100}%` : '0%',
                    }}
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
                    <span
                      className={clsx('num flex-1 text-right font-mono font-medium', signedClass(row.pnl))}
                    >
                      {fmtSigned(row.pnl)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="console-card min-w-0 overflow-hidden">
            <div className="max-h-[calc(100vh-320px)] min-h-[240px] overflow-auto">
              <table className="w-full min-w-[760px] border-collapse text-[12px]">
                <thead className="sticky top-0 z-10 bg-console-card">
                  <tr className="text-left text-[11px] text-console-faint shadow-[inset_0_-1px_0_var(--color-console-line)]">
                    <th className="w-[116px] px-4 py-2 font-normal">平仓时间</th>
                    <th className="w-[96px] px-2 py-2 font-normal">品种 / 方向</th>
                    <th className="w-[48px] px-2 py-2 text-right font-normal">手数</th>
                    <th className="w-[150px] px-3 py-2 text-right font-normal">开 → 平</th>
                    <th className="w-[112px] px-3 py-2 text-right font-normal">盈亏</th>
                    <th className="w-[62px] px-2 py-2 text-right font-normal">持仓</th>
                    <th className="w-[110px] px-2 py-2 font-normal">标签</th>
                    <th className="w-[72px] px-2 py-2 text-right font-normal">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {records.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-4 py-14 text-center text-[12px] text-console-faint">
                        {loading ? '读取中…' : '这段时间还没有已平仓交易'}
                      </td>
                    </tr>
                  )}
                  {shown.map((record) => {
                    const rMultiple = record.risk && record.risk > 0 ? record.profit / record.risk : null;
                    const closedBy = CLOSED_BY[String(record.closed_by)] ?? null;
                    return (
                      <tr
                        key={`${record.login}-${record.position_id}`}
                        onClick={() => setShot({ record, tab: 'chart' })}
                        className="cursor-pointer border-t border-console-line/70 transition-colors hover:bg-console-hover/50"
                      >
                        <td className="num whitespace-nowrap px-4 py-1.5 font-mono text-[11px] text-console-muted">
                          {fmtTime(record.close_time)}
                          {closedBy && (
                            <span className="ml-1.5 text-[10px] text-console-faint">· {closedBy}</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-2 py-1.5">
                          <span className="font-medium text-console-ink">{record.symbol}</span>
                          <span
                            className={clsx(
                              'ml-1.5 inline-flex items-center gap-1 text-[11px]',
                              record.side === 'buy' ? 'text-console-gain' : 'text-console-loss',
                            )}
                          >
                            <span
                              className={clsx(
                                'h-1.5 w-1.5 rounded-full',
                                record.side === 'buy' ? 'bg-console-gain' : 'bg-console-loss',
                              )}
                            />
                            {record.side === 'buy' ? '多' : '空'}
                          </span>
                        </td>
                        <td className="num px-2 py-1.5 text-right font-mono text-[11px] text-console-ink-2">
                          {fmtVolume(record.volume)}
                        </td>
                        <td className="num whitespace-nowrap px-3 py-1.5 text-right font-mono text-[11px] text-console-muted">
                          {price(record.entry_price)} → {price(record.exit_price)}
                        </td>
                        <td
                          className={clsx(
                            'num whitespace-nowrap px-3 py-1.5 text-right font-mono font-medium',
                            signedClass(record.profit),
                          )}
                        >
                          {fmtSigned(record.profit)}
                          {rMultiple != null && (
                            <span className="ml-1.5 text-[10px] font-normal text-console-faint">
                              {rMultiple >= 0 ? '+' : ''}
                              {rMultiple.toFixed(2)}R
                            </span>
                          )}
                        </td>
                        <td className="num whitespace-nowrap px-2 py-1.5 text-right font-mono text-[11px] text-console-muted">
                          {fmtDuration(record.duration_sec)}
                        </td>
                        <td className="px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
                          {editing?.id === record.position_id ? (
                            <input
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
                              className="console-input h-6 w-24 px-1.5 text-[12px]"
                            />
                          ) : (
                            <button
                              onClick={() =>
                                setEditing({ id: record.position_id, value: record.tag ?? '' })
                              }
                              className="h-6 max-w-[104px] truncate rounded-md px-1.5 text-left text-[12px] text-console-ink-2 transition-colors hover:bg-console-hover"
                              title="点击修改策略标签"
                            >
                              {record.tag || <span className="text-console-faint">未标记</span>}
                            </button>
                          )}
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="flex items-center justify-end gap-0.5">
                            <RowAction
                              label="交易图"
                              onClick={() => setShot({ record, tab: 'chart' })}
                            >
                              <ChartCandlestick size={14} strokeWidth={1.6} />
                            </RowAction>
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
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {records.length > 0 && (
              <div className="flex items-center justify-between border-t border-console-line bg-console-card/60 px-4 py-1.5 text-[11px] text-console-faint">
                <span>
                  已显示 {shown.length} / {records.length} 条
                </span>
                {shown.length < records.length && (
                  <button
                    onClick={() => setVisible((value) => value + PAGE_SIZE)}
                    className="h-7 rounded-md border border-console-line bg-console-card px-2.5 text-[11px] text-console-ink-2 transition-colors hover:bg-console-hover"
                  >
                    显示更多
                  </button>
                )}
              </div>
            )}
          </section>
        </div>
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

      <ReferenceCapacityDialog
        pending={replay.pending}
        onConfirm={replay.confirm}
        onCancel={replay.cancel}
      />
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
    <button
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      title={label}
      aria-label={label}
      className="flex h-6 w-6 items-center justify-center rounded-md text-console-muted transition-colors hover:bg-console-hover hover:text-console-ink"
    >
      {children}
    </button>
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
      <div className="text-[12px] text-console-muted">{label}</div>
      <div className={clsx('num mt-1.5 font-mono text-[20px] font-medium leading-none tracking-[-0.01em]', tone)}>
        {value}
      </div>
      <div className="mt-2 truncate text-[11px] text-console-faint">{hint ?? ' '}</div>
    </div>
  );
}
