import { useEffect, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { CalendarDays, X } from 'lucide-react';
import {
  IMPACT_LABEL,
  currenciesForSymbol,
  loadCalendar,
} from '../lib/calendar';
import { useApp } from '../store/useApp';
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
      className="absolute inset-y-0 right-0 z-20 flex w-[340px] flex-col border-l border-tv-border bg-tv-panel shadow-[-12px_0_32px_-16px_rgba(0,0,0,0.35)]"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-tv-border px-4">
        <CalendarDays size={14} strokeWidth={1.5} className="text-tv-muted" />
        <span className="text-[12px] font-medium text-tv-text">财经日历</span>
        <span className="num font-mono text-[11px] text-tv-muted">{rows.length}</span>
        <span className="flex-1" />
        <button
          onClick={() => setOpen(false)}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-tv-muted transition-colors hover:bg-tv-hover hover:text-tv-text"
          title="关闭日历面板"
          aria-label="关闭日历面板"
        >
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-tv-border px-3 py-2.5">
        <div className="flex overflow-hidden rounded-lg border border-tv-border">
          {(
            [
              ['symbol', symbol || '当前品种'],
              ['all', '全部'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              onClick={() => setScope(value)}
              className={clsx(
                'h-7 max-w-[150px] truncate px-2.5 text-[11px] transition-colors',
                scope === value
                  ? 'bg-tv-raised font-medium text-tv-text'
                  : 'text-tv-muted hover:text-tv-text',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          onClick={() => setHighOnly(!highOnly)}
          className={clsx(
            'h-7 rounded-lg border px-2.5 text-[11px] transition-colors',
            highOnly
              ? 'border-tv-border bg-tv-raised text-tv-text'
              : 'border-transparent text-tv-muted hover:bg-tv-hover hover:text-tv-text',
          )}
        >
          仅高影响
        </button>
        <button
          onClick={() => setOverlay(!overlay)}
          className={clsx(
            'ml-auto flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] transition-colors',
            overlay
              ? 'border-tv-accent/40 bg-tv-accent-soft text-tv-accent'
              : 'border-transparent text-tv-muted hover:bg-tv-hover hover:text-tv-text',
          )}
        >
          <span className={clsx('h-1.5 w-1.5 rounded-full', overlay ? 'bg-tv-accent' : 'bg-tv-faint')} />
          图表标注
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {error && (
          <div className="border-b border-tv-border px-3 py-2 text-[11px] text-tv-warn">
            {error}
          </div>
        )}
        {loading && rows.length === 0 && (
          <div className="px-4 py-10 text-center text-[12px] text-tv-faint">读取本周日历…</div>
        )}
        {!loading && rows.length === 0 && (
          <div className="px-6 py-10 text-center text-[12px] leading-relaxed text-tv-faint">
            本周没有符合条件的事件。
            <br />
            可以切到「全部」或关闭「仅高影响」。
          </div>
        )}
        {rows.map((event) => {
          const high = event.impact === 'High';
          return (
            <div
              key={event.id}
              className={clsx(
                'border-b border-tv-border/60 px-3 py-2.5',
                event.id === nextId && 'bg-tv-raised/60',
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  className={clsx(
                    'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                    high ? 'bg-tv-down-soft text-tv-down' : 'bg-tv-warn-soft text-tv-warn',
                  )}
                >
                  {IMPACT_LABEL[event.impact] ?? event.impact}
                </span>
                <span className="num shrink-0 font-mono text-[11px] text-tv-muted">
                  {eventTime(event.ts)}
                </span>
                <span className="ml-auto shrink-0 font-mono text-[11px] text-tv-text">
                  {event.country}
                </span>
              </div>
              <div className="mt-1 text-[12px] leading-snug text-tv-text">{event.title}</div>
              {(event.forecast || event.previous) && (
                <div className="mt-1 flex gap-3 text-[10.5px] text-tv-faint">
                  {event.forecast && <span>预期 {event.forecast}</span>}
                  {event.previous && <span>前值 {event.previous}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="shrink-0 border-t border-tv-border px-3 py-2 text-[10px] text-tv-faint">
        ForexFactory 周历 · 每 6 小时刷新
        {fetchedAt > 0 && ` · ${new Date(fetchedAt * 1000).toLocaleString('zh-CN')}`}
      </div>
    </aside>
  );
}
