import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gateway } from '../gateway/client';
import type { TradeNoteDetail } from '../gateway/types';
import { useApp } from '../store/useApp';
import { ReferencePanel } from './ReferencePanel';
import { useReplay } from './store';
import { makeSession } from './testUtils';
import type { ReplayFill, ReplayReference, ReplaySession } from './types';

const START = Date.UTC(2026, 10, 15, 1, 0) / 1000;

const FILLS: ReplayFill[] = [
  { ticket: 11, entry: 'in', volume: 1, price: 2000.5, time: START, profit: 0 },
  { ticket: 12, entry: 'out', volume: 0.5, price: 2001.5, time: START + 1800, profit: 50 },
];

function makeReference(overrides: Partial<ReplayReference> = {}): ReplayReference {
  return {
    kind: 'journal',
    login: 11,
    positionId: 88,
    symbol: 'XAUUSD',
    openTs: START,
    closeTs: START + 3900,
    side: 'buy',
    volume: 1,
    entry: 2000.5,
    exit: 2001.5,
    sl: 1995,
    tp: 2005,
    profit: 100,
    r: 2,
    mfe: 120,
    mae: -30,
    tag: '突破',
    closedBy: 'tp',
    hasShot: false,
    key: '11:88',
    ...overrides,
  };
}

function makeSessionWith(reference?: ReplayReference, overrides: Partial<ReplaySession> = {}) {
  return makeSession({
    id: 'ref-session',
    status: 'ready',
    dataSource: 'gateway',
    cursorIndex: 5,
    cursorTs: START + 300,
    reference,
    ...overrides,
  });
}

const NOTE: TradeNoteDetail = {
  positionId: 88,
  playbookId: null,
  playbookName: null,
  rating: null,
  mistakes: [],
  note: '',
  reviewedAt: null,
  rules: [],
  preTrade: null,
  playbooks: [],
  trade: {
    positionId: 88,
    symbol: 'XAUUSD',
    side: 'buy',
    volume: 1,
    openTime: START,
    closeTime: START + 3900,
    profit: 100,
    r: 2,
  },
};

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(gateway, 'call').mockResolvedValue(NOTE);
  useApp.setState({ privacy: false, page: 'replay', account: null });
  useReplay.setState({ sessions: [] });
});

describe('ReferencePanel 参照交易摘要', () => {
  it('显示方向、入场、出场、盈亏与持仓时长', () => {
    render(
      <ReferencePanel
        session={makeSessionWith(makeReference())}
        onRetry={() => {}}
        onToggleVisible={() => {}}
      />,
    );

    expect(screen.getByText('参照交易 · 实盘')).toBeInTheDocument();
    expect(screen.getByText('#88')).toBeInTheDocument();
    expect(screen.getByText('多 1.00')).toBeInTheDocument();
    expect(screen.getByText('+100.00')).toBeInTheDocument();
    expect(screen.getByText('+2.00R')).toBeInTheDocument();
    expect(screen.getByText('2000.50')).toBeInTheDocument();
    expect(screen.getByText('2001.50')).toBeInTheDocument();
    expect(screen.getByText('1995.00')).toBeInTheDocument();
    expect(screen.getByText('2005.00')).toBeInTheDocument();
    expect(screen.getByText('120.00')).toBeInTheDocument();
    expect(screen.getByText('-30.00')).toBeInTheDocument();
    expect(screen.getByText('1 小时 5 分')).toBeInTheDocument();
    expect(screen.getAllByText('止盈').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('这笔交易没有保存截图。')).toBeInTheDocument();
  });

  it('隐私模式下盈亏与 MFE/MAE 被掩码，价格仍可读', () => {
    useApp.setState({ privacy: true, page: 'replay' });
    render(
      <ReferencePanel
        session={makeSessionWith(makeReference())}
        onRetry={() => {}}
        onToggleVisible={() => {}}
      />,
    );

    expect(screen.queryByText('+100.00')).not.toBeInTheDocument();
    expect(screen.queryByText('+2.00R')).not.toBeInTheDocument();
    expect(screen.queryByText('120.00')).not.toBeInTheDocument();
    expect(screen.getAllByText('••••').length).toBeGreaterThanOrEqual(2);

    expect(screen.getByText('2000.50')).toBeInTheDocument();
    expect(screen.getByText('2001.50')).toBeInTheDocument();
  });

  it('没有关联实盘交易时显示空态，也不去网关读取复盘', () => {
    render(
      <ReferencePanel session={makeSessionWith()} onRetry={() => {}} onToggleVisible={() => {}} />,
    );

    expect(screen.getByText('这个会话没有关联实盘交易。')).toBeInTheDocument();
    expect(gateway.call).not.toHaveBeenCalled();
  });
});

describe('ReferencePanel 逐笔成交', () => {
  it('按票号渲染开仓/平仓成交与各自盈亏', () => {
    render(
      <ReferencePanel
        session={makeSessionWith(makeReference({ fills: FILLS }))}
        onRetry={() => {}}
        onToggleVisible={() => {}}
      />,
    );

    expect(screen.getByText('逐笔成交')).toBeInTheDocument();
    expect(screen.getByText('2 笔')).toBeInTheDocument();
    expect(screen.getByText('开仓')).toBeInTheDocument();
    expect(screen.getAllByText('平仓').length).toBeGreaterThanOrEqual(2);
    // 开仓成交没有盈亏，显示占位；平仓成交显示 +50.00
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('+50.00')).toBeInTheDocument();
    expect(screen.getByText('0.50')).toBeInTheDocument();
  });

  it('没有逐笔成交时不渲染成交表', () => {
    render(
      <ReferencePanel
        session={makeSessionWith(makeReference())}
        onRetry={() => {}}
        onToggleVisible={() => {}}
      />,
    );

    expect(screen.queryByText('逐笔成交')).not.toBeInTheDocument();
  });
});

describe('ReferencePanel 参照层开关与重演', () => {
  it('参照层隐藏时按钮提示「显示参照层」，点击交给父级处理', async () => {
    const user = userEvent.setup();
    const onToggleVisible = vi.fn();
    render(
      <ReferencePanel
        session={makeSessionWith(makeReference(), { referenceVisible: false })}
        onRetry={() => {}}
        onToggleVisible={onToggleVisible}
      />,
    );

    await user.click(screen.getByRole('button', { name: '显示参照层' }));
    expect(onToggleVisible).toHaveBeenCalledTimes(1);
  });

  it('演示数据的参照层默认隐藏并给出提示', () => {
    render(
      <ReferencePanel
        session={makeSessionWith(makeReference(), { dataSource: 'demo' })}
        onRetry={() => {}}
        onToggleVisible={() => {}}
      />,
    );

    expect(
      screen.getByText('演示数据 · 不能作为真实行情对照。参照层默认隐藏，需要手动打开。'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '显示参照层' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '隐藏参照层' })).not.toBeInTheDocument();
  });

  it('参照层可见时按钮变成「隐藏参照层」', () => {
    render(
      <ReferencePanel
        session={makeSessionWith(makeReference(), { referenceVisible: true })}
        onRetry={() => {}}
        onToggleVisible={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: '隐藏参照层' })).toBeInTheDocument();
  });

  it('点击「重演这笔」触发父级回调', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <ReferencePanel
        session={makeSessionWith(makeReference())}
        onRetry={onRetry}
        onToggleVisible={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: '重演这笔' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
