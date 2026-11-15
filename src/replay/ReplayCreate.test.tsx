import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bar, SymbolInfo } from '../gateway/types';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import { readCachedBars } from './cache';
import { ReplayCreate } from './ReplayCreate';
import { useReplay, type NewSessionInput } from './store';
import { GOLD_INFO, makeBar } from './testUtils';

vi.mock('./cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cache')>();
  return { ...actual, readCachedBars: vi.fn() };
});

const SEC = (year: number, month: number, day: number, hour = 0, minute = 0) =>
  Date.UTC(year, month - 1, day, hour, minute) / 1000;

const LATEST = SEC(2026, 11, 15);

const EURUSD: SymbolInfo = {
  ...GOLD_INFO,
  name: 'EURUSD',
  description: 'Euro vs US Dollar',
  digits: 5,
  point: 0.00001,
  tickSize: 0.00001,
  contractSize: 100_000,
  spreadPoints: 8,
  currency: 'USD',
};

function cachedRange(from: number, to: number): Bar[] {
  return [makeBar(from, 2000, 2001, 1999, 2000), makeBar(to, 2000, 2001, 1999, 2000)];
}

function coverageCells(): HTMLElement[] {
  const section = screen.getByText('数据覆盖').closest('section');
  const strip = section?.querySelector('[aria-hidden="true"]');
  return Array.from(strip?.children ?? []) as HTMLElement[];
}

function countByTone(tone: 'bg-console-gain' | 'bg-console-warn' | 'bg-console-line'): number {
  return coverageCells().filter((cell) => cell.className.includes(tone)).length;
}

function startInput(): HTMLInputElement {
  return screen.getByLabelText('开始时间') as HTMLInputElement;
}

function endInput(): HTMLInputElement {
  return screen.getByLabelText('结束时间') as HTMLInputElement;
}

async function waitForDefaults(): Promise<void> {
  await waitFor(() => expect(startInput().value).not.toBe(''));
  await waitFor(() => expect(endInput().value).not.toBe(''));
}

async function setRange(start: string, end: string): Promise<void> {
  fireEvent.change(startInput(), { target: { value: start } });
  fireEvent.change(endInput(), { target: { value: end } });
  await waitFor(() => {
    expect(startInput().value).toBe(start);
    expect(endInput().value).toBe(end);
  });
}

let createSession: ReturnType<typeof vi.fn<(input: NewSessionInput) => string>>;

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = '#/replay';
  createSession = vi.fn<(input: NewSessionInput) => string>(() => 'new-replay');
  vi.spyOn(gateway, 'call').mockImplementation((async (method: string) => {
    if (method === 'history.get') {
      return { bars: [makeBar(LATEST - 60, 2000, 2001, 1999, 2000)] };
    }
    throw new Error(`未预置的方法：${method}`);
  }) as typeof gateway.call);
  vi.mocked(readCachedBars).mockReset();
  vi.mocked(readCachedBars).mockResolvedValue(cachedRange(SEC(2026, 11, 1), SEC(2026, 11, 10)));
  useReplay.setState({
    sessions: [],
    activeId: null,
    hydrated: true,
    storageMode: 'gateway',
    createSession,
  });
  useApp.setState({
    symbols: [GOLD_INFO, EURUSD],
    symbol: 'XAUUSD',
    privacy: false,
    page: 'replay',
    account: null,
  });
});

describe('ReplayCreate 数据覆盖色条', () => {
  it('按本机缓存与所选区间的重叠比例填充，部分覆盖时留一格警示', async () => {
    render(<ReplayCreate open onClose={() => {}} />);

    await waitForDefaults();
    await screen.findByText(/本机缓存 2 根/);
    // 缓存 11-01 → 11-10，选择 11-05 → 11-15：正好一半
    await setRange('2026-11-05T00:00', '2026-11-15T00:00');

    await waitFor(() => expect(countByTone('bg-console-gain')).toBe(12));
    expect(coverageCells()).toHaveLength(24);
    expect(countByTone('bg-console-warn')).toBe(1);
    expect(countByTone('bg-console-line')).toBe(11);
    expect(coverageCells()[12].className).toContain('bg-console-warn');

    expect(screen.getByText('预计 10,080 根 M1')).toBeInTheDocument();
    expect(screen.getByText('约 0.5 MB')).toBeInTheDocument();
    expect(screen.getByText('10 天 · 10x 下约 1 小时')).toBeInTheDocument();
  });

  it('所选区间完全落在缓存内时 24 格全部填满且没有警示格', async () => {
    render(<ReplayCreate open onClose={() => {}} />);

    await waitForDefaults();
    await screen.findByText(/本机缓存 2 根/);
    await setRange('2026-11-02T00:00', '2026-11-09T00:00');

    await waitFor(() => expect(countByTone('bg-console-gain')).toBe(24));
    expect(countByTone('bg-console-warn')).toBe(0);
    expect(countByTone('bg-console-line')).toBe(0);
  });

  it('本机没有缓存时只留一格警示并提示将联网读取', async () => {
    vi.mocked(readCachedBars).mockResolvedValue([]);
    render(<ReplayCreate open onClose={() => {}} />);

    await waitForDefaults();
    await screen.findByText('本机暂无缓存，将联网读取');
    await setRange('2026-11-05T00:00', '2026-11-15T00:00');

    await waitFor(() => expect(countByTone('bg-console-warn')).toBe(1));
    expect(countByTone('bg-console-gain')).toBe(0);
    expect(coverageCells()[0].className).toContain('bg-console-warn');
  });
});

describe('ReplayCreate 提交校验', () => {
  it('开始或结束时间不完整时不创建会话，并提示补全', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ReplayCreate open onClose={onClose} />);

    await waitForDefaults();
    fireEvent.change(endInput(), { target: { value: '' } });
    await user.click(screen.getByRole('button', { name: '创建并准备数据' }));

    expect(screen.getByText('请填写完整的开始与结束时间')).toBeInTheDocument();
    expect(createSession).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('结束时间不晚于开始时间时不创建会话，并提示先后顺序', async () => {
    const user = userEvent.setup();
    render(<ReplayCreate open onClose={() => {}} />);

    await waitForDefaults();
    await setRange('2026-11-15T12:00', '2026-11-14T00:00');

    // 先去除默认区间带来的估算文案影响，再提交
    await user.click(screen.getByRole('button', { name: '创建并准备数据' }));

    expect(screen.getByText('结束时间需要晚于开始时间')).toBeInTheDocument();
    expect(createSession).not.toHaveBeenCalled();
  });

  it('区间合法时按所选区间调用 createSession，关闭弹窗并进入工作台', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ReplayCreate open onClose={onClose} />);

    await waitForDefaults();
    await setRange('2026-11-05T00:00', '2026-11-15T00:00');
    await user.click(screen.getByRole('button', { name: '创建并准备数据' }));

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'XAUUSD',
        startTs: SEC(2026, 11, 5),
        endTs: SEC(2026, 11, 15),
        settings: expect.objectContaining({
          initialBalance: 10000,
          currency: 'USD',
          leverage: 100,
          spreadPoints: 20,
          timeframe: '15',
        }),
      }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe('#/replay/new-replay');
  });
});
