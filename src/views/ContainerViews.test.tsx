import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import { DisciplineView } from './DisciplineView';
import { InsightsView } from './InsightsView';
import { RecordsView } from './RecordsView';

type CallImpl = (
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<unknown>;

function resetApp() {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  useApp.setState({
    page: 'records',
    conn: 'closed',
    account: null,
    health: null,
    symbols: [],
    recordsTab: 'list',
    insightsTab: 'reports',
    disciplineTab: 'strategy',
    journalFocus: null,
    journalFilter: {},
    journalDays: null,
    toast: null,
  });
}

function mockGateway() {
  const impl: CallImpl = (method) => {
    if (method === 'journal.stats') return Promise.resolve({});
    if (method === 'journal.list') return Promise.resolve([]);
    if (method === 'diary.calendar') {
      return Promise.resolve({
        month: '2026-11',
        today: '2026-11-15',
        timezoneOffsetMin: 480,
        weeks: [],
        summary: null,
      });
    }
    if (method === 'review.trades') {
      return Promise.resolve({
        days: 180,
        start: '2026-08-19',
        end: '2026-11-15',
        timezoneOffsetMin: 480,
        trades: [],
      });
    }
    if (method === 'strategy.list') return Promise.resolve({ playbooks: [] });
    if (method === 'strategy.adherence') return Promise.resolve({ books: [] });
    if (method === 'missed.list') return Promise.resolve({ missed: [], summary: null });
    if (method === 'routine.day') {
      return Promise.resolve({ date: '2026-11-15', items: [], total: 0, done: 0 });
    }
    if (method === 'routine.heatmap') return Promise.resolve({ weeks: [], days: [] });
    if (method === 'routine.list') return Promise.resolve({ routines: [] });
    return Promise.resolve([]);
  };
  return vi.spyOn(gateway, 'call').mockImplementation(impl as unknown as typeof gateway.call);
}

describe('RecordsView', () => {
  beforeEach(resetApp);

  it('默认挂载交易列表，切到盈亏日历后两个面板都保留', async () => {
    mockGateway();
    const user = userEvent.setup();
    render(<RecordsView />);

    expect(useApp.getState().recordsTab).toBe('list');
    expect(screen.getByRole('tab', { name: '交易列表' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('heading', { name: '交易日志' })).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: '盈亏日历' }));

    expect(useApp.getState().recordsTab).toBe('calendar');
    const journal = screen.getByRole('heading', { name: '交易日志' });
    const diary = screen.getByRole('heading', { name: '盈亏日历' });
    // keep-alive：两个面板都还在 DOM 里，只有非当前页签被 hidden 包裹
    expect(journal.closest('.hidden')).not.toBeNull();
    expect(diary.closest('.hidden')).toBeNull();
  });
});

describe('InsightsView', () => {
  beforeEach(resetApp);

  it('默认挂载报表，切到复盘后两个页签都保留且只取一次 review.trades', async () => {
    const call = mockGateway();
    const user = userEvent.setup();
    render(<InsightsView />);

    expect(useApp.getState().insightsTab).toBe('reports');
    expect(screen.getByRole('tab', { name: '报表' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: '统计报表' })).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: '复盘' }));

    expect(useApp.getState().insightsTab).toBe('review');
    expect(screen.getByRole('heading', { name: '绩效趋势' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '深度分析' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '统计报表' })).toBeInTheDocument();

    const reviews = call.mock.calls.filter(([method]) => method === 'review.trades');
    expect(reviews).toHaveLength(1);
  });
});

describe('DisciplineView', () => {
  beforeEach(resetApp);

  it('默认挂载策略手册，点错过机会切换页签', async () => {
    mockGateway();
    const user = userEvent.setup();
    render(<DisciplineView />);

    expect(useApp.getState().disciplineTab).toBe('strategy');
    expect(screen.getByRole('tab', { name: '策略手册' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('heading', { name: '策略手册' })).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: '错过机会' }));

    expect(useApp.getState().disciplineTab).toBe('missed');
    expect(screen.getByRole('heading', { name: '错过机会' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '策略手册' })).toBeInTheDocument();
  });
});
