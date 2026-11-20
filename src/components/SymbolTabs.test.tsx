import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SymbolInfo, WatchlistRow } from '../gateway/types';
import { useApp } from '../store/useApp';
import { GOLD_INFO } from '../replay/testUtils';
import { SymbolTabs } from './SymbolTabs';

const INFO = (name: string, description: string): SymbolInfo =>
  ({ ...GOLD_INFO, name, description }) as SymbolInfo;

const SYMBOLS = [
  INFO('XAUUSD', 'Gold'),
  INFO('EURUSD', 'Euro vs US Dollar'),
  INFO('GBPUSD', 'Pound vs US Dollar'),
];

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
    hasPosition: false,
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
    symbols: SYMBOLS,
    openSymbols: ['XAUUSD', 'EURUSD'],
    symbol: 'XAUUSD',
    quote: null,
    watchRows: ROWS,
  });
}

describe('SymbolTabs', () => {
  beforeEach(reset);

  it('显示已打开品种与价格涨跌', () => {
    render(<SymbolTabs />);

    expect(screen.getByRole('button', { name: /^XAUUSD/ })).toBeInTheDocument();
    expect(screen.getByText('+1.25%')).toBeInTheDocument();
    expect(screen.getByText('-0.40%')).toBeInTheDocument();
  });

  it('点击标签切换品种', async () => {
    const user = userEvent.setup();
    render(<SymbolTabs />);

    await user.click(screen.getByRole('button', { name: /^EURUSD/ }));

    expect(useApp.getState().symbol).toBe('EURUSD');
    expect(useApp.getState().openSymbols[0]).toBe('EURUSD');
  });

  it('关闭当前标签后切到相邻品种并持久化', async () => {
    const user = userEvent.setup();
    render(<SymbolTabs />);

    await user.click(screen.getByRole('button', { name: '关闭 XAUUSD' }));

    expect(useApp.getState().openSymbols).toEqual(['EURUSD']);
    expect(useApp.getState().symbol).toBe('EURUSD');
    expect(JSON.parse(window.localStorage.getItem('mytrade.openSymbols') ?? '[]')).toEqual([
      'EURUSD',
    ]);
  });

  it('从搜索列表添加新标签', async () => {
    const user = userEvent.setup();
    render(<SymbolTabs />);

    await user.click(screen.getByRole('button', { name: '添加品种' }));
    await user.type(screen.getByLabelText('搜索品种'), 'GBP');
    await user.click(screen.getByRole('button', { name: /GBPUSD/ }));

    expect(useApp.getState().symbol).toBe('GBPUSD');
    expect(useApp.getState().openSymbols).toContain('GBPUSD');
  });
});
