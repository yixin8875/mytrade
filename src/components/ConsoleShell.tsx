import type { ReactNode } from 'react';
import {
  BarChart3,
  BookOpen,
  ChartCandlestick,
  FileClock,
  LayoutDashboard,
  RefreshCw,
  Settings as SettingsIcon,
  ShieldCheck,
} from 'lucide-react';
import { clsx } from 'clsx';
import { checkForUpdates, isUpdateUiAvailable } from '../lib/updater';
import { fmtMoney } from '../lib/format';
import { useApp, type Page } from '../store/useApp';

const NAV: { label: string; items: { page: Page; label: string; icon: typeof LayoutDashboard }[] }[] =
  [
    {
      label: '工作台',
      items: [
        { page: 'overview', label: '概览', icon: LayoutDashboard },
        { page: 'trade', label: '交易台', icon: ChartCandlestick },
      ],
    },
    {
      label: '记录',
      items: [
        { page: 'journal', label: '交易日志', icon: BookOpen },
        { page: 'reports', label: '统计报表', icon: BarChart3 },
        { page: 'executions', label: '执行质量', icon: ShieldCheck },
        { page: 'audit', label: '审计日志', icon: FileClock },
      ],
    },
  ];

/** 与启动页同一支标记：五根蜡烛，不做渐变和阴影 */
function Mark() {
  return (
    <span className="flex h-[18px] items-end gap-[3px]" aria-hidden="true">
      <span className="h-2 w-[3px] rounded-[1px] bg-console-muted" />
      <span className="h-3.5 w-[3px] rounded-[1px] bg-console-ink" />
      <span className="h-2.5 w-[3px] rounded-[1px] bg-console-muted" />
      <span className="h-[18px] w-[3px] rounded-[1px] bg-console-ink" />
      <span className="h-[15px] w-[3px] rounded-[1px] bg-console-muted" />
    </span>
  );
}

/** 左侧中心服务台：所有页面从这里进入，交易台保留自己的顶栏 */
export function ConsoleShell({ children }: { children: ReactNode }) {
  const page = useApp((s) => s.page);
  const setPage = useApp((s) => s.setPage);
  const conn = useApp((s) => s.conn);
  const health = useApp((s) => s.health);
  const account = useApp((s) => s.account);
  const positions = useApp((s) => s.positions);
  const orders = useApp((s) => s.orders);
  const risk = useApp((s) => s.riskStatus);

  const mode = health?.tradeMode ?? 'readonly';
  const modeLabel = mode === 'readonly' ? '只读' : mode === 'demo' ? '模拟' : '实盘';
  const modeTone =
    mode === 'live' ? 'bg-console-loss' : mode === 'demo' ? 'bg-console-gain' : 'bg-console-faint';
  const online = conn === 'open';
  const terminal = online && !!health?.connected;
  const updateAvailable = isUpdateUiAvailable();
  const statusText = risk?.halted
    ? '交易已停机'
    : risk?.canTrade === false
      ? '暂不可开仓'
      : '交易正常';

  return (
    <div className="flex h-full min-h-0 bg-console-canvas text-console-ink">
      <aside className="flex w-[240px] shrink-0 flex-col border-r border-console-line bg-console-sidebar">
        <div className="flex h-16 items-center gap-3 px-4">
          <Mark />
          <div className="min-w-0">
            <div className="text-[15px] font-semibold leading-none">MyTrade</div>
            <div className="mt-1 text-[11px] leading-none text-console-muted">
              MT5 交易终端
            </div>
          </div>
        </div>

        <div className="border-y border-console-line px-4 py-3">
          <div className="flex items-center justify-between text-[11px] text-console-muted">
            <span>余额</span>
            <span className="flex items-center gap-1.5">
              <span className={clsx('h-1.5 w-1.5 rounded-full', modeTone)} />
              {modeLabel}
            </span>
          </div>
          <div className="num mt-1 font-mono text-[20px] font-medium leading-none tracking-tight">
            {fmtMoney(account?.balance)}
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-console-muted">
            <span>净值</span>
            <span className="num font-mono text-console-ink-2">{fmtMoney(account?.equity)}</span>
          </div>
        </div>

        <nav className="mt-5 px-3">
          {NAV.map((group, groupIndex) => (
            <div key={group.label} className={groupIndex > 0 ? 'mt-6' : undefined}>
              <div className="console-label px-2.5 pb-2">{group.label}</div>
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const badge =
                    item.page === 'trade'
                      ? positions.length
                      : item.page === 'overview'
                        ? orders.length
                        : undefined;
                  return (
                    <button
                      key={item.page}
                      onClick={() => setPage(item.page)}
                      className={clsx('console-nav', page === item.page && 'console-nav-active')}
                      aria-current={page === item.page ? 'page' : undefined}
                    >
                      <Icon
                        size={16}
                        strokeWidth={1.5}
                        className={clsx(
                          'shrink-0',
                          page === item.page ? 'text-console-ink' : 'text-console-muted',
                        )}
                      />
                      <span className="flex-1">{item.label}</span>
                      {badge ? <span className="num text-[11px] text-console-faint">{badge}</span> : null}
                      {item.page === 'trade' && risk?.halted ? (
                        <span className="h-1.5 w-1.5 rounded-full bg-console-loss" title="已停机" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="mt-auto px-3 pb-3">
          <button
            onClick={() => setPage('settings')}
            className={clsx('console-nav mb-1', page === 'settings' && 'console-nav-active')}
            aria-current={page === 'settings' ? 'page' : undefined}
          >
            <SettingsIcon
              size={16}
              strokeWidth={1.5}
              className={page === 'settings' ? 'text-console-ink' : 'text-console-muted'}
            />
            <span className="flex-1">设置</span>
          </button>

          {updateAvailable && (
            <button
              onClick={() => void checkForUpdates(true)}
              className="console-nav mb-1"
              title="检查 GitHub 上的新版本"
            >
              <RefreshCw size={16} strokeWidth={1.5} className="text-console-muted" />
              <span className="flex-1">检查更新</span>
            </button>
          )}

          <div className="mt-3 space-y-1.5 border-t border-console-line px-2.5 pt-3 text-[11px] text-console-muted">
            <div className="flex items-center gap-1.5">
              <span
                className={clsx(
                  'h-1.5 w-1.5 rounded-full',
                  terminal ? 'bg-console-gain' : online ? 'bg-console-warn' : 'bg-console-loss',
                )}
              />
              {terminal ? '网关与终端已连接' : online ? '等待 MT5 终端' : '网关未连接'}
            </div>
            <div className="flex items-center justify-between">
              <span className={risk?.halted ? 'text-console-loss' : undefined}>{statusText}</span>
              <span className="num font-mono text-console-faint">v{health?.version ?? '—'}</span>
            </div>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
