import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gateway } from '../gateway/client';
import type { Account, GatewayHealth, RiskStatus } from '../gateway/types';
import { useApp } from '../store/useApp';
import { GOLD_INFO } from '../replay/testUtils';
import { TopBar } from './TopBar';

const ACCOUNT = {
  login: 1,
  server: 'S1',
  company: 'Broker',
  name: 'Demo',
  currency: 'USD',
  leverage: 100,
  balance: 10_000,
  equity: 10_000,
  margin: 0,
  freeMargin: 10_000,
  marginLevel: null,
  accountType: 'demo',
} as Account;

function health(overrides: Partial<GatewayHealth> = {}): GatewayHealth {
  return {
    connected: true,
    terminal: null,
    account: ACCOUNT,
    accounts: [],
    activeAccountId: 'a',
    tradeMode: 'demo',
    config: { allow_live: false } as never,
    risk: null,
    lastError: null,
    serverTime: 1_763_200_000,
    serverOffset: 0,
    version: '0.7.5',
    ...overrides,
  };
}

const RISK = {
  dayStartBalance: 10_000,
  dayPnl: 0,
  dailyLoss: 0,
  dailyLossLimit: 0,
  remaining: 0,
  tradesToday: 0,
  maxTrades: 0,
  consecutiveLosses: 0,
  maxConsecutiveLosses: 0,
  cooldownUntil: 0,
  cooldownRemainingSec: 0,
  halted: false,
  haltReason: '',
  canTrade: true,
  blockReason: '',
} as RiskStatus;

function setup(overrides: Partial<GatewayHealth> = {}, account: Account = ACCOUNT) {
  useApp.setState({
    conn: 'open',
    health: health(overrides),
    account,
    symbols: [GOLD_INFO],
    symbol: 'XAUUSD',
    quote: null,
    riskStatus: RISK,
    alerts: [],
    toast: null,
  });
}

describe('TopBar 交易模式', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setup();
  });

  it('只读点一次切到模拟交易并提示', async () => {
    setup({ tradeMode: 'readonly' });
    const call = vi.spyOn(gateway, 'call').mockResolvedValue({} as never);
    render(<TopBar />);

    await userEvent.click(screen.getByRole('button', { name: '只读' }));

    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('system.setTradeMode', { mode: 'demo' }),
    );
    expect(useApp.getState().toast?.text).toBe('已开启模拟交易');
  });

  it('模拟交易点一次切回只读', async () => {
    const call = vi.spyOn(gateway, 'call').mockResolvedValue({} as never);
    render(<TopBar />);

    await userEvent.click(screen.getByRole('button', { name: '模拟可交易' }));

    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('system.setTradeMode', { mode: 'readonly' }),
    );
    expect(useApp.getState().toast?.text).toBe('已切到只读模式');
  });

  it('实盘账户未开 allow_live 时锁在只读，点击不发请求', async () => {
    const real = { ...ACCOUNT, accountType: 'real' } as Account;
    setup(
      { tradeMode: 'readonly', accountType: 'real', account: real } as Partial<GatewayHealth>,
      real,
    );
    const call = vi.spyOn(gateway, 'call').mockResolvedValue({} as never);
    render(<TopBar />);

    const button = screen.getByRole('button', { name: '只读' });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(call).not.toHaveBeenCalled();
  });

  it('切换期间按钮显示切换中且禁用', async () => {
    setup({ tradeMode: 'readonly' });
    let resolve: (value: unknown) => void = () => {};
    vi.spyOn(gateway, 'call').mockImplementation(
      (() => new Promise((done) => (resolve = done))) as never,
    );
    render(<TopBar />);

    await userEvent.click(screen.getByRole('button', { name: '只读' }));

    const busy = await screen.findByRole('button', { name: '切换中…' });
    expect(busy).toBeDisabled();

    resolve({});
    await waitFor(() => expect(screen.getByRole('button', { name: '只读' })).toBeEnabled());
  });
});

describe('TopBar 急停', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setup();
  });

  it('急停需要二次确认，确认后平掉所有仓并提示', async () => {
    const call = vi
      .spyOn(gateway, 'call')
      .mockResolvedValue({ closed: [{}, { error: '已平' }] } as never);
    render(<TopBar />);

    await userEvent.click(screen.getByRole('button', { name: '急停' }));
    expect(screen.getByRole('button', { name: '确认平仓？' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '确认平仓？' }));

    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('system.halt', { closeAll: true, reason: '手动急停' }),
    );
    expect(useApp.getState().toast?.text).toContain('1 个失败');
  });

  it('已停机时按钮显示恢复交易，点击发系统恢复', async () => {
    useApp.setState({ riskStatus: { ...RISK, halted: true, haltReason: '手动急停' } });
    const call = vi.spyOn(gateway, 'call').mockResolvedValue({} as never);
    render(<TopBar />);

    await userEvent.click(screen.getByRole('button', { name: '恢复交易' }));

    await waitFor(() => expect(call).toHaveBeenCalledWith('system.resume', {}));
    expect(useApp.getState().toast?.text).toBe('已恢复交易');
  });
});
