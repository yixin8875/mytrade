import { useEffect, useState, type ReactNode } from 'react';
import {
  ArrowUpRight,
  BarChart3,
  BookOpen,
  ChartCandlestick,
  Gauge,
  Layers,
  ListChecks,
  PlayCircle,
  Settings as SettingsIcon,
  ShieldCheck,
} from 'lucide-react';
import { clsx } from 'clsx';
import { gateway } from '../gateway/client';
import { goReplaySession } from '../replay/route';
import { useReplay } from '../replay/store';
import { useApp, type Page } from '../store/useApp';
import { fmtMoney, fmtSigned, fmtVolume, signedClass } from '../lib/format';
import { usePrivacyMask } from '../lib/privacy';
import { scoreTone, scoreWords } from '../lib/score';
import { fmtLocalTime, rowOffset, serverDayStart } from '../lib/time';
import type {
  DisciplineMode,
  JournalRecord,
  JournalStats,
  ProcessScore,
  Playbook,
  RoutineDay,
  RoutinePhase,
} from '../gateway/types';

const QUICK_LINKS: {
  page: Page;
  title: string;
  hint: string;
  icon: typeof ChartCandlestick;
}[] = [
  { page: 'trade', title: '交易台', hint: '图表、画线下单与持仓管理', icon: ChartCandlestick },
  { page: 'journal', title: '交易日志', hint: '已平仓记录、策略标签与截图', icon: BookOpen },
  { page: 'reports', title: '统计报表', hint: '胜率、盈亏比与执行质量', icon: BarChart3 },
  { page: 'settings', title: '设置', hint: '外观、风控、告警与更新', icon: SettingsIcon },
];

