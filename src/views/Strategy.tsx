import { useCallback, useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { Archive, ListChecks, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react';
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
    <div className="console-scope h-full min-h-0 overflow-auto bg-console-canvas">
      <div className="mx-auto w-full max-w-[1240px] px-8 py-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-medium tracking-[-0.01em]">策略手册</h1>
            <p className="mt-1.5 text-[13px] text-console-muted">
              把进出场条件写成固定规则
              {activeLogin ? ` · 账户 ${activeLogin}` : ''} · 复盘时逐条勾遵守 / 违反
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
            <button onClick={() => void load()} disabled={loading} className="console-btn console-btn-secondary">
              <RefreshCw size={14} strokeWidth={1.5} className={clsx(loading && 'animate-spin')} />
              {loading ? '读取中…' : '刷新'}
            </button>
            <button onClick={startCreate} className="console-btn console-btn-primary">
              <Plus size={14} strokeWidth={1.8} />
              新建策略
            </button>
          </div>
        </header>

        {error && (
          <div className="mt-4 rounded-lg border border-console-loss/30 bg-console-loss-soft px-3 py-2 text-[12px] text-console-loss">
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
                  <button
                    key={book.id}
                    onClick={() => setSelectedId(book.id)}
                    className={clsx(
                      'console-card w-full px-4 py-3 text-left transition-colors',
                      selectedId === book.id
                        ? 'border-console-ink/40 bg-console-selected'
                        : 'hover:bg-console-hover/60',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[13px] font-medium">{book.name}</span>
                      <span className="num shrink-0 font-mono text-[11px] text-console-faint">
                        {book.tradeCount ?? 0} 笔
                      </span>
                    </div>
                    {book.description && (
                      <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-console-muted">
                        {book.description}
                      </p>
                    )}
                    <div className="mt-2 flex items-center justify-between text-[11px]">
                      <span className="text-console-faint">{book.rules.length} 条规则</span>
                      <span
                        className={clsx(
                          'num font-mono',
                          stats?.rate == null
                            ? 'text-console-faint'
                            : stats.rate >= 0.8
                              ? 'text-console-gain'
                              : stats.rate >= 0.5
                                ? 'text-console-warn'
                                : 'text-console-loss',
                        )}
                      >
                        {stats ? `遵守度 ${fmtPct(stats.rate)}` : '—'}
                      </span>
                    </div>
                  </button>
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
              <section className="console-card flex items-center justify-center px-6 py-16 text-[12px] text-console-faint">
                {loading ? '读取中…' : '选择左侧一本策略查看遵守度'}
              </section>
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
    <section className="console-card min-w-0 overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-console-line px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-[16px] font-medium">{book.name}</h2>
            {book.archived_at && (
              <span className="flex items-center gap-1 rounded border border-console-line px-1.5 py-0.5 text-[10px] text-console-faint">
                <Archive size={10} strokeWidth={1.8} />
                已归档
              </span>
            )}
          </div>
          {book.description && (
            <p className="mt-1 text-[12px] leading-relaxed text-console-muted">{book.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onEdit} className="console-btn console-btn-secondary">
            <Pencil size={13} strokeWidth={1.6} />
            编辑
          </button>
          {!book.archived_at && (
            <button onClick={onDelete} className="console-btn console-btn-secondary text-console-loss">
              <Trash2 size={13} strokeWidth={1.6} />
              归档
            </button>
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
                ? 'text-console-gain'
                : stats.rate < 0.5
                  ? 'text-console-loss'
                  : 'text-console-warn'
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

      {hint && (
        <div className="mx-5 -mt-1 mb-4 rounded-lg border border-console-warn/30 bg-console-warn-soft px-3 py-2 text-[12px] text-console-warn">
          {hint}。遵守度只统计已勾选的规则，不把「没评估」当成「遵守」。
        </div>
      )}
      {stats.unassessed > 0 && (
        <div className="mx-5 -mt-1 mb-4 text-[11px] text-console-faint">
          还有 {stats.unassessed} 笔关联交易没有勾完规则，未计入遵守 / 违反。
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-[12px]">
          <thead>
            <tr className="border-y border-console-line text-left text-[11px] text-console-faint">
              <th className="px-5 py-2 font-normal">规则</th>
              <th className="px-3 py-2 text-right font-normal">评估</th>
              <th className="px-3 py-2 text-right font-normal">遵守率</th>
              <th className="px-3 py-2 text-right font-normal">遵守时均 R</th>
              <th className="px-3 py-2 text-right font-normal">违反时均 R</th>
              <th className="px-5 py-2 text-right font-normal">违反次数</th>
            </tr>
          </thead>
          <tbody>
            {stats.ruleStats.length === 0 && (
              <tr>
                <td colSpan={6} className="px-5 py-10 text-center text-[12px] text-console-faint">
                  这本策略还没有规则。点「编辑」加上进出场条件。
                </td>
              </tr>
            )}
            {stats.ruleStats.map((rule) => (
              <tr key={rule.rule} className="border-t border-console-line/70">
                <td className="px-5 py-2.5 text-console-ink-2">{rule.rule}</td>
                <td className="num px-3 py-2.5 text-right font-mono text-[11px] text-console-muted">
                  {rule.evaluated}
                </td>
                <td
                  className={clsx(
                    'num px-3 py-2.5 text-right font-mono',
                    rule.rate == null
                      ? 'text-console-faint'
                      : rule.rate >= 0.8
                        ? 'text-console-gain'
                        : rule.rate < 0.5
                          ? 'text-console-loss'
                          : 'text-console-warn',
                  )}
                >
                  {fmtPct(rule.rate)}
                </td>
                <td className="num px-3 py-2.5 text-right font-mono text-[11px]">
                  {fmtR(rule.followed.avgR)}
                </td>
                <td className="num px-3 py-2.5 text-right font-mono text-[11px]">
                  {fmtR(rule.broken.avgR)}
                </td>
                <td className="num px-5 py-2.5 text-right font-mono text-[11px] text-console-muted">
                  {rule.broken.trades}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="border-t border-console-line px-5 py-3 text-[11px] leading-relaxed text-console-faint">
        遵守时与违反时的均 R 是同一批交易里的横向对比，不证明因果；样本少于 20 笔时只当提示。
      </div>
    </section>
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
      <div className="text-[11px] text-console-muted">{label}</div>
      <div className={clsx('num mt-1.5 font-mono text-[19px] font-medium leading-none', tone)}>
        {value}
      </div>
      <div className="mt-2 truncate text-[10px] text-console-faint">{hint ?? ' '}</div>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="console-card mt-6 flex flex-col items-center px-8 py-16 text-center">
      <ListChecks size={28} strokeWidth={1.3} className="text-console-faint" />
      <h2 className="mt-4 text-[15px] font-medium">先把一套做法写下来</h2>
      <p className="mt-2 max-w-[420px] text-[12px] leading-relaxed text-console-muted">
        策略手册只做两件事：记录你认可的进场 / 出场条件，和让每笔交易回答「我按它做了吗」。
        规则不要写结果（要盈利），要写可核对的动作（等回调到前高再进）。
      </p>
      <button onClick={onCreate} className="console-btn console-btn-primary mt-5">
        <Plus size={14} strokeWidth={1.8} />
        新建第一本策略
      </button>
    </section>
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
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-6" onClick={onCancel}>
      <div
        className="w-full max-w-[560px] rounded-xl border border-console-line bg-console-card p-5 text-console-ink shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label={form.id ? '编辑策略' : '新建策略'}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[16px] font-medium">{form.id ? '编辑策略' : '新建策略'}</h2>
          <button
            onClick={onCancel}
            className="rounded-md p-1 text-console-muted hover:bg-console-hover hover:text-console-ink"
            aria-label="关闭"
          >
            <X size={18} strokeWidth={1.6} />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="console-label mb-1.5 block">名称</span>
            <input
              autoFocus
              value={form.name}
              maxLength={40}
              onChange={(event) => onChange({ ...form, name: event.target.value })}
              placeholder="例如：前高突破回踩"
              className="console-input w-full"
            />
          </label>
          <label className="block">
            <span className="console-label mb-1.5 block">说明</span>
            <textarea
              value={form.description}
              rows={2}
              maxLength={500}
              onChange={(event) => onChange({ ...form, description: event.target.value })}
              placeholder="适用品种、时段、行情环境"
              className="console-input w-full resize-y py-2 leading-relaxed"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 flex items-center justify-between">
              <span className="console-label">规则（一行一条）</span>
              <span className="text-[11px] text-console-faint">{rules} / 20 条</span>
            </span>
            <textarea
              value={form.rules}
              rows={7}
              onChange={(event) => onChange({ ...form, rules: event.target.value })}
              placeholder={'只做 H1 趋势方向\n等价格回到前高附近\n止损放在结构低点下方'}
              className="console-input w-full resize-y py-2 leading-relaxed"
            />
          </label>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onCancel} className="console-btn console-btn-secondary">
            取消
          </button>
          <button
            onClick={onSave}
            disabled={saving || !form.name.trim()}
            className="console-btn console-btn-primary"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
