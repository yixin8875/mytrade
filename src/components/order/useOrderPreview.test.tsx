import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gateway } from '../../gateway/client';
import type { DraftOrder, RiskSettings } from '../../gateway/types';
import { GOLD_INFO } from '../../replay/testUtils';
import { useOrderPreview } from './useOrderPreview';

const DRAFT: DraftOrder = {
  active: true,
  symbol: 'XAUUSD',
  side: 'sell',
  type: 'market',
  price: 2000,
  sl: 2010,
  tp: 1990,
  volume: 0.01,
};

const RISK: RiskSettings = { mode: 'percent', value: 1, auto: true };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useOrderPreview', () => {
  it('市价单随现价刷新风险预览与自动手数', async () => {
    const calls: string[] = [];
    vi.spyOn(gateway, 'call').mockImplementation((async (method: string) => {
      calls.push(method);
      if (method === 'trade.size') {
        return { volume: 0.01, riskAmount: 100, warnings: [], capped: [] };
      }
      return { riskAmount: 100, rewardAmount: 100, margin: 10, rr: 1, riskPct: 1 };
    }) as never);

    const { rerender } = renderHook(
      ({ entry }: { entry: number }) =>
        useOrderPreview({
          ready: true,
          info: GOLD_INFO,
          symbol: 'XAUUSD',
          draft: DRAFT,
          risk: RISK,
          liveEntry: entry,
          patchDraft: vi.fn(),
          setPreview: vi.fn(),
        }),
      { initialProps: { entry: 2000 } },
    );

    await waitFor(() => expect(calls).toContain('trade.size'), { timeout: 2000 });
    const before = calls.filter((method) => method === 'trade.size').length;

    // 价格跳动后应当在节流窗口内重新计算手数
    rerender({ entry: 2005 });

    await waitFor(
      () =>
        expect(calls.filter((method) => method === 'trade.size').length).toBeGreaterThan(before),
      { timeout: 2000 },
    );
  });
});
