import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import type { AuditRecord } from '../gateway/types';

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function fmtClock(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

/** 审计日志页：按 UTC 日期查询网关 JSONL 审计记录 */
export function AuditView() {
  const conn = useApp((s) => s.conn);
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
    if (conn !== 'open') return;
    void load();
    // 连接可用时自动查一次，之后筛选条件用「查询」按钮
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn]);

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

  return (
    <div className="console-scope h-full min-h-0 overflow-auto bg-console-canvas">
      <div className="mx-auto w-full max-w-[1240px] px-8 py-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-medium tracking-[-0.01em]">审计日志</h1>
            <p className="mt-1.5 text-[13px] text-console-muted">
              UTC 日期 · JSONL 文件 · 最多返回 300 条
            </p>
          </div>
          <button
            onClick={reconcile}
            className="console-btn console-btn-secondary"
            title="按 clientOrderId 与 MT5 挂单/持仓/近 7 天成交重新对账"
          >
            <RefreshCw size={14} strokeWidth={1.5} />
            立即对账
          </button>
        </header>

        <section className="console-card mt-6 p-5">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="console-label">日期（UTC）</span>
              <input
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                className="console-input w-[152px]"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="console-label">类型</span>
              <input
                value={kind}
                onChange={(event) => setKind(event.target.value)}
                placeholder="如 order. / alert / reconcile"
                className="console-input w-64"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="console-label">含文本</span>
              <input
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="品种 / clientId / 错误"
                className="console-input w-60"
              />
            </label>
            <button
              onClick={() => void load()}
              disabled={loading}
              className="console-btn console-btn-primary h-8"
            >
              {loading ? '查询中…' : '查询'}
            </button>
            <span className="flex-1" />
            <span className="num pb-2 font-mono text-[11px] text-console-faint">
              {rows.length} 条
            </span>
          </div>
          {error && (
            <div className="mt-4 rounded-lg border border-console-loss/30 bg-console-loss-soft px-3 py-2 text-[12px] text-console-loss">
              读取审计日志失败：{error}
            </div>
          )}
        </section>

        <section className="console-card mt-4 overflow-hidden">
          <div className="flex items-baseline justify-between border-b border-console-line px-5 py-3.5">
            <span className="text-[13px] font-semibold">记录</span>
            <span className="num font-mono text-[11px] text-console-faint">{date}</span>
          </div>

          {rows.length === 0 && !loading ? (
            <div className="px-5 py-14 text-center text-[12px] text-console-faint">
              这个日期没有匹配的审计记录
            </div>
          ) : (
            <div>
              {rows.map((record, index) => (
                <details
                  key={`${record.ts}-${index}`}
                  className="group border-b border-console-line/70 last:border-b-0"
                >
                  <summary className="flex cursor-pointer list-none items-center gap-2.5 px-5 py-2.5 text-[12px] hover:bg-console-hover/60">
                    <span className="num w-[76px] shrink-0 font-mono text-[11px] text-console-muted">
                      {fmtClock(record.ts)}
                    </span>
                    <span className="shrink-0 rounded-md border border-console-line bg-console-canvas px-1.5 py-0.5 font-mono text-[11px] text-console-ink-2">
                      {record.kind}
                    </span>
                    <span className="truncate font-mono text-[11px] text-console-faint">
                      {JSON.stringify(record.payload)}
                    </span>
                  </summary>
                  <pre className="max-h-72 overflow-auto border-t border-console-line/60 bg-console-canvas/60 px-5 py-3 font-mono text-[11px] leading-relaxed text-console-ink-2">
                    {JSON.stringify(record.payload, null, 2)}
                  </pre>
                </details>
              ))}
            </div>
          )}
        </section>

        <p className="mt-4 text-[11px] text-console-faint">
          {loading ? '正在读取审计文件…' : '审计记录由网关写入 gateway/audit，按 UTC 日期分文件。'}
        </p>
      </div>
    </div>
  );
}
