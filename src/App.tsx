import { useEffect } from 'react';
import { clsx } from 'clsx';
import { AlertsModal } from './components/AlertsModal';
import { AuditModal } from './components/AuditModal';
import { ChartGrid } from './components/ChartGrid';
import { ExecutionModal } from './components/ExecutionModal';
import { JournalPanel } from './components/JournalPanel';
import { OrderTicket } from './components/OrderTicket';
import { OrdersPanel } from './components/OrdersPanel';
import { PositionsPanel } from './components/PositionsPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { StatusBar } from './components/StatusBar';
import { Toast } from './components/Toast';
import { TopBar } from './components/TopBar';
import { UpdatePanel } from './components/UpdatePanel';
import { WatchlistPanel } from './components/WatchlistPanel';
import { primaryWidget } from './chart/tv/registry';
import { gateway } from './gateway/client';
import { beep, desktopNotify } from './lib/alert';
import { handleGlobalShortcut, useApp, type SidebarTab } from './store/useApp';
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
    let positionId = 0;
    for (let attempt = 0; attempt < 12 && positionId === 0; attempt += 1) {
      const positions = await gateway.call<Position[]>('positions.get');
      const found = positions.find((item) => item.ticket === ticket || item.identifier === ticket);
      if (found) positionId = found.ticket;
      else await sleep(350);
    }
    if (positionId === 0) return;
    const canvas = await widget.takeClientScreenshot({ hideStudiesFromLegend: true });
    const data = canvas.toDataURL('image/jpeg', 0.5);
    await gateway.call('journal.screenshot.save', { positionId, data });
  } catch {
    /* 截图只是日志的补充，失败不影响交易 */
  }
}

export default function App() {
  useEffect(() => {
    gateway.start();

    const offState = gateway.onState((state) => {
      useApp.getState().setConn(state);
      if (state === 'open') void refresh();
    });

    const offs = [
      gateway.on('gateway', (data) => {
        const health = data as GatewayHealth;
        useApp.getState().setHealth(health);
        if (health.account) useApp.getState().setAccount(health.account);
        if (health.risk) useApp.getState().setRiskStatus(health.risk);
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
        const event = data as { ticket: number; sl: number; symbol: string };
        useApp
          .getState()
          .notify('success', `自动保本：${event.symbol} 已到 1R，止损移到开仓价 ${event.sl}`);
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

  const symbol = useApp((s) => s.symbol);
  const conn = useApp((s) => s.conn);
  const sidebarTab = useApp((s) => s.sidebarTab);
  const setSidebarTab = useApp((s) => s.setSidebarTab);
  const positionsCount = useApp((s) => s.positions.length);
  const ordersCount = useApp((s) => s.orders.length);
  const watchCount = useApp((s) => s.watchlist.length);
  const theme = useApp((s) => s.theme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

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
    <div className="flex h-full flex-col bg-tv-bg text-tv-text">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <main className="relative min-w-0 flex-1">
          <ChartGrid />
        </main>
        <aside className="flex w-[320px] shrink-0 flex-col border-l border-tv-border bg-tv-panel">
          <OrderTicket />
          <div className="flex shrink-0 border-y border-tv-border bg-tv-bg/40">
            {(
              [
                ['positions', `持仓 ${positionsCount}`],
                ['orders', `挂单 ${ordersCount}`],
                ['watchlist', `自选 ${watchCount}`],
              ] as [SidebarTab, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                onClick={() => setSidebarTab(value)}
                className={clsx(
                  'h-7 flex-1 text-[10px] transition-colors',
                  sidebarTab === value
                    ? 'bg-tv-panel text-tv-text'
                    : 'text-tv-muted hover:text-tv-text',
                )}
              >
                {label}
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
      <AlertsModal />
      <JournalPanel />
      <ExecutionModal />
      <AuditModal />
      <SettingsPanel />
      <UpdatePanel />
      <StatusBar />
      <Toast />
    </div>
  );
}
