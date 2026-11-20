import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gateway } from '../gateway/client';
import type { SymbolInfo, WatchlistRow } from '../gateway/types';
import { useApp } from '../store/useApp';
import { GOLD_INFO } from '../replay/testUtils';
import { WatchlistPanel } from './WatchlistPanel';

const SYMBOLS: SymbolInfo[] = [
  { ...GOLD_INFO, name: 'XAUUSD', description: 'Gold' },
  { ...GOLD_INFO, name: 'EURUSD', description: 'Euro vs US Dollar' },
] as SymbolInfo[];

const ROWS: WatchlistRow[] = [
  {
    symbol: 'XAUUSD',
    description: 'Gold',
    digits: 2,
    point: 0.01,
    bid: 2000,
    ask: 2000.5,
    spreadPoints: 50,
    changePct: 1.25,
    hasPosition: true,
  },
  {
    symbol: 'EURUSD',
    description: 'Euro vs US Dollar',
    digits: 5,
    point: 0.00001,
    bid: 1.085,
    ask: 1.0852,
    spreadPoints: 20,
    changePct: -0.4,
    hasPosition: false,
  },
];

function reset() {
  window.localStorage.clear();
  useApp.setState({
    conn: 'open',
    symbols: SYMBOLS,
    symbol: 'XAUUSD',
    watchlist: ['XAUUSD', 'EURUSD'],
    watchRows: ROWS,
    orders: [],
    watchColumnOpen: true,
  });
  vi.spyOn(gateway, 'call').mockImplementation((async (method: string) => {
    if (method === 'watchlist.get') return ROWS;
    return [];
  }) as never);
}

describe('WatchlistPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    reset();
  });

  it('以表格显示自选品种的买卖价与涨跌', () => {
    render(<WatchlistPanel />);

    expect(screen.getByText('XAUUSD')).toBeInTheDocument();
    expect(screen.getByText('2000.00')).toBeInTheDocument();
    expect(screen.getByText('1.08500')).toBeInTheDocument();
    expect(screen.getByText('+1.25%')).toBeInTheDocument();
  });

  it('搜索只保留匹配的品种', async () => {
    const user = userEvent.setup();
    render(<WatchlistPanel />);

    await user.type(screen.getByLabelText('搜索自选品种'), 'EUR');

    expect(screen.queryByText('XAUUSD')).not.toBeInTheDocument();
    expect(screen.getByText('EURUSD')).toBeInTheDocument();
  });

  it('持仓中筛选只保留有持仓的品种', async () => {
    const user = userEvent.setup();
    render(<WatchlistPanel />);

    await user.click(screen.getByRole('button', { name: '持仓中' }));

    expect(screen.getByText('XAUUSD')).toBeInTheDocument();
    expect(screen.queryByText('EURUSD')).not.toBeInTheDocument();
  });

  it('点击行切换图表品种', async () => {
    const user = userEvent.setup();
    render(<WatchlistPanel />);

    await user.click(screen.getByText('EURUSD'));

    expect(useApp.getState().symbol).toBe('EURUSD');
  });

  it('可以收起行情列', async () => {
    const user = userEvent.setup();
    render(<WatchlistPanel />);

    await user.click(screen.getByRole('button', { name: '收起行情列' }));

    expect(useApp.getState().watchColumnOpen).toBe(false);
  });
});
