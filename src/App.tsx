import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { AlertsPanel } from './components/AlertsPanel';
import { CalendarPanel } from './components/CalendarPanel';
import { ChartGrid } from './components/ChartGrid';
import { CommandPalette } from './components/CommandPalette';
import { ConsoleShell } from './components/ConsoleShell';
import { OrderTicket } from './components/OrderTicket';
import { SettingsPanel } from './components/SettingsPanel';
import { StatusBar } from './components/StatusBar';
import { Toast } from './components/Toast';
import { TopBar } from './components/TopBar';
import { TradeDock } from './components/TradeDock';
import { UpdatePanel } from './components/UpdatePanel';
import { WatchlistPanel } from './components/WatchlistPanel';
import { Overview } from './views/Overview';
import { ReplayView } from './replay/ReplayView';
import { useReplay } from './replay/store';
import { clearReplayBack } from './replay/back';
import { RecordsView } from './views/RecordsView';
import { InsightsView } from './views/InsightsView';
import { DisciplineView } from './views/DisciplineView';
import { ScoreView } from './views/Score';
import { AuditView } from './views/Audit';
import { primaryHost, primaryWidget } from './chart/tv/registry';
import { buildShotMeta } from './chart/tv/shotMeta';
import { gateway } from './gateway/client';
import { applyAccent } from './lib/accent';
import { beep, desktopNotify } from './lib/alert';
import { mountBootProgress } from './lib/boot';
import { handleGlobalShortcut, syncPageFromHash, useApp } from './store/useApp';
import type {
  Account,
  AlertChannelTestEvent,
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
    // 复盘会话按登录号存在网关 SQLite；连接后补一次，切换账户时自动换列表
    void useReplay.getState().hydrate(account.login);
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
  // 启动页按「本地网关 → MT5 终端 → 账户同步」分阶段提示，
  // 连上并拿到第一份品种/持仓数据后再淡出，避免先闪一屏空数据。
  useEffect(() => mountBootProgress(), []);

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
        const event = data as {
          ticket: number;
          symbol: string;
          atR: number;
          price?: number;
          volume: number;
          skipped?: boolean;
        };
        const where =
          Number(event.atR) > 0
            ? `${Number(event.atR).toFixed(2)}R`
            : event.price
              ? String(event.price)
              : '目标价';
        const state = useApp.getState();
        if (event.skipped) {
          state.notify('info', `仓位过小，已跳过 ${event.symbol} ${where} 分批`);
          return;
        }
        state.notify(
          'success',
          `分批止盈：${event.symbol} 已到 ${where}，平掉 ${event.volume} 手`,
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
            'Tally 告警',
            `${text}${alert.marketPrice ? `，现价 ${alert.marketPrice}` : ''}`,
          );
        }
        gateway
          .call<PriceAlert[]>('alerts.list')
          .then((next) => state.setAlerts(next))
          .catch(() => {});
      }),
      gateway.on('alertChannelTest', (data) => {
        const event = data as AlertChannelTestEvent;
        const state = useApp.getState();
        if (event.ok) {
          state.notify('success', `通道「${event.label}」测试消息已发送`);
        } else {
          state.notify('error', `通道「${event.label}」测试失败：${event.error ?? '未知错误'}`);
        }
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
    const onHash = () => syncPageFromHash();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [setPage]);

  // 离开回放域后清掉返回来源，避免下次从其它页面进来时显示旧入口
  useEffect(() => {
    if (page !== 'replay') clearReplayBack();
  }, [page]);

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
  const watchColumnOpen = useApp((s) => s.watchColumnOpen);
  const setWatchColumnOpen = useApp((s) => s.setWatchColumnOpen);
  const ticketOpen = useApp((s) => s.ticketOpen);
  const setTicketOpen = useApp((s) => s.setTicketOpen);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const theme = useApp((s) => s.theme);
  const accentColor = useApp((s) => s.accentColor);
  const activeAccountId = useApp((s) => s.health?.activeAccountId ?? '');
  const activeLogin = useApp((s) => s.account?.login ?? 0);
  const alertsOpen = useApp((s) => s.alertsOpen);
  const calendarOpen = useApp((s) => s.calendarOpen);
  const showWatch = watchColumnOpen && viewportWidth >= 1360;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    applyAccent(accentColor, theme);
  }, [theme, accentColor]);

  // 窄窗口时自动收起自选列，但不改写用户的手动选择
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

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
            {showWatch ? (
              <aside
                className={clsx(
                  'flex shrink-0 flex-col border-r border-tv-border bg-tv-panel',
                  viewportWidth < 1500 ? 'w-[220px]' : 'w-[280px]',
                )}
              >
                <WatchlistPanel />
              </aside>
            ) : (
              <button
                onClick={() => setWatchColumnOpen(true)}
                title="展开行情列（Ctrl+\\）"
                aria-label="展开行情列"
                className="flex w-7 shrink-0 cursor-pointer items-center justify-center border-r border-tv-border bg-tv-raised text-[11px] tracking-widest text-tv-muted transition-colors hover:bg-tv-hover hover:text-tv-text [writing-mode:vertical-rl]"
              >
                行情
              </button>
            )}

            <main className="flex min-w-0 flex-1 flex-col">
              <div className="relative min-h-0 flex-1">
                {/* 切换账户或原地改登录号后重建图表，避免沿用上一个账户的品种和历史缓存 */}
                <ChartGrid key={`${activeAccountId}:${activeLogin}`} />
                {/* 价格告警 / 财经日历覆盖在图表右侧，不挤压图表也不另开弹窗 */}
                {alertsOpen && <AlertsPanel />}
                {calendarOpen && <CalendarPanel />}
              </div>
              <TradeDock />
            </main>

            {ticketOpen ? (
              <aside
                className={clsx(
                  'flex shrink-0 flex-col border-l border-tv-border bg-tv-panel',
                  viewportWidth < 1200 ? 'w-[280px]' : 'w-[300px]',
                )}
              >
                <OrderTicket />
              </aside>
            ) : (
              <button
                onClick={() => setTicketOpen(true)}
                title="展开下单面板"
                aria-label="展开下单面板"
                className="flex w-8 shrink-0 cursor-pointer flex-col items-center justify-center gap-2 border-l border-tv-border bg-tv-panel text-[11px] tracking-widest text-tv-muted transition-colors hover:bg-tv-hover hover:text-tv-text [writing-mode:vertical-rl]"
              >
                <span>下单</span>
                <span className="num font-mono text-[11px] text-tv-faint">{symbol}</span>
              </button>
            )}
          </div>
          <StatusBar />
        </div>
      )}

      {page === 'replay' && <ReplayView />}
      {page === 'records' && <RecordsView />}
      {page === 'insights' && <InsightsView />}
      {page === 'discipline' && <DisciplineView />}
      {page === 'score' && <ScoreView />}
      {page === 'audit' && <AuditView />}
      {page === 'settings' && <SettingsPanel />}

      <UpdatePanel />
      <CommandPalette />
      <Toast />
    </ConsoleShell>
  );
}
