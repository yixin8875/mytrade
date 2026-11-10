import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
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

type BreakdownTab = 'symbol' | 'hour' | 'tag';

export function JournalPanel() {
  const open = useApp((s) => s.journalOpen);
  const setOpen = useApp((s) => s.setJournalOpen);
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
    if (open) void load(true);
    // load 每次渲染都是新函数，只在打开或切换天数时重新拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, days]);

  if (!open) return null;

  const summary = stats?.summary;
  const breakdown: JournalBreakdown[] =
    tab === 'symbol'
      ? stats?.bySymbol ?? []
      : tab === 'hour'
        ? stats?.byHour ?? []
        : stats?.byTag ?? [];

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
    <div
      data-modal="journal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="flex max-h-[90vh] w-[min(1120px,96vw)] flex-col rounded border border-tv-border bg-tv-panel shadow-2xl">
        <div className="flex items-center gap-2 border-b border-tv-border px-4 py-2.5">
          <span className="text-sm font-medium text-tv-text">交易日志</span>
          <div className="flex gap-1">
            {RANGES.map((value) => (
              <button
                key={value}
                onClick={() => setDays(value)}
                className={clsx(
                  'h-6 rounded px-2 text-[10px]',
                  days === value
                    ? 'bg-tv-border text-tv-text'
                    : 'text-tv-muted hover:bg-tv-border/60 hover:text-tv-text',
                )}
              >
                {value} 天
              </button>
            ))}
          </div>
          <button
            onClick={() => void load(true)}
            disabled={loading}
            className={clsx(
              'h-6 rounded bg-tv-border px-2 text-[10px] text-tv-text hover:bg-tv-hover',
              loading && 'opacity-50',
            )}
          >
            {loading ? '刷新中…' : '刷新'}
          </button>
          <span className="flex-1" />
          <span className="text-[9px] text-tv-muted">已平仓交易自动记录；标签可点击修改</span>
          <button
            onClick={() => setOpen(false)}
            className="h-6 w-6 rounded text-tv-muted hover:bg-tv-hover hover:text-tv-text"
          >
            ✕
          </button>
        </div>

        {error && <div className="px-4 py-2 text-[11px] text-tv-down">读取日志失败：{error}</div>}

        <div className="grid shrink-0 grid-cols-6 gap-2 px-4 py-3">
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
                ? `毛利 ${fmtMoney(summary.grossProfit)} / 毛损 ${fmtMoney(summary.grossLoss)}`
                : undefined
            }
          />
          <StatCard
            label="期望/笔"
            value={summary?.expectancy != null ? fmtSigned(summary.expectancy) : '—'}
            tone={summary?.expectancy != null ? signedClass(summary.expectancy) : undefined}
            hint={summary ? `平均持仓 ${fmtDuration(summary.avgDurationSec)}` : undefined}
          />
          <StatCard
            label="最大回撤"
            value={summary ? fmtMoney(summary.maxDrawdown) : '—'}
            tone="text-tv-down"
            hint={
              summary
                ? `最好 ${fmtSigned(summary.bestTrade)} / 最差 ${fmtSigned(summary.worstTrade)}`
                : undefined
            }
          />
        </div>

        <div className="flex min-h-0 flex-1 gap-3 px-4 pb-3">
          <div className="flex w-[300px] shrink-0 flex-col rounded border border-tv-border/60">
            <div className="flex items-center gap-1 border-b border-tv-border/60 px-2 py-1.5">
              {(
                [
                  ['symbol', '按品种'],
                  ['hour', '按时段'],
                  ['tag', '按策略'],
                ] as [BreakdownTab, string][]
              ).map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setTab(value)}
                  className={clsx(
                    'h-5 rounded px-1.5 text-[10px]',
                    tab === value ? 'bg-tv-border text-tv-text' : 'text-tv-muted hover:text-tv-text',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {breakdown.length === 0 && (
                <div className="px-2 py-4 text-center text-[10px] text-tv-muted">暂无数据</div>
              )}
              {breakdown.map((row) => (
                <div
                  key={row.key}
                  className="flex items-center gap-2 border-b border-tv-border/40 px-2 py-1 text-[10px]"
                >
                  <span className="w-16 shrink-0 truncate text-tv-text">{row.key}</span>
                  <span className="w-10 shrink-0 text-right font-mono text-tv-muted">
                    {row.trades} 笔
                  </span>
                  <span className="w-12 shrink-0 text-right font-mono text-tv-muted">
                    {row.winRate.toFixed(0)}%
                  </span>
                  <span className={clsx('flex-1 text-right font-mono', signedClass(row.pnl))}>
                    {fmtSigned(row.pnl)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto rounded border border-tv-border/60">
            <table className="w-full border-collapse text-[10px]">
              <thead className="sticky top-0 z-10 bg-tv-panel">
                <tr className="text-left text-tv-muted">
                  <th className="px-2 py-1 font-normal">时间</th>
                  <th className="px-2 py-1 font-normal">品种 / 方向</th>
                  <th className="px-2 py-1 text-right font-normal">手数</th>
                  <th className="px-2 py-1 text-right font-normal">开 → 平</th>
                  <th className="px-2 py-1 text-right font-normal">盈亏</th>
                  <th className="px-2 py-1 text-right font-normal">持仓</th>
                  <th className="px-2 py-1 text-right font-normal">MFE / MAE</th>
                  <th className="px-2 py-1 font-normal">出场</th>
                  <th className="px-2 py-1 font-normal">标签</th>
                  <th className="px-2 py-1 font-normal">图</th>
                </tr>
              </thead>
              <tbody>
                {records.length === 0 && (
                  <tr>
                    <td colSpan={10} className="px-2 py-6 text-center text-tv-muted">
                      {loading ? '读取中…' : '这段时间还没有已平仓交易'}
                    </td>
                  </tr>
                )}
                {records.map((record) => (
                  <tr key={record.position_id} className="border-t border-tv-border/40">
                    <td className="whitespace-nowrap px-2 py-1 font-mono text-tv-muted">
                      {fmtTime(record.close_time)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1">
                      <span className="text-tv-text">{record.symbol}</span>
                      <span
                        className={clsx(
                          'ml-1 rounded px-1 text-[9px] font-semibold text-white',
                          record.side === 'buy' ? 'bg-tv-up' : 'bg-tv-down',
                        )}
                      >
                        {record.side === 'buy' ? '多' : '空'}
                      </span>
                    </td>
                    <td className="px-2 py-1 text-right font-mono text-tv-text">
                      {fmtVolume(record.volume)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-tv-muted">
                      {fmtPrice(record.entry_price)} → {fmtPrice(record.exit_price)}
                    </td>
                    <td
                      className={clsx('px-2 py-1 text-right font-mono', signedClass(record.profit))}
                    >
                      {fmtSigned(record.profit)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-tv-muted">
                      {fmtDuration(record.duration_sec)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 text-right font-mono">
                      <span className="text-tv-up">
                        {record.mfe != null ? fmtSigned(record.mfe) : '—'}
                      </span>
                      <span className="text-tv-muted"> / </span>
                      <span className="text-tv-down">
                        {record.mae != null ? fmtSigned(record.mae) : '—'}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 text-tv-muted">
                      {CLOSED_BY[String(record.closed_by)] ?? record.closed_by ?? '—'}
                    </td>
                    <td className="px-2 py-1">
                      {editing?.id === record.position_id ? (
                        <input
                          autoFocus
                          value={editing.value}
                          maxLength={40}
                          onChange={(event) =>
                            setEditing({ id: record.position_id, value: event.target.value })
                          }
                          onBlur={() => saveTag(record, editing.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void saveTag(record, editing.value);
                            if (event.key === 'Escape') setEditing(null);
                          }}
                          className="h-5 w-24 rounded border border-tv-accent bg-tv-bg px-1 text-[10px] text-tv-text outline-none"
                        />
                      ) : (
                        <button
                          onClick={() =>
                            setEditing({ id: record.position_id, value: record.tag ?? '' })
                          }
                          className="h-5 rounded px-1 text-left text-[10px] text-tv-text hover:bg-tv-hover"
                          title="点击修改策略标签"
                        >
                          {record.tag || <span className="text-tv-muted">未标记</span>}
                        </button>
                      )}
                    </td>
                    <td className="px-2 py-1">
                      {record.has_shot ? (
                        <button
                          onClick={() => setShot(record.position_id)}
                          className="h-5 rounded bg-tv-border px-1.5 text-[9px] text-tv-text hover:bg-tv-hover"
                        >
                          查看
                        </button>
                      ) : (
                        <span className="text-tv-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {shot != null && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-6"
          onClick={() => setShot(null)}
        >
          <img
            src={`${SHOT_BASE}/${shot}.jpg`}
            alt={`交易 ${shot} 的图表截图`}
            className="max-h-full max-w-full rounded border border-tv-border object-contain"
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
    <div className="rounded border border-tv-border/60 bg-tv-bg/40 px-2 py-1.5">
      <div className="text-[9px] text-tv-muted">{label}</div>
      <div className={clsx('font-mono text-[13px]', tone ?? 'text-tv-text')}>{value}</div>
      <div className="truncate text-[9px] text-tv-muted">{hint ?? ' '}</div>
    </div>
  );
}
