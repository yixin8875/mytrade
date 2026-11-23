import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gateway } from '../gateway/client';
import { useApp, type Page } from '../store/useApp';
import { makeSession } from '../replay/testUtils';
import { useReplay } from '../replay/store';
import type {
  Account,
  GatewayConfig,
  GatewayHealth,
  JournalRecord,
  JournalStats,
  ProcessScore,
  RiskStatus,
  RoutineDay,
  RoutineItem,
} from '../gateway/types';
import { Overview } from './Overview';

function routineItem(overrides: Partial<RoutineItem>): RoutineItem {
  return {
    id: 1,
    title: '合成例行',
    phase: 'pre',
    weekdays: [1, 2, 3, 4, 5],
    sort: 0,
    archivedAt: null,
    createdAt: 1763200000,
    updatedAt: 1763200000,
    due: true,
    done: false,
    ...overrides,
  };
}

const ROUTINE: RoutineDay = {
  date: '2026-11-15',
  today: '2026-11-15',
  weekday: 6,
  editable: true,
  items: [],
  phases: {
    pre: [routineItem({ id: 1, phase: 'pre', done: true })],
    during: [routineItem({ id: 2, phase: 'during', done: true })],
    post: [routineItem({ id: 3, phase: 'post', done: false })],
  },
  summary: { total: 3, done: 2, rate: 66.7 },
};

function makeRecord(positionId: number, symbol: string, profit: number): JournalRecord {
  return {
    login: 12345,
    position_id: positionId,
    symbol,
    side: 'buy',
    volume: 0.1,
    entry_price: 3950,
    exit_price: 3960,
    profit,
    swap: 0,
    commission: 0,
    open_time: 1763200000,
    close_time: 1763203600,
    duration_sec: 3600,
    mfe: profit + 5,
    mae: -5,
    tag: '突破',
    closed_by: 'manual',
    sl: 3940,
    tp: 3980,
    risk: 50,
    risk_source: 'order',
    reviewed_at: null,
    has_shot: 0,
    recorded_at: 1763203600,
  };
}

const RISK: RiskStatus = {
  dayStartBalance: 10_000,
  dayPnl: 12.5,
  dailyLoss: 0,
  dailyLossLimit: 0,
  remaining: 0,
  tradesToday: 2,
  maxTrades: 0,
  consecutiveLosses: 0,
  maxConsecutiveLosses: 0,
  cooldownUntil: 0,
  cooldownRemainingSec: 0,
  halted: false,
  haltReason: '',
  canTrade: true,
  blockReason: '',
};

const TODAY_RECORDS = [makeRecord(101, 'XAUUSD', -8.5), makeRecord(102, 'EURUSD', -4)];
const RECENT_RECORDS = [makeRecord(101, 'XAUUSD', -8.5)];

const STATS: JournalStats = {
  days: 30,
  summary: {
    trades: 3,
    wins: 1,
    losses: 2,
    winRate: 33.3,
    netPnl: -12.5,
    grossProfit: 40,
    grossLoss: -52.5,
    profitFactor: 0.76,
    expectancy: -4.17,
    avgWin: 40,
    avgLoss: -26.25,
    avgDurationSec: 3600,
    maxDrawdown: 52.5,
    bestTrade: 40,
    worstTrade: -30,
  },
  r: {
    trades: 2,
    coverage: 66.7,
    avgR: -0.5,
    totalR: -1,
    bestR: 1,
    worstR: -1.5,
    maxDrawdownR: 1,
    hit1R: 50,
    sources: { journal: 0, order: 2, position: 0, intent: 0 },
  },
  template: {
    planned: 1,
    reached1R: 1,
    breakeven: 1,
    held: 0,
    breakevenRate: 100,
    heldRate: 0,
    avgR: -0.5,
  },
  execution: {
    matched: 1,
    wins: { trades: 0, avgSlippage: null, avgSpread: null },
    losses: { trades: 1, avgSlippage: 2, avgSpread: 12 },
  },
  bySymbol: [],
  byHour: [],
  byTag: [],
  byDuration: [],
  curve: [{ t: 1763203600, pnl: -12.5, cum: -12.5 }],
  rCurve: [{ t: 1763203600, r: -1, cum: -1 }],
};

const SCORE: ProcessScore = {
  version: 1,
  score: 72,
  sample: { trades: 10, rTrades: 5, days: 90 },
  windowStart: '2026-08-17',
  windowEnd: '2026-11-15',
  components: [],
  note: null,
};

const CONFIG: GatewayConfig = {
  max_lot: 1,
  max_risk_pct: 2,
  max_spread_points: 30,
  max_positions: 3,
  daily_loss_pct: 5,
  max_trades_per_day: 10,
  max_consecutive_losses: 3,
  cooldown_minutes: 30,
  trade_mode: 'demo',
  allow_live: false,
  deviation_points: 20,
  trailing_step_points: 10,
  magic: 1,
  discipline_mode: 'confirm',
  discipline_playbook: 'pb1',
  discipline_require_reason: false,
  alert_channel_names: [],
};

const ACCOUNT: Account = {
  login: 12345,
  server: 'Demo-Server',
  company: 'Demo',
  name: '合成账户',
  currency: 'USD',
  leverage: 100,
  balance: 10000,
  equity: 10050,
  margin: 100,
  freeMargin: 9950,
  marginLevel: 10050,
  marginMode: 'hedging',
  tradeAllowed: true,
  accountType: 'demo',
};

