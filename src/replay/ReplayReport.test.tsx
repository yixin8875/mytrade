import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { useApp } from '../store/useApp';
import { ReplayReport } from './ReplayReport';
import { useReplay } from './store';
import { makeSession } from './testUtils';
import type { ReplaySession, ReplayTrade } from './types';

const START = Date.UTC(2026, 10, 15, 1, 0) / 1000;

function makeTrade(overrides: Partial<ReplayTrade> & { id: string }): ReplayTrade {
  return {
    side: 'buy',
    volume: 1,
    entry: 2000,
    exit: 2010,
    openTs: START,
    closeTs: START + 3600,
    profit: 100,
    commission: 1,
    r: 2,
    tag: '突破',
    closedBy: 'tp',
    mfe: 120,
    mae: -20,
    ...overrides,
  };
}

function setup(overrides: Partial<ReplaySession> = {}): ReplaySession {
  const session = makeSession({
    id: 'report-1',
    name: '复盘报告会话',
    status: 'finished',
    equity: 10_050,
    maxDrawdownPct: 4.2,
    equityCurve: [
      { t: START, v: 10_000, peak: 10_000 },
      { t: START + 3600, v: 10_050, peak: 10_050 },
    ],
    trades: [
      makeTrade({ id: 'trade-win' }),
      makeTrade({
        id: 'trade-loss',
        side: 'sell',
        volume: 0.5,
        entry: 2010,
        exit: 2020,
        openTs: START + 7200,
        closeTs: START + 9000,
        profit: -50,
        r: -1,
        tag: '回调',
        closedBy: 'sl',
        mfe: 10,
        mae: -60,
        templateName: '日内',
      }),
    ],
    ...overrides,
  });
  useReplay.setState({ sessions: [session] });
  return session;
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  useReplay.setState({
    sessions: [],
    activeId: null,
    hydrated: true,
    storageMode: 'gateway',
  });
  useApp.setState({ privacy: false, page: 'replay', journalFocus: null, account: null });
});

describe('ReplayReport 汇总指标与分组', () => {
  it('显示交易次数、胜率、净盈亏与平均 R', () => {
    setup();
    render(<ReplayReport sessionId="report-1" />);

    expect(screen.getByText('50.0%')).toBeInTheDocument();
    expect(screen.getByText('1 胜 / 1 负')).toBeInTheDocument();
    expect(screen.getAllByText('+50.00')).toHaveLength(2);
    expect(screen.getByText('毛利 100.00 · 亏损 50.00')).toBeInTheDocument();
    expect(screen.getByText('每笔期望 +25.00')).toBeInTheDocument();
    expect(screen.getByText('总 R +1.00')).toBeInTheDocument();
    expect(screen.getByText('-4.2%')).toBeInTheDocument();
    expect(screen.getByText('共 2 笔 · 已扣佣金')).toBeInTheDocument();
  });

  it('按标签分组，并在交易明细里显示方向与持仓时间', () => {
    setup();
    render(<ReplayReport sessionId="report-1" />);

    // 「按标签」表按每笔交易的 tag 汇总
    const tagSection = screen.getByText('按标签').parentElement as HTMLElement;
    expect(within(tagSection).getByText('突破')).toBeInTheDocument();
    expect(within(tagSection).getByText('回调')).toBeInTheDocument();

    // 交易明细列方向；入场/出场时间来自 openTs/closeTs
    expect(screen.getAllByText('买入').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('卖出').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('11-15 01:00').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('11-15 02:00').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('11-15 03:00').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('11-15 03:30').length).toBeGreaterThanOrEqual(1);

    expect(screen.getByText('2 个采样点')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '模拟净值曲线' })).toBeInTheDocument();
  });

  it('没有交易时给出空态与零值口径', () => {
    setup({ trades: [], equity: 10_000 });
    render(<ReplayReport sessionId="report-1" />);

    expect(screen.getByText('没有已平仓交易')).toBeInTheDocument();
    expect(
      screen.getByText('这段回放没有已平仓交易。下次可以先按模板给出一张带止损的单。'),
    ).toBeInTheDocument();
    expect(screen.getByText('共 0 笔 · 已扣佣金')).toBeInTheDocument();
  });
});

describe('ReplayReport 隐私模式', () => {
  it('金额被掩码成 ••••，不泄漏具体金额', () => {
    setup();
    useApp.setState({ privacy: true, page: 'replay' });
    render(<ReplayReport sessionId="report-1" />);

    expect(screen.getAllByText('••••').length).toBeGreaterThan(0);
    expect(screen.getByText(/初始 •••• USD/)).toBeInTheDocument();

    expect(screen.queryByText('+50.00')).not.toBeInTheDocument();
    expect(screen.queryByText('10,000.00')).not.toBeInTheDocument();
    expect(screen.queryByText('毛利 100.00 · 亏损 50.00')).not.toBeInTheDocument();
    expect(screen.queryByText('+100.00')).not.toBeInTheDocument();

    // 价格不是金额，仍然可读
    expect(screen.getByText('2000.00')).toBeInTheDocument();
  });
});

describe('ReplayReport 返回入口', () => {
  it('有返回记录时点击「返回交易日志」聚焦对应持仓并切回记录页', async () => {
    setup();
    window.sessionStorage.setItem(
      'mytrade.replay.back',
      JSON.stringify({ page: 'journal', label: '交易日志', positionId: 42 }),
    );
    const user = userEvent.setup();
    render(<ReplayReport sessionId="report-1" />);

    await user.click(screen.getByRole('button', { name: '返回交易日志' }));

    expect(useApp.getState().journalFocus).toBe(42);
    expect(useApp.getState().page).toBe('records');
    expect(window.sessionStorage.getItem('mytrade.replay.back')).toBeNull();
  });

  it('左上角返回按钮回到复盘列表', async () => {
    setup();
    const user = userEvent.setup();
    render(<ReplayReport sessionId="report-1" />);

    await user.click(screen.getByRole('button', { name: '返回复盘列表' }));

    expect(window.location.hash).toBe('#/replay');
  });

  it('会话不存在时显示空态并可以返回列表', () => {
    render(<ReplayReport sessionId="missing" />);

    expect(screen.getByText('复盘会话不存在')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '返回复盘列表' })).toBeInTheDocument();
  });
});
