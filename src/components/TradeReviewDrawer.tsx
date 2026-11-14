import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { Check, Minus, Star, X } from 'lucide-react';
import { gateway } from '../gateway/client';
import { fmtSigned, fmtVolume, signedClass } from '../lib/format';
import { fmtR, fmtReviewTime } from '../lib/review';
import { useApp } from '../store/useApp';
import type { RuleCheck, TradeNoteDetail } from '../gateway/types';

/**
 * 单笔复盘抽屉：策略、规则勾选、评分、错误标签与笔记。
 * 日历页、策略页、交易日志共用；只写复盘表，不改成交记录。
 */
export function TradeReviewDrawer({
  positionId,
  onClose,
  onChanged,
}: {
  positionId: number | null;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const notify = useApp((s) => s.notify);
  const serverOffset = useApp((s) => s.health?.serverOffset ?? 0);

  const [detail, setDetail] = useState<TradeNoteDetail | null>(null);
  const [playbookId, setPlaybookId] = useState<string | null>(null);
  const [rating, setRating] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [mistakes, setMistakes] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyDetail = (next: TradeNoteDetail) => {
    setDetail(next);
    setPlaybookId(next.playbookId);
    setRating(next.rating);
    setNote(next.note);
    setMistakes(next.mistakes.join('、'));
  };

  useEffect(() => {
    if (positionId == null) {
      setDetail(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    gateway
      .call<TradeNoteDetail>('strategy.tradeNote', { positionId })
      .then((next) => {
        if (alive) applyDetail(next);
      })
      .catch((err) => {
        if (alive) setError((err as Error).message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [positionId]);

  useEffect(() => {
    if (positionId == null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [positionId, onClose]);

  if (positionId == null) return null;

  const rules: RuleCheck[] = detail?.rules ?? [];
  const selectedBook = detail?.playbooks.find((book) => book.id === playbookId) ?? null;
  const followed = rules.filter((item) => item.followed === true).length;
  const broken = rules.filter((item) => item.followed === false).length;

  const toggleRule = async (rule: string, value: boolean | null) => {
    if (!detail || !playbookId) return;
    try {
      await gateway.call('strategy.check', { positionId, playbookId, rule, followed: value });
      setDetail({
        ...detail,
        rules: detail.rules.map((item) =>
          item.rule === rule ? { ...item, followed: value } : item,
        ),
      });
    } catch (err) {
      notify('error', (err as Error).message);
    }
  };

  const save = async () => {
    if (!detail) return;
    setSaving(true);
    try {
      const payload = {
        positionId,
        playbookId,
        rating,
        mistakes: mistakes
          .split(/[、,，;；\s]+/)
          .map((item) => item.trim())
          .filter(Boolean),
        note,
      };
      const response = await gateway.call<{ note: TradeNoteDetail }>(
        'strategy.tradeNote.save',
        payload,
      );
      applyDetail(response.note);
      notify('success', '复盘已保存');
      onChanged?.();
    } catch (err) {
      notify('error', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex justify-end bg-black/45" onClick={onClose}>
      <aside
        className="flex h-full w-full max-w-[440px] flex-col border-l border-console-line bg-console-card text-console-ink shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label="单笔复盘"
      >
        <header className="flex items-start justify-between gap-3 border-b border-console-line px-5 py-4">
          <div className="min-w-0">
            <div className="text-[11px] text-console-muted">单笔复盘 · #{positionId}</div>
            {detail ? (
              <div className="mt-1 flex flex-wrap items-baseline gap-2">
                <span className="text-[18px] font-medium">{detail.trade.symbol}</span>
                <span
                  className={clsx(
                    'text-[12px]',
                    detail.trade.side === 'buy' ? 'text-console-gain' : 'text-console-loss',
                  )}
                >
                  {detail.trade.side === 'buy' ? '多' : '空'} {fmtVolume(detail.trade.volume)}
                </span>
                <span className={clsx('num font-mono text-[16px]', signedClass(detail.trade.profit))}>
                  {fmtSigned(detail.trade.profit)}
                </span>
                <span className="num font-mono text-[12px] text-console-muted">
                  {fmtR(detail.trade.r)}
                </span>
              </div>
            ) : (
              <div className="mt-1 text-[13px] text-console-muted">
                {loading ? '读取中…' : '未找到这笔交易'}
              </div>
            )}
            {detail && (
              <div className="num mt-1 font-mono text-[11px] text-console-faint">
                {fmtReviewTime(detail.trade.openTime, serverOffset, true)} →{' '}
                {fmtReviewTime(detail.trade.closeTime, serverOffset, true)}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-console-muted transition-colors hover:bg-console-hover hover:text-console-ink"
            aria-label="关闭"
          >
            <X size={18} strokeWidth={1.6} />
          </button>
        </header>

        {error && (
          <div className="mx-5 mt-4 rounded-lg border border-console-loss/30 bg-console-loss-soft px-3 py-2 text-[12px] text-console-loss">
            {error}
          </div>
        )}

        {detail && (
          <div className="min-h-0 flex-1 space-y-6 overflow-auto px-5 py-5">
            <section>
              <div className="console-label mb-2">策略</div>
              <select
                value={playbookId ?? ''}
                onChange={(event) => {
                  const next = event.target.value || null;
                  setPlaybookId(next);
                  setDetail({
                    ...detail,
                    rules:
                      next && next === detail.playbookId
                        ? detail.rules
                        : detail.playbooks
                            .find((book) => book.id === next)
                            ?.rules.map((rule) => ({ rule, followed: null })) ?? [],
                  });
                }}
                className="console-input w-full"
              >
                <option value="">未关联策略</option>
                {detail.playbooks.map((book) => (
                  <option key={book.id} value={book.id}>
                    {book.name}
                  </option>
                ))}
              </select>
              {detail.playbooks.length === 0 && (
                <p className="mt-2 text-[11px] text-console-faint">
                  还没有策略手册。先到「策略手册」建一本，再回来逐条勾规则。
                </p>
              )}
              {selectedBook?.description && (
                <p className="mt-2 text-[12px] leading-relaxed text-console-muted">
                  {selectedBook.description}
                </p>
              )}
            </section>

            {rules.length > 0 && (
              <section>
                <div className="mb-2 flex items-center justify-between">
                  <span className="console-label">规则执行</span>
                  <span className="num font-mono text-[11px] text-console-faint">
                    遵守 {followed} · 违反 {broken} · 未评估 {rules.length - followed - broken}
                  </span>
                </div>
                <div className="space-y-1.5">
                  {rules.map((item) => (
                    <RuleRow
                      key={item.rule}
                      rule={item.rule}
                      value={item.followed}
                      onChange={(value) => void toggleRule(item.rule, value)}
                    />
                  ))}
                </div>
              </section>
            )}

            <section>
              <div className="console-label mb-2">执行评分</div>
              <div className="flex items-center gap-1">
                {[1, 2, 3, 4, 5].map((value) => (
                  <button
                    key={value}
                    onClick={() => setRating(rating === value ? null : value)}
                    className="rounded-md p-1 transition-colors hover:bg-console-hover"
                    aria-label={`${value} 分`}
                  >
                    <Star
                      size={18}
                      strokeWidth={1.5}
                      className={clsx(
                        rating != null && value <= rating
                          ? 'fill-console-warn text-console-warn'
                          : 'text-console-faint',
                      )}
                    />
                  </button>
                ))}
                <span className="ml-2 text-[11px] text-console-faint">
                  {rating ? `${rating} / 5` : '未评分'}
                </span>
              </div>
            </section>

            <section>
              <div className="console-label mb-2">错误标签</div>
              <input
                value={mistakes}
                onChange={(event) => setMistakes(event.target.value)}
                placeholder="追单、提前离场、移动止损…（顿号或逗号分隔）"
                className="console-input w-full"
                maxLength={200}
              />
            </section>

            <section>
              <div className="console-label mb-2">复盘笔记</div>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="当时看到了什么？按计划做了吗？下次怎么改？"
                rows={5}
                maxLength={4000}
                className="console-input w-full resize-y py-2 leading-relaxed"
              />
            </section>
          </div>
        )}

        <footer className="flex items-center justify-between gap-3 border-t border-console-line px-5 py-3">
          <span className="text-[11px] text-console-faint">
            {detail?.reviewedAt
              ? `上次复盘 ${fmtReviewTime(detail.reviewedAt, 0, true)}`
              : '只记事实，不改成交'}
          </span>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="console-btn console-btn-secondary">
              关闭
            </button>
            <button
              onClick={() => void save()}
              disabled={!detail || saving}
              className="console-btn console-btn-primary"
            >
              {saving ? '保存中…' : '保存复盘'}
            </button>
          </div>
        </footer>
      </aside>
    </div>
  );
}

function RuleRow({
  rule,
  value,
  onChange,
}: {
  rule: string;
  value: boolean | null;
  onChange: (value: boolean | null) => void;
}) {
  const options: { key: string; label: string; value: boolean | null; icon: typeof Check }[] = [
    { key: 'none', label: '未评估', value: null, icon: Minus },
    { key: 'yes', label: '遵守', value: true, icon: Check },
    { key: 'no', label: '违反', value: false, icon: X },
  ];
  return (
    <div className="flex items-center gap-2 rounded-lg border border-console-line px-2.5 py-2">
      <span className="min-w-0 flex-1 text-[12px] leading-snug text-console-ink-2">{rule}</span>
      <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-console-line p-0.5">
        {options.map((option) => {
          const Icon = option.icon;
          const active = value === option.value;
          return (
            <button
              key={option.key}
              onClick={() => onChange(option.value)}
              title={option.label}
              aria-pressed={active}
              className={clsx(
                'flex h-6 items-center gap-1 rounded px-1.5 text-[11px] transition-colors',
                active
                  ? option.value === true
                    ? 'bg-console-gain-soft font-medium text-console-gain'
                    : option.value === false
                      ? 'bg-console-loss-soft font-medium text-console-loss'
                      : 'bg-console-selected font-medium text-console-ink'
                  : 'text-console-faint hover:bg-console-hover hover:text-console-ink',
              )}
            >
              <Icon size={12} strokeWidth={2} />
              <span className="hidden sm:inline">{option.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
