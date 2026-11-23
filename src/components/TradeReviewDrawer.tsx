import { useEffect, useState } from 'react';
import { Check, Minus, Star, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { gateway } from '../gateway/client';
import { fmtSigned, fmtVolume, signedClass } from '../lib/format';
import { fmtR, fmtReviewTime } from '../lib/review';
import { useApp } from '../store/useApp';
import { Button } from './ui/button';
import { Input } from './ui/input';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import { Sheet, SheetPopup, SheetTitle } from './ui/sheet';
import { Textarea } from './ui/textarea';
import type { DisciplineGateState, RuleCheck, TradeNoteDetail } from '../gateway/types';

const PRE_TRADE_LABEL: Record<DisciplineGateState, string> = {
  passed: '下单时已完成',
  overridden: '复核后强行下单',
  skipped: '无规则 · 已跳过',
  pending: '未完成',
  blocked: '已拦截',
};

const PRE_TRADE_TONE: Record<DisciplineGateState, string> = {
  passed: 'text-success-foreground',
  overridden: 'text-warning-foreground',
  skipped: 'text-muted-foreground',
  pending: 'text-muted-foreground',
  blocked: 'text-destructive-foreground',
};

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
  const openStrategyNew = useApp((s) => s.openStrategyNew);
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

  const toggleReviewed = async () => {
    if (!detail) return;
    const next = !detail.reviewedAt;
    setSaving(true);
    try {
      const res = await gateway.call<{ positionId: number; reviewedAt: number | null }>(
        'strategy.tradeNote.reviewed',
        { positionId, reviewed: next },
      );
      setDetail({ ...detail, reviewedAt: res.reviewedAt });
      notify('success', next ? '已标记为已复盘' : '已取消复盘标记');
      onChanged?.();
    } catch (err) {
      notify('error', (err as Error).message);
    } finally {
      setSaving(false);
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
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetPopup
        side="right"
        showCloseButton={false}
        className="h-full max-w-[440px] gap-0 border-l border-border p-0"
      >
        <SheetTitle className="sr-only">单笔复盘</SheetTitle>
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <div className="text-[11px] text-muted-foreground">单笔复盘 · #{positionId}</div>
            {detail ? (
              <div className="mt-1 flex flex-wrap items-baseline gap-2">
                <span className="text-[18px] font-medium">{detail.trade.symbol}</span>
                <span
                  className={cn(
                    'text-[12px]',
                    detail.trade.side === 'buy'
                      ? 'text-success-foreground'
                      : 'text-destructive-foreground',
                  )}
                >
                  {detail.trade.side === 'buy' ? '多' : '空'} {fmtVolume(detail.trade.volume)}
                </span>
                <span className={cn('num font-mono text-[16px]', signedClass(detail.trade.profit))}>
                  {fmtSigned(detail.trade.profit)}
                </span>
                <span className="num font-mono text-[12px] text-muted-foreground">
                  {fmtR(detail.trade.r)}
                </span>
              </div>
            ) : (
              <div className="mt-1 text-[13px] text-muted-foreground">
                {loading ? '读取中…' : '未找到这笔交易'}
              </div>
            )}
            {detail && (
              <div className="num mt-1 font-mono text-[11px] text-muted-foreground/60">
                {fmtReviewTime(detail.trade.openTime, serverOffset, true)} →{' '}
                {fmtReviewTime(detail.trade.closeTime, serverOffset, true)}
              </div>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            aria-label="关闭"
          >
            <X size={18} strokeWidth={1.6} />
          </Button>
        </header>

        {error && (
          <div className="mx-5 mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive-foreground">
            {error}
          </div>
        )}

        {detail && (
          <div className="min-h-0 flex-1 space-y-6 overflow-auto px-5 py-5">
            <section>
              <div className="mb-2 text-[11px] font-medium text-muted-foreground">策略</div>
              <Select
                value={playbookId ?? ''}
                onValueChange={(next) => {
                  const value = next == null ? '' : String(next);
                  const nextId = value || null;
                  setPlaybookId(nextId);
                  setDetail({
                    ...detail,
                    rules:
                      nextId && nextId === detail.playbookId
                        ? detail.rules
                        : detail.playbooks
                            .find((book) => book.id === nextId)
                            ?.rules.map((rule) => ({ rule, followed: null })) ?? [],
                  });
                }}
                items={[
                  { value: '', label: '未关联策略' },
                  ...detail.playbooks.map((book) => ({ value: book.id, label: book.name })),
                ]}
              >
                <SelectTrigger aria-label="策略" className="h-8 w-full text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="">未关联策略</SelectItem>
                  {detail.playbooks.map((book) => (
                    <SelectItem key={book.id} value={book.id}>
                      {book.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {detail.playbooks.length === 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground/60">
                  <span>还没有策略手册。</span>
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={openStrategyNew}
                    className="h-auto px-2 py-0.5 text-[11px] font-normal"
                  >
                    新建一本
                  </Button>
                </div>
              )}
              {selectedBook?.description && (
                <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
                  {selectedBook.description}
                </p>
              )}
            </section>

            {detail.preTrade && (
              <section className="border-t border-border pt-5">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] font-medium text-muted-foreground">开仓时清单</span>
                  <span className={cn('text-[11px]', PRE_TRADE_TONE[detail.preTrade.state])}>
                    {PRE_TRADE_LABEL[detail.preTrade.state]}
                  </span>
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {detail.preTrade.playbookName ?? '未关联清单'} ·{' '}
                  {detail.preTrade.mode === 'block' ? '强制拦截' : '二次确认'}
                </div>
                {detail.preTrade.rules.length > 0 ? (
                  <div className="mt-2 space-y-1.5">
                    {detail.preTrade.rules.map((item) => (
                      <div key={item.rule} className="flex items-center gap-2 text-[12px]">
                        {item.followed === true ? (
                          <Check
                            size={13}
                            strokeWidth={2}
                            className="size-3.5 shrink-0 text-success-foreground"
                          />
                        ) : item.followed === false ? (
                          <X
                            size={13}
                            strokeWidth={2}
                            className="size-3.5 shrink-0 text-destructive-foreground"
                          />
                        ) : (
                          <Minus
                            size={13}
                            strokeWidth={2}
                            className={cn(
                              'size-3.5 shrink-0',
                              item.evaluated ? 'text-muted-foreground' : 'text-muted-foreground/60',
                            )}
                          />
                        )}
                        <span
                          className={cn(
                            'min-w-0 flex-1 truncate',
                            item.followed === false
                              ? 'text-destructive-foreground'
                              : 'text-foreground/80',
                          )}
                        >
                          {item.rule}
                        </span>
                        <span className="shrink-0 text-[10px] text-muted-foreground/60">
                          {item.followed === true
                            ? '遵守'
                            : item.followed === false
                              ? '违反'
                              : item.evaluated
                                ? '不适用'
                                : '未评估'}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-[11px] text-muted-foreground/60">当时没有可用的清单规则。</p>
                )}
                {detail.preTrade.reason && (
                  <p className="mt-2 text-[11px] text-warning-foreground">
                    破例理由：{detail.preTrade.reason}
                  </p>
                )}
                <p className="mt-2 text-[10px] leading-4 text-muted-foreground/60">
                  这是下单时的只读快照，之后修改或归档清单不会改变这里。
                </p>
              </section>
            )}

            {rules.length > 0 && (
              <section>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] font-medium text-muted-foreground">规则执行</span>
                  <span className="num font-mono text-[11px] text-muted-foreground/60">
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
              <div className="mb-2 text-[11px] font-medium text-muted-foreground">执行评分</div>
              <div className="flex items-center gap-1">
                {[1, 2, 3, 4, 5].map((value) => (
                  <Button
                    key={value}
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setRating(rating === value ? null : value)}
                    className="h-7 w-7 rounded-md"
                    aria-label={`${value} 分`}
                  >
                    <Star
                      size={18}
                      strokeWidth={1.5}
                      className={cn(
                        'size-4.5',
                        rating != null && value <= rating
                          ? 'fill-warning text-warning-foreground'
                          : 'text-muted-foreground/60',
                      )}
                    />
                  </Button>
                ))}
                <span className="ml-2 text-[11px] text-muted-foreground/60">
                  {rating ? `${rating} / 5` : '未评分'}
                </span>
              </div>
            </section>

            <section>
              <div className="mb-2 text-[11px] font-medium text-muted-foreground">错误标签</div>
              <Input
                value={mistakes}
                onChange={(event) => setMistakes(event.target.value)}
                placeholder="追单、提前离场、移动止损…（顿号或逗号分隔）"
                className="h-8 text-[12px]"
                maxLength={200}
              />
            </section>

            <section>
              <div className="mb-2 text-[11px] font-medium text-muted-foreground">复盘笔记</div>
              <Textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="当时看到了什么？按计划做了吗？下次怎么改？"
                rows={5}
                maxLength={4000}
                className="text-[12px] [&_textarea]:min-h-24 [&_textarea]:resize-y [&_textarea]:leading-relaxed"
              />
            </section>
          </div>
        )}

        <footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
          <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground/60">
            <span className="truncate">
              {detail?.reviewedAt
                ? `已复盘 ${fmtReviewTime(detail.reviewedAt, 0, true)}`
                : '只记事实，不改成交'}
            </span>
            {detail && (
              <Button
                variant="outline"
                size="xs"
                onClick={() => void toggleReviewed()}
                disabled={saving}
                className="h-auto shrink-0 px-2 py-0.5 text-[11px] font-normal"
              >
                {detail.reviewedAt ? '取消标记' : '标记已复盘'}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onClose} className="h-8 text-[12px]">
              关闭
            </Button>
            <Button
              size="sm"
              onClick={() => void save()}
              disabled={!detail || saving}
              className="h-8 text-[12px]"
            >
              {saving ? '保存中…' : '保存复盘'}
            </Button>
          </div>
        </footer>
      </SheetPopup>
    </Sheet>
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
    <div className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-2">
      <span className="min-w-0 flex-1 text-[12px] leading-snug text-foreground/80">{rule}</span>
      <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-border p-0.5">
        {options.map((option) => {
          const Icon = option.icon;
          const active = value === option.value;
          return (
            <Button
              key={option.key}
              variant="ghost"
              size="xs"
              onClick={() => onChange(option.value)}
              title={option.label}
              aria-pressed={active}
              className={cn(
                'h-6 gap-1 rounded px-1.5 text-[11px] font-normal',
                active
                  ? option.value === true
                    ? 'bg-success/10 font-medium text-success-foreground hover:bg-success/10'
                    : option.value === false
                      ? 'bg-destructive/10 font-medium text-destructive-foreground hover:bg-destructive/10'
                      : 'bg-accent font-medium text-foreground hover:bg-accent'
                  : 'text-muted-foreground/60 hover:bg-accent hover:text-foreground',
              )}
            >
              <Icon size={12} strokeWidth={2} className="size-3" />
              <span className="hidden sm:inline">{option.label}</span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
