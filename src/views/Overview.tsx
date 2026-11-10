import { useEffect, useState } from 'react';
import {
  ArrowUpRight,
  BarChart3,
  BookOpen,
  ChartCandlestick,
  Layers,
  Settings as SettingsIcon,
  ShieldCheck,
} from 'lucide-react';
import { clsx } from 'clsx';
import { gateway } from '../gateway/client';
import { useApp, type Page } from '../store/useApp';
import { fmtMoney, fmtSigned, fmtVolume, signedClass } from '../lib/format';
import type { JournalRecord, JournalStats } from '../gateway/types';

function fmtTime(ts: number): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

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
  const account = useApp((s) => s.account);
  const risk = useApp((s) => s.riskStatus);
  const positions = useApp((s) => s.positions);
  const orders = useApp((s) => s.orders);
  const health = useApp((s) => s.health);

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
  }, [conn]);

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
      <div className="mx-auto w-full max-w-[1120px] px-8 py-7">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight">概览</h1>
          <p className="mt-1 text-[11.5px] text-console-muted">
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

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="余额" value={fmtMoney(account?.balance)} hint={account?.currency ?? '账户货币'} />
        <Metric label="净值" value={fmtMoney(account?.equity)} hint={`已用保证金 ${fmtMoney(account?.margin)}`} />
        <Metric
          label="今日盈亏"
          value={fmtSigned(today)}
          tone={today > 0 ? 'gain' : today < 0 ? 'loss' : 'flat'}
          hint={stats ? `近 30 天 ${fmtSigned(stats.summary.netPnl)}` : '—'}
        />
        <Metric
          label="浮动盈亏"
          value={fmtSigned(floating)}
          tone={floating > 0 ? 'gain' : floating < 0 ? 'loss' : 'flat'}
          hint={`${positions.length} 个持仓 · ${orders.length} 个挂单`}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(300px,1fr)]">
        <section className="console-card overflow-hidden">
          <div className="flex items-center justify-between border-b border-console-line px-5 py-3.5">
            <div>
              <div className="text-[13px] font-semibold">最近交易</div>
              <div className="mt-0.5 text-[10.5px] text-console-muted">近 30 天已平仓记录</div>
            </div>
            <button
              onClick={() => onNavigate('journal')}
              className="flex items-center gap-1 text-[11px] text-console-muted hover:text-console-ink"
            >
              全部日志
              <ArrowUpRight size={12} />
            </button>
          </div>

          {recent.length === 0 ? (
            <div className="px-5 py-12 text-center text-[11.5px] text-console-faint">
              {loading ? '读取中…' : '还没有已平仓交易，去交易台开始第一笔'}
            </div>
          ) : (
            <table className="w-full border-collapse text-[11.5px]">
              <thead>
                <tr className="text-left text-[10px] text-console-faint">
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
                    <td className="num whitespace-nowrap px-5 py-2.5 text-console-muted">
                      {fmtTime(record.close_time)}
                    </td>
                    <td className="px-2 py-2.5 font-medium">{record.symbol}</td>
                    <td className="px-2 py-2.5">
                      <span
                        className={clsx(
                          'rounded px-1.5 py-0.5 text-[9.5px] font-semibold',
                          record.side === 'buy'
                            ? 'bg-console-gain-soft text-console-gain'
                            : 'bg-console-loss-soft text-console-loss',
                        )}
                      >
                        {record.side === 'buy' ? '多' : '空'}
                      </span>
                    </td>
                    <td className="num px-2 py-2.5 text-right text-console-muted">
                      {fmtVolume(record.volume)}
                    </td>
                    <td className={clsx('num px-5 py-2.5 text-right font-medium', signedClass(record.profit))}>
                      {fmtSigned(record.profit)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="flex items-center justify-between border-t border-console-line bg-console-card/60 px-5 py-2.5 text-[10.5px] text-console-muted">
            <span>
              {stats
                ? `近 30 天 ${stats.summary.trades} 笔 · 胜率 ${
                    stats.summary.winRate != null ? `${stats.summary.winRate.toFixed(1)}%` : '—'
                  }`
                : '加载统计中…'}
            </span>
            <span className={clsx('num', stats ? signedClass(stats.summary.netPnl) : '')}>
              {stats ? fmtSigned(stats.summary.netPnl) : ''}
            </span>
          </div>
        </section>

        <div className="space-y-4">
          <section className="console-card p-5">
            <div className="flex items-center gap-2">
              <ShieldCheck size={14} className="text-console-muted" />
              <span className="text-[13px] font-semibold">今日风控</span>
              <span className="flex-1" />
              <span
                className={clsx(
                  'rounded-full px-2 py-0.5 text-[9.5px] font-semibold',
                  risk?.halted
                    ? 'bg-console-loss-soft text-console-loss'
                    : risk?.canTrade === false
                      ? 'bg-console-warn-soft text-console-warn'
                      : 'bg-console-gain-soft text-console-gain',
                )}
              >
                {risk?.halted ? '已停机' : risk?.canTrade === false ? '暂不可开仓' : '正常'}
              </span>
            </div>

            <div className="mt-4">
              <div className="flex items-baseline justify-between text-[10.5px] text-console-muted">
                <span>当日亏损</span>
                <span className="num">
                  {fmtMoney(risk?.dailyLoss ?? 0)}
                  {lossLimit > 0 ? ` / ${fmtMoney(lossLimit)}` : ' · 未设上限'}
                </span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-console-hover">
                <div
                  className={clsx(
                    'h-full rounded-full transition-[width]',
                    lossUsed >= 1 ? 'bg-console-loss' : lossUsed >= 0.6 ? 'bg-amber-500' : 'bg-console-gain',
                  )}
                  style={{ width: `${Math.max(lossUsed * 100, risk?.dailyLoss ? 3 : 0)}%` }}
                />
              </div>
              {lossLimit > 0 && (
                <div className="mt-1 text-right text-[9.5px] text-console-faint">
                  剩余 {fmtMoney(risk?.remaining ?? 0)}
                </div>
              )}
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2">
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
              <div className="mt-3 rounded-md bg-console-warn-soft px-2.5 py-1.5 text-[10px] text-console-warn">
                {risk.blockReason}
              </div>
            )}

            <button
              onClick={() => onNavigate('settings')}
              className="mt-3 flex items-center gap-1 text-[10.5px] text-console-muted hover:text-console-ink"
            >
              调整风控上限
              <ArrowUpRight size={11} />
            </button>
          </section>

          <section className="console-card p-5">
            <div className="flex items-center gap-2">
              <Layers size={14} className="text-console-muted" />
              <span className="text-[13px] font-semibold">当前持仓</span>
              <span className="flex-1" />
              <span className="num text-[10.5px] text-console-faint">{positions.length}</span>
            </div>

            {positions.length === 0 ? (
              <div className="py-6 text-center text-[11px] text-console-faint">暂无持仓</div>
            ) : (
              <div className="mt-2 divide-y divide-console-line/70">
                {positions.slice(0, 4).map((position) => (
                  <div key={position.ticket} className="flex items-center gap-2 py-2">
                    <span className="w-16 shrink-0 text-[11.5px] font-medium">{position.symbol}</span>
                    <span
                      className={clsx(
                        'rounded px-1 text-[9px] font-semibold',
                        position.side === 'buy'
                          ? 'bg-console-gain-soft text-console-gain'
                          : 'bg-console-loss-soft text-console-loss',
                      )}
                    >
                      {position.side === 'buy' ? '多' : '空'}
                    </span>
                    <span className="num text-[10.5px] text-console-muted">
                      {fmtVolume(position.volume)}
                    </span>
                    <span className="flex-1" />
                    <span className={clsx('num text-[11px] font-medium', signedClass(position.profit))}>
                      {fmtSigned(position.profit)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <button
              onClick={() => onNavigate('trade')}
              className="mt-1 flex items-center gap-1 text-[10.5px] text-console-muted hover:text-console-ink"
            >
              打开交易台
              <ArrowUpRight size={11} />
            </button>
          </section>
        </div>
      </div>

      <section className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {QUICK_LINKS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.page}
              onClick={() => onNavigate(item.page)}
              className="console-card group flex items-start gap-3 p-4 text-left transition-colors hover:bg-console-card"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-console-canvas text-console-muted group-hover:text-console-ink">
                <Icon size={15} />
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1 text-[12px] font-medium">
                  {item.title}
                  <ArrowUpRight
                    size={11}
                    className="text-console-faint transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                  />
                </span>
                <span className="mt-0.5 block text-[10px] leading-relaxed text-console-muted">
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
    <div className="console-card p-4">
      <div className="text-[10.5px] text-console-muted">{label}</div>
      <div
        className={clsx(
          'num mt-1 text-[21px] font-semibold tracking-tight',
          tone === 'gain' && 'text-console-gain',
          tone === 'loss' && 'text-console-loss',
        )}
      >
        {value}
      </div>
      <div className="mt-0.5 truncate text-[9.5px] text-console-faint">{hint ?? ' '}</div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-console-canvas px-2.5 py-2">
      <div className="text-[9.5px] text-console-faint">{label}</div>
      <div className="num mt-0.5 text-[12px] font-medium">{value}</div>
    </div>
  );
}