/** 中心服务台首页：账户、今日风控、最近交易与快捷入口 */
export function Overview({ onNavigate }: { onNavigate: (page: Page) => void }) {
  const conn = useApp((s) => s.conn);
  usePrivacyMask();
  const account = useApp((s) => s.account);
  const risk = useApp((s) => s.riskStatus);
  const positions = useApp((s) => s.positions);
  const orders = useApp((s) => s.orders);
  const health = useApp((s) => s.health);
  const activeLogin = useApp((s) => s.account?.login ?? 0);

  const [stats, setStats] = useState<JournalStats | null>(null);
  const [recent, setRecent] = useState<JournalRecord[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (conn !== 'open') return;
    let alive = true;
    setLoading(true);
    Promise.all([
      gateway.call<JournalStats>('journal.stats', { days: 30 }),
      gateway.call<JournalRecord[]>('journal.list', { days: 30, limit: 6 }),
    ])
      .then(([nextStats, nextRecent]) => {
        if (!alive) return;
        setStats(nextStats);
        setRecent(nextRecent);
      })
      .catch(() => {
        /* 日志还没准备好时，账户信息照常显示 */
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [conn, activeLogin]);

  const floating = positions.reduce(
    (sum, item) => sum + item.profit + (item.swap ?? 0) + (item.commission ?? 0),
    0,
  );
  const today = risk?.dayPnl ?? 0;
  const lossLimit = risk?.dailyLossLimit ?? 0;
  const lossUsed = lossLimit > 0 ? Math.min(1, Math.max(0, (risk?.dailyLoss ?? 0) / lossLimit)) : 0;
  const dateText = new Date().toLocaleDateString('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });

  return (
    <div className="console-scope h-full min-h-0 overflow-auto bg-console-canvas">
      <div className="mx-auto w-full max-w-[1240px] px-8 py-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-medium tracking-[-0.01em]">概览</h1>
            <p className="mt-1.5 text-[13px] text-console-muted">
              {dateText} · {health?.terminal?.name ?? 'MT5 未连接'}
              {account?.currency ? ` · ${account.currency}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button className="console-btn console-btn-secondary" onClick={() => onNavigate('journal')}>
              交易日志
            </button>
            <button className="console-btn console-btn-primary" onClick={() => onNavigate('trade')}>
              打开交易台
            </button>
          </div>
        </header>

        <div className="readout mt-6 grid-cols-2 lg:grid-cols-4">
          <Metric label="余额" value={fmtMoney(account?.balance)} hint={account?.currency ?? '账户货币'} />
          <Metric label="净值" value={fmtMoney(account?.equity)} hint={`已用保证金 ${fmtMoney(account?.margin)}`} />
          <Metric
            label="今日盈亏"
            value={fmtSigned(today)}
            tone={today > 0 ? 'gain' : today < 0 ? 'loss' : 'flat'}
            hint={stats ? `含浮动 · 近 30 天 ${fmtSigned(stats.summary.netPnl)}` : '含浮动'}
          />
          <Metric
            label="浮动盈亏"
            value={fmtSigned(floating)}
            tone={floating > 0 ? 'gain' : floating < 0 ? 'loss' : 'flat'}
            hint={`${positions.length} 个持仓 · ${orders.length} 个挂单`}
          />
        </div>

        {conn === 'open' && <TodayBoard onNavigate={onNavigate} />}

        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(300px,1fr)]">
          <section className="console-card overflow-hidden">
            <div className="flex items-center justify-between border-b border-console-line px-5 py-4">
              <div>
                <div className="text-[13px] font-semibold">最近交易</div>
                <div className="mt-1 text-[12px] text-console-muted">近 30 天已平仓记录</div>
              </div>
              <button
                onClick={() => onNavigate('journal')}
                className="flex items-center gap-1 text-[12px] text-console-muted transition-colors hover:text-console-ink"
              >
                全部日志
                <ArrowUpRight size={14} strokeWidth={1.5} />
              </button>
            </div>

            {recent.length === 0 ? (
              <div className="px-5 py-12 text-center text-[12px] text-console-faint">
                {loading ? '读取中…' : '还没有已平仓交易，去交易台开始第一笔'}
              </div>
            ) : (
              <table className="w-full border-collapse text-[12px]">
                <thead>
                  <tr className="text-left text-[11px] text-console-faint">
                    <th className="px-5 py-2 font-normal">平仓时间</th>
                    <th className="px-2 py-2 font-normal">品种</th>
                    <th className="px-2 py-2 font-normal">方向</th>
                    <th className="px-2 py-2 text-right font-normal">手数</th>
                    <th className="px-5 py-2 text-right font-normal">盈亏</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((record) => (
                    <tr key={record.position_id} className="border-t border-console-line/70">
                      <td
                        className="num whitespace-nowrap px-5 py-2.5 font-mono text-[11px] text-console-muted"
                        title="本机时区"
                      >
                        {fmtLocalTime(record.close_time, rowOffset(record, health?.serverOffset ?? 0))}
                      </td>
                      <td className="px-2 py-2.5 font-medium">{record.symbol}</td>
                      <td className="px-2 py-2.5">
                        <span
                          className={clsx(
                            'inline-flex items-center gap-1.5 text-[11px]',
                            record.side === 'buy' ? 'text-console-gain' : 'text-console-loss',
                          )}
                        >
                          <span
                            className={clsx(
                              'h-1.5 w-1.5 rounded-full',
                              record.side === 'buy' ? 'bg-console-gain' : 'bg-console-loss',
                            )}
                          />
                          {record.side === 'buy' ? '多' : '空'}
                        </span>
                      </td>
                      <td className="num px-2 py-2.5 text-right font-mono text-[11px] text-console-muted">
                        {fmtVolume(record.volume)}
                      </td>
                      <td className={clsx('num px-5 py-2.5 text-right font-mono font-medium', signedClass(record.profit))}>
                        {fmtSigned(record.profit)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className="flex items-center justify-between border-t border-console-line bg-console-card/60 px-5 py-3 text-[12px] text-console-muted">
              <span>
                {stats
                  ? `近 30 天 ${stats.summary.trades} 笔 · 胜率 ${
                      stats.summary.winRate != null ? `${stats.summary.winRate.toFixed(1)}%` : '—'
                    }`
                  : '加载统计中…'}
              </span>
              <span className={clsx('num font-mono', stats ? signedClass(stats.summary.netPnl) : '')}>
                {stats ? fmtSigned(stats.summary.netPnl) : ''}
              </span>
            </div>
          </section>

          <div className="space-y-4">
            <section className="console-card p-5">
              <div className="flex items-center gap-2">
                <ShieldCheck size={16} strokeWidth={1.5} className="text-console-muted" />
                <span className="text-[13px] font-semibold">今日风控</span>
                <span className="flex-1" />
                <span
                  className={clsx(
                    'inline-flex items-center gap-1.5 text-[11px]',
                    risk?.halted
                      ? 'text-console-loss'
                      : risk?.canTrade === false
                        ? 'text-console-warn'
                        : 'text-console-gain',
                  )}
                >
                  <span
                    className={clsx(
                      'h-1.5 w-1.5 rounded-full',
                      risk?.halted
                        ? 'bg-console-loss'
                        : risk?.canTrade === false
                          ? 'bg-console-warn'
                          : 'bg-console-gain',
                    )}
                  />
                  {risk?.halted ? '已停机' : risk?.canTrade === false ? '暂不可开仓' : '正常'}
                </span>
              </div>

              <div className="mt-5">
                <div className="flex items-baseline justify-between text-[12px] text-console-muted">
                  <span>当日亏损</span>
                  <span className="num font-mono text-console-ink-2">
                    {fmtMoney(risk?.dailyLoss ?? 0)}
                    {lossLimit > 0 ? ` / ${fmtMoney(lossLimit)}` : ' · 未设上限'}
                  </span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-console-hover">
                  <div
                    className={clsx(
                      'h-full origin-left rounded-full',
                      lossUsed >= 1 ? 'bg-console-loss' : lossUsed >= 0.6 ? 'bg-console-warn' : 'bg-console-gain',
                    )}
                    style={{ transform: `scaleX(${Math.max(lossUsed, risk?.dailyLoss ? 0.03 : 0)})` }}
                  />
                </div>
                {lossLimit > 0 && (
                  <div className="mt-1.5 text-right text-[11px] text-console-faint">
                    剩余 {fmtMoney(risk?.remaining ?? 0)}
                  </div>
                )}
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3">
                <MiniStat
                  label="今日开仓"
                  value={`${risk?.tradesToday ?? 0}${risk?.maxTrades ? ` / ${risk.maxTrades}` : ''}`}
                />
                <MiniStat
                  label="连续亏损"
                  value={`${risk?.consecutiveLosses ?? 0}${
                    risk?.maxConsecutiveLosses ? ` / ${risk.maxConsecutiveLosses}` : ''
                  }`}
                />
              </div>

              {risk?.blockReason && !risk.halted && (
                <div className="mt-3 rounded-lg bg-console-warn-soft px-3 py-2 text-[12px] text-console-warn">
                  {risk.blockReason}
                </div>
              )}

              <button
                onClick={() => onNavigate('settings')}
                className="mt-4 flex items-center gap-1 text-[12px] text-console-muted transition-colors hover:text-console-ink"
              >
                调整风控上限
                <ArrowUpRight size={13} strokeWidth={1.5} />
              </button>
            </section>

            <section className="console-card p-5">
              <div className="flex items-center gap-2">
                <Layers size={16} strokeWidth={1.5} className="text-console-muted" />
                <span className="text-[13px] font-semibold">当前持仓</span>
                <span className="flex-1" />
                <span className="num font-mono text-[11px] text-console-faint">{positions.length}</span>
              </div>

              {positions.length === 0 ? (
                <div className="py-7 text-center text-[12px] text-console-faint">暂无持仓</div>
              ) : (
                <div className="mt-3 divide-y divide-console-line/70">
                  {positions.slice(0, 4).map((position) => (
                    <div key={position.ticket} className="flex items-center gap-2 py-2.5">
                      <span className="w-16 shrink-0 text-[12px] font-medium">{position.symbol}</span>
                      <span
                        className={clsx(
                          'inline-flex items-center gap-1 text-[11px]',
                          position.side === 'buy' ? 'text-console-gain' : 'text-console-loss',
                        )}
                      >
                        <span
                          className={clsx(
                            'h-1.5 w-1.5 rounded-full',
                            position.side === 'buy' ? 'bg-console-gain' : 'bg-console-loss',
                          )}
                        />
                        {position.side === 'buy' ? '多' : '空'}
                      </span>
                      <span className="num font-mono text-[11px] text-console-muted">
                        {fmtVolume(position.volume)}
                      </span>
                      <span className="flex-1" />
                      <span className={clsx('num font-mono text-[12px] font-medium', signedClass(position.profit))}>
                        {fmtSigned(position.profit)}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <button
                onClick={() => onNavigate('trade')}
                className="mt-2 flex items-center gap-1 text-[12px] text-console-muted transition-colors hover:text-console-ink"
              >
                打开交易台
                <ArrowUpRight size={13} strokeWidth={1.5} />
              </button>
            </section>

            <ScoreCard onNavigate={onNavigate} />
          </div>
        </div>

        <section className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {QUICK_LINKS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.page}
                onClick={() => onNavigate(item.page)}
                className="console-card group flex items-start gap-3 p-4 text-left transition-colors hover:bg-console-hover/60"
              >
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-console-hover text-console-muted group-hover:text-console-ink">
                  <Icon size={16} strokeWidth={1.5} />
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-1 text-[13px] font-medium">
                    {item.title}
                    <ArrowUpRight
                      size={12}
                      strokeWidth={1.5}
                      className="text-console-faint transition-colors group-hover:text-console-ink"
                    />
                  </span>
                  <span className="mt-1 block text-[12px] leading-relaxed text-console-muted">
                    {item.hint}
                  </span>
                </span>
              </button>
            );
          })}
        </section>
      </div>
    </div>
  );
}

const PHASES: { key: RoutinePhase; label: string }[] = [
  { key: 'pre', label: '盘前' },
  { key: 'during', label: '盘中' },
  { key: 'post', label: '盘后' },
];

const MODE_TEXT: Record<DisciplineMode, string> = {
  off: '未开启',
  confirm: '下单前确认清单',
  block: '不勾清单不能下单',
};

/** 今天的四个起点：例行、开仓门禁、今日交易、回放；每块都给出可执行的下一步 */
function TodayBoard({ onNavigate }: { onNavigate: (page: Page) => void }) {
  const notify = useApp((s) => s.notify);
  const health = useApp((s) => s.health);
  const config = useApp((s) => s.health?.config);
  const activeLogin = useApp((s) => s.account?.login ?? 0);
  const openSettings = useApp((s) => s.openSettings);
  const setJournalFilter = useApp((s) => s.setJournalFilter);
  const setJournalDays = useApp((s) => s.setJournalDays);
  const sessions = useReplay((s) => s.sessions);
  const risk = useApp((s) => s.riskStatus);
  const serverOffset = useApp((s) => s.health?.serverOffset ?? 0);

  const [routine, setRoutine] = useState<RoutineDay | null>(null);
  const [today, setToday] = useState<{ trades: number; unreviewed: number } | null>(null);
  const [books, setBooks] = useState<Playbook[]>([]);
  const [seeding, setSeeding] = useState(false);

  const globalMode: DisciplineMode = config?.discipline_mode ?? 'off';
  const activeAccount = health?.accounts?.find((item) => item.id === health.activeAccountId);
  const override = activeAccount?.discipline ?? {};
  const mode: DisciplineMode = override.mode ?? globalMode;
  const playbookId = override.playbook || config?.discipline_playbook || '';

  useEffect(() => {
    let alive = true;
    gateway
      .call<RoutineDay>('routine.day', {})
      .then((next) => {
        if (alive) setRoutine(next);
      })
      .catch(() => {
        /* 例行还没准备好时留空态 */
      });
    // 「今天」与顶部今日盈亏同口径：按券商服务器日切分，不用滚动的 24 小时
    const dayStart = serverDayStart(serverOffset);
    Promise.all([
      gateway.call<JournalStats>('journal.stats', { days: 1, since: dayStart }),
      gateway.call<JournalRecord[]>('journal.list', {
        days: 1,
        since: dayStart,
        limit: 300,
        filters: { reviewed: 0 },
      }),
    ])
      .then(([stats, unreviewed]) => {
        if (!alive) return;
        setToday({
          trades: stats.summary.trades,
          unreviewed: unreviewed.length,
        });
      })
      .catch(() => {
        /* 日志未同步时今日交易停在空态 */
      });
    return () => {
      alive = false;
    };
  }, [activeLogin, serverOffset]);

  useEffect(() => {
    if (mode === 'off' && !playbookId) {
      setBooks([]);
      return;
    }
    let alive = true;
    gateway
      .call<{ playbooks: Playbook[] }>('strategy.list', {})
      .then((res) => {
        if (alive) setBooks(res.playbooks ?? []);
      })
      .catch(() => {
        /* 清单名解析不出来时退回显示 id */
      });
    return () => {
      alive = false;
    };
  }, [mode, playbookId, activeLogin]);

  const seed = async () => {
    setSeeding(true);
    try {
      await gateway.call('routine.seed', {});
      const next = await gateway.call<RoutineDay>('routine.day', {});
      setRoutine(next);
      notify('success', '已生成默认例行清单');
    } catch (err) {
      notify('error', (err as Error).message);
    } finally {
      setSeeding(false);
    }
  };

  const total = routine?.summary.total ?? 0;
  const done = routine?.summary.done ?? 0;
  const playbookName = books.find((book) => book.id === playbookId)?.name ?? null;
  const resumable = [...sessions]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .find((item) => !['finished', 'archived', 'error'].includes(item.status));
  const unreviewed = today?.unreviewed ?? 0;
  const todayPnl = risk?.dayPnl ?? 0;

  const openJournal = () => {
    setJournalFilter(unreviewed > 0 ? { reviewed: 0 } : {});
    setJournalDays(1);
    onNavigate('journal');
  };

  const openReplay = () => {
    if (resumable) goReplaySession(resumable.id);
    onNavigate('replay');
  };

  return (
    <section className="mt-4">
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] font-semibold">今天</span>
        <button
          onClick={() => onNavigate('diary')}
          className="flex items-center gap-1 text-[12px] text-console-muted transition-colors hover:text-console-ink"
        >
          写今日笔记
          <ArrowUpRight size={13} strokeWidth={1.5} />
        </button>
      </div>

      <div className="mt-2 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <TodayCard
          icon={ListChecks}
          title="今天例行"
          aside={total > 0 ? `${done} / ${total}` : '未建立'}
          asideTone={total > 0 && done >= total ? 'text-console-gain' : 'text-console-faint'}
        >
          {total === 0 ? (
            <p className="text-[12px] leading-relaxed text-console-muted">
              还没有例行清单。先生成一份盘前 / 盘中 / 盘后的默认清单，之后每天打勾。
            </p>
          ) : (
            <div className="space-y-2">
              {PHASES.map(({ key, label }) => {
                const items = (routine?.phases?.[key] ?? []).filter((item) => item.due);
                const finished = items.filter((item) => item.done).length;
                const ratio = items.length > 0 ? finished / items.length : 0;
                return (
                  <div key={key}>
                    <div className="flex items-baseline justify-between text-[11px] text-console-muted">
                      <span>{label}</span>
                      <span className="num font-mono text-console-faint">
                        {items.length > 0 ? `${finished} / ${items.length}` : '—'}
                      </span>
                    </div>
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-console-hover">
                      <div
                        className={clsx(
                          'h-full rounded-full',
                          items.length > 0 && finished >= items.length
                            ? 'bg-console-gain'
                            : 'bg-console-ink-2/50',
                        )}
                        style={{ width: `${ratio * 100}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {total === 0 ? (
            <TodayAction onClick={() => void seed()} disabled={seeding}>
              {seeding ? '生成中…' : '生成默认清单'}
            </TodayAction>
          ) : (
            <TodayAction onClick={() => onNavigate('routines')}>去例行页打勾</TodayAction>
          )}
        </TodayCard>

        <TodayCard
          icon={ShieldCheck}
          title="开仓门禁"
          aside={mode === 'off' ? '未开启' : '生效中'}
          asideTone={mode === 'off' ? 'text-console-warn' : 'text-console-gain'}
        >
          <p className="text-[12px] leading-relaxed text-console-muted">
            {MODE_TEXT[mode]}
            {override.mode ? '（账户覆盖）' : ''}
          </p>
          <p className="mt-1 truncate text-[11px] text-console-faint" title={playbookId || undefined}>
            {playbookName ?? (playbookId || '还没有默认清单')}
          </p>
          <TodayAction onClick={() => openSettings('discipline')}>
            {mode === 'off' ? '去开启门禁' : '调整门禁设置'}
          </TodayAction>
        </TodayCard>

        <TodayCard
          icon={BookOpen}
          title="今日交易"
          aside={today ? `${today.trades} 笔` : '—'}
          asideTone="text-console-faint"
        >
          {today == null ? (
            <p className="text-[12px] text-console-faint">读取中…</p>
          ) : (
            <div className="space-y-1">
              <div className="flex items-baseline justify-between text-[12px]">
                <span className="text-console-muted">今日盈亏（含浮动）</span>
                <span
                  className={clsx('num font-mono font-medium', signedClass(todayPnl))}
                >
                  {fmtSigned(todayPnl)}
                </span>
              </div>
              <div className="flex items-baseline justify-between text-[12px]">
                <span className="text-console-muted">待复盘</span>
                <span
                  className={clsx(
                    'num font-mono',
                    unreviewed > 0 ? 'text-console-warn' : 'text-console-gain',
                  )}
                >
                  {unreviewed > 0 ? `${unreviewed} 笔` : '都写完了'}
                </span>
              </div>
              {today.trades === 0 && (
                <p className="text-[11px] leading-relaxed text-console-faint">
                  今天还没有已平仓交易。开仓前先过一遍门禁清单。
                </p>
              )}
            </div>
          )}
          <TodayAction onClick={openJournal}>
            {unreviewed > 0 ? '去复盘今天的交易' : '查看今日交易'}
          </TodayAction>
        </TodayCard>

        <TodayCard
          icon={PlayCircle}
          title="继续复盘"
          aside={resumable ? resumable.status === 'paused' ? '已暂停' : '未结束' : '无进行中'}
          asideTone="text-console-faint"
        >
          {resumable ? (
            <>
              <p className="truncate text-[12px] font-medium" title={resumable.name}>
                {resumable.name}
              </p>
              <p className="mt-1 text-[11px] text-console-faint">
                {resumable.symbol} · 更新于 {fmtLocalTime(resumable.updatedAt / 1000, 0)}
              </p>
            </>
          ) : (
            <p className="text-[12px] leading-relaxed text-console-muted">
              没有未结束的回放。挑一笔今天的交易，重演一遍入场与离场。
            </p>
          )}
          <TodayAction onClick={openReplay}>
            {resumable ? '继续这次回放' : '开始一次回放'}
          </TodayAction>
        </TodayCard>
      </div>
    </section>
  );
}

function TodayCard({
  icon: Icon,
  title,
  aside,
  asideTone,
  children,
}: {
  icon: typeof ChartCandlestick;
  title: string;
  aside: string;
  asideTone: string;
  children: ReactNode;
}) {
  return (
    <section className="console-card flex flex-col p-4">
      <div className="flex items-center gap-2">
        <Icon size={15} strokeWidth={1.5} className="text-console-muted" />
        <span className="text-[13px] font-semibold">{title}</span>
        <span className="flex-1" />
        <span className={clsx('num font-mono text-[11px]', asideTone)}>{aside}</span>
      </div>
      <div className="mt-3 flex-1">{children}</div>
    </section>
  );
}

function TodayAction({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="mt-3 flex items-center gap-1 text-[12px] text-console-muted transition-colors hover:text-console-ink disabled:opacity-50"
    >
      {children}
      <ArrowUpRight size={13} strokeWidth={1.5} />
    </button>
  );
}

/** 首页只用一张小卡提示过程评分，分量与公式去「过程评分」页看 */
function ScoreCard({ onNavigate }: { onNavigate: (page: Page) => void }) {
  const conn = useApp((s) => s.conn);
  const activeLogin = useApp((s) => s.account?.login ?? 0);
  const [score, setScore] = useState<ProcessScore | null>(null);

  useEffect(() => {
    if (conn !== 'open') return;
    let alive = true;
    gateway
      .call<ProcessScore>('score.get', { days: 90 })
      .then((next) => {
        if (alive) setScore(next);
      })
      .catch(() => {
        /* 评分算不出来时卡片停在空态，不打扰首页其他信息 */
      });
    return () => {
      alive = false;
    };
  }, [conn, activeLogin]);

  const value = score?.score ?? null;

  return (
    <section className="console-card p-5">
      <div className="flex items-center gap-2">
        <Gauge size={16} strokeWidth={1.5} className="text-console-muted" />
        <span className="text-[13px] font-semibold">过程评分</span>
        <span className="flex-1" />
        {score && <span className="num font-mono text-[10px] text-console-faint">v{score.version}</span>}
      </div>

      <div className="mt-3 flex items-end gap-3">
        <span className={clsx('num font-mono text-[28px] leading-none', scoreTone(value))}>
          {value == null ? '—' : Math.round(value)}
        </span>
        <span className={clsx('pb-0.5 text-[12px]', scoreTone(value))}>{scoreWords(value)}</span>
      </div>

      <div className="mt-2 text-[11px] leading-relaxed text-console-muted">
        {score?.note ??
          (score
            ? `近 90 天 · ${score.sample.trades} 笔 · 其中 ${score.sample.rTrades} 笔可折算 R`
            : '连接网关后读取')}
      </div>

      <button
        onClick={() => onNavigate('score')}
        className="mt-2 flex items-center gap-1 text-[12px] text-console-muted transition-colors hover:text-console-ink"
      >
        查看分量与公式
        <ArrowUpRight size={13} strokeWidth={1.5} />
      </button>
    </section>
  );
}

function Metric({
  label,
  value,
  hint,
  tone = 'flat',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'gain' | 'loss' | 'flat';
}) {
  return (
    <div className="readout-cell">
      <div className="text-[12px] text-console-muted">{label}</div>
      <div
        className={clsx(
          'num mt-1.5 font-mono text-[24px] font-medium leading-none tracking-[-0.01em]',
          tone === 'gain' && 'text-console-gain',
          tone === 'loss' && 'text-console-loss',
        )}
      >
        {value}
      </div>
      <div className="mt-2 truncate text-[11px] text-console-faint">{hint ?? ' '}</div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-console-hover/70 px-3 py-2.5">
      <div className="text-[11px] text-console-faint">{label}</div>
      <div className="num mt-1 font-mono text-[13px] font-medium">{value}</div>
    </div>
  );
}
