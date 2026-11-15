import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useApp } from '../store/useApp';
import { cacheSummary, clearCache } from './cache';
import { ReplayList } from './ReplayList';
import { SESSION_SOFT_LIMIT, useReplay } from './store';
import { makeSession } from './testUtils';

vi.mock('./cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cache')>();
  return { ...actual, cacheSummary: vi.fn(), clearCache: vi.fn() };
});

const MB = 1024 * 1024;

function cacheRows() {
  return [
    { symbol: 'XAUUSD', bars: 120, bytes: 2 * MB },
    { symbol: 'EURUSD', bars: 80, bytes: 1 * MB },
  ];
}

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(cacheSummary).mockReset();
  vi.mocked(cacheSummary).mockResolvedValue(cacheRows());
  vi.mocked(clearCache).mockReset();
  vi.mocked(clearCache).mockResolvedValue(undefined);
  useReplay.setState({
    sessions: [],
    activeId: null,
    hydrated: true,
    playing: false,
    loading: null,
    storageMode: 'gateway',
  });
  useApp.setState({ privacy: false, page: 'replay' });
});

describe('ReplayList 本地行情缓存概览', () => {
  it('汇总所有缓存品种的品种数、总根数与合计体积', async () => {
    render(<ReplayList onCreate={() => {}} />);

    expect(await screen.findByText('2 个品种 · 200 根 · 3.0 MB')).toBeInTheDocument();
  });

  it('没有缓存时显示空态文案', async () => {
    vi.mocked(cacheSummary).mockResolvedValue([]);
    render(<ReplayList onCreate={() => {}} />);

    expect(await screen.findByText('还没有缓存行情')).toBeInTheDocument();
  });

  it('清理缓存需要确认；确认后调用 clearCache 并清空概览', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<ReplayList onCreate={() => {}} />);

    await screen.findByText('2 个品种 · 200 根 · 3.0 MB');

    await user.click(screen.getByRole('button', { name: '清理缓存' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(clearCache).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: '清理缓存' }));

    await waitFor(() => expect(clearCache).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('还没有缓存行情')).toBeInTheDocument();
  });
});

describe('ReplayList 会话来源筛选与状态', () => {
  function seedSessions() {
    const journal = makeSession({
      id: 's-journal',
      name: '实盘来源复盘',
      origin: 'journal',
      status: 'paused',
      updatedAt: 5_000,
    });
    const missed = makeSession({
      id: 's-missed',
      name: '机会来源复盘',
      origin: 'missed',
      status: 'finished',
      updatedAt: 6_000,
      equity: 11_000,
    });
    const manual = makeSession({
      id: 's-manual',
      name: '手动复盘',
      origin: 'manual',
      status: 'ready',
      updatedAt: 4_000,
    });
    const archived = makeSession({
      id: 's-archived',
      name: '归档复盘',
      origin: 'manual',
      status: 'archived',
      updatedAt: 3_000,
    });
    const broken = makeSession({
      id: 's-error',
      name: '数据不足复盘',
      origin: 'manual',
      status: 'error',
      updatedAt: 2_000,
      totalBars: 0,
    });
    useReplay.setState({
      sessions: [journal, missed, manual, archived, broken],
      storageMode: 'gateway',
    });
    return { journal, missed, manual, archived, broken };
  }

  it('来源筛选只在列表里保留对应会话，并更新计数', async () => {
    const user = userEvent.setup();
    seedSessions();
    render(<ReplayList onCreate={() => {}} />);

    const table = () => within(screen.getByRole('table'));

    expect(screen.getByText('共 5 个会话')).toBeInTheDocument();
    expect(table().getByText('实盘来源复盘')).toBeInTheDocument();
    expect(table().getByText('机会来源复盘')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '来自实盘' }));
    expect(screen.getByText('共 1 个会话')).toBeInTheDocument();
    expect(table().getByText('实盘来源复盘')).toBeInTheDocument();
    expect(table().queryByText('机会来源复盘')).not.toBeInTheDocument();
    expect(table().queryByText('手动复盘')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '来自机会' }));
    expect(table().getByText('机会来源复盘')).toBeInTheDocument();
    expect(table().queryByText('实盘来源复盘')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '手动新建' }));
    expect(screen.getByText('共 3 个会话')).toBeInTheDocument();
    expect(table().getByText('手动复盘')).toBeInTheDocument();
    expect(table().getByText('归档复盘')).toBeInTheDocument();
    expect(table().getByText('数据不足复盘')).toBeInTheDocument();
    expect(table().queryByText('实盘来源复盘')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '全部' }));
    expect(screen.getByText('共 5 个会话')).toBeInTheDocument();
  });

  it('每个会话按状态显示不同文案与操作入口', () => {
    seedSessions();
    render(<ReplayList onCreate={() => {}} />);

    expect(screen.getAllByText('进行中').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('已完成').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('已归档').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('数据不足').length).toBeGreaterThanOrEqual(1);

    // 已完成显示「报告」，已归档显示「查看」
    expect(screen.getAllByRole('button', { name: '报告' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('button', { name: '查看' }).length).toBeGreaterThanOrEqual(1);
  });

  it('来源筛选没有匹配时给出对应的空态提示', async () => {
    const user = userEvent.setup();
    useReplay.setState({
      sessions: [makeSession({ id: 'only-manual', name: '只有手动', origin: 'manual' })],
    });
    render(<ReplayList onCreate={() => {}} />);

    await user.click(screen.getByRole('button', { name: '来自实盘' }));
    expect(
      screen.getByText('还没有从实盘交易创建的会话。到交易日志点「回放」即可。'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '来自机会' }));
    expect(
      screen.getByText('还没有从错过的机会创建的会话。到「错过的机会」点「在回放中看」即可。'),
    ).toBeInTheDocument();
  });

  it('当前会话卡片优先显示进行中的会话，而不是更新的已完成会话', () => {
    useReplay.setState({
      sessions: [
        makeSession({
          id: 'active',
          name: '进行中的复盘',
          status: 'paused',
          updatedAt: 5_000,
          cursorIndex: 20,
          totalBars: 100,
        }),
        makeSession({
          id: 'finished',
          name: '最新的已完成',
          status: 'finished',
          updatedAt: 9_000,
          equity: 10_200,
        }),
      ],
    });
    render(<ReplayList onCreate={() => {}} />);

    expect(screen.getByRole('button', { name: '继续复盘' })).toBeInTheDocument();
    expect(screen.getAllByText('进行中的复盘')).toHaveLength(2);
    expect(screen.getByText('已回放 20% · 20 根')).toBeInTheDocument();
  });
});

describe('ReplayList 软上限提示', () => {
  it('会话数达到软上限时提示归档旧会话，降到上限以下后消失', () => {
    const sessions = Array.from({ length: SESSION_SOFT_LIMIT }, (_, index) =>
      makeSession({ id: `soft-${index}`, name: `会话 ${index}`, updatedAt: index }),
    );
    useReplay.setState({ sessions });
    const { unmount } = render(<ReplayList onCreate={() => {}} />);

    expect(screen.getByText(/建议归档旧会话/)).toBeInTheDocument();
    expect(screen.getByText(`共 ${SESSION_SOFT_LIMIT} 个会话 · 建议归档旧会话`)).toBeInTheDocument();

    unmount();
    useReplay.setState({ sessions: sessions.slice(0, SESSION_SOFT_LIMIT - 1) });
    render(<ReplayList onCreate={() => {}} />);
    expect(screen.queryByText(/建议归档旧会话/)).not.toBeInTheDocument();
  });
});
