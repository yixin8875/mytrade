import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GOLD_INFO } from '../replay/testUtils';
import { useApp } from '../store/useApp';
import type { DraftOrder, Quote } from '../gateway/types';
import type { IChartWidgetApi } from '../../public/charting_library/charting_library';

const mocks = vi.hoisted(() => ({ measurePriceAxis: vi.fn() }));

vi.mock('./ChartChips', () => ({
  measurePriceAxis: mocks.measurePriceAxis,
}));

import { ChartQuickActions } from './ChartQuickActions';

const QUOTE: Quote = {
  symbol: 'XAUUSD',
  bid: 3980,
  ask: 3980.2,
  time: 1_700_000_000,
  timeMs: 1_700_000_000_000,
};

function draft(overrides: Partial<DraftOrder> = {}): DraftOrder {
  return {
    active: false,
    symbol: '',
    side: 'buy',
    type: 'limit',
    price: 0,
    sl: null,
    tp: null,
    volume: 0.01,
    ...overrides,
  };
}

/** y → 价格：y=300 时 3742.00，落在买价下方 */
function priceAxisBox() {
  return {
    top: 42,
    height: 857,
    right: 64,
    inAxis: (x: number, y: number) => x > 671 && y >= 42 && y <= 899,
    priceAtLocal: (y: number) => 4000 - (y - 42),
    yFor: (price: number) => 42 + (4000 - price),
  };
}

const hosts: HTMLElement[] = [];

function setup() {
  const host = document.createElement('div');
  const frame = document.createElement('iframe');
  host.append(frame);
  document.body.append(host);
  hosts.push(host);

  const hostRef = { current: host };
  const view = render(
    <ChartQuickActions host={hostRef} chart={{} as IChartWidgetApi} symbol="XAUUSD" />,
  );
  return { host, doc: frame.contentDocument!, ...view };
}

/** 每次移动后等过 50ms 节流窗口，否则连续移动会被吞掉 */
async function move(doc: Document, x: number, y: number): Promise<void> {
  act(() => {
    doc.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
}

async function hoverAxis(doc: Document): Promise<HTMLElement> {
  await move(doc, 700, 300);
  return screen.findByLabelText('图表快捷操作');
}

beforeEach(() => {
  mocks.measurePriceAxis.mockReset();
  mocks.measurePriceAxis.mockImplementation(() => priceAxisBox());
  useApp.setState({
    page: 'trade',
    symbols: [GOLD_INFO],
    symbol: 'XAUUSD',
    quote: QUOTE,
    draft: draft(),
    alertsOpen: false,
    calendarOpen: false,
    alertPrefill: null,
    ticketOpen: false,
    toast: null,
  });
});

afterEach(() => {
  while (hosts.length) hosts.pop()!.remove();
});

describe('ChartQuickActions', () => {
  it('悬停价格轴出现「+」，菜单三项带价格与快捷键', async () => {
    const { doc } = setup();
    const button = await hoverAxis(doc);

    expect(button.style.top).toBe('290px');
    expect(button.style.right).toBe('64px');

    await userEvent.click(button);

    expect(await screen.findByText('XAUUSD · 3742.00')).toBeInTheDocument();
    expect(screen.getByText('以 3742.00 在 XAUUSD 添加警报')).toBeInTheDocument();
    expect(screen.getByText('买入 0.01 XAUUSD @ 3742.00 限价')).toBeInTheDocument();
    expect(screen.getByText('卖出 0.01 XAUUSD @ 3742.00 停损')).toBeInTheDocument();
    expect(screen.getByText('Alt+A')).toBeInTheDocument();
    expect(screen.getByText('Alt+Shift+B')).toBeInTheDocument();
    expect(screen.getByText('Alt+Shift+S')).toBeInTheDocument();
  });

  it('点「买入」只预填草稿并打开下单区', async () => {
    const { doc } = setup();
    const button = await hoverAxis(doc);
    await userEvent.click(button);
    await userEvent.click(await screen.findByText('买入 0.01 XAUUSD @ 3742.00 限价'));

    const state = useApp.getState();
    expect(state.draft).toEqual(
      draft({ active: true, symbol: 'XAUUSD', side: 'buy', type: 'limit', price: 3742 }),
    );
    expect(state.ticketOpen).toBe(true);
    expect(state.toast).toMatchObject({ kind: 'info' });
    expect(screen.queryByText('买入 0.01 XAUUSD @ 3742.00 限价')).not.toBeInTheDocument();
  });

  it('点「添加价格警报」打开面板并写入预填', async () => {
    const { doc } = setup();
    const button = await hoverAxis(doc);
    await userEvent.click(button);
    await userEvent.click(await screen.findByText('以 3742.00 在 XAUUSD 添加警报'));

    const state = useApp.getState();
    expect(state.alertsOpen).toBe(true);
    expect(state.alertPrefill).toEqual({
      symbol: 'XAUUSD',
      price: 3742,
      kind: 'below',
      nonce: 1,
    });
    expect(state.draft.active).toBe(false);
  });

  it('移出价格轴、离开面板或点击图表都会收起', async () => {
    const { doc } = setup();
    await hoverAxis(doc);

    await move(doc, 300, 300);
    await waitFor(() =>
      expect(screen.queryByLabelText('图表快捷操作')).not.toBeInTheDocument(),
    );

    // 再出现后点图内空白处（iframe 内的点击不会冒泡到父文档）
    const button = await hoverAxis(doc);
    await userEvent.click(button);
    expect(await screen.findByText('XAUUSD · 3742.00')).toBeInTheDocument();
    act(() => {
      doc.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    await waitFor(() => expect(screen.queryByText('XAUUSD · 3742.00')).not.toBeInTheDocument());

    // 鼠标离开整个图表容器 → 延迟收起
    await hoverAxis(doc);
    const panel = document.querySelector('div.z-30')?.parentElement;
    expect(panel).toBeTruthy();
    act(() => {
      panel!.dispatchEvent(new Event('pointerleave'));
    });
    await waitFor(
      () => expect(screen.queryByLabelText('图表快捷操作')).not.toBeInTheDocument(),
      { timeout: 1000 },
    );
  });

  it('告警 / 日历面板打开时不显示', async () => {
    useApp.setState({ alertsOpen: true });
    const { doc } = setup();
    await move(doc, 700, 300);

    expect(screen.queryByLabelText('图表快捷操作')).not.toBeInTheDocument();

    useApp.setState({ alertsOpen: false, calendarOpen: true });
    await move(doc, 700, 320);
    expect(screen.queryByLabelText('图表快捷操作')).not.toBeInTheDocument();
  });

  it('量不到价格轴时不显示', async () => {
    mocks.measurePriceAxis.mockImplementation(() => null);
    const { doc } = setup();
    await move(doc, 700, 300);

    expect(screen.queryByLabelText('图表快捷操作')).not.toBeInTheDocument();
  });
});
