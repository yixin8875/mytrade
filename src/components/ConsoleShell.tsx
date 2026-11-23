import type { ReactNode } from 'react';
import {
  BarChart3,
  BookOpen,
  ChartCandlestick,
  ClipboardCheck,
  Eye,
  EyeOff,
  History,
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { checkForUpdates, isUpdateUiAvailable } from '../lib/updater';
import { fmtMoney } from '../lib/format';
import { usePrivacyMask } from '../lib/privacy';
import { goReplayList, routeSessionId, useReplayRoute } from '../replay/route';
import { sessionProgress, useReplaySession } from '../replay/store';
import { Tape } from '../replay/Tape';
import { useApp, type Page } from '../store/useApp';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Kbd } from './ui/kbd';
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip';

type NavItem = { page: Page; label: string; icon: typeof LayoutDashboard };

const NAV: { label: string; items: NavItem[] }[] = [
  {
    label: '工作台',
    items: [
      { page: 'overview', label: '概览', icon: LayoutDashboard },
      { page: 'trade', label: '交易台', icon: ChartCandlestick },
    ],
  },
  {
    label: '复盘',
    items: [{ page: 'replay', label: '历史复盘', icon: History }],
  },
  {
    label: '记录',
    items: [{ page: 'records', label: '交易记录', icon: BookOpen }],
  },
  {
    label: '分析',
    items: [{ page: 'insights', label: '分析', icon: BarChart3 }],
  },
  {
    label: '纪律',
    items: [{ page: 'discipline', label: '纪律', icon: ClipboardCheck }],
  },
];

const RAIL_ITEMS: NavItem[] = NAV.flatMap((group) => group.items);

