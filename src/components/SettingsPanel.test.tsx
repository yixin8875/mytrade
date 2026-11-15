import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import { SettingsPanel } from './SettingsPanel';

type CallImpl = (
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<unknown>;

function resetApp() {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  useApp.setState({
    page: 'settings',
    conn: 'closed',
    health: null,
    account: null,
    settingsSection: 'appearance',
    settingsReturn: null,
    exportDays: 30,
    toast: null,
  });
}

function mockGateway() {
  const impl: CallImpl = (method) => {
    if (method === 'data.backup.list') return Promise.resolve([]);
    if (method === 'data.info') {
      return Promise.resolve({
        dir: 'C:/data',
        exports: 'C:/data/exports',
        backups: 'C:/data/backups',
      });
    }
    if (method === 'data.export') {
      return Promise.resolve({
        kind: 'json',
        name: 'export.json',
        path: 'C:/data/exports/export.json',
        rows: 0,
        bytes: 0,
      });
    }
    return Promise.resolve([]);
  };
  return vi.spyOn(gateway, 'call').mockImplementation(impl as unknown as typeof gateway.call);
}

describe('SettingsPanel', () => {
  beforeEach(resetApp);

  it('左侧显示五个分组标题和全部分区按钮', () => {
    render(<SettingsPanel />);

    for (const group of ['界面', '交易', '账户与通知', '数据', '实验与系统']) {
      expect(screen.getByText(group)).toBeInTheDocument();
    }

    for (const label of [
      '外观',
      '图表',
      '交易模板',
      '交易与风控',
      '开仓纪律',
      'MT5 账户',
      '告警',
      '数据与备份',
      '诊断',
      'Pine 脚本',
      'AI 复盘',
      '更新',
      '数据与连接',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('点击「诊断」后挂载审计面板', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);

    await user.click(screen.getByRole('button', { name: '诊断' }));

    expect(useApp.getState().settingsSection).toBe('diagnostics');
    expect(screen.getByRole('button', { name: '立即对账' })).toBeInTheDocument();
    expect(
      screen.getByText('UTC 日期 · JSONL 文件 · 最多返回 300 条'),
    ).toBeInTheDocument();
  });

  it('「数据与备份」显示五个导出按钮，复盘会话 JSON 调用 data.export', async () => {
    const spy = mockGateway();
    const user = userEvent.setup();
    render(<SettingsPanel />);

    await user.click(screen.getByRole('button', { name: '数据与备份' }));

    for (const label of [
      '交易日志 CSV',
      '执行质量 CSV',
      '审计日志 JSONL',
      '设置 JSON',
      '复盘会话 JSON',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }

    await user.click(screen.getByText('复盘会话 JSON'));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(
        'data.export',
        expect.objectContaining({ kind: 'replay' }),
        30_000,
      ),
    );
  });

  it('settingsReturn 为 overview 时「返回」回到概览', async () => {
    const user = userEvent.setup();
    useApp.setState({ settingsReturn: 'overview' });
    render(<SettingsPanel />);

    await user.click(screen.getByRole('button', { name: '返回' }));

    expect(useApp.getState().page).toBe('overview');
  });

  it('导出天数来自 store，setExportDays 后导出使用新值', async () => {
    const spy = mockGateway();
    const user = userEvent.setup();
    useApp.setState({ settingsSection: 'data', exportDays: 30 });
    render(<SettingsPanel />);

    await user.click(screen.getByRole('button', { name: '7 天' }));
    expect(useApp.getState().exportDays).toBe(7);

    await user.click(screen.getByText('交易日志 CSV'));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(
        'data.export',
        expect.objectContaining({ kind: 'journal', days: 7 }),
        30_000,
      ),
    );
  });
});
