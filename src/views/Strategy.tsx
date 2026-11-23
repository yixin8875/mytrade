import { useCallback, useEffect, useState } from 'react';
import { Archive, ListChecks, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { gateway } from '../gateway/client';
import { fmtPct, fmtR, sampleHint } from '../lib/review';
import { usePrivacyMask } from '../lib/privacy';
import { fmtSigned, signedClass } from '../lib/format';
import { useApp } from '../store/useApp';
import type { AdherenceBook, AdherenceResult, Playbook } from '../gateway/types';

const RANGES = [90, 365];

interface BookForm {
  id?: string;
  name: string;
  description: string;
  rules: string;
}

const EMPTY_FORM: BookForm = { name: '', description: '', rules: '' };

/** 策略手册：定义规则，按交易勾执行情况，看遵守度与两种结果的实际差异 */
export function StrategyView() {
  const notify = useApp((s) => s.notify);
  const activeLogin = useApp((s) => s.account?.login ?? 0);
  const strategyNew = useApp((s) => s.strategyNew);
  usePrivacyMask();

  const [books, setBooks] = useState<Playbook[]>([]);
  const [adherence, setAdherence] = useState<AdherenceResult | null>(null);
  const [days, setDays] = useState(90);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<BookForm | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, stats] = await Promise.all([
        gateway.call<{ playbooks: Playbook[] }>('strategy.list', {}),
        gateway.call<AdherenceResult>('strategy.adherence', { days }),
      ]);
      setBooks(list.playbooks);
      setAdherence(stats);
      setSelectedId((prev) => {
        if (prev && list.playbooks.some((book) => book.id === prev)) return prev;
        return list.playbooks[0]?.id ?? null;
      });
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load, activeLogin]);

  // 从交易复盘/下单票的「新建策略」入口进来时，直接打开空白表单
  useEffect(() => {
    if (strategyNew > 0) setForm({ ...EMPTY_FORM });
  }, [strategyNew]);

  const selectedBook = books.find((book) => book.id === selectedId) ?? null;
  const selectedStats = adherence?.books.find((book) => book.id === selectedId) ?? null;

  const startCreate = () => setForm({ ...EMPTY_FORM });
  const startEdit = (book: Playbook) =>
    setForm({
      id: book.id,
      name: book.name,
      description: book.description,
      rules: book.rules.join('\n'),
    });

  const saveForm = async () => {
    if (!form) return;
    const name = form.name.trim();
    if (!name) {
      notify('error', '策略名不能为空');
      return;
    }
    setSaving(true);
    try {
      const response = await gateway.call<{ playbook: Playbook }>('strategy.save', {
        id: form.id,
        name,
        description: form.description,
        rules: form.rules
          .split('\n')
          .map((rule) => rule.trim())
          .filter(Boolean),
      });
      setForm(null);
      setSelectedId(response.playbook.id);
      notify('success', form.id ? '策略已更新' : '策略已创建');
      await load();
    } catch (err) {
      notify('error', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const removeBook = async (book: Playbook) => {
    if (!window.confirm(`归档「${book.name}」？历史交易的规则勾选会保留，卡片不再显示。`)) return;
    try {
      await gateway.call('strategy.delete', { id: book.id });
      notify('info', '策略已归档');
      await load();
    } catch (err) {
      notify('error', (err as Error).message);
    }
  };

  return (
    <div className="console-scope h-full min-h-0 overflow-auto bg-sidebar">
      <div className="mx-auto w-full max-w-[1240px] px-8 py-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-medium tracking-[-0.01em]">策略手册</h1>
            <p className="mt-1.5 text-[13px] text-muted-foreground">
              把进出场条件写成固定规则
              {activeLogin ? ` · 账户 ${activeLogin}` : ''} · 复盘时逐条勾遵守 / 违反
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              {RANGES.map((value) => (
                <Button
                  key={value}
                  onClick={() => setDays(value)}
                  size="xs"
                  variant={days === value ? 'default' : 'outline'}
                >
                  {value} 天
                </Button>
              ))}
            </div>
            <Button onClick={() => void load()} disabled={loading} variant="outline">
              <RefreshCw size={14} strokeWidth={1.5} className={cn(loading && 'animate-spin')} />
              {loading ? '读取中…' : '刷新'}
            </Button>
            <Button onClick={startCreate}>
              <Plus size={14} strokeWidth={1.8} />
              新建策略
            </Button>
          </div>
        </header>

        {error && (
          <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive-foreground">
            读取失败：{error}
          </div>
        )}

        {books.length === 0 && !loading ? (
          <EmptyState onCreate={startCreate} />
        ) : (
          <div className="mt-6 grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
            <section className="space-y-2">
              {books.map((book) => {
                const stats = adherence?.books.find((item) => item.id === book.id);
                return (
                  <Card
                    key={book.id}
                    render={<button type="button" onClick={() => setSelectedId(book.id)} />}
                    className={cn(
                      'w-full px-4 py-3 text-left transition-colors',
                      selectedId === book.id
                        ? 'border-foreground/40 bg-accent'
                        : 'hover:bg-accent/60',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[13px] font-medium">{book.name}</span>
                      <span className="num shrink-0 font-mono text-[11px] text-muted-foreground/60">
                        {book.tradeCount ?? 0} 笔
                      </span>
                    </div>
                    {book.description && (
                      <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                        {book.description}
                      </p>
                    )}
                    <div className="mt-2 flex items-center justify-between text-[11px]">
                      <span className="text-muted-foreground/60">{book.rules.length} 条规则</span>
                      <span
                        className={cn(
                          'num font-mono',
                          stats?.rate == null
                            ? 'text-muted-foreground/60'
                            : stats.rate >= 0.8
                              ? 'text-success-foreground'
                              : stats.rate >= 0.5
                                ? 'text-warning-foreground'
                                : 'text-destructive-foreground',
                        )}
                      >
                        {stats ? `遵守度 ${fmtPct(stats.rate)}` : '—'}
                      </span>
                    </div>
                  </Card>
                );
              })}
            </section>

            {selectedBook && selectedStats ? (
              <BookDetail
                book={selectedBook}
                stats={selectedStats}
                onEdit={() => startEdit(selectedBook)}
                onDelete={() => void removeBook(selectedBook)}
              />
            ) : (
              <Card className="flex items-center justify-center px-6 py-16 text-[12px] text-muted-foreground/60">
                {loading ? '读取中…' : '选择左侧一本策略查看遵守度'}
              </Card>
            )}
          </div>
        )}
      </div>

      {form && (
        <BookFormModal
          form={form}
          saving={saving}
          onChange={setForm}
          onCancel={() => setForm(null)}
          onSave={() => void saveForm()}
        />
      )}
    </div>
  );
}

function BookDetail({
  book,
  stats,
  onEdit,
  onDelete,
}: {
  book: Playbook;
  stats: AdherenceBook;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const hint = sampleHint(stats.total);
  return (
    <Card className="min-w-0 overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-[16px] font-medium">{book.name}</h2>
            {book.archived_at && (
              <span className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground/60">
                <Archive size={10} strokeWidth={1.8} />
                已归档
              </span>
            )}
          </div>
          {book.description && (
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{book.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={onEdit} variant="outline">
            <Pencil size={13} strokeWidth={1.6} />
            编辑
          </Button>
          {!book.archived_at && (
            <Button onClick={onDelete} variant="destructive-outline">
              <Trash2 size={13} strokeWidth={1.6} />
              归档
            </Button>
          )}
        </div>
      </div>

      <div className="readout m-5 grid-cols-2 sm:grid-cols-4">
        <DetailStat label="关联交易" value={String(stats.total)} hint={`已评估 ${stats.evaluated}`} />
        <DetailStat
          label="遵守度"
          value={fmtPct(stats.rate)}
          hint={stats.rate == null ? '还没有勾过规则' : '勾选里遵守的比例'}
          tone={
            stats.rate == null
              ? undefined
              : stats.rate >= 0.8
                ? 'text-success-foreground'
                : stats.rate < 0.5
                  ? 'text-destructive-foreground'
                  : 'text-warning-foreground'
          }
        />
        <DetailStat
          label="遵守时净盈亏"
          value={fmtSigned(stats.followed.net)}
          hint={`${stats.followed.trades} 笔 · 均 R ${fmtR(stats.followed.avgR)}`}
          tone={signedClass(stats.followed.net)}
        />
        <DetailStat
          label="违反时净盈亏"
          value={fmtSigned(stats.broken.net)}
          hint={`${stats.broken.trades} 笔 · 均 R ${fmtR(stats.broken.avgR)}`}
          tone={signedClass(stats.broken.net)}
        />
      </div>

      {stats.preTrade && stats.preTrade.total > 0 && (
        <div className="mx-5 -mt-1 mb-4 rounded-lg border border-border bg-sidebar px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">开仓前清单</span>
            <span className="num font-mono text-[11px] text-foreground/80">
              完成率 {fmtPct(stats.preTrade.completionRate)} · 强行下单{' '}
              {fmtPct(stats.preTrade.overrideRate)}
            </span>
          </div>
          <div className="mt-1 text-[11px] leading-5 text-muted-foreground/60">
            共 {stats.preTrade.total} 次开仓尝试 · 通过 {stats.preTrade.passed} · 破例{' '}
            {stats.preTrade.overridden} · 跳过 {stats.preTrade.skipped} · 未完成{' '}
            {stats.preTrade.pending}
          </div>
        </div>
      )}

      {hint && (
        <div className="mx-5 -mt-1 mb-4 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning-foreground">
          {hint}。遵守度只统计已勾选的规则，不把「没评估」当成「遵守」。
        </div>
      )}
      {stats.unassessed > 0 && (
        <div className="mx-5 -mt-1 mb-4 text-[11px] text-muted-foreground/60">
          还有 {stats.unassessed} 笔关联交易没有勾完规则，未计入遵守 / 违反。
        </div>
      )}

      <Table className="w-full min-w-[640px] border-collapse text-[12px]">
        <TableHeader>
          <TableRow className="border-y border-border text-left text-[11px] text-muted-foreground/60 hover:bg-transparent">
            <TableHead className="h-auto px-5 py-2 font-normal">规则</TableHead>
            <TableHead className="h-auto px-3 py-2 text-right font-normal">评估</TableHead>
            <TableHead className="h-auto px-3 py-2 text-right font-normal">遵守率</TableHead>
            <TableHead className="h-auto px-3 py-2 text-right font-normal">遵守时均 R</TableHead>
            <TableHead className="h-auto px-3 py-2 text-right font-normal">违反时均 R</TableHead>
            <TableHead className="h-auto px-5 py-2 text-right font-normal">违反次数</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {stats.ruleStats.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="px-5 py-10 text-center text-[12px] text-muted-foreground/60">
                这本策略还没有规则。点「编辑」加上进出场条件。
              </TableCell>
            </TableRow>
          )}
          {stats.ruleStats.map((rule) => (
            <TableRow key={rule.rule} className="border-t border-border/70">
              <TableCell className="px-5 py-2.5 text-foreground/80">{rule.rule}</TableCell>
              <TableCell className="num px-3 py-2.5 text-right font-mono text-[11px] text-muted-foreground">
                {rule.evaluated}
              </TableCell>
              <TableCell
                className={cn(
                  'num px-3 py-2.5 text-right font-mono',
                  rule.rate == null
                    ? 'text-muted-foreground/60'
                    : rule.rate >= 0.8
                      ? 'text-success-foreground'
                      : rule.rate < 0.5
                        ? 'text-destructive-foreground'
                        : 'text-warning-foreground',
                )}
              >
                {fmtPct(rule.rate)}
              </TableCell>
              <TableCell className="num px-3 py-2.5 text-right font-mono text-[11px]">
                {fmtR(rule.followed.avgR)}
              </TableCell>
              <TableCell className="num px-3 py-2.5 text-right font-mono text-[11px]">
                {fmtR(rule.broken.avgR)}
              </TableCell>
              <TableCell className="num px-5 py-2.5 text-right font-mono text-[11px] text-muted-foreground">
                {rule.broken.trades}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <div className="border-t border-border px-5 py-3 text-[11px] leading-relaxed text-muted-foreground/60">
        遵守时与违反时的均 R 是同一批交易里的横向对比，不证明因果；样本少于 20 笔时只当提示。
      </div>
    </Card>
  );
}

function DetailStat({
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
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn('num mt-1.5 font-mono text-[19px] font-medium leading-none', tone)}>
        {value}
      </div>
      <div className="mt-2 truncate text-[10px] text-muted-foreground/60">{hint ?? ' '}</div>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <Card className="mt-6 flex flex-col items-center px-8 py-16 text-center">
      <ListChecks size={28} strokeWidth={1.3} className="text-muted-foreground/60" />
      <h2 className="mt-4 text-[15px] font-medium">先把一套做法写下来</h2>
      <p className="mt-2 max-w-[420px] text-[12px] leading-relaxed text-muted-foreground">
        策略手册只做两件事：记录你认可的进场 / 出场条件，和让每笔交易回答「我按它做了吗」。
        规则不要写结果（要盈利），要写可核对的动作（等回调到前高再进）。
      </p>
      <Button onClick={onCreate} className="mt-5">
        <Plus size={14} strokeWidth={1.8} />
        新建第一本策略
      </Button>
    </Card>
  );
}

function BookFormModal({
  form,
  saving,
  onChange,
  onCancel,
  onSave,
}: {
  form: BookForm;
  saving: boolean;
  onChange: (form: BookForm) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const rules = form.rules.split('\n').filter((rule) => rule.trim()).length;
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogPopup showCloseButton={false} className="max-w-[560px]">
        <DialogHeader className="flex-row items-center justify-between">
          <DialogTitle>{form.id ? '编辑策略' : '新建策略'}</DialogTitle>
          <DialogClose
            render={<Button size="icon-sm" variant="ghost" aria-label="关闭" />}
            onClick={onCancel}
          >
            <X size={18} strokeWidth={1.6} />
          </DialogClose>
        </DialogHeader>

        <DialogPanel className="space-y-3">
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-medium text-muted-foreground">名称</span>
            <Input
              autoFocus
              value={form.name}
              maxLength={40}
              onChange={(event) => onChange({ ...form, name: event.target.value })}
              placeholder="例如：前高突破回踩"
              className="w-full"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-medium text-muted-foreground">说明</span>
            <Textarea
              value={form.description}
              rows={2}
              maxLength={500}
              onChange={(event) => onChange({ ...form, description: event.target.value })}
              placeholder="适用品种、时段、行情环境"
              className="w-full"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] font-medium text-muted-foreground">规则（一行一条）</span>
              <span className="text-[11px] text-muted-foreground/60">{rules} / 20 条</span>
            </span>
            <Textarea
              value={form.rules}
              rows={7}
              onChange={(event) => onChange({ ...form, rules: event.target.value })}
              placeholder={'只做 H1 趋势方向\n等价格回到前高附近\n止损放在结构低点下方'}
              className="w-full"
            />
          </label>
        </DialogPanel>

        <DialogFooter>
          <Button onClick={onCancel} variant="outline">
            取消
          </Button>
          <Button onClick={onSave} disabled={saving || !form.name.trim()}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