/** 与启动页同一支标记：五根蜡烛，不做渐变和阴影 */
function Mark() {
  return (
    <span className="relative flex h-[18px] items-center gap-[3px]" aria-hidden="true">
      <span className="h-[15px] w-[3px] rounded-[1px] bg-foreground/70" />
      <span className="h-[15px] w-[3px] rounded-[1px] bg-foreground/70" />
      <span className="h-[15px] w-[3px] rounded-[1px] bg-foreground/70" />
      <span className="h-[15px] w-[3px] rounded-[1px] bg-foreground/70" />
      <span className="absolute left-[-4px] top-1/2 h-[2.5px] w-[26px] -translate-y-1/2 -rotate-[30deg] rounded-[1px] bg-brand" />
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
  const setPaletteOpen = useApp((s) => s.setPaletteOpen);
  const privacy = useApp((s) => s.privacy);
  const setPrivacy = useApp((s) => s.setPrivacy);
  const railPinned = useApp((s) => s.railPinned);
  const setRailPinned = useApp((s) => s.setRailPinned);
  const masked = usePrivacyMask();
  const replayRoute = useReplayRoute();
  const replaySession = useReplaySession(routeSessionId(replayRoute));

  const mode = health?.tradeMode ?? 'readonly';
  const modeLabel = mode === 'readonly' ? '只读' : mode === 'demo' ? '模拟' : '实盘';
  const modeTone =
    mode === 'live' ? 'bg-destructive' : mode === 'demo' ? 'bg-success' : 'bg-muted-foreground';
  const online = conn === 'open';
  const terminal = online && !!health?.connected;
  const updateAvailable = isUpdateUiAvailable();
  const statusText = risk?.halted
    ? '交易已停机'
    : risk?.canTrade === false
      ? '暂不可开仓'
      : '交易正常';
  const tradePage = page === 'trade';

  const go = (target: Page) => {
    // 复盘页有自己的子路由，点导航回列表
    if (target === 'replay') goReplayList();
    setPage(target);
  };

  /** 240px 完整导航；交易台钉住时作为浮层复用同一份内容 */
  const sidebar = (
    <aside className="flex h-full w-[240px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
      <div className="flex h-16 items-center gap-3 px-4">
        <Mark />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold leading-none">Tally</div>
          <div className="mt-1 text-[11px] leading-none text-muted-foreground">MT5 交易终端</div>
        </div>
        {tradePage && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setRailPinned(false)}
            title="收起导航"
            aria-label="收起导航"
          >
            <PanelLeftClose strokeWidth={1.5} />
          </Button>
        )}
      </div>

      <div className="px-3 pb-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setPaletteOpen(true)}
          title="搜索命令（Ctrl K）"
          className="w-full justify-start gap-2 px-2.5 font-normal text-muted-foreground"
        >
          <Search strokeWidth={1.5} />
          <span className="flex-1 text-left">搜索命令</span>
          <Kbd>Ctrl K</Kbd>
        </Button>
      </div>

      <div className="border-y border-sidebar-border px-4 py-3">
        {page === 'replay' ? (
          <>
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>复盘 · 模拟账户</span>
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-warning" />
                不连实盘
              </span>
            </div>
            {replaySession ? (
              <>
                <div className="mt-1 truncate text-[12px] leading-tight">{replaySession.name}</div>
                <div className="mt-1.5 flex items-baseline justify-between gap-2">
                  <span className="num font-mono text-[19px] font-medium leading-none tracking-tight">
                    {fmtMoney(replaySession.equity)}
                  </span>
                  <span className="num font-mono text-[10px] text-muted-foreground">
                    {Math.round(sessionProgress(replaySession) * 100)}%
                  </span>
                </div>
                <Tape
                  session={replaySession}
                  height={16}
                  count={64}
                  className="mt-1.5 h-4 w-full"
                />
              </>
            ) : (
              <div className="mt-1 text-[11px] text-muted-foreground">未选择复盘会话</div>
            )}
          </>
        ) : (
          <>
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>余额</span>
              <span className="flex items-center gap-1.5">
                <span className={cn('h-1.5 w-1.5 rounded-full', modeTone)} />
                {modeLabel}
              </span>
            </div>
            <div className="num mt-1 font-mono text-[20px] font-medium leading-none tracking-tight">
              {fmtMoney(account?.balance)}
            </div>
            <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
              <span>净值</span>
              <span className="num font-mono text-foreground/80">{fmtMoney(account?.equity)}</span>
            </div>
          </>
        )}
      </div>

      <nav className="mt-5 px-3">
        {NAV.map((group, groupIndex) => (
          <div key={group.label} className={groupIndex > 0 ? 'mt-6' : undefined}>
            <div className="px-2.5 pb-2 text-[11px] font-medium text-muted-foreground">
              {group.label}
            </div>
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = page === item.page;
                const badge =
                  item.page === 'trade'
                    ? positions.length
                    : item.page === 'overview'
                      ? orders.length
                      : undefined;
                return (
                  <Button
                    key={item.page}
                    variant="ghost"
                    onClick={() => go(item.page)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'h-8.5 w-full justify-start gap-2.5 px-2.5 text-left text-[13px] font-normal',
                      active && 'bg-accent font-medium text-accent-foreground',
                    )}
                  >
                    <Icon
                      size={16}
                      strokeWidth={1.5}
                      className={cn(
                        'shrink-0',
                        active ? 'text-foreground' : 'text-muted-foreground',
                      )}
                    />
                    <span className="flex-1">{item.label}</span>
                    {badge ? (
                      <span className="num text-[11px] text-muted-foreground/70">{badge}</span>
                    ) : null}
                    {item.page === 'trade' && risk?.halted ? (
                      <span className="h-1.5 w-1.5 rounded-full bg-destructive" title="已停机" />
                    ) : null}
                  </Button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="mt-auto px-3 pb-3">
        <Button
          variant="ghost"
          onClick={() => setPrivacy(!privacy)}
          className={cn(
            'mb-1 h-8.5 w-full justify-start gap-2.5 px-2.5 text-[13px] font-normal',
            privacy && 'bg-accent font-medium text-accent-foreground',
          )}
          title="隐私模式下，复盘与报表页的金额显示为 ••••；交易台不受影响"
          aria-pressed={privacy}
        >
          {privacy ? (
            <EyeOff size={16} strokeWidth={1.5} className="text-foreground" />
          ) : (
            <Eye size={16} strokeWidth={1.5} className="text-muted-foreground" />
          )}
          <span className="flex-1">隐私模式</span>
          <span className="text-[10px] text-muted-foreground/70">
            {privacy ? (masked ? '已遮金额' : '交易台不遮') : '关'}
          </span>
        </Button>

        <Button
          variant="ghost"
          onClick={() => setPage('settings')}
          aria-current={page === 'settings' ? 'page' : undefined}
          className={cn(
            'mb-1 h-8.5 w-full justify-start gap-2.5 px-2.5 text-[13px] font-normal',
            page === 'settings' && 'bg-accent font-medium text-accent-foreground',
          )}
        >
          <SettingsIcon
            size={16}
            strokeWidth={1.5}
            className={page === 'settings' ? 'text-foreground' : 'text-muted-foreground'}
          />
          <span className="flex-1">设置</span>
        </Button>

        {updateAvailable && (
          <Button
            variant="ghost"
            onClick={() => void checkForUpdates(true)}
            title="检查 GitHub 上的新版本"
            className="mb-1 h-8.5 w-full justify-start gap-2.5 px-2.5 text-[13px] font-normal"
          >
            <RefreshCw size={16} strokeWidth={1.5} className="text-muted-foreground" />
            <span className="flex-1">检查更新</span>
          </Button>
        )}

        <div className="mt-3 space-y-1.5 border-t border-sidebar-border px-2.5 pt-3 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                page === 'replay'
                  ? 'bg-warning'
                  : terminal
                    ? 'bg-success'
                    : online
                      ? 'bg-warning'
                      : 'bg-destructive',
              )}
            />
            {page === 'replay'
              ? '复盘模式 · 不连接实盘'
              : terminal
                ? '网关与终端已连接'
                : online
                  ? '等待 MT5 终端'
                  : '网关未连接'}
          </div>
          <div className="flex items-center justify-between">
            <span className={risk?.halted && page !== 'replay' ? 'text-destructive' : undefined}>
              {page === 'replay' ? '复盘不写实盘日志' : statusText}
            </span>
            <span className="num font-mono text-muted-foreground/70">
              v{health?.version ?? '—'}
            </span>
          </div>
        </div>
      </div>
    </aside>
  );

  /** 交易台的 56px 图标栏：把图表宽度让出来，钉住后浮出完整导航 */
  const rail = (
    <aside className="relative z-30 flex w-14 shrink-0 flex-col items-center border-r border-sidebar-border bg-sidebar">
      <div className="flex h-11 w-full items-center justify-center">
        <Mark />
      </div>
      <div className="flex w-full flex-col items-center gap-1 px-1.5">
        {RAIL_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = page === item.page;
          const badge =
            item.page === 'trade' ? positions.length : item.page === 'overview' ? orders.length : 0;
          return (
            <Tooltip key={item.page}>
              <TooltipTrigger
                render={
                  <Button
                    variant={active ? 'secondary' : 'ghost'}
                    size="icon"
                    onClick={() => go(item.page)}
                    aria-label={item.label}
                    aria-current={active ? 'page' : undefined}
                    className="relative"
                  />
                }
              >
                <Icon size={17} strokeWidth={1.5} />
                {badge > 0 && (
                  <Badge
                    size="sm"
                    className="absolute -right-1 -top-1 h-4 min-w-4 rounded-full px-1 font-mono text-[9px] leading-none"
                  >
                    {badge > 99 ? '99' : badge}
                  </Badge>
                )}
                {item.page === 'trade' && risk?.halted ? (
                  <span className="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full bg-destructive" />
                ) : null}
              </TooltipTrigger>
              <TooltipPopup side="right">{item.label}</TooltipPopup>
            </Tooltip>
          );
        })}
      </div>

      <div className="mt-auto flex w-full flex-col items-center gap-1 px-1.5 pb-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant={privacy ? 'secondary' : 'ghost'}
                size="icon"
                onClick={() => setPrivacy(!privacy)}
                aria-label="隐私模式"
                aria-pressed={privacy}
              />
            }
          >
            {privacy ? <EyeOff size={17} strokeWidth={1.5} /> : <Eye size={17} strokeWidth={1.5} />}
          </TooltipTrigger>
          <TooltipPopup side="right">隐私模式</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant={page === 'settings' ? 'secondary' : 'ghost'}
                size="icon"
                onClick={() => setPage('settings')}
                aria-label="设置"
              />
            }
          >
            <SettingsIcon size={17} strokeWidth={1.5} />
          </TooltipTrigger>
          <TooltipPopup side="right">设置</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setRailPinned(!railPinned)}
                aria-label="展开导航"
              />
            }
          >
            <PanelLeftOpen size={17} strokeWidth={1.5} />
          </TooltipTrigger>
          <TooltipPopup side="right">展开导航</TooltipPopup>
        </Tooltip>
        <span
          className={cn(
            'mt-1 h-1.5 w-1.5 rounded-full',
            terminal ? 'bg-success' : online ? 'bg-warning' : 'bg-destructive',
          )}
          title={terminal ? '网关与终端已连接' : online ? '等待 MT5 终端' : '网关未连接'}
        />
      </div>
    </aside>
  );

  if (tradePage) {
    return (
      <div className="relative flex h-full min-h-0 bg-background text-foreground">
        {rail}
        {railPinned && (
          <>
            <button
              className="absolute inset-0 z-30 cursor-default bg-black/20"
              onClick={() => setRailPinned(false)}
              aria-label="收起导航"
              tabIndex={-1}
            />
            <div className="absolute inset-y-0 left-14 z-40 shadow-lg">
              {sidebar}
            </div>
          </>
        )}
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 bg-background text-foreground">
      {sidebar}
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
