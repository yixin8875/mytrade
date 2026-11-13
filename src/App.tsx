import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { AlertsPanel } from './components/AlertsPanel';
import { ChartGrid } from './components/ChartGrid';
import { ConsoleShell } from './components/ConsoleShell';
import { OrderTicket } from './components/OrderTicket';
import { OrdersPanel } from './components/OrdersPanel';
import { PositionsPanel } from './components/PositionsPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { StatusBar } from './components/StatusBar';
import { Toast } from './components/Toast';
import { TopBar } from './components/TopBar';
import { UpdatePanel } from './components/UpdatePanel';
import { WatchlistPanel } from './components/WatchlistPanel';
import { Overview } from './views/Overview';
import { JournalView } from './views/Journal';
import { ReportsView } from './views/Reports';
import { ExecutionsView } from './views/Executions';
import { AuditView } from './views/Audit';
import { primaryHost, primaryWidget } from './chart/tv/registry';
import { buildShotMeta } from './chart/tv/shotMeta';
import { gateway } from './gateway/client';
import { applyAccent } from './lib/accent';
import { beep, desktopNotify } from './lib/alert';
import { handleGlobalShortcut, routeFromHash, useApp, type SidebarTab } from './store/useApp';
import type {
  Account,
  AlertEvent,
  GatewayHealth,
  Order,
  Position,
  PriceAlert,
  Quote,
  RiskStatus,
  SymbolInfo,
  TradeEvent,
} from './gateway/types';

async function refresh(): Promise<void> {
  const state = useApp.getState();
  try {
    const health = await gateway.call<GatewayHealth>('system.health');
    state.setHealth(health);
    if (health.account) state.setAccount(health.account);
    if (!health.connected) return;

    const symbols = await gateway.call<SymbolInfo[]>('symbols.list', {});
    state.setSymbols(symbols);

    const current = useApp.getState();
    const next =
      current.symbol || symbols.find((item) => item.visible)?.name || symbols[0]?.name || '';
    if (next && next !== current.symbol) current.setSymbol(next);

    const [account, positions, orders, riskStatus, alerts] = await Promise.all([
      gateway.call<Account>('account.get'),
      gateway.call<Position[]>('positions.get'),
      gateway.call<Order[]>('orders.get'),
      gateway.call<RiskStatus>('risk.status'),
      gateway.call<PriceAlert[]>('alerts.list'),
    ]);
    const latest = useApp.getState();
    latest.setAccount(account);
    latest.setPositions(positions);
    latest.setOrders(orders);
    latest.setRiskStatus(riskStatus);
    latest.setAlerts(alerts);
  } catch (error) {
    state.notify('error', (error as Error).message);
  }
}

