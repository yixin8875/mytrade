import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import {
  ChevronLeft,
  ChevronRight,
  FileDown,
  ImageDown,
  NotebookPen,
  RefreshCw,
} from 'lucide-react';
import { gateway } from '../gateway/client';
import { AiReviewPanel } from '../components/AiReviewPanel';
import { TradeReviewDrawer } from '../components/TradeReviewDrawer';
import { ReferenceCapacityDialog, useTradeReplay } from '../replay/useTradeReplay';
import { fmtSigned, signedClass } from '../lib/format';
import { usePrivacyMask } from '../lib/privacy';
import { downloadReviewCard, downloadReviewCardPdf } from '../lib/reviewCard';
import type { ReviewCardData } from '../lib/reviewCard';
import {
  WEEKDAYS,
  compactMoney,
  currentMonth,
  dayTone,
  fmtPct,
  fmtR,
  fmtReviewTime,
  monthLabel,
  shiftMonth,
  shortDay,
} from '../lib/review';
import { useApp } from '../store/useApp';
import type {
  DiaryCalendar,
  DiaryDay,
  DiaryDayDetail,
  DiaryRecord,
  DayNote,
  NoteTemplate,
} from '../gateway/types';

const MOODS = [
  { value: 1, label: '很差' },
  { value: 2, label: '差' },
  { value: 3, label: '一般' },
  { value: 4, label: '好' },
  { value: 5, label: '很好' },
];

interface NoteDraft {
  date: string;
  note: string;
  mood: number | null;
  tags: string[];
}