const HEALTH: GatewayHealth = {
  connected: true,
  terminal: {
    company: 'Demo',
    name: 'MT5 Demo',
    build: 4000,
    path: 'C:/MT5',
    connected: true,
    tradeAllowed: true,
    dllsAllowed: true,
  },
  account: ACCOUNT,
  accounts: [
    {
      id: 'acc-1',
      label: 'Demo',
      login: 12345,
      server: 'Demo-Server',
      active: true,
      connected: true,
      discipline: {},
    },
  ],
  activeAccountId: 'acc-1',
  tradeMode: 'demo',
  config: CONFIG,
  risk: null,
  lastError: null,
  serverTime: 1763203600,
  serverOffset: 0,
  version: '0.9.0',
};

function mockGateway() {
  return vi.spyOn(gateway, 'call').mockImplementation((async (
    method: string,
    params?: Record<string, unknown>,
  ) => {
    switch (method) {
      case 'routine.day':
        return ROUTINE;
      case 'journal.stats':
        return STATS;
      case 'journal.list':
        return params?.days === 1 ? TODAY_RECORDS : RECENT_RECORDS;
      case 'strategy.list':
        return {
          playbooks: [
            {
              id: 'pb1',
              login: 12345,
              name: '突破清单',
              description: '',
              rules: [],
              archived_at: null,
              created_at: 1763200000,
              updated_at: 1763200000,
            },
          ],
        };
      case 'score.get':
        return SCORE;
      default:
        throw new Error(`未预置的方法：${method}`);
    }
  }) as typeof gateway.call);
}

function resetStore(conn: 'open' | 'closed' = 'open') {
  useApp.setState({
    page: 'overview',
    conn,
    health: HEALTH,
    account: ACCOUNT,
    symbols: [],
    symbol: '',
    positions: [],
    orders: [],
    riskStatus: null,
    journalFilter: {},
    journalDays: null,
    journalFocus: null,
    privacy: false,
    settingsSection: 'appearance',
    settingsReturn: null,
  });
  useReplay.setState({ sessions: [] });
}

const navigate = (page: Page) => useApp.getState().setPage(page);

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  resetStore();
});

describe('Overview · TodayBoard', () => {
  it('今天例行卡展示阶段进度，写今日笔记跳到盈亏日历', async () => {
    mockGateway();
    render(<Overview onNavigate={navigate} />);

    expect(await screen.findByText('2 / 3')).toBeInTheDocument();
    expect(screen.getByText('盘前')).toBeInTheDocument();
    expect(screen.getByText('盘中')).toBeInTheDocument();
    expect(screen.getByText('盘后')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /写今日笔记/ }));

    expect(useApp.getState().page).toBe('records');
    expect(useApp.getState().recordsTab).toBe('calendar');
  });

  it('开仓门禁卡按钮打开设置页的纪律分区', async () => {
    mockGateway();
    render(<Overview onNavigate={navigate} />);

    expect(await screen.findByText('下单前确认清单')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /调整门禁设置/ }));

    expect(useApp.getState().page).toBe('settings');
    expect(useApp.getState().settingsSection).toBe('discipline');
  });

  it('今日交易卡点去复盘，写入待复盘筛选并跳到日志列表', async () => {
    mockGateway();
    render(<Overview onNavigate={navigate} />);

    const action = await screen.findByRole('button', { name: /去复盘今天的交易/ });
    await userEvent.click(action);

    expect(useApp.getState().journalFilter).toEqual({ reviewed: 0 });
    expect(useApp.getState().journalDays).toBe(1);
    expect(useApp.getState().page).toBe('records');
    expect(useApp.getState().recordsTab).toBe('list');
  });

  it('今日交易卡与顶部共用含浮动的今日盈亏，并按券商日取数', async () => {
    const call = mockGateway();
    useApp.setState({ riskStatus: RISK });
    render(<Overview onNavigate={navigate} />);

    expect(await screen.findByText('今日盈亏（含浮动）')).toBeInTheDocument();
    // 顶部指标卡与今日交易卡显示同一个数
    expect(screen.getAllByText('+12.50')).toHaveLength(2);
    expect(call).toHaveBeenCalledWith(
      'journal.stats',
      expect.objectContaining({ days: 1, since: expect.any(Number) }),
    );
  });

  it('继续复盘卡列出未结束会话并跳到 replay 子路由', async () => {
    mockGateway();
    useReplay.setState({
      sessions: [
        makeSession({
          id: 'sess-1',
          name: '黄金复盘',
          symbol: 'XAUUSD',
          status: 'paused',
          updatedAt: 1763200000000,
        }),
      ],
    });
    render(<Overview onNavigate={navigate} />);

    expect(await screen.findByText('黄金复盘')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /继续这次回放/ }));

    expect(window.location.hash.startsWith('#/replay/')).toBe(true);
    expect(useApp.getState().page).toBe('replay');
  });

  it('连接未打开时不渲染 TodayBoard', async () => {
    mockGateway();
    resetStore('closed');
    render(<Overview onNavigate={navigate} />);

    expect(screen.getByText('概览')).toBeInTheDocument();
    expect(screen.queryByText('今天例行')).toBeNull();
    expect(screen.queryByText('开仓门禁')).toBeNull();
    expect(screen.queryByText('写今日笔记')).toBeNull();
  });
});
