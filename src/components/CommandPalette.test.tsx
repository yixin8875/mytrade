import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import { CommandPalette } from './CommandPalette';

function resetApp() {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  useApp.setState({
    page: 'overview',
    conn: 'closed',
    paletteOpen: false,
    exportDays: 30,
    settingsSection: 'appearance',
    settingsReturn: null,
    toast: null,
  });
}

function openPalette() {
  useApp.setState({ paletteOpen: true });
  render(<CommandPalette />);
  return screen.getByPlaceholderText('跳转页面、导出数据、打开日历…');
}

describe('CommandPalette', () => {
  beforeEach(resetApp);

  it('命令包含 13 个「设置：…」项与复盘入口', () => {
    openPalette();

    expect(screen.getAllByText(/^设置：/)).toHaveLength(13);
    expect(screen.getByText('新建复盘')).toBeInTheDocument();
    expect(screen.getByText('继续上次复盘')).toBeInTheDocument();
  });

  it('输入「设置」只保留设置相关命令', () => {
    const input = openPalette();

    fireEvent.change(input, { target: { value: '设置' } });

    expect(screen.getAllByText(/^设置：/)).toHaveLength(13);
    expect(screen.getByText('前往设置')).toBeInTheDocument();
    expect(screen.queryByText('新建复盘')).not.toBeInTheDocument();
    expect(screen.queryAllByText(/^导出交易日志/)).toHaveLength(0);
  });

  it('输入「replay」命中复盘相关命令', () => {
    const input = openPalette();

    fireEvent.change(input, { target: { value: 'replay' } });

    expect(screen.getByText('前往历史复盘')).toBeInTheDocument();
    expect(screen.getByText('新建复盘')).toBeInTheDocument();
    expect(screen.getByText('继续上次复盘')).toBeInTheDocument();
    expect(screen.queryAllByText(/^设置：/)).toHaveLength(0);
  });

  it('执行「设置：诊断」打开设置并选中诊断分区', async () => {
    const user = userEvent.setup();
    openPalette();

    await user.click(screen.getByText('设置：诊断'));

    expect(useApp.getState().settingsSection).toBe('diagnostics');
    expect(useApp.getState().page).toBe('settings');
    expect(useApp.getState().paletteOpen).toBe(false);
  });

  it('导出命令标签：exportDays 为 0 时显示「全部」', () => {
    useApp.setState({ exportDays: 0 });
    openPalette();

    expect(screen.getByText('导出交易日志 CSV（全部）')).toBeInTheDocument();
  });

  it('导出命令标签：exportDays 为 30 时显示「30 天」并调用 data.export', async () => {
    const spy = vi
      .spyOn(gateway, 'call')
      .mockResolvedValue({ name: 'journal.csv', rows: 12 } as never);
    const user = userEvent.setup();
    useApp.setState({ exportDays: 30 });
    openPalette();

    await user.click(screen.getByText('导出交易日志 CSV（30 天）'));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith('data.export', { kind: 'journal', days: 30 }, 30_000),
    );
    expect(useApp.getState().paletteOpen).toBe(false);
  });

  it('按 Esc 关闭命令面板', () => {
    const input = openPalette();

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(useApp.getState().paletteOpen).toBe(false);
  });
});
