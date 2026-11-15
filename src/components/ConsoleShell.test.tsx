import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Position } from '../gateway/types';
import { useApp } from '../store/useApp';
import { ConsoleShell } from './ConsoleShell';

function resetApp() {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  useApp.setState({
    page: 'overview',
    conn: 'closed',
    health: null,
    account: null,
    positions: [],
    orders: [],
    riskStatus: null,
    privacy: false,
    paletteOpen: false,
    settingsSection: 'appearance',
    settingsReturn: null,
    recordsTab: 'list',
    insightsTab: 'reports',
    disciplineTab: 'strategy',
    exportDays: 30,
    toast: null,
  });
}

function renderShell() {
  return render(
    <ConsoleShell>
      <div>页面内容</div>
    </ConsoleShell>,
  );
}

describe('ConsoleShell', () => {
  beforeEach(resetApp);

  it('显示五个分组标题和六个顶层入口', () => {
    renderShell();

    for (const label of ['工作台', '复盘', '记录', '分析', '纪律']) {
      const matches = screen.getAllByText(label);
      // 分组标题是纯文本，不在任何按钮里；「分析」「纪律」同时是入口按钮
      expect(matches.some((el) => el.closest('button') === null)).toBe(true);
    }

    for (const label of ['概览', '交易台', '历史复盘', '交易记录', '分析', '纪律']) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it('点击顶层入口调用 setPage 切换页面', async () => {
    const user = userEvent.setup();
    renderShell();

    const entries: [string, string][] = [
      ['概览', 'overview'],
      ['交易台', 'trade'],
      ['历史复盘', 'replay'],
      ['交易记录', 'records'],
      ['分析', 'insights'],
      ['纪律', 'discipline'],
    ];

    for (const [label, page] of entries) {
      await user.click(screen.getByRole('button', { name: new RegExp(label) }));
      expect(useApp.getState().page).toBe(page);
    }
  });

  it('复盘页侧栏显示「复盘模式 · 不连接实盘」', () => {
    useApp.setState({ page: 'replay' });
    renderShell();

    expect(screen.getByText('复盘模式 · 不连接实盘')).toBeInTheDocument();
    expect(screen.getByText('未选择复盘会话')).toBeInTheDocument();
  });

  it('点击隐私模式按钮切换 privacy', async () => {
    const user = userEvent.setup();
    useApp.setState({ privacy: false });
    renderShell();

    const button = screen.getByRole('button', { name: /隐私模式/ });
    expect(button).toHaveAttribute('aria-pressed', 'false');

    await user.click(button);

    expect(useApp.getState().privacy).toBe(true);
    expect(button).toHaveAttribute('aria-pressed', 'true');
  });

  it('交易台徽标显示持仓数', () => {
    useApp.setState({
      positions: [{ ticket: 1 }, { ticket: 2 }, { ticket: 3 }] as unknown as Position[],
    });
    renderShell();

    const trade = screen.getByRole('button', { name: /交易台/ });
    expect(within(trade).getByText('3')).toBeInTheDocument();
  });
});
