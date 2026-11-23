import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Position } from '../gateway/types';
import { useApp } from '../store/useApp';
import { TradeDock } from './TradeDock';

const POSITION = {
  ticket: 1,
  identifier: 1,
  symbol: 'XAUUSD',
  side: 'buy',
  volume: 0.1,
  openPrice: 2000,
  sl: 1990,
  tp: 2020,
  profit: 12.5,
  swap: 0,
  commission: -0.5,
  magic: 0,
  comment: '',
  openTime: 1_763_200_000,
} as Position;

function reset() {
  window.localStorage.clear();
  useApp.setState({
    positions: [],
    orders: [],
    symbols: [],
    symbol: 'XAUUSD',
    quote: null,
    dockTab: 'positions',
    dockCollapsed: false,
    dockHeight: 208,
  });
}

describe('TradeDock', () => {
  beforeEach(reset);

  it('显示四个页签和空态', () => {
    render(<TradeDock />);

    expect(screen.getByRole('tab', { name: /持仓/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /挂单/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /成交/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /已平仓/ })).toBeInTheDocument();
    expect(screen.getByText('当前没有持仓')).toBeInTheDocument();
  });

  it('切到挂单页签显示挂单空态', async () => {
    const user = userEvent.setup();
    render(<TradeDock />);

    await user.click(screen.getByRole('tab', { name: /挂单/ }));

    expect(screen.getByText('当前没有挂单')).toBeInTheDocument();
    expect(useApp.getState().dockTab).toBe('orders');
  });

  it('持仓行显示方向、手数与盈亏，并可展开设置', async () => {
    useApp.setState({ positions: [POSITION] });
    const user = userEvent.setup();
    render(<TradeDock />);

    expect(screen.getByText('XAUUSD')).toBeInTheDocument();
    expect(screen.getByText('+12.50')).toBeInTheDocument();
    expect(screen.getByText('平掉一半')).toBeInTheDocument();

    await user.click(screen.getByText('XAUUSD'));

    expect(screen.getByLabelText('XAUUSD 止损价')).toHaveValue('1990.00000');
    expect(screen.getByLabelText('XAUUSD 止盈价')).toHaveValue('2020.00000');
  });

  it('清仓按钮写清作用域，二次点击才确认', async () => {
    const user = userEvent.setup();
    render(<TradeDock />);

    const flatten = screen.getByRole('button', { name: '平掉 XAUUSD 全部' });
    const closeAll = screen.getByRole('button', { name: '平掉账户全部' });
    expect(flatten).toHaveAttribute('title', '平掉 XAUUSD 的全部持仓，并撤销该品种挂单');

    await user.click(flatten);
    expect(screen.getByRole('button', { name: '确认平掉 XAUUSD 全部？' })).toBeInTheDocument();

    await user.click(closeAll);
    expect(screen.getByRole('button', { name: '确认平掉所有品种？' })).toBeInTheDocument();
  });

  it('收起后只留一条摘要，展开恢复原高度', async () => {
    const user = userEvent.setup();
    render(<TradeDock />);

    await user.click(screen.getByRole('button', { name: '收起托盘' }));

    expect(useApp.getState().dockCollapsed).toBe(true);
    expect(document.querySelector('[data-dock]')).toHaveStyle({ height: '32px' });
    expect(window.localStorage.getItem('mytrade.dockCollapsed')).toBe('1');

    await user.click(screen.getByRole('button', { name: '展开托盘' }));
    expect(useApp.getState().dockCollapsed).toBe(false);
  });

  it('高度会被夹在 120–480 之间并持久化', () => {
    useApp.getState().setDockHeight(300);
    expect(useApp.getState().dockHeight).toBe(300);
    expect(window.localStorage.getItem('mytrade.dockHeight')).toBe('300');

    useApp.getState().setDockHeight(9999);
    expect(useApp.getState().dockHeight).toBe(480);

    useApp.getState().setDockHeight(10);
    expect(useApp.getState().dockHeight).toBe(120);
  });
});