function alertText(alert: AlertEvent): string {
  const direction = alert.kind === 'above' ? '上穿' : '下穿';
  return `${alert.symbol} ${direction} ${alert.price}${alert.note ? `（${alert.note}）` : ''}`;
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** 成交后等持仓出现在网关里，把主图截一张存进交易日志 */
async function captureTradeShot(ticket: number): Promise<void> {
  const widget = primaryWidget();
  if (!widget) return;
  try {
    let position: Position | null = null;
    for (let attempt = 0; attempt < 12 && !position; attempt += 1) {
      const positions = await gateway.call<Position[]>('positions.get');
      position = positions.find((item) => item.ticket === ticket || item.identifier === ticket) ?? null;
      if (!position) await sleep(350);
    }
    if (!position) return;
    // 先读坐标再截图，保证锚点和画面是同一帧
    const sameSymbol = widget.activeChart().symbol() === position.symbol;
    const info = useApp.getState().symbols.find((item) => item.name === position.symbol);
    const meta = sameSymbol ? buildShotMeta(widget, primaryHost(), info?.digits ?? 5) : null;
    const canvas = await widget.takeClientScreenshot({ hideStudiesFromLegend: true });
    const data = canvas.toDataURL('image/jpeg', 0.5);
    await gateway.call('journal.screenshot.save', { positionId: position.ticket, data, meta });
  } catch {
    /* 截图只是日志的补充，失败不影响交易 */
  }
}

export default function App() {
  // 启动动画一直保留到网关连上、且拿到第一份品种/持仓数据后再淡出，
  // 避免先闪一屏余额为 0、列表为空的数据。连接慢或 MT5 未登录时给出提示，
  // 并有超时兜底，不会把用户一直挡在启动页。
  useEffect(() => {
    const boot = document.getElementById('boot');
    if (!boot) return;
    const sub = document.getElementById('boot-sub');
    let hidden = false;
    let removeTimer = 0;
    let disconnectedTimer = 0;

    const hide = () => {
      if (hidden) return;
      hidden = true;
      window.clearTimeout(disconnectedTimer);
      boot.classList.add('boot-hide');
      removeTimer = window.setTimeout(() => boot.remove(), 520);
    };

    const update = () => {
      if (hidden) return;
      const state = useApp.getState();
      if (state.conn === 'open' && state.health) {
        if (state.health.connected) {
          if (state.symbols.length > 0) {
            hide();
            return;
          }
          if (sub) sub.textContent = '正在加载品种与持仓…';
          return;
        }
        // MT5 终端可能还在启动/登录：先提示，8 秒仍未连上就放行到应用内
        if (sub) sub.textContent = '等待 MT5 终端登录…';
        if (disconnectedTimer === 0) {
          disconnectedTimer = window.setTimeout(hide, 8000);
        }
        return;
      }
      if (sub) {
        sub.textContent =
          state.conn === 'connecting' ? '正在连接本地网关…' : '正在启动本地网关…';
      }
    };

    update();
    const unsubscribe = useApp.subscribe(update);
    const slow = window.setTimeout(() => {
      if (!hidden && sub) sub.textContent = '本地网关启动较慢，正在重试…';
    }, 8000);
    const watchdog = window.setTimeout(hide, 25000);

    return () => {
      unsubscribe();
      window.clearTimeout(slow);
      window.clearTimeout(watchdog);
      window.clearTimeout(removeTimer);
      window.clearTimeout(disconnectedTimer);
    };
  }, []);

  useEffect(() => {
    gateway.start();

    const offState = gateway.onState((state) => {
      useApp.getState().setConn(state);
      if (state === 'open') void refresh();
    });

    const offs = [
      gateway.on('gateway', (data) => {
        const health = data as GatewayHealth;
        const state = useApp.getState();
        state.setHealth(health);
        if (health.account) state.setAccount(health.account);
        if (health.risk) state.setRiskStatus(health.risk);
        // 切换账户失败后网关会在后台继续重连；连上时补一次品种与持仓
        if (health.connected && state.symbols.length === 0) void refresh();
      }),
      gateway.on('account', (data) => useApp.getState().setAccount(data as Account)),
      gateway.on('positions', (data) => useApp.getState().setPositions(data as Position[])),
      gateway.on('orders', (data) => useApp.getState().setOrders(data as Order[])),
      gateway.on('risk', (data) => useApp.getState().setRiskStatus(data as RiskStatus)),
      gateway.on('tick', (data) => {
        const quote = data as Quote;
        const state = useApp.getState();
        if (quote.symbol === state.symbol) state.setQuote(quote);
      }),
      gateway.on('trade', (data) => {
        const trade = data as TradeEvent;
        useApp
          .getState()
          .notify(
            'success',
            `已提交：${trade.side === 'buy' ? '买入' : '卖出'} ${trade.volume} ${trade.symbol}`,
          );
        void captureTradeShot(trade.order);
      }),
      gateway.on('autoBreakeven', (data) => {
        const event = data as { ticket: number; sl: number; symbol: string; r?: number };
        const r = Number(event.r) > 0 ? Number(event.r) : 1;
        useApp
          .getState()
          .notify(
            'success',
            `自动保本：${event.symbol} 已到 ${Number(r.toFixed(2))}R，止损移到开仓价 ${event.sl}`,
          );
      }),
      gateway.on('templateStep', (data) => {
        const event = data as { ticket: number; symbol: string; atR: number; volume: number };
        useApp
          .getState()
          .notify(
            'success',
            `分批止盈：${event.symbol} 已到 ${Number(event.atR.toFixed(2))}R，平掉 ${event.volume} 手`,
          );
      }),
      gateway.on('alert', (data) => {
        const alert = data as AlertEvent;
        const state = useApp.getState();
        const text = alertText(alert);
        state.notify('success', `告警：${text}`);
        if (state.alertSound) beep();
        if (state.alertDesktop) {
          desktopNotify(
            'MyTrade 告警',
            `${text}${alert.marketPrice ? `，现价 ${alert.marketPrice}` : ''}`,
          );
        }
        gateway
          .call<PriceAlert[]>('alerts.list')
          .then((next) => state.setAlerts(next))
          .catch(() => {});
      }),
    ];

    const ping = window.setInterval(async () => {
      if (gateway.state !== 'open') return;
      const started = performance.now();
      try {
        await gateway.call('ping', {}, 3000);
        useApp.getState().setLatency(Math.round(performance.now() - started));
      } catch {
        useApp.getState().setLatency(null);
      }
    }, 5000);

    if (gateway.state === 'open') void refresh();

    return () => {
      offState();
      offs.forEach((off) => off());
      window.clearInterval(ping);
    };
  }, []);

  // 全局快捷键：B/S 建市价草稿、Esc 关弹窗/清除划线；输入框里不抢键
  useEffect(() => {
    window.addEventListener('keydown', handleGlobalShortcut);
    return () => window.removeEventListener('keydown', handleGlobalShortcut);
  }, []);

  // 账户切换后重新拉账户、品种、持仓与告警；图表按 activeAccountId 重新挂载
  useEffect(() => {
    const onSwitch = () => void refresh();
    window.addEventListener('mytrade:account-switched', onSwitch);
    return () => window.removeEventListener('mytrade:account-switched', onSwitch);
  }, []);

  const page = useApp((s) => s.page);
  const setPage = useApp((s) => s.setPage);
  /** 交易台首次进入后才挂载，之后一直保留，切页不丢图表状态 */
  const [tradeMounted, setTradeMounted] = useState(page === 'trade');

  useEffect(() => {
    const onHash = () => setPage(routeFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [setPage]);

  useEffect(() => {
    if (page === 'trade') setTradeMounted(true);
  }, [page]);

  // 图表在 display:none 期间可能被压成 0 宽，回来时让它重新量一次
  useEffect(() => {
    if (page !== 'trade') return;
    const timer = window.setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
    return () => window.clearTimeout(timer);
  }, [page]);

  const symbol = useApp((s) => s.symbol);
  const conn = useApp((s) => s.conn);
  const sidebarTab = useApp((s) => s.sidebarTab);
  const setSidebarTab = useApp((s) => s.setSidebarTab);
  const positionsCount = useApp((s) => s.positions.length);
  const ordersCount = useApp((s) => s.orders.length);
  const watchCount = useApp((s) => s.watchlist.length);
  const theme = useApp((s) => s.theme);
  const accentColor = useApp((s) => s.accentColor);
  const activeAccountId = useApp((s) => s.health?.activeAccountId ?? '');
  const activeLogin = useApp((s) => s.account?.login ?? 0);
  const alertsOpen = useApp((s) => s.alertsOpen);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    applyAccent(accentColor, theme);
  }, [theme, accentColor]);

  useEffect(() => {
    if (conn !== 'open' || !symbol) return;
    gateway.call('quotes.subscribe', { symbols: [symbol] }).catch(() => {});
    return () => {
      gateway.call('quotes.unsubscribe', { symbols: [symbol] }).catch(() => {});
    };
  }, [symbol, conn]);

  useEffect(() => {
    if (!symbol) return;
    const info = useApp.getState().symbols.find((item) => item.name === symbol);
    if (!info) return;
    const draft = useApp.getState().draft;
    useApp.getState().patchDraft({
      volume: Math.max(info.minVolume, Math.min(info.maxVolume, draft.volume)),
    });
  }, [symbol]);

  return (
    <ConsoleShell>
      {page === 'overview' && <Overview onNavigate={setPage} />}

      {tradeMounted && (
        <div
          className={clsx(
            'min-h-0 flex-1 flex-col bg-tv-bg text-tv-text',
            page === 'trade' ? 'flex' : 'hidden',
          )}
        >
          <TopBar />
          <div className="flex min-h-0 flex-1">
            <main className="relative min-w-0 flex-1">
              {/* 切换账户或原地改登录号后重建图表，避免沿用上一个账户的品种和历史缓存 */}
              <ChartGrid key={`${activeAccountId}:${activeLogin}`} />
              {/* 价格告警覆盖在图表右侧，不挤压图表也不另开弹窗 */}
              {alertsOpen && <AlertsPanel />}
            </main>
            <aside className="flex w-[336px] shrink-0 flex-col border-l border-tv-border bg-tv-panel">
              <OrderTicket />
              <div className="flex h-9 shrink-0 items-stretch border-y border-tv-border bg-tv-raised px-1">
                {(
                  [
                    ['positions', '持仓', positionsCount],
                    ['orders', '挂单', ordersCount],
                    ['watchlist', '自选', watchCount],
                  ] as [SidebarTab, string, number][]
                ).map(([value, label, count]) => (
                  <button
                    key={value}
                    onClick={() => setSidebarTab(value)}
                    className={clsx(
                      'relative flex flex-1 items-center justify-center gap-1.5 text-[12px] transition-colors',
                      sidebarTab === value
                        ? 'font-medium text-tv-text'
                        : 'text-tv-muted hover:text-tv-text',
                    )}
                  >
                    {label}
                    <span className="num font-mono text-[11px] text-tv-faint">{count}</span>
                    {sidebarTab === value && (
                      <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-tv-accent" />
                    )}
                  </button>
                ))}
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {sidebarTab === 'positions' && <PositionsPanel />}
                {sidebarTab === 'orders' && <OrdersPanel />}
                {sidebarTab === 'watchlist' && <WatchlistPanel />}
              </div>
            </aside>
          </div>
          <StatusBar />
        </div>
      )}

      {page === 'journal' && <JournalView />}
      {page === 'reports' && <ReportsView />}
      {page === 'executions' && <ExecutionsView />}
      {page === 'audit' && <AuditView />}
      {page === 'settings' && <SettingsPanel />}

      <UpdatePanel />
      <Toast />
    </ConsoleShell>
  );
}
