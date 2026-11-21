import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import type { TrendSeries } from '../gateway/types';
import { ReviewView } from './ReviewView';

/** 合成复盘区间：日期为 2026 年，金额为合成数字 */
function makeSeries(days: number): TrendSeries {
  return {
    days,
    start: '2026-05-25',
    end: '2026-11-21',
    timezoneOffsetMin: 480,
    trades: [
      {
        positionId: 1,
        symbol: 'XAUUSD',
        side: 'buy',
        volume: 0.1,
        openTime: 1763600000,
        closeTime: 1763603600,
        profit: 120,
        r: 1.2,
        risk: 100,
        durationSec: 3600,
        mfe: 1.5,
        mae: -0.3,
        tag: '突破',
        day: '2026-11-20',
      },
    ],
  };
}

function mockSeries() {
  return vi
    .spyOn(gateway, 'call')
    .mockImplementation((async (method: string, params: { days?: number }) => {
      if (method === 'review.trades') return makeSeries(params.days ?? 180);
      throw new Error(`未预置的方法：${method}`);
    }) as typeof gateway.call);
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  useApp.setState({
    account: null,
    privacy: false,
    conn: 'open',
  });
});

describe('ReviewView', () => {
  it('绩效趋势与深度分析共用一次 review.trades 请求', async () => {
    const call = mockSeries();
    render(<ReviewView />);

    expect(await screen.findByRole('heading', { name: '绩效趋势' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '深度分析' })).toBeInTheDocument();
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('review.trades', { days: 180 });
    });

    const reviews = call.mock.calls.filter(([method]) => method === 'review.trades');
    expect(reviews).toHaveLength(1);
  });

  it('切换区间只重新请求一次', async () => {
    const call = mockSeries();
    render(<ReviewView />);

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('review.trades', { days: 180 });
    });
    call.mockClear();

    await userEvent.click(screen.getByRole('button', { name: '90 天' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('review.trades', { days: 90 });
    });
    const reviews = call.mock.calls.filter(([method]) => method === 'review.trades');
    expect(reviews).toHaveLength(1);
  });
});
