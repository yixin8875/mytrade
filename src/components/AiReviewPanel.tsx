import { useCallback, useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { ChevronDown, Loader2, Sparkles } from 'lucide-react';
import { gateway } from '../gateway/client';
import { usePrivacyMask } from '../lib/privacy';
import type {
  AiKind,
  AiPayloadPreview,
  AiReviewResult,
  AiStatus,
} from '../gateway/types';

interface Props {
  /** YYYY-MM-DD：
   *  当日复盘看这一天；本周复盘看截止这一天的 7 天 */
  date: string;
}

function fmtWhen(ts: number): string {
  const when = new Date(ts * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(
    when.getHours(),
  )}:${pad(when.getMinutes())}`;
}

/**
 * AI 复盘面板：没有 Key 或没开启时整块不渲染（功能完全不可见）。
 * 生成前可展开「将发送哪些字段」，笔记必须手动勾选才会带上。
 */
export function AiReviewPanel({ date }: Props) {
  usePrivacyMask();
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [kind, setKind] = useState<AiKind>('day');
  const [preview, setPreview] = useState<AiPayloadPreview | null>(null);
  const [result, setResult] = useState<AiReviewResult | null>(null);
  const [includeNotes, setIncludeNotes] = useState(false);
  const [showFields, setShowFields] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visible = Boolean(status?.enabled && status?.hasKey);

  useEffect(() => {
    let alive = true;
    gateway
      .call<AiStatus>('ai.status')
      .then((next) => {
        if (alive) setStatus(next);
      })
      .catch(() => {
        if (alive) setStatus(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    setResult(null);
    setError(null);
  }, [kind, date]);

  const loadPreview = useCallback(async () => {
    if (!visible) return;
    try {
      const next = await gateway.call<AiPayloadPreview>('ai.payload', {
        kind,
        date,
        includeNotes,
      });
      setPreview(next);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [visible, kind, date, includeNotes]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  if (!visible) return null;

  const generate = async (refresh: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const next = await gateway.call<AiReviewResult>('ai.review', {
        kind,
        date,
        includeNotes,
        refresh,
      });
      setResult(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="console-card mt-3 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[13px] font-medium">
          <Sparkles size={14} strokeWidth={1.6} />
          AI 复盘
          <span className="text-[11px] font-normal text-console-faint">
            {status?.provider === 'anthropic' ? 'Claude' : status?.model}
            {result?.cached ? ' · 缓存' : ''}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-console-line bg-console-canvas p-0.5 text-[11px]">
            {(
              [
                ['day', '当日'],
                ['week', '本周'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                onClick={() => setKind(value)}
                className={clsx(
                  'h-6 rounded-md px-2 transition-colors',
                  kind === value
                    ? 'bg-console-card text-console-ink shadow-[0_1px_2px_rgba(33,28,22,0.06)]'
                    : 'text-console-muted hover:text-console-ink',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={() => setShowFields((value) => !value)}
            className="flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] text-console-muted transition-colors hover:bg-console-hover hover:text-console-ink"
          >
            将发送哪些字段
            <ChevronDown
              size={12}
              strokeWidth={1.8}
              className={clsx('transition-transform', showFields && 'rotate-180')}
            />
          </button>
          <button
            onClick={() => void generate(Boolean(result))}
            disabled={busy}
            className="console-btn console-btn-secondary h-7 text-[11px]"
          >
            {busy ? (
              <Loader2 size={13} strokeWidth={1.6} className="animate-spin" />
            ) : (
              <Sparkles size={13} strokeWidth={1.6} />
            )}
            {busy ? '生成中…' : result ? '重新生成' : '生成复盘'}
          </button>
        </div>
      </div>

      {showFields && (
        <div className="mt-3 rounded-lg border border-console-line bg-console-canvas px-3 py-2.5">
          <div className="flex items-center justify-between text-[11px] text-console-faint">
            <span>只会发送下面这些内容，不含账户号、服务器、截图</span>
            {preview && <span className="num font-mono">{preview.bytes} 字节</span>}
          </div>
          <ul className="mt-2 space-y-1 text-[11px] leading-relaxed">
            {(preview?.fields ?? []).map((field) => (
              <li key={field.key} className="flex gap-2">
                <span className="text-console-ink">{field.label}</span>
                <span className="text-console-muted">{field.text}</span>
              </li>
            ))}
            {!preview && <li className="text-console-faint">正在统计…</li>}
          </ul>
          <label className="mt-2 flex items-center gap-1.5 text-[11px] text-console-muted">
            <input
              type="checkbox"
              checked={includeNotes}
              onChange={(event) => setIncludeNotes(event.target.checked)}
              className="h-3 w-3 accent-console-accent"
            />
            同时发送我写的日笔记与逐笔备注（默认不发）
          </label>
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-lg border border-console-warn/30 bg-console-warn/5 px-3 py-2 text-[11px] text-console-warn">
          {error}
        </div>
      )}

      {result ? (
        <div className="mt-3">
          <div className="space-y-2 text-[12px] leading-relaxed text-console-ink-2">
            {result.text.split(/\n+/).map((line, index) => (
              <p key={index}>{line}</p>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-3 text-[10px] text-console-faint">
            <span>{fmtWhen(result.generatedAt)}</span>
            <span>{result.model}</span>
            <span>只作建议，不写回交易数据</span>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-[11px] leading-relaxed text-console-faint">
          {kind === 'week'
            ? `本周复盘统计截止 ${date} 的 7 天；`
            : '生成的复盘只发给模型做文字总结，'}
          不会修改任何记录；同一区间重复打开会直接用缓存。
        </p>
      )}
    </section>
  );
}