/** 盈亏日历：按月看每天的净盈亏，点开某天写笔记、逐笔复盘、导出卡片 */
export function DiaryView() {
  const notify = useApp((s) => s.notify);
  const activeLogin = useApp((s) => s.account?.login ?? 0);
  const serverOffset = useApp((s) => s.health?.serverOffset ?? 0);
  const masked = usePrivacyMask();

  const [month, setMonth] = useState(currentMonth);
  const [selected, setSelected] = useState<string | null>(null);
  const [calendar, setCalendar] = useState<DiaryCalendar | null>(null);
  const [detail, setDetail] = useState<DiaryDayDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [dayLoading, setDayLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 日笔记本地草稿：输入后延迟保存，切换日期前先冲刷
  const [noteText, setNoteText] = useState('');
  const [mood, setMood] = useState<number | null>(null);
  const [tagsText, setTagsText] = useState('');
  const pending = useRef<NoteDraft | null>(null);
  const timer = useRef<number | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [reviewing, setReviewing] = useState<number | null>(null);
  const replay = useTradeReplay();

  const flushNote = useCallback(() => {
    if (timer.current != null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    const draft = pending.current;
    pending.current = null;
    if (!draft) return;
    gateway
      .call<{ note: DayNote }>('diary.note.save', {
        date: draft.date,
        note: draft.note,
        mood: draft.mood,
        tags: draft.tags,
      })
      .then(() => setSavedAt(Date.now()))
      .catch((err) => notify('error', (err as Error).message));
  }, [notify]);

  const queueNote = (patch: Partial<Omit<NoteDraft, 'date'>>) => {
    if (!selected) return;
    const next: NoteDraft = {
      date: selected,
      note: patch.note ?? noteText,
      mood: patch.mood === undefined ? mood : patch.mood,
      tags: patch.tags ?? splitTags(tagsText),
    };
    if (patch.note !== undefined) setNoteText(patch.note);
    if (patch.mood !== undefined) setMood(patch.mood);
    if (patch.tags !== undefined) setTagsText(patch.tags.join('、'));
    pending.current = next;
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flushNote, 700);
  };

  const loadCalendar = useCallback(async (targetMonth: string) => {
    setLoading(true);
    try {
      const next = await gateway.call<DiaryCalendar>('diary.calendar', {
        month: targetMonth,
      });
      setCalendar(next);
      setError(null);
      setSelected((prev) => {
        if (prev && prev.startsWith(next.month)) return prev;
        return next.today.startsWith(next.month) ? next.today : `${next.month}-01`;
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    flushNote();
    void loadCalendar(month);
    // 账户切换时回到本月；flushNote 只用于切换前保存
  }, [month, activeLogin, loadCalendar]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selected) return;
    let alive = true;
    setDayLoading(true);
    gateway
      .call<DiaryDayDetail>('diary.day', { date: selected })
      .then((next) => {
        if (!alive) return;
        setDetail(next);
        setNoteText(next.note.note ?? '');
        setMood(next.note.mood ?? null);
        setTagsText((next.note.tags ?? []).join('、'));
        setSavedAt(null);
      })
      .catch((err) => {
        if (alive) setError((err as Error).message);
      })
      .finally(() => {
        if (alive) setDayLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [selected, activeLogin]);

  // 离开页面时把没来得及保存的笔记写掉
  useEffect(() => () => flushNote(), [flushNote]);

  const summary = calendar?.summary;
  const best = useMemo(
    () =>
      detail?.records.reduce<DiaryRecord | null>(
        (top, row) => (!top || row.profit > top.profit ? row : top),
        null,
      ) ?? null,
    [detail],
  );
  const worst = useMemo(
    () =>
      detail?.records.reduce<DiaryRecord | null>(
        (low, row) => (!low || row.profit < low.profit ? row : low),
        null,
      ) ?? null,
    [detail],
  );

  const saveAsTemplate = async () => {
    if (!noteText.trim()) {
      notify('info', '先写点内容，再存成模板');
      return;
    }
    const name = window.prompt('模板名称', '盘后复盘')?.trim();
    if (!name) return;
    try {
      const response = await gateway.call<{ template: NoteTemplate }>('diary.template.save', {
        name,
        body: noteText,
      });
      setDetail((prev) =>
        prev ? { ...prev, templates: [...prev.templates, response.template] } : prev,
      );
      notify('success', '模板已保存');
    } catch (err) {
      notify('error', (err as Error).message);
    }
  };

  const cardPayload = (): ReviewCardData | null => {
    if (!detail) return null;
    const annotation = detail.records.find((row) => row.annotation)?.annotation;
    const followed = detail.records.reduce((sum, row) => sum + (row.annotation?.followed ?? 0), 0);
    const broken = detail.records.reduce((sum, row) => sum + (row.annotation?.broken ?? 0), 0);
    return {
      date: detail.date,
      net: detail.summary.net,
      trades: detail.summary.trades,
      wins: detail.summary.wins,
      losses: detail.summary.losses,
      winRate: detail.summary.winRate,
      totalR: detail.summary.totalR,
      rTrades: detail.summary.rTrades,
      best: best?.profit ?? null,
      worst: worst?.profit ?? null,
      bookName: annotation?.playbookName ?? null,
      followed,
      broken,
      note: noteText,
    };
  };

  const exportCard = (format: 'png' | 'pdf') => {
    const payload = cardPayload();
    if (!payload) return;
    if (masked) {
      notify('info', '隐私模式开启，先关闭再导出含金额的复盘卡片');
      return;
    }
    if (format === 'pdf') {
      downloadReviewCardPdf(payload);
      notify('success', '复盘卡片 PDF 已导出');
      return;
    }
    downloadReviewCard(payload);
    notify('success', '复盘卡片已导出');
  };

  return (
    <div className="console-scope h-full min-h-0 overflow-auto bg-console-canvas">
      <div className="mx-auto w-full max-w-[1240px] px-8 py-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-medium tracking-[-0.01em]">盈亏日历</h1>
            <p className="mt-1.5 text-[13px] text-console-muted">
              按交易日归集净盈亏
              {activeLogin ? ` · 账户 ${activeLogin}` : ''}
              {calendar ? ` · UTC${offsetLabel(calendar.timezoneOffsetMin)}` : ''} · 点格子看当天明细
            </p>
          </div>
          <div className="flex items-center gap-2">
            {masked && (
              <span className="console-chip border-console-warn/40 text-console-warn">
                隐私模式 · 金额已遮
              </span>
            )}
            <div className="flex items-center gap-1">
              <button
                onClick={() => setMonth(shiftMonth(month, -1))}
                className="console-chip px-2"
                aria-label="上个月"
              >
                <ChevronLeft size={14} strokeWidth={1.8} />
              </button>
              <span className="min-w-[110px] text-center text-[13px] font-medium">
                {monthLabel(month)}
              </span>
              <button
                onClick={() => setMonth(shiftMonth(month, 1))}
                className="console-chip px-2"
                aria-label="下个月"
              >
                <ChevronRight size={14} strokeWidth={1.8} />
              </button>
              <button onClick={() => setMonth(currentMonth())} className="console-chip">
                本月
              </button>
            </div>
            <button
              onClick={() => void loadCalendar(month)}
              disabled={loading}
              className="console-btn console-btn-secondary"
            >
              <RefreshCw size={14} strokeWidth={1.5} className={clsx(loading && 'animate-spin')} />
              {loading ? '读取中…' : '刷新'}
            </button>
          </div>
        </header>

        {error && (
          <div className="mt-4 rounded-lg border border-console-loss/30 bg-console-loss-soft px-3 py-2 text-[12px] text-console-loss">
            读取失败：{error}
          </div>
        )}

        <div className="readout mt-6 grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
          <Stat
            label="本月净盈亏"
            value={summary ? fmtSigned(summary.net) : '—'}
            tone={summary ? signedClass(summary.net) : undefined}
          />
          <Stat
            label="交易笔数"
            value={summary ? String(summary.trades) : '—'}
            hint={summary ? `${summary.wins} 胜 / ${summary.losses} 负` : undefined}
          />
          <Stat
            label="本月胜率"
            value={summary ? fmtPct(summary.winRate) : '—'}
            hint={summary ? `日胜率 ${fmtPct(summary.dayWinRate)}` : undefined}
          />
          <Stat
            label="累计 R"
            value={
              summary && summary.rTrades > 0
                ? `${summary.totalR >= 0 ? '+' : ''}${summary.totalR.toFixed(2)}R`
                : '—'
            }
            tone={summary && summary.totalR > 0 ? 'text-console-gain' : undefined}
            hint={summary ? `${summary.rTrades} 笔带风险` : undefined}
          />
          <Stat
            label="交易日"
            value={summary ? `${summary.tradingDays} 天` : '—'}
            hint={summary ? `盈利 ${summary.winDays} · 亏损 ${summary.lossDays}` : undefined}
          />
          <Stat
            label="最好 / 最差"
            value={summary?.bestDay ? fmtSigned(summary.bestDay.net) : '—'}
            tone={summary?.bestDay ? signedClass(summary.bestDay.net) : undefined}
            hint={summary?.worstDay ? `最差 ${fmtSigned(summary.worstDay.net)}` : undefined}
          />
        </div>

        <section className="console-card mt-4 overflow-hidden">
          <div className="grid grid-cols-[repeat(7,minmax(0,1fr))_76px] border-b border-console-line bg-console-sidebar/60">
            {WEEKDAYS.map((label) => (
              <div key={label} className="px-2 py-2 text-center text-[11px] text-console-muted">
                周{label}
              </div>
            ))}
            <div className="hidden px-2 py-2 text-center text-[11px] text-console-muted sm:block">
              周合计
            </div>
          </div>
          {calendar?.weeks.map((week, index) => (
            <div
              key={`${week.days[0]?.date ?? index}-${index}`}
              className="grid grid-cols-[repeat(7,minmax(0,1fr))_76px] border-b border-console-line/60 last:border-b-0"
            >
              {week.days.map((day, dayIndex) => (
                <DayCell
                  key={day?.date ?? `blank-${dayIndex}`}
                  day={day}
                  today={calendar.today}
                  selected={selected}
                  onSelect={(date) => {
                    flushNote();
                    setSelected(date);
                  }}
                />
              ))}
              <div
                className={clsx(
                  'hidden items-center justify-end px-2 py-2 font-mono text-[11px] sm:flex',
                  signedClass(week.total),
                )}
              >
                {week.total === 0 ? '—' : fmtSigned(week.total)}
              </div>
            </div>
          ))}
          {!calendar && (
            <div className="px-4 py-16 text-center text-[12px] text-console-faint">
              {loading ? '读取中…' : '还没有数据'}
            </div>
          )}
        </section>

        <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_390px]">
          <section className="console-card min-w-0 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-console-line px-4 py-3">
              <div>
                <div className="text-[14px] font-medium">
                  {selected ? shortDay(selected) : '选择一天'}
                  {detail && detail.summary.trades > 0 && (
                    <span
                      className={clsx('num ml-2 font-mono text-[13px]', signedClass(detail.summary.net))}
                    >
                      {fmtSigned(detail.summary.net)}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-[11px] text-console-muted">
                  {detail && detail.summary.trades > 0
                    ? `${detail.summary.trades} 笔 · 胜率 ${fmtPct(detail.summary.winRate)} · 累计 R ${
                        detail.summary.rTrades > 0 ? detail.summary.totalR.toFixed(2) : '—'
                      } · 平均持仓 ${fmtDuration(detail.summary.avgDurationSec)}`
                    : dayLoading
                      ? '读取中…'
                      : '这天没有已平仓交易'}
                </div>
              </div>
              <button
                onClick={() => exportCard('png')}
                disabled={!detail}
                className="console-btn console-btn-secondary"
                title="把当天复盘导出为 PNG"
              >
                <ImageDown size={14} strokeWidth={1.5} />
                复盘卡片
              </button>
              <button
                onClick={() => exportCard('pdf')}
                disabled={!detail}
                className="console-btn console-btn-secondary"
                title="把当天复盘导出为单页 PDF（中文已栅格化）"
              >
                <FileDown size={14} strokeWidth={1.5} />
                PDF
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] border-collapse text-[12px]">
                <thead>
                  <tr className="border-b border-console-line text-left text-[11px] text-console-faint">
                    <th className="px-4 py-2 font-normal">平仓</th>
                    <th className="px-2 py-2 font-normal">品种 / 方向</th>
                    <th className="px-3 py-2 text-right font-normal">盈亏</th>
                    <th className="px-3 py-2 text-right font-normal">R</th>
                    <th className="px-3 py-2 font-normal">复盘</th>
                    <th className="px-4 py-2 font-normal" />
                  </tr>
                </thead>
                <tbody>
                  {(detail?.records.length ?? 0) === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-12 text-center text-[12px] text-console-faint">
                        {dayLoading ? '读取中…' : '这天没有已平仓交易，也可以在右侧写当天笔记'}
                      </td>
                    </tr>
                  )}
                  {detail?.records.map((record) => (
                    <tr
                      key={record.position_id}
                      className="border-t border-console-line/70 transition-colors hover:bg-console-hover/50"
                    >
                      <td className="num whitespace-nowrap px-4 py-2.5 font-mono text-[11px] text-console-muted">
                        {fmtReviewTime(record.close_time, serverOffset)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2.5">
                        <span className="font-medium">{record.symbol}</span>
                        <span
                          className={clsx(
                            'ml-1.5 text-[11px]',
                            record.side === 'buy' ? 'text-console-gain' : 'text-console-loss',
                          )}
                        >
                          {record.side === 'buy' ? '多' : '空'}
                        </span>
                      </td>
                      <td
                        className={clsx(
                          'num px-3 py-2.5 text-right font-mono font-medium',
                          signedClass(record.profit),
                        )}
                      >
                        {fmtSigned(record.profit)}
                      </td>
                      <td
                        className={clsx(
                          'num px-3 py-2.5 text-right font-mono text-[11px]',
                          signedClass(record.r),
                        )}
                      >
                        {fmtR(record.r)}
                      </td>
                      <td className="px-3 py-2.5">
                        {record.annotation ? (
                          <span className="flex items-center gap-1.5 text-[11px] text-console-muted">
                            <span className="truncate font-medium text-console-ink-2">
                              {record.annotation.playbookName ?? '未关联策略'}
                            </span>
                            {record.annotation.rules.length > 0 && (
                              <span className="num font-mono text-console-faint">
                                ✓{record.annotation.followed} ✗{record.annotation.broken}
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="text-[11px] text-console-faint">未复盘</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => setReviewing(record.position_id)}
                            className="console-chip"
                          >
                            复盘
                          </button>
                          <button
                            onClick={() => replay.start(record)}
                            className="console-chip"
                            title="从当时行情回放这笔交易"
                          >
                            回放
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {selected && <AiReviewPanel date={selected} />}

          <section className="console-card flex min-h-[320px] flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b border-console-line px-4 py-3">
              <div className="flex items-center gap-2 text-[13px] font-medium">
                <NotebookPen size={15} strokeWidth={1.5} className="text-console-muted" />
                当天笔记
              </div>
              <span className="text-[11px] text-console-faint">
                {savedAt ? '已保存' : noteText || mood ? '自动保存' : ' '}
              </span>
            </div>

            <div className="space-y-3 p-4">
              <div className="flex items-center gap-1">
                {MOODS.map((item) => (
                  <button
                    key={item.value}
                    onClick={() => queueNote({ mood: mood === item.value ? null : item.value })}
                    className={clsx(
                      'h-7 flex-1 rounded-md border text-[11px] transition-colors',
                      mood === item.value
                        ? 'border-console-ink bg-console-selected font-medium text-console-ink'
                        : 'border-console-line text-console-muted hover:bg-console-hover',
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <input
                value={tagsText}
                onChange={(event) => queueNote({ tags: splitTags(event.target.value) })}
                placeholder="标签：耐心、按计划、情绪化…"
                className="console-input w-full"
                maxLength={120}
              />

              <textarea
                value={noteText}
                onChange={(event) => queueNote({ note: event.target.value })}
                placeholder="盘前计划 / 盘中发生了什么 / 收盘复盘"
                rows={9}
                maxLength={20000}
                className="console-input w-full resize-y py-2 leading-relaxed"
              />

              <div className="flex items-center justify-between gap-2">
                <select
                  defaultValue=""
                  onChange={(event) => {
                    const template = detail?.templates.find(
                      (item) => String(item.id) === event.target.value,
                    );
                    if (template) {
                      queueNote({
                        note: noteText ? `${noteText}\n\n${template.body}` : template.body,
                      });
                    }
                    event.target.value = '';
                  }}
                  className="console-input h-8 flex-1 text-[12px]"
                >
                  <option value="">插入模板…</option>
                  {detail?.templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </select>
                <button onClick={flushNote} className="console-chip">
                  立即保存
                </button>
                <button onClick={() => void saveAsTemplate()} className="console-chip">
                  存为模板
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>

      <TradeReviewDrawer
        positionId={reviewing}
        onClose={() => setReviewing(null)}
        onChanged={() => {
          if (selected) {
            gateway
              .call<DiaryDayDetail>('diary.day', { date: selected })
              .then(setDetail)
              .catch(() => {});
          }
          void loadCalendar(month);
        }}
      />

      <ReferenceCapacityDialog
        pending={replay.pending}
        onConfirm={() => replay.confirm()}
        onCancel={replay.cancel}
      />
    </div>
  );
}

function DayCell({
  day,
  today,
  selected,
  onSelect,
}: {
  day: DiaryDay | null;
  today: string;
  selected: string | null;
  onSelect: (date: string) => void;
}) {
  if (!day) {
    return <div className="min-h-[84px] border-r border-console-line/40 last:border-r-0" />;
  }
  const tone = dayTone(day.net);
  const isToday = day.date === today;
  const isSelected = day.date === selected;
  return (
    <button
      onClick={() => onSelect(day.date)}
      className={clsx(
        'relative flex min-h-[84px] flex-col items-start gap-1 border-r border-console-line/40 px-2 py-1.5 text-left transition-colors last:border-r-0 hover:bg-console-hover/60',
        tone === 'win' && 'bg-console-gain-soft/50',
        tone === 'loss' && 'bg-console-loss-soft/50',
        isSelected && 'ring-1 ring-inset ring-console-ink/60',
      )}
    >
      <span className="flex w-full items-center justify-between">
        <span
          className={clsx(
            'num font-mono text-[11px]',
            isToday ? 'rounded bg-console-ink px-1 text-console-card' : 'text-console-muted',
          )}
        >
          {Number(day.date.slice(8))}
        </span>
        {day.trades > 0 && (
          <span className="num font-mono text-[10px] text-console-faint">{day.trades} 笔</span>
        )}
      </span>
      {day.trades > 0 && (
        <>
          <span
            className={clsx(
              'num font-mono text-[13px] font-medium leading-none',
              tone === 'win'
                ? 'text-console-gain'
                : tone === 'loss'
                  ? 'text-console-loss'
                  : 'text-console-muted',
            )}
          >
            {compactMoney(day.net)}
          </span>
          {day.rTrades > 0 && (
            <span className="num font-mono text-[10px] text-console-faint">{fmtR(day.r)}</span>
          )}
        </>
      )}
    </button>
  );
}

function Stat({
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
      <div className="text-[12px] text-console-muted">{label}</div>
      <div
        className={clsx(
          'num mt-1.5 font-mono text-[20px] font-medium leading-none tracking-[-0.01em]',
          tone,
        )}
      >
        {value}
      </div>
      <div className="mt-2 truncate text-[11px] text-console-faint">{hint ?? ' '}</div>
    </div>
  );
}

function splitTags(text: string): string[] {
  return text
    .split(/[、,，;；\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  if (sec < 3600) return `${Math.round(sec / 60)} 分`;
  return `${Math.floor(sec / 3600)} 时 ${Math.round((sec % 3600) / 60)} 分`;
}

/** 480 → "+08:00" */
function offsetLabel(minutes: number): string {
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}
