import { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw, Target, Trash2, X, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { gateway } from '../gateway/client';
import { fmtR } from '../lib/review';
import {
  MISSED_STATUS_LABELS,
  fmtMissedTime,
  fromLocalInput,
  isSettled,
  missedStatusTone,
  rTone,
  summaryLine,
  toLocalInput,
  toServerEpoch,
  toUtcEpoch,
} from '../lib/missed';
import { useApp } from '../store/useApp';
import { useTradeReplay } from '../replay/useTradeReplay';
import type { MissedList, MissedTrade, Playbook, Side } from '../gateway/types';

interface Form {
  symbol: string;
  side: Side;
  observedAt: string;
  entryPrice: string;
  sl: string;
  tp: string;
  playbookId: string;
  note: string;
}

function draftForm(symbol: string): Form {
  return {
    symbol,
    side: 'buy',
    observedAt: toLocalInput(Math.floor(Date.now() / 1000)),
    entryPrice: '',
    sl: '',
    tp: '',
    playbookId: '',
    note: '',
  };
}

/** 错过机会：记录看到了却没做的 setup，用观察后的 M1 走一遍计划 */
export function MissedView() {
  const notify = useApp((s) => s.notify);
  const activeLogin = useApp((s) => s.account?.login ?? 0);
  const currentSymbol = useApp((s) => s.symbol);
  const serverOffset = useApp((s) => s.health?.serverOffset ?? 0);

  const [data, setData] = useState<MissedList | null>(null);
  const [books, setBooks] = useState<Playbook[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [simulating, setSimulating] = useState<number | null>(null);
  const replay = useTradeReplay();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, strategies] = await Promise.all([
        gateway.call<MissedList>('missed.list', {}),
        gateway.call<{ playbooks: Playbook[] }>('strategy.list', {}),
      ]);
      setData(list);
      setBooks(strategies.playbooks.filter((book) => !book.archived_at));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, activeLogin]);

  const openForm = () => setForm(draftForm(currentSymbol ?? ''));

  const save = async () => {
    if (!form) return;
    const symbol = form.symbol.trim().toUpperCase();
    if (!symbol) {
      notify('error', '品种不能为空');
      return;
    }
    const observedAt = fromLocalInput(form.observedAt);
    if (!observedAt) {
      notify('error', '请选择观察时间');
      return;
    }
    setSaving(true);
    try {
      await gateway.call('missed.save', {
        symbol,
        side: form.side,
        observedAt: toServerEpoch(observedAt, serverOffset),
        entryPrice: form.entryPrice.trim() || null,
        sl: form.sl.trim() || null,
        tp: form.tp.trim() || null,
        playbookId: form.playbookId || null,
        note: form.note,
      });
      setForm(null);
      notify('success', '已记录一笔错过的机会');
      await load();
    } catch (err) {
      notify('error', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const simulate = async (item: MissedTrade) => {
    setSimulating(item.id);
    try {
      const result = await gateway.call<{ missed: MissedTrade }>('missed.simulate', {
        id: item.id,
      });
      const status = result.missed.sim?.status;
      if (status) {
        notify('info', `模拟完成：${MISSED_STATUS_LABELS[status]}`);
      }
      await load();
    } catch (err) {
      notify('error', (err as Error).message);
    } finally {
      setSimulating(null);
    }
  };

  const remove = async (item: MissedTrade) => {
    if (!window.confirm(`删除 ${item.symbol} ${item.side === 'buy' ? '多' : '空'} 这条记录？`)) return;
    try {
      await gateway.call('missed.delete', { id: item.id });
      notify('info', '已删除');
      await load();
    } catch (err) {
      notify('error', (err as Error).message);
    }
  };

  const summary = data?.summary ?? null;

  return (
    <div className="console-scope h-full min-h-0 overflow-auto bg-sidebar">
      <div className="mx-auto w-full max-w-[1240px] px-8 py-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-medium tracking-[-0.01em]">错过机会</h1>
            <p className="mt-1.5 text-[13px] text-muted-foreground">
              记下看到却没做的 setup
              {activeLogin ? ` · 账户 ${activeLogin}` : ''} · 用观察后的 M1 走一遍计划，只看理论 R
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={() => void load()} disabled={loading} variant="outline">
              <RefreshCw size={14} strokeWidth={1.5} className={cn(loading && 'animate-spin')} />
              {loading ? '读取中…' : '刷新'}
            </Button>
            <Button onClick={openForm}>
              <Plus size={14} strokeWidth={1.8} />
              记录一笔
            </Button>
          </div>
        </header>

        {error && (
          <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive-foreground">
            读取失败：{error}
          </div>
        )}

        {summary && (
          <Card className="mt-5 flex flex-row flex-wrap items-center gap-x-5 gap-y-1 px-4 py-2.5 text-[12px] text-muted-foreground">
            <span>{summaryLine(summary)}</span>
            <span className="text-[11px] text-muted-foreground/60">
              理论值，不含点差 / 滑点 / 手续费；不进入任何绩效统计
            </span>
          </Card>
        )}

        {form && (
          <Card className="mt-4 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[13px] font-medium">记录一笔错过的机会</h2>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      onClick={() => setForm(null)}
                      size="icon-sm"
                      variant="ghost"
                      aria-label="关闭"
                    />
                  }
                >
                  <X size={15} strokeWidth={1.6} />
                </TooltipTrigger>
                <TooltipPopup>关闭</TooltipPopup>
              </Tooltip>
            </div>
            <div className="grid gap-3 md:grid-cols-4">
              <Field label="品种">
                <Input
                  value={form.symbol}
                  onChange={(event) =>
                    setForm({ ...form, symbol: event.target.value.toUpperCase() })
                  }
                  placeholder="EURUSD"
                  className="w-full"
                />
              </Field>
              <Field label="方向">
                <div className="flex items-center gap-1">
                  {(['buy', 'sell'] as Side[]).map((side) => (
                    <Button
                      key={side}
                      onClick={() => setForm({ ...form, side })}
                      size="xs"
                      variant={form.side === side ? 'default' : 'outline'}
                      className="flex-1"
                    >
                      {side === 'buy' ? '做多' : '做空'}
                    </Button>
                  ))}
                </div>
              </Field>
              <Field label="观察时间">
                <Input
                  type="datetime-local"
                  value={form.observedAt}
                  onChange={(event) => setForm({ ...form, observedAt: event.target.value })}
                  className="w-full"
                />
              </Field>
              <Field label="计划入场价（空 = 现价）">
                <Input
                  value={form.entryPrice}
                  onChange={(event) => setForm({ ...form, entryPrice: event.target.value })}
                  placeholder="留空按第一根 M1 开盘价"
                  className="w-full"
                />
              </Field>
              <Field label="止损">
                <Input
                  value={form.sl}
                  onChange={(event) => setForm({ ...form, sl: event.target.value })}
                  placeholder="留空则没有 R"
                  className="w-full"
                />
              </Field>
              <Field label="目标">
                <Input
                  value={form.tp}
                  onChange={(event) => setForm({ ...form, tp: event.target.value })}
                  placeholder="留空只看漂移"
                  className="w-full"
                />
              </Field>
              <Field label="策略（可选）">
                <Select
                  value={form.playbookId || 'none'}
                  onValueChange={(value) =>
                    setForm({
                      ...form,
                      playbookId: String(value) === 'none' ? '' : String(value),
                    })
                  }
                >
                  <SelectTrigger aria-label="策略（可选）">
                    <SelectValue>
                      {books.find((book) => book.id === form.playbookId)?.name ?? '不关联'}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="none">不关联</SelectItem>
                    {books.map((book) => (
                      <SelectItem key={book.id} value={book.id}>
                        {book.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
              <Field label="备注">
                <Input
                  value={form.note}
                  onChange={(event) => setForm({ ...form, note: event.target.value })}
                  placeholder="为什么没做"
                  className="w-full"
                />
              </Field>
            </div>
            <div className="mt-3 flex items-center justify-end gap-2">
              <Button onClick={() => setForm(null)} variant="ghost">
                取消
              </Button>
              <Button onClick={() => void save()} disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </Button>
            </div>
          </Card>
        )}

        {data && data.missed.length === 0 ? (
          <Card className="mt-5 flex flex-col items-center gap-3 px-6 py-16 text-center">
            <Target size={26} strokeWidth={1.4} className="text-muted-foreground/60" />
            <div>
              <p className="text-[14px] font-medium">还没有记录</p>
              <p className="mt-1 text-[12px] text-muted-foreground">
                下次看到符合规则却没出手的机会，顺手记一笔，过几天回看它走成什么样。
              </p>
            </div>
            <Button onClick={openForm} className="mt-1">
              <Plus size={13} strokeWidth={1.8} />
              记录一笔
            </Button>
          </Card>
        ) : (
          <div className="mt-4 space-y-2">
            {(data?.missed ?? []).map((item) => (
              <Card key={item.id} render={<article />} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div className="flex min-w-[150px] items-center gap-2">
                    <span className="text-[13px] font-medium">{item.symbol}</span>
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[10px]',
                        item.side === 'buy'
                          ? 'bg-success/15 text-success-foreground'
                          : 'bg-destructive/10 text-destructive-foreground',
                      )}
                    >
                      {item.side === 'buy' ? '多' : '空'}
                    </span>
                    {item.playbookId && (
                      <span className="truncate text-[10px] text-muted-foreground/60">
                        {books.find((book) => book.id === item.playbookId)?.name ?? '策略'}
                      </span>
                    )}
                  </div>
                  <span className="num font-mono text-[11px] text-muted-foreground">
                    {fmtMissedTime(toUtcEpoch(item.observedAt, serverOffset))}
                  </span>
                  <span className="num font-mono text-[11px] text-muted-foreground/60">
                    计划 {fmtPrice(item.entryPrice)} → 止损 {fmtPrice(item.sl)} · 目标{' '}
                    {fmtPrice(item.tp)}
                  </span>
                  <div className="ml-auto flex items-center gap-2">
                    {item.sim ? (
                      <>
                        <span
                          className={cn(
                            'rounded border px-1.5 py-0.5 text-[10px]',
                            missedStatusTone(item.sim.status),
                          )}
                        >
                          {MISSED_STATUS_LABELS[item.sim.status]}
                        </span>
                        {isSettled(item.sim.status) && (
                          <span
                            className={cn(
                              'num min-w-[52px] text-right font-mono text-[13px]',
                              rTone(item.sim.r),
                            )}
                          >
                            {fmtR(item.sim.r)}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-[10px] text-muted-foreground/60">未模拟</span>
                    )}
                    <Button
                      onClick={() => void simulate(item)}
                      disabled={simulating === item.id}
                      variant="outline"
                      size="sm"
                    >
                      <Zap size={12} strokeWidth={1.8} />
                      {simulating === item.id ? '模拟中…' : '模拟'}
                    </Button>
                    <Button
                      onClick={() =>
                        replay.startWindow({
                          symbol: item.symbol,
                          anchorTs: item.observedAt,
                          label: item.note || `#${item.id}`,
                        })
                      }
                      variant="outline"
                      size="sm"
                      title="按观察时间前后生成一段回放"
                    >
                      在回放中看
                    </Button>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            onClick={() => void remove(item)}
                            size="icon-sm"
                            variant="ghost"
                            aria-label="删除"
                          />
                        }
                      >
                        <Trash2 size={13} strokeWidth={1.6} />
                      </TooltipTrigger>
                      <TooltipPopup>删除</TooltipPopup>
                    </Tooltip>
                  </div>
                </div>
                {(item.note || item.sim?.note) && (
                  <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground/60">
                    {item.note}
                    {item.note && item.sim?.note ? ' · ' : ''}
                    {item.sim?.note}
                  </p>
                )}
                {item.sim && item.sim.status !== 'no_entry' && item.sim.status !== 'no_data' && (
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground/60">
                    {item.sim.entryPrice != null && item.sim.entryAt != null && (
                      <span>
                        入场 {fmtPrice(item.sim.entryPrice)} ·{' '}
                        {fmtMissedTime(toUtcEpoch(item.sim.entryAt, serverOffset))}
                      </span>
                    )}
                    {item.sim.mfeR != null && <span>最大有利 {fmtR(item.sim.mfeR)}</span>}
                    {item.sim.maeR != null && <span>最大不利 {fmtR(item.sim.maeR)}</span>}
                    {item.sim.barsHeld != null && <span>持有 {item.sim.barsHeld} 分钟</span>}
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function fmtPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString(undefined, { maximumFractionDigits: 5 });
}
