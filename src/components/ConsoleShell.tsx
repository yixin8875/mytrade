import type { ReactNode } from 'react';
import {
  Activity,
  BarChart3,
  Bell,
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
      ],
    },
  ];

/** 左侧中心服务台：所有页面从这里进入，交易台保留自己的顶栏 */
export function ConsoleShell({ children }: { children: ReactNode }) {
  const page = useApp((s) => s.page);
  const setPage = useApp((s) => s.setPage);
  const conn = useApp((s) => s.conn);
  const health = useApp((s) => s.health);
  const account = useApp((s) => s.account);
  const positions = useApp((s) => s.positions);
  const orders = useApp((s) => s.orders);
  const alerts = useApp((s) => s.alerts);
  const risk = useApp((s) => s.riskStatus);
  const setAlertsOpen = useApp((s) => s.setAlertsOpen);
  const setExecutionOpen = useApp((s) => s.setExecutionOpen);
  const setAuditOpen = useApp((s) => s.setAuditOpen);

  const activeAlerts = alerts.filter((item) => item.enabled).length;
  const mode = health?.tradeMode ?? 'readonly';
  const modeLabel = mode === 'readonly' ? '只读' : mode === 'demo' ? '模拟' : '实盘';
  const online = conn === 'open';
  const terminal = online && !!health?.connected;
  const updateAvailable = isUpdateUiAvailable();

  const tools = [
    {
      label: '价格告警',
      icon: Bell,
      count: activeAlerts,
      onClick: () => setAlertsOpen(true),
    },
    { label: '执行质量', icon: ShieldCheck, onClick: () => setExecutionOpen(true) },
    { label: '审计日志', icon: FileClock, onClick: () => setAuditOpen(true) },
  ];

  return (
    <div className="flex h-full min-h-0 bg-console-canvas text-console-ink">
      <aside className="flex w-[228px] shrink-0 flex-col border-r border-console-line bg-console-sidebar">
        <div className="flex h-[56px] items-center gap-2.5 px-4">
          <span className="flex h-[30px] w-[30px] items-center justify-center rounded-lg bg-console-accent text-white shadow-[0_1px_2px_rgba(11,108,240,0.35)]">
            <Activity size={17} strokeWidth={2.2} />
          </span>
          <div className="min-w-0">
            <div className="text-[13.5px] font-semibold tracking-[0.12em]">MyTrade</div>
            <div className="text-[9.5px] text-console-faint">MT5 交易台</div>
          </div>
        </div>

        <div className="mx-3 mb-3 rounded-lg border border-console-line bg-white/70 px-3 py-2.5">
          <div className="flex items-center justify-between text-[10px] text-console-muted">
            <span>余额</span>
            <span
              className={clsx(
                'rounded px-1.5 py-0.5 text-[9px] font-semibold',
                mode === 'readonly' && 'bg-console-selected text-console-muted',
                mode === 'demo' && 'bg-console-gain-soft text-console-gain',
                mode === 'live' && 'bg-console-loss-soft text-console-loss',
              )}
            >
              {modeLabel}
            </span>
          </div>
          <div className="num mt-0.5 text-[17px] font-semibold tracking-tight">
            {fmtMoney(account?.balance)}
          </div>
          <div className="mt-1 flex items-center justify-between text-[10px] text-console-muted">
            <span>净值</span>
            <span className="num text-console-ink-2">{fmtMoney(account?.equity)}</span>
          </div>
        </div>

        <nav className="space-y-4 px-2.5">
          {NAV.map((group) => (
            <div key={group.label}>
              <div className="console-label px-2 pb-1.5">{group.label}</div>
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
                      <Icon size={15} strokeWidth={1.8} className="shrink-0 text-console-muted" />
                      <span className="flex-1">{item.label}</span>
                      {badge ? (
                        <span className="num text-[10px] text-console-faint">{badge}</span>
                      ) : null}
                      {item.page === 'trade' && risk?.halted ? (
                        <span className="h-1.5 w-1.5 rounded-full bg-console-loss" title="已停机" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          <div>
            <div className="console-label px-2 pb-1.5">工具</div>
            <div className="space-y-0.5">
              {tools.map((item) => {
                const Icon = item.icon;
                return (
                  <button key={item.label} className="console-nav" onClick={item.onClick}>
                    <Icon size={15} strokeWidth={1.8} className="shrink-0 text-console-muted" />
                    <span className="flex-1">{item.label}</span>
                    {item.count ? (
                      <span className="rounded-full bg-console-warn-soft px-1.5 text-[9px] font-semibold text-console-warn">
                        {item.count}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        </nav>

        <div className="mt-auto px-2.5 pb-3">
          <button
            onClick={() => setPage('settings')}
            className={clsx('console-nav mb-1', page === 'settings' && 'console-nav-active')}
            aria-current={page === 'settings' ? 'page' : undefined}
          >
            <SettingsIcon size={15} strokeWidth={1.8} className="text-console-muted" />
            <span className="flex-1">设置</span>
          </button>

          {updateAvailable && (
            <button
              onClick={() => void checkForUpdates(true)}
              className="console-nav mb-1"
              title="检查 GitHub 上的新版本"
            >
              <RefreshCw size={14} strokeWidth={1.8} className="text-console-muted" />
              <span className="flex-1">检查更新</span>
            </button>
          )}

          <div className="flex items-center gap-1.5 px-2 pb-1 text-[9.5px] text-console-faint">
            <span
              className={clsx(
                'h-1.5 w-1.5 rounded-full',
                terminal ? 'bg-console-gain' : online ? 'bg-amber-400' : 'bg-console-loss',
              )}
            />
            {terminal ? '网关与终端已连接' : online ? '等待 MT5 终端' : '网关未连接'}
          </div>
          <div className="flex items-center justify-between px-2 text-[9.5px] text-console-faint">
            <span>{risk?.halted ? '交易已停机' : risk?.canTrade === false ? '暂不可开仓' : '交易正常'}</span>
            <span className="num">v{health?.version ?? '—'}</span>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
