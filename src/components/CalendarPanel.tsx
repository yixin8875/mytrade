import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  IMPACT_LABEL,
  currenciesForSymbol,
  loadCalendar,
} from '../lib/calendar';
import { useApp } from '../store/useApp';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Empty, EmptyDescription } from './ui/empty';
import { SegmentedControl, SegmentedControlItem } from './ui/segmented-control';
import type { CalendarEvent } from '../gateway/types';

function eventTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString('zh-CN', {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** 交易台右侧的财经日历：本周事件、品种筛选与图表标注开关 */
export function CalendarPanel() {
  const setOpen = useApp((s) => s.setCalendarOpen);
  const overlay = useApp((s) => s.calendarOverlay);
  const setOverlay = useApp((s) => s.setCalendarOverlay);
  const symbol = useApp((s) => s.symbol);

  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState<'symbol' | 'all'>('symbol');
  const [highOnly, setHighOnly] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    let retry: number | undefined;
    let attempts = 0;
    const load = async () => {
      try {
        const week = await loadCalendar();
        if (!alive) return;
        setEvents(week.events);
        setFetchedAt(week.fetchedAt);
        setError(week.error);
        // 网关第一次抓取时返回空缓存，隔几秒再问一次
        if (week.events.length === 0 && week.fetchedAt === 0 && attempts < 4) {
          attempts += 1;
          retry = window.setTimeout(() => void load(), 2500);
        }
      } catch (err) {
        if (alive) setError((err as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => setTick((value) => value + 1), 60_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
      if (retry) window.clearTimeout(retry);
    };
  }, []);

  const now = Date.now() / 1000;
  const currencies = useMemo(() => currenciesForSymbol(symbol), [symbol]);
  const rows = useMemo(() => {
    const impactRows = events.filter((event) =>
      highOnly ? event.impact === 'High' : event.impact === 'High' || event.impact === 'Medium',
    );
    const scoped =
      scope === 'symbol'
        ? impactRows.filter((event) => currencies.includes(event.country))
        : impactRows;
    return scoped.filter((event) => event.ts >= now - 3600).slice(0, 40);
    // tick 只用来让「即将开始」随时间推进
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, highOnly, scope, currencies, tick]);

  const nextId = rows.find((event) => event.ts >= now)?.id;

  return (
    <aside
      data-panel="calendar"
      className="absolute inset-y-0 right-0 z-20 flex w-[340px] flex-col border-l border-border bg-card shadow-lg/5"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
        <CalendarDays size={14} strokeWidth={1.5} className="text-muted-foreground" />
        <span className="text-[12px] font-medium text-foreground">财经日历</span>
        <span className="num font-mono text-[11px] text-muted-foreground">{rows.length}</span>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setOpen(false)}
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          title="关闭日历面板"
          aria-label="关闭日历面板"
        >
          <X size={14} strokeWidth={1.5} />
        </Button>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-2.5">
        <SegmentedControl size="sm">
          {(
            [
              ['symbol', symbol || '当前品种'],
              ['all', '全部'],
            ] as const
          ).map(([value, label]) => {
            const active = scope === value;
            return (
              <SegmentedControlItem
                key={value}
                data-checked={active ? '' : undefined}
                aria-pressed={active}
                onClick={() => setScope(value)}
                className="h-7 max-w-[150px] truncate px-2.5 text-[11px]"
              >
                {label}
              </SegmentedControlItem>
            );
          })}
        </SegmentedControl>
        <Button
          variant={highOnly ? 'secondary' : 'ghost'}
          size="xs"
          onClick={() => setHighOnly(!highOnly)}
          aria-pressed={highOnly}
          className={cn(
            'h-7 px-2.5 text-[11px] font-normal',
            !highOnly && 'text-muted-foreground hover:text-foreground',
          )}
        >
          仅高影响
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setOverlay(!overlay)}
          aria-pressed={overlay}
          className={cn(
            'ml-auto h-7 gap-1.5 rounded-lg border px-2.5 text-[11px] font-normal',
            overlay
              ? 'border-brand/40 bg-brand/10 text-brand hover:bg-brand/10'
              : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          <span className={cn('h-1.5 w-1.5 rounded-full', overlay ? 'bg-brand' : 'bg-muted-foreground/60')} />
          图表标注
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {error && (
          <div className="border-b border-border px-3 py-2 text-[11px] text-warning-foreground">
            {error}
          </div>
        )}
        {loading && rows.length === 0 && (
          <div className="px-4 py-10 text-center text-[12px] text-muted-foreground/60">读取本周日历…</div>
        )}
        {!loading && rows.length === 0 && (
          <Empty className="gap-1 px-6 py-10">
            <EmptyDescription className="text-[12px] leading-relaxed text-muted-foreground/60">
              本周没有符合条件的事件。
              <br />
              可以切到「全部」或关闭「仅高影响」。
            </EmptyDescription>
          </Empty>
        )}
        {rows.map((event) => {
          const high = event.impact === 'High';
          return (
            <div
              key={event.id}
              className={cn(
                'border-b border-border/60 px-3 py-2.5',
                event.id === nextId && 'bg-muted/60',
              )}
            >
              <div className="flex items-center gap-2">
                <Badge
                  variant={high ? 'error' : 'warning'}
                  size="sm"
                  className="h-auto shrink-0 rounded px-1.5 py-0.5 text-[10px]"
                >
                  {IMPACT_LABEL[event.impact] ?? event.impact}
                </Badge>
                <span className="num shrink-0 font-mono text-[11px] text-muted-foreground">
                  {eventTime(event.ts)}
                </span>
                <span className="ml-auto shrink-0 font-mono text-[11px] text-foreground">
                  {event.country}
                </span>
              </div>
              <div className="mt-1 text-[12px] leading-snug text-foreground">{event.title}</div>
              {(event.forecast || event.previous) && (
                <div className="mt-1 flex gap-3 text-[10.5px] text-muted-foreground/60">
                  {event.forecast && <span>预期 {event.forecast}</span>}
                  {event.previous && <span>前值 {event.previous}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="shrink-0 border-t border-border px-3 py-2 text-[10px] text-muted-foreground/60">
        ForexFactory 周历 · 每 6 小时刷新
        {fetchedAt > 0 && ` · ${new Date(fetchedAt * 1000).toLocaleString('zh-CN')}`}
      </div>
    </aside>
  );
}
