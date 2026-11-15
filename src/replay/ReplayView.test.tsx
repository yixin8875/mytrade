import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import { ReplayView } from './ReplayView';
import { useReplay } from './store';
import { makeSession } from './testUtils';

const realHydrate = useReplay.getState().hydrate;

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = '#/replay';
  useApp.setState({ account: null, privacy: false, page: 'replay' });
  useReplay.setState({
    sessions: [],
    activeId: null,
    hydrated: false,
    playing: false,
    loading: null,
    storageMode: 'local',
    hydrate: realHydrate,
  });
});

describe('ReplayView 载入状态', () => {
  it('hydrate 完成前显示骨架与读取提示，不先闪「还没有复盘会话」', () => {
    useReplay.setState({ hydrate: vi.fn(() => new Promise<void>(() => {})) });
    render(<ReplayView />);

    expect(screen.getByText('正在从网关读取复盘会话…')).toBeInTheDocument();
    expect(screen.queryByText('还没有复盘会话')).not.toBeInTheDocument();
    expect(screen.queryByText('新建复盘')).not.toBeInTheDocument();
  });

  it('hydrate 完成后渲染复盘列表与已有会话', () => {
    useReplay.setState({
      hydrated: true,
      storageMode: 'gateway',
      sessions: [makeSession({ id: 'listed-1', name: '行情复盘甲' })],
    });
    render(<ReplayView />);

    expect(screen.getByRole('heading', { name: '复盘' })).toBeInTheDocument();
    expect(screen.getAllByText('行情复盘甲').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('正在从网关读取复盘会话…')).not.toBeInTheDocument();
  });

  it('网关离线时退回本机模式，并在列表上提示只读快照', async () => {
    const offline = makeSession({ id: 'offline-1', name: '离线复盘', updatedAt: 1_000 });
    window.localStorage.setItem('mytrade.replay.sessions', JSON.stringify([offline]));
    vi.spyOn(gateway, 'call').mockRejectedValue(
      Object.assign(new Error('网关未连接'), { code: 'OFFLINE' }),
    );
    render(<ReplayView />);

    expect((await screen.findAllByText('离线复盘')).length).toBeGreaterThanOrEqual(1);
    expect(useReplay.getState().storageMode).toBe('local');
    expect(useReplay.getState().hydrated).toBe(true);

    expect(screen.getByText('网关不可用 · 只读本机快照')).toBeInTheDocument();
    expect(screen.getByText('共 1 个会话 · 本机缓存（离线）')).toBeInTheDocument();
    expect(screen.getByText('网关离线 · 复盘会话暂存本机')).toBeInTheDocument();
  });
});
