import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import type { AuditRecord } from '../gateway/types';

const inputClass =
  'h-7 rounded border border-tv-border bg-tv-bg px-2 text-[11px] text-tv-text outline-none focus:border-tv-accent';

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function fmtClock(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

export function AuditModal() {
  const open = useApp((s) => s.auditOpen);
  const setOpen = useApp((s) => s.setAuditOpen);
  const notify = useApp((s) => s.notify);
  const [date, setDate] = useState(todayUtc);
  const [kind, setKind] = useState('');
  const [text, setText] = useState('');
  const [rows, setRows] = useState<AuditRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const result = await gateway.call<AuditRecord[]>('audit.query', {
        date,
        kind: kind.trim() || undefined,
        text: text.trim() || undefined,
        limit: 300,
      });
      setRows(result);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void load();
    // 只在打开时自动查一次，筛选条件用「查询」按钮
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const reconcile = async () => {
    try {
      const result = await gateway.call<{ checked: number; found: number; notFound: number }>(
        'system.reconcile',
        {},
      );
      notify(
        result.notFound > 0 ? 'error' : 'success',
        `对账完成：检查 ${result.checked}，找到 ${result.found}，未找到 ${result.notFound}`,
      );
      await load();
    } catch (err) {
      notify('error', (err as Error).message);
    }
  };

  if (!open) return null;

  return (
    <div
      data-modal="audit"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="flex max-h-[90vh] w-[min(1080px,96vw)] flex-col rounded border border-tv-border bg-tv-panel shadow-2xl">
        <div className="flex items-center gap-2 border-b border-tv-border px-4 py-2.5">
          <span className="text-sm font-medium text-tv-text">审计日志</span>
          <span className="text-[10px] text-tv-muted">UTC 日期 · JSONL</span>
          <span className="flex-1" />
          <button
            onClick={reconcile}
            className="h-6 rounded bg-tv-accent/20 px-2 text-[10px] text-tv-accent hover:bg-tv-accent/30"
            title="按 clientOrderId 与 MT5 挂单/持仓/近 7 天成交重新对账"
          >
            立即对账
          </button>
          <button
            onClick={() => setOpen(false)}
            className="h-6 w-6 rounded text-tv-muted hover:bg-tv-hover hover:text-tv-text"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-tv-border px-4 py-2">
          <label className="flex items-center gap-1 text-[10px] text-tv-muted">
            日期
            <input
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              className={inputClass}
            />
          </label>
          <label className="flex items-center gap-1 text-[10px] text-tv-muted">
            类型
            <input
              value={kind}
              onChange={(event) => setKind(event.target.value)}
              placeholder="如 order. / alert / reconcile"
              className={clsx(inputClass, 'w-56')}
            />
          </label>
          <label className="flex items-center gap-1 text-[10px] text-tv-muted">
            含文本
            <input
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="品种 / clientId / 错误"
              className={clsx(inputClass, 'w-52')}
            />
          </label>
          <button
            onClick={load}
            disabled={loading}
            className="h-7 rounded bg-tv-border px-3 text-[10px] text-tv-text hover:bg-tv-hover disabled:opacity-50"
          >
            {loading ? '查询中…' : '查询'}
          </button>
          <span className="text-[10px] text-tv-muted">{rows.length} 条（最多 300）</span>
          {error && <span className="text-[10px] text-tv-down">{error}</span>}
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-2">
          {rows.length === 0 && !loading && (
            <div className="py-10 text-center text-[11px] text-tv-muted">
              这个日期没有匹配的审计记录
            </div>
          )}
          {rows.map((record, index) => (
            <details
              key={`${record.ts}-${index}`}
              className="mb-1 rounded border border-tv-border/70 bg-tv-bg/40"
            >
              <summary className="flex cursor-pointer items-center gap-2 px-2 py-1 text-[10px]">
                <span className="w-[68px] shrink-0 font-mono text-tv-muted">{fmtClock(record.ts)}</span>
                <span className="shrink-0 rounded bg-tv-panel px-1.5 py-0.5 font-mono text-tv-text">
                  {record.kind}
                </span>
                <span className="truncate font-mono text-tv-muted">
                  {JSON.stringify(record.payload)}
                </span>
              </summary>
              <pre className="max-h-60 overflow-auto border-t border-tv-border/60 px-2 py-1 font-mono text-[10px] leading-relaxed text-tv-text">
                {JSON.stringify(record.payload, null, 2)}
              </pre>
            </details>
          ))}
        </div>
      </div>
    </div>
  );
}
