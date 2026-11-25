import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DraftOrder, RiskSettings, TradeTemplate } from '../../gateway/types';
import { GOLD_INFO } from '../../replay/testUtils';
import { useTemplateSync } from './useTemplateSync';

const TEMPLATE: TradeTemplate = {
  id: 't1',
  name: '1R',
  riskMode: 'percent',
  riskPercent: 1,
  riskAmount: 100,
  rewardR: 1,
  steps: [],
  autoApply: false,
};

const DRAFT: DraftOrder = {
  active: true,
  symbol: 'XAUUSD',
  side: 'buy',
  type: 'market',
  price: 2000,
  sl: 1990,
  tp: 2010,
  volume: 0.01,
};

const RISK: RiskSettings = { mode: 'percent', value: 1, auto: true };

function setup(rulerEntry: number) {
  const patchDraft = vi.fn();
  const patchRisk = vi.fn();
  const view = renderHook(
    ({ entry }: { entry: number }) =>
      useTemplateSync({
        info: GOLD_INFO,
        tick: GOLD_INFO.tickSize,
        digits: GOLD_INFO.digits,
        template: TEMPLATE,
        armed: true,
        draft: DRAFT,
        risk: RISK,
        rulerEntry: entry,
        entryMode: 'regular',
        patchDraft,
        patchRisk,
      }),
    { initialProps: { entry: rulerEntry } },
  );
  return { ...view, patchDraft, patchRisk };
}

describe('useTemplateSync', () => {
  it('市价单价格跳动时按新的 1R 距离重算止盈', () => {
    const { rerender, patchDraft } = setup(2000);
    expect(patchDraft).not.toHaveBeenCalled();

    // 价格上移 5，止损不动：1R 距离由 10 变成 15，止盈应跟到 2020
    rerender({ entry: 2005 });

    expect(patchDraft).toHaveBeenCalledWith({ tp: 2020 });
  });

  it('未启用模板时止盈按基础 1R 跟随', () => {
    const patchDraft = vi.fn();
    renderHook(() =>
      useTemplateSync({
        info: GOLD_INFO,
        tick: GOLD_INFO.tickSize,
        digits: GOLD_INFO.digits,
        template: TEMPLATE,
        armed: false,
        draft: { ...DRAFT, tp: null },
        risk: RISK,
        rulerEntry: 2000,
        entryMode: 'regular',
        patchDraft,
        patchRisk: vi.fn(),
      }),
    );
    expect(patchDraft).toHaveBeenCalledWith({ tp: 2010 });
  });

  it('金额口径模板把固定亏损金额套到下单票', () => {
    const patchRisk = vi.fn();
    renderHook(() =>
      useTemplateSync({
        info: GOLD_INFO,
        tick: GOLD_INFO.tickSize,
        digits: GOLD_INFO.digits,
        template: { ...TEMPLATE, riskMode: 'amount', riskAmount: 150 },
        armed: true,
        draft: DRAFT,
        risk: RISK,
        rulerEntry: 2000,
        entryMode: 'regular',
        patchDraft: vi.fn(),
        patchRisk,
      }),
    );
    expect(patchRisk).toHaveBeenCalledWith({ mode: 'amount', value: 150, auto: true });
  });

  it('用户手动改过止盈后，价格跳动不再抢回', () => {
    const { result, rerender, patchDraft } = setup(2000);

    result.current.setTpTouched(true);
    rerender({ entry: 2005 });

    expect(patchDraft).not.toHaveBeenCalled();
  });
});
