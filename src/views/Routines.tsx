import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive,
  Check,
  ChevronLeft,
  ChevronRight,
  ListChecks,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogClose,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { gateway } from '../gateway/client';
import { WEEKDAYS } from '../lib/review';
import {
  PHASE_HINTS,
  PHASE_LABELS,
  PHASE_ORDER,
  dateLabel,
  heatCellTitle,
  heatTone,
  rateText,
  shiftDay,
  streakText,
  weekdayMaskText,
} from '../lib/routines';
import { useApp } from '../store/useApp';
import type { Routine, RoutineDay, RoutineHeatmap, RoutinePhase } from '../gateway/types';

const HEAT_WEEKS = 13;

interface Draft {
  id?: number;
  title: string;
  phase: RoutinePhase;
  weekdays: number[];
}

/** 例行清单：盘前 / 盘中 / 盘后的打勾流程，以及 13 周完成率热力图 */
export function RoutinesView() {
  const notify = useApp((s) => s.notify);
  const activeLogin = useApp((s) => s.account?.login ?? 0);

  const [day, setDay] = useState<RoutineDay | null>(null);
  const [heat, setHeat] = useState<RoutineHeatmap | null>(null);
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [pending, setPending] = useState<number | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (date?: string) => {
    setLoading(true);
    try {
      const [dayData, heatData, listData] = await Promise.all([
        gateway.call<RoutineDay>('routine.day', date ? { date } : {}),
        gateway.call<RoutineHeatmap>('routine.heatmap', { weeks: HEAT_WEEKS }),
        gateway.call<{ routines: Routine[] }>('routine.list', {}),
      ]);
      setDay(dayData);
      setHeat(heatData);
      setRoutines(listData.routines);
      setAnchor(dayData.date);
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

  const toggle = async (routineId: number, next: boolean) => {
    if (!day || !day.editable) return;
    setPending(routineId);
    try {
      const updated = await gateway.call<RoutineDay>('routine.toggle', {
        id: routineId,
        date: day.date,
        done: next,
      });
      setDay(updated);
      const heatData = await gateway.call<RoutineHeatmap>('routine.heatmap', {
        weeks: HEAT_WEEKS,
      });
      setHeat(heatData);
    } catch (err) {
      notify('error', (err as Error).message);
    } finally {
      setPending(null);
    }
  };

  const seed = async () => {
    setSeeding(true);
    try {
      const result = await gateway.call<{ created: number }>('routine.seed', {});
      notify('success', `已生成 ${result.created} 条默认例行`);
      await load(anchor ?? undefined);
    } catch (err) {
      notify('error', (err as Error).message);
    } finally {
      setSeeding(false);
    }
  };

  const go = (delta: number) => {
    if (!day) return;
    void load(shiftDay(day.date, delta));
  };

  const empty = routines !== null && routines.length === 0;
  const isToday = Boolean(day && day.date === day.today);

  return (
    <div className="console-scope h-full min-h-0 overflow-auto bg-sidebar">
      <div className="mx-auto w-full max-w-[1240px] px-8 py-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-medium tracking-[-0.01em]">例行清单</h1>
            <p className="mt-1.5 text-[13px] text-muted-foreground">
              盘前、盘中、盘后各一组固定动作
              {activeLogin ? ` · 账户 ${activeLogin}` : ''} · 与盈亏统计完全独立
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={() => void load(anchor ?? undefined)} disabled={loading} variant="outline">
              <RefreshCw size={14} strokeWidth={1.5} className={cn(loading && 'animate-spin')} />
              {loading ? '读取中…' : '刷新'}
            </Button>
            <Button onClick={() => setManageOpen(true)}>
              <Pencil size={13} strokeWidth={1.8} />
              管理清单
            </Button>
          </div>
        </header>

        {error && (
          <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive-foreground">
            读取失败：{error}
          </div>
        )}

        {empty ? (
          <Card className="mt-6 flex flex-col items-center gap-3 px-6 py-16 text-center">
            <ListChecks size={26} strokeWidth={1.4} className="text-muted-foreground/60" />
            <div>
              <p className="text-[14px] font-medium">还没有例行清单</p>
              <p className="mt-1 text-[12px] text-muted-foreground">
                先套用一套常用的盘前 / 盘中 / 盘后动作，之后随时可以改。
              </p>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <Button onClick={() => void seed()} disabled={seeding}>
                <Sparkles size={13} strokeWidth={1.8} />
                {seeding ? '生成中…' : '生成默认清单'}
              </Button>
              <Button onClick={() => setManageOpen(true)} variant="outline">
                <Plus size={13} strokeWidth={1.8} />
                自己写
              </Button>
            </div>
          </Card>
        ) : (
          <div className="mt-6 grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
            <div className="min-w-0 space-y-4">
              <Card className="flex flex-row flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="flex items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          onClick={() => go(-1)}
                          disabled={loading}
                          size="icon-sm"
                          variant="ghost"
                          aria-label="前一天"
                        />
                      }
                    >
                      <ChevronLeft size={16} strokeWidth={1.6} />
                    </TooltipTrigger>
                    <TooltipPopup>前一天</TooltipPopup>
                  </Tooltip>
                  <div className="min-w-[132px] text-center">
                    <div className="text-[13px] font-medium">
                      {day ? dateLabel(day.date, day.today) : '—'}
                    </div>
                    <div className="num font-mono text-[10px] text-muted-foreground/60">{day?.date ?? ''}</div>
                  </div>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          onClick={() => go(1)}
                          disabled={loading}
                          size="icon-sm"
                          variant="ghost"
                          aria-label="后一天"
                        />
                      }
                    >
                      <ChevronRight size={16} strokeWidth={1.6} />
                    </TooltipTrigger>
                    <TooltipPopup>后一天</TooltipPopup>
                  </Tooltip>
                  {day && !isToday && (
                    <Button onClick={() => void load(day.today)} size="xs" variant="outline" className="ml-1">
                      回到今天
                    </Button>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  {day && !day.editable && (
                    <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground/60">
                      只读
                    </span>
                  )}
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-28 overflow-hidden rounded-full bg-border/60">
                      <div
                        className="h-full rounded-full bg-brand transition-[width]"
                        style={{ width: `${Math.round((day?.summary.rate ?? 0) * 100)}%` }}
                      />
                    </div>
                    <span className="num font-mono text-[12px] text-muted-foreground">
                      {day ? `${day.summary.done}/${day.summary.total}` : '—'}
                      <span className="ml-1 text-muted-foreground/60">
                        {rateText(day?.summary.rate ?? null)}
                      </span>
                    </span>
                  </div>
                </div>
              </Card>

              {PHASE_ORDER.map((phase) => (
                <PhaseLane
                  key={phase}
                  phase={phase}
                  items={day?.phases[phase] ?? []}
                  editable={Boolean(day?.editable)}
                  pending={pending}
                  onToggle={toggle}
                />
              ))}

              {day && day.items.length === 0 && (
                <p className="px-1 text-[12px] text-muted-foreground/60">
                  这一天没有需要执行的例行。
                  {day.editable ? '可以在「管理清单」里调整星期安排。' : ''}
                </p>
              )}
            </div>

            <Heatmap heat={heat} />
          </div>
        )}
      </div>

      {manageOpen && (
        <RoutineManager
          onClose={() => setManageOpen(false)}
          onChanged={() => void load(anchor ?? undefined)}
        />
      )}
    </div>
  );
}

function PhaseLane({
  phase,
  items,
  editable,
  pending,
  onToggle,
}: {
  phase: RoutinePhase;
  items: RoutineDay['items'];
  editable: boolean;
  pending: number | null;
  onToggle: (id: number, next: boolean) => void;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[13px] font-medium">{PHASE_LABELS[phase]}</h2>
          <span className="text-[11px] text-muted-foreground/60">{PHASE_HINTS[phase]}</span>
        </div>
        <span className="num font-mono text-[11px] text-muted-foreground/60">
          {items.filter((item) => item.done).length}/{items.length}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="px-4 py-3 text-[12px] text-muted-foreground/60">这一组今天没有安排</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {items.map((item) => (
            <li key={item.id}>
              <Button
                onClick={() => onToggle(item.id, !item.done)}
                disabled={!editable || pending === item.id}
                variant="ghost"
                className={cn(
                  'h-auto w-full justify-start gap-3 rounded-none border-0 px-4 py-2.5 text-left transition-colors',
                  editable && 'hover:bg-accent/60',
                  !editable && 'cursor-default',
                )}
              >
                <span
                  className={cn(
                    'flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-[4px] border',
                    item.done
                      ? 'border-brand bg-brand text-sidebar'
                      : 'border-input text-transparent',
                  )}
                >
                  <Check size={12} strokeWidth={2.4} />
                </span>
                <span
                  className={cn(
                    'min-w-0 flex-1 text-[13px]',
                    item.done ? 'text-muted-foreground/60 line-through' : 'text-foreground',
                  )}
                >
                  {item.title}
                </span>
                {item.weekdays.length < 7 && (
                  <span className="shrink-0 text-[10px] text-muted-foreground/60">
                    {weekdayMaskText(item.weekdays)}
                  </span>
                )}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Heatmap({ heat }: { heat: RoutineHeatmap | null }) {
  const cells = useMemo(() => {
    if (!heat) return new Map<string, RoutineHeatmap['cells'][number]>();
    return new Map(heat.cells.map((cell) => [cell.date, cell]));
  }, [heat]);

  const columns = useMemo(() => {
    if (!heat) return [] as string[];
    return Array.from({ length: heat.weeks }, (_, index) => shiftDay(heat.start, index * 7));
  }, [heat]);

  return (
    <Card className="h-fit overflow-hidden">
      <div className="border-b border-border px-4 py-2.5">
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-medium">最近 13 周</h2>
          <span className="num font-mono text-[11px] text-muted-foreground">
            {rateText(heat?.summary.rate ?? null)}
          </span>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground/60">
          {heat
            ? `${streakText(heat.summary.streak)} · 共完成 ${heat.summary.done}/${heat.summary.due}`
            : '读取中…'}
        </p>
      </div>
      <div className="px-4 py-3">
        <div className="flex gap-2">
          <div className="flex flex-col justify-between py-[1px]">
            {WEEKDAYS.map((label) => (
              <span key={label} className="h-[14px] text-[9px] leading-[14px] text-muted-foreground/60">
                {label}
              </span>
            ))}
          </div>
          <div
            className="grid flex-1 gap-[3px]"
            style={{
              gridTemplateColumns: `repeat(${heat?.weeks ?? 13}, minmax(0, 1fr))`,
              gridTemplateRows: 'repeat(7, 14px)',
              gridAutoFlow: 'column',
            }}
          >
            {columns.map((monday) =>
              Array.from({ length: 7 }, (_, offset) => {
                const key = shiftDay(monday, offset);
                const cell = cells.get(key);
                return (
                  <div
                    key={key}
                    title={heatCellTitle(key, cell?.due ?? 0, cell?.done ?? 0, cell?.future ?? false)}
                    className={cn(
                      'rounded-[3px] border border-transparent',
                      cell?.future ? 'bg-transparent' : heatTone(cell?.rate ?? null),
                      cell?.date === heat?.today && 'outline outline-1 outline-brand/70',
                    )}
                  />
                );
              }),
            )}
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between text-[10px] text-muted-foreground/60">
          <span>越接近绿色完成度越高</span>
          <div className="flex items-center gap-1">
            <span className="h-[10px] w-[10px] rounded-[2px] bg-border/25" />
            <span className="h-[10px] w-[10px] rounded-[2px] bg-warning/35" />
            <span className="h-[10px] w-[10px] rounded-[2px] bg-success/40" />
          </div>
        </div>
      </div>
    </Card>
  );
}

function RoutineManager({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const notify = useApp((s) => s.notify);
  const [list, setList] = useState<Routine[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState<Draft>({
    title: '',
    phase: 'pre',
    weekdays: [1, 2, 3, 4, 5],
  });

  const loadList = useCallback(async () => {
    try {
      const data = await gateway.call<{ routines: Routine[] }>('routine.list', {
        includeArchived: true,
      });
      setList(data.routines);
      setDrafts(
        Object.fromEntries(
          data.routines.map((routine) => [
            String(routine.id),
            {
              id: routine.id,
              title: routine.title,
              phase: routine.phase,
              weekdays: [...routine.weekdays],
            } satisfies Draft,
          ]),
        ),
      );
    } catch (err) {
      notify('error', (err as Error).message);
    }
  }, [notify]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async (key: string, draft: Draft) => {
    if (!draft.title.trim()) {
      notify('error', '例行标题不能为空');
      return;
    }
    setSavingKey(key);
    try {
      await gateway.call('routine.save', {
        id: draft.id,
        title: draft.title.trim(),
        phase: draft.phase,
        weekdays: draft.weekdays,
      });
      notify('success', draft.id ? '例行已更新' : '例行已添加');
      await loadList();
      onChanged();
    } catch (err) {
      notify('error', (err as Error).message);
    } finally {
      setSavingKey(null);
    }
  };

  const archive = async (routine: Routine) => {
    if (!window.confirm(`归档「${routine.title}」？过去的打勾记录会保留。`)) return;
    try {
      await gateway.call('routine.delete', { id: routine.id });
      notify('info', '例行已归档');
      await loadList();
      onChanged();
    } catch (err) {
      notify('error', (err as Error).message);
    }
  };

  const active = (list ?? []).filter((routine) => !routine.archivedAt);
  const archived = (list ?? []).filter((routine) => routine.archivedAt);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup showCloseButton={false} className="max-w-[760px]">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="text-[15px]">管理例行清单</DialogTitle>
              <p className="mt-0.5 text-[11px] text-muted-foreground/60">
                星期决定哪天出现；归档不删除历史打勾记录。
              </p>
            </div>
            <DialogClose
              render={<Button size="icon-sm" variant="ghost" aria-label="关闭" />}
              onClick={onClose}
            >
              <X size={16} strokeWidth={1.6} />
            </DialogClose>
          </div>
        </DialogHeader>

        <DialogPanel className="space-y-2">
          {list === null && <p className="text-[12px] text-muted-foreground/60">读取中…</p>}
          {active.map((routine) => {
            const key = String(routine.id);
            const draft = drafts[key];
            if (!draft) return null;
            const dirty =
              draft.title !== routine.title ||
              draft.phase !== routine.phase ||
              draft.weekdays.join(',') !== routine.weekdays.join(',');
            return (
              <DraftRow
                key={key}
                draft={draft}
                dirty={dirty}
                saving={savingKey === key}
                onChange={(next) => setDrafts((prev) => ({ ...prev, [key]: next }))}
                onSave={() => void save(key, draft)}
                onArchive={() => void archive(routine)}
              />
            );
          })}
          {list !== null && active.length === 0 && !creating && (
            <p className="py-4 text-center text-[12px] text-muted-foreground/60">还没有例行，先加一条。</p>
          )}

          {creating ? (
            <div className="rounded-lg border border-brand/40 bg-accent p-3">
              <DraftRow
                draft={fresh}
                dirty
                saving={savingKey === 'new'}
                onChange={setFresh}
                onSave={() => {
                  void save('new', fresh).then(() => {
                    setFresh({ title: '', phase: 'pre', weekdays: [1, 2, 3, 4, 5] });
                    setCreating(false);
                  });
                }}
                onCancel={() => setCreating(false)}
              />
            </div>
          ) : (
            <Button
              onClick={() => setCreating(true)}
              variant="outline"
              className="w-full border-dashed text-muted-foreground"
            >
              <Plus size={13} strokeWidth={1.8} />
              添加例行
            </Button>
          )}

          {archived.length > 0 && (
            <div className="pt-3">
              <div className="pb-2 text-[11px] font-medium text-muted-foreground">已归档</div>
              <div className="space-y-1">
                {archived.map((routine) => (
                  <div
                    key={routine.id}
                    className="flex items-center justify-between rounded border border-border/60 px-3 py-1.5 text-[12px] text-muted-foreground/60"
                  >
                    <span className="truncate">
                      {PHASE_LABELS[routine.phase]} · {routine.title}
                    </span>
                    <Archive size={12} strokeWidth={1.6} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function DraftRow({
  draft,
  dirty,
  saving,
  onChange,
  onSave,
  onArchive,
  onCancel,
}: {
  draft: Draft;
  dirty: boolean;
  saving: boolean;
  onChange: (draft: Draft) => void;
  onSave: () => void;
  onArchive?: () => void;
  onCancel?: () => void;
}) {
  const toggleWeekday = (day: number) => {
    const next = draft.weekdays.includes(day)
      ? draft.weekdays.filter((value) => value !== day)
      : [...draft.weekdays, day].sort((a, b) => a - b);
    onChange({ ...draft, weekdays: next.length ? next : [day] });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        value={draft.title}
        onChange={(event) => onChange({ ...draft, title: event.target.value })}
        placeholder="例行动作"
        className="min-w-[180px] flex-1"
      />
      <div className="flex items-center gap-0.5">
        {PHASE_ORDER.map((phase) => (
          <Button
            key={phase}
            onClick={() => onChange({ ...draft, phase })}
            size="xs"
            variant={draft.phase === phase ? 'default' : 'outline'}
          >
            {PHASE_LABELS[phase]}
          </Button>
        ))}
      </div>
      <div className="flex items-center gap-0.5">
        {WEEKDAYS.map((label, index) => {
          const day = index + 1;
          const on = draft.weekdays.includes(day);
          return (
            <Button
              key={label}
              onClick={() => toggleWeekday(day)}
              title={`周${label}`}
              size="icon-xs"
              variant={on ? 'default' : 'ghost'}
              className="size-[22px] text-[10px]"
            >
              {label}
            </Button>
          );
        })}
      </div>
      <div className="ml-auto flex items-center gap-1">
        {onCancel && (
          <Button onClick={onCancel} variant="ghost">
            取消
          </Button>
        )}
        <Button onClick={onSave} disabled={!dirty || saving} variant="outline">
          {saving ? '保存中…' : '保存'}
        </Button>
        {onArchive && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button onClick={onArchive} size="icon-sm" variant="ghost" aria-label="归档" />
              }
            >
              <Archive size={14} strokeWidth={1.6} />
            </TooltipTrigger>
            <TooltipPopup>归档</TooltipPopup>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
