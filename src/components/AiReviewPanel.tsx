import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { ChevronDown, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card as CossCard } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control';
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

const KINDS = [
  ['day', '当日'],
  ['week', '本周'],
] as const;

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
    <CossCard render={<section />} className="mt-3 gap-0 rounded-xl px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[13px] font-medium">
          <Sparkles size={14} strokeWidth={1.6} />
          AI 复盘
          <span className="text-[11px] font-normal text-muted-foreground/60">
            {status?.provider === 'anthropic' ? 'Claude' : status?.model}
            {result?.cached ? ' · 缓存' : ''}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <SegmentedControl size="sm">
            {KINDS.map(([value, label]) => {
              const active = kind === value;
              return (
                <SegmentedControlItem
                  key={value}
                  data-checked={active ? '' : undefined}
                  aria-pressed={active}
                  onClick={() => setKind(value)}
                  className="px-2 text-[11px]"
                >
                  {label}
                </SegmentedControlItem>
              );
            })}
          </SegmentedControl>
          <Button
            variant="ghost"
            size="xs"
            aria-expanded={showFields}
            onClick={() => setShowFields((value) => !value)}
            className="gap-1 text-[11px] font-normal text-muted-foreground"
          >
            将发送哪些字段
            <ChevronDown
              size={12}
              strokeWidth={1.8}
              className={cn('transition-transform', showFields && 'rotate-180')}
            />
          </Button>
          <Button
            variant="outline"
            size="xs"
            onClick={() => void generate(Boolean(result))}
            disabled={busy}
            className="text-[11px] font-normal"
          >
            {busy ? (
              <Loader2 size={13} strokeWidth={1.6} className="animate-spin" />
            ) : (
              <Sparkles size={13} strokeWidth={1.6} />
            )}
            {busy ? '生成中…' : result ? '重新生成' : '生成复盘'}
          </Button>
        </div>
      </div>

      {showFields && (
        <div className="mt-3 rounded-lg border border-border bg-muted px-3 py-2.5">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground/60">
            <span>只会发送下面这些内容，不含账户号、服务器、截图</span>
            {preview && <span className="num font-mono">{preview.bytes} 字节</span>}
          </div>
          <ul className="mt-2 space-y-1 text-[11px] leading-relaxed">
            {(preview?.fields ?? []).map((field) => (
              <li key={field.key} className="flex gap-2">
                <span className="text-foreground">{field.label}</span>
                <span className="text-muted-foreground">{field.text}</span>
              </li>
            ))}
            {!preview && <li className="text-muted-foreground/60">正在统计…</li>}
          </ul>
          <label className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Checkbox
              checked={includeNotes}
              onCheckedChange={setIncludeNotes}
              aria-label="同时发送我写的日笔记与逐笔备注（默认不发）"
            />
            同时发送我写的日笔记与逐笔备注（默认不发）
          </label>
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-[11px] text-warning-foreground">
          {error}
        </div>
      )}

      {result ? (
        <div className="mt-3">
          <div className="space-y-2 text-[12px] leading-relaxed text-foreground/82">
            {result.text.split(/\n+/).map((line, index) => (
              <p key={index}>{line}</p>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-3 text-[10px] text-muted-foreground/60">
            <span>{fmtWhen(result.generatedAt)}</span>
            <span>{result.model}</span>
            <span>只作建议，不写回交易数据</span>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/60">
          {kind === 'week'
            ? `本周复盘统计截止 ${date} 的 7 天；`
            : '生成的复盘只发给模型做文字总结，'}
          不会修改任何记录；同一区间重复打开会直接用缓存。
        </p>
      )}
    </CossCard>
  );
}
