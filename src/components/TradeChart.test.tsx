import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Bar, JournalRecord } from '../gateway/types';
import { TradeChart } from './TradeChart';

const gatewayMock = vi.hoisted(() => ({ call: vi.fn() }));

vi.mock('../gateway/client', () => ({
  gateway: { call: gatewayMock.call },
}));

const OPEN = 1_800_000_000;
const CLOSE = OPEN + 3600;

function bars(): Bar[] {
  const out: Bar[] = [];
  for (let time = OPEN - 1200; time <= CLOSE + 1200; time += 60) {
    const drift = (time - OPEN) / 1000;
    const price = 1.08 + Math.sin(drift / 300) * 0.002;
    out.push({
      time,
      open: price,
      high: price + 0.0006,
      low: price - 0.0006,
      close: price + (drift % 120 === 0 ? 0.0003 : -0.0003),
      volume: 10,
    });
  }
  return out;
}

function record(overrides: Partial<JournalRecord> = {}): JournalRecord {
  return {
    login: 1,
    position_id: 7,
    symbol: 'EURUSD',
    side: 'buy',
    volume: 0.1,
    entry_price: 1.08,
    exit_price: 1.0815,
    profit: 10,
    swap: 0,
    commission: 0,
    open_time: OPEN,
    close_time: CLOSE,
    duration_sec: CLOSE - OPEN,
    mfe: null,
    mae: null,
    tag: null,
    closed_by: 'manual',
    sl: 1.075,
    tp: 1.09,
    risk: 5,
    risk_source: 'order',
    server_offset: 7200,
    has_shot: 0,
    recorded_at: CLOSE,
    ...overrides,
  };
}

function setup(data: JournalRecord) {
  gatewayMock.call.mockResolvedValue({ bars: bars(), digits: 5 });
  return render(<TradeChart record={data} />);
}

describe('TradeChart 逐笔成交点', () => {
  it('多笔出场各画一个点，并标出场均价', async () => {
    const { container } = setup(
      record({
        fills: [
          { side: 'in', time: OPEN, price: 1.08, volume: 0.1 },
          { side: 'out', time: OPEN + 1800, price: 1.0805, volume: 0.05 },
          { side: 'out', time: CLOSE, price: 1.0815, volume: 0.05 },
        ],
      }),
    );

    await waitFor(() => {
      expect(container.querySelectorAll('[data-role="fill-point"]')).toHaveLength(3);
    });
    const points = [...container.querySelectorAll('[data-role="fill-point"]')];
    expect(points.filter((node) => node.getAttribute('data-side') === 'entry')).toHaveLength(1);
    expect(points.filter((node) => node.getAttribute('data-side') === 'exit')).toHaveLength(2);
    expect(points[0].tagName.toLowerCase()).toBe('path');
    const titles = [...container.querySelectorAll('[data-role="fill-point"] title')].map(
      (node) => node.textContent ?? '',
    );
    expect(titles.filter((text) => text.startsWith('出场'))).toHaveLength(2);
    expect(titles.some((text) => text.includes('0.05 手'))).toBe(true);
    expect(container.textContent).toContain('出场均价');
  });

  it('没有成交明细时退回单笔入场/出场点', async () => {
    const { container } = setup(record());

    await waitFor(() => {
      expect(container.querySelectorAll('[data-role="fill-point"]')).toHaveLength(2);
    });
    expect(container.textContent).not.toContain('出场均价');
  });
});
