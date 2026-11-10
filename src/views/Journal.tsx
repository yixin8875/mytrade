import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { RefreshCw } from 'lucide-react';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import { fmtMoney, fmtPrice, fmtSigned, fmtVolume, signedClass } from '../lib/format';
import type { JournalBreakdown, JournalRecord, JournalStats } from '../gateway/types';

const SHOT_BASE = 'http://127.0.0.1:8765/shots';
const RANGES = [7, 30, 90];

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

  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<JournalStats | null>(null);
  const [records, setRecords] = useState<JournalRecord[]>([]);
  const [tab, setTab] = useState<BreakdownTab>('symbol');
  const [editing, setEditing] = useState<{ id: number; value: string } | null>(null);
  const [shot, setShot] = useState<number | null>(null);
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
    // load 每次渲染都是新函数，只在区间变化时重新拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

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
      <div className="mx-auto w-full max-w-[1240px] px-8 py-7">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-semibold tracking-tight">交易日志</h1>
            <p className="mt-1 text-[11.5px] text-console-muted">
              已平仓交易自动记录 · 点击标签可修改策略 · 截图随成交自动保存
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
              <RefreshCw size={13} className={clsx(loading && 'animate-spin')} />
              {loading ? '读取中…' : '同步刷新'}
            </button>
          </div>
        </header>

        {error && (
          <div className="mt-4 rounded-lg border border-console-loss/30 bg-console-loss-soft px-3 py-2 text-[11px] text-console-loss">
            读取日志失败：{error}
          </div>
        )}

        <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <StatCard label="交易笔数" value={summary ? String(summary.trades) : '—'} />
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

        <div className="mt-4 grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
          <section className="console-card flex flex-col overflow-hidden">
            <div className="flex items-center gap-1 border-b border-console-line px-3 py-2">
              {BREAKDOWN_TABS.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setTab(item.id)}
                  className={clsx(
                    'h-6 rounded-md px-2 text-[10.5px] transition-colors',
                    tab === item.id
                      ? 'bg-console-selected font-medium text-console-ink'
                      : 'text-console-muted hover:bg-console-hover hover:text-console-ink',
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="min-h-[120px] flex-1 overflow-auto p-2">
              {breakdown.length === 0 && (
                <div className="px-2 py-8 text-center text-[11px] text-console-faint">
                  {loading ? '读取中…' : '暂无数据'}
                </div>
              )}
              {breakdown.map((row) => (
                <div key={row.key} className="relative rounded-md px-2 py-1.5">
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
                  <div className="relative flex items-center gap-2 text-[10.5px]">
                    <span className="w-16 shrink-0 truncate font-medium text-console-ink">
                      {row.key}
                    </span>
                    <span className="num w-12 shrink-0 text-right text-console-muted">
                      {row.trades} 笔
                    </span>
                    <span className="num w-10 shrink-0 text-right text-console-muted">
                      {row.winRate.toFixed(0)}%
                    </span>
                    <span
                      className={clsx('num flex-1 text-right font-medium', signedClass(row.pnl))}
                    >
                      {fmtSigned(row.pnl)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="console-card min-w-0 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[880px] border-collapse text-[11.5px]">
                <thead>
                  <tr className="border-b border-console-line text-left text-[10px] text-console-faint">
                    <th className="px-4 py-2 font-normal">平仓时间</th>
                    <th className="px-2 py-2 font-normal">品种 / 方向</th>
                    <th className="px-2 py-2 text-right font-normal">手数</th>
                    <th className="px-3 py-2 text-right font-normal">开 → 平</th>
                    <th className="px-3 py-2 text-right font-normal">盈亏</th>
                    <th className="px-2 py-2 text-right font-normal">持仓</th>
                    <th className="px-3 py-2 text-right font-normal">MFE / MAE</th>
                    <th className="px-2 py-2 font-normal">出场</th>
                    <th className="px-2 py-2 font-normal">标签</th>
                    <th className="px-4 py-2 font-normal">图</th>
                  </tr>
                </thead>
                <tbody>
                  {records.length === 0 && (
                    <tr>
                      <td colSpan={10} className="px-4 py-14 text-center text-console-faint">
                        {loading ? '读取中…' : '这段时间还没有已平仓交易'}
                      </td>
                    </tr>
                  )}
                  {records.map((record) => (
                    <tr
                      key={record.position_id}
                      className="border-t border-console-line/70 transition-colors hover:bg-console-hover/50"
                    >
                      <td className="num whitespace-nowrap px-4 py-2.5 text-console-muted">
                        {fmtTime(record.close_time)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2.5">
                        <span className="font-medium text-console-ink">{record.symbol}</span>
                        <span
                          className={clsx(
                            'ml-1.5 rounded px-1 py-0.5 text-[9.5px] font-semibold',
                            record.side === 'buy'
                              ? 'bg-console-gain-soft text-console-gain'
                              : 'bg-console-loss-soft text-console-loss',
                          )}
                        >
                          {record.side === 'buy' ? '多' : '空'}
                        </span>
                      </td>
                      <td className="num px-2 py-2.5 text-right text-console-ink-2">
                        {fmtVolume(record.volume)}
                      </td>
                      <td className="num whitespace-nowrap px-3 py-2.5 text-right text-console-muted">
                        {fmtPrice(record.entry_price)} → {fmtPrice(record.exit_price)}
                      </td>
                      <td
                        className={clsx(
                          'num px-3 py-2.5 text-right font-medium',
                          signedClass(record.profit),
                        )}
                      >
                        {fmtSigned(record.profit)}
                      </td>
                      <td className="num whitespace-nowrap px-2 py-2.5 text-right text-console-muted">
                        {fmtDuration(record.duration_sec)}
                      </td>
                      <td className="num whitespace-nowrap px-3 py-2.5 text-right">
                        <span className="text-console-gain">
                          {record.mfe != null ? fmtSigned(record.mfe) : '—'}
                        </span>
                        <span className="text-console-faint"> / </span>
                        <span className="text-console-loss">
                          {record.mae != null ? fmtSigned(record.mae) : '—'}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-2 py-2.5 text-console-muted">
                        {CLOSED_BY[String(record.closed_by)] ?? record.closed_by ?? '—'}
                      </td>
                      <td className="px-2 py-2.5">
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
                            className="console-input h-6 w-24 px-1.5 text-[10.5px]"
                          />
                        ) : (
                          <button
                            onClick={() =>
                              setEditing({ id: record.position_id, value: record.tag ?? '' })
                            }
                            className="h-6 rounded px-1.5 text-left text-[10.5px] text-console-ink-2 hover:bg-console-hover"
                            title="点击修改策略标签"
                          >
                            {record.tag || <span className="text-console-faint">未标记</span>}
                          </button>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {record.has_shot ? (
                          <button
                            onClick={() => setShot(record.position_id)}
                            className="h-6 rounded border border-console-line bg-white px-1.5 text-[10px] text-console-ink-2 hover:bg-console-hover"
                          >
                            查看
                          </button>
                        ) : (
                          <span className="text-console-faint">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>

      {shot != null && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6"
          onClick={() => setShot(null)}
        >
          <img
            src={`${SHOT_BASE}/${shot}.jpg`}
            alt={`交易 ${shot} 的图表截图`}
            className="max-h-full max-w-full rounded-lg border border-console-line object-contain shadow-2xl"
          />
        </div>
      )}
    </div>
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
    <div className="console-card px-4 py-3">
      <div className="text-[10.5px] text-console-muted">{label}</div>
      <div className={clsx('num mt-1 text-[17px] font-semibold tracking-tight', tone)}>{value}</div>
      <div className="mt-0.5 truncate text-[9.5px] text-console-faint">{hint ?? ' '}</div>
    </div>
  );
}
