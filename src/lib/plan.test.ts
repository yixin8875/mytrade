import { describe, expect, it } from 'vitest';
import { GOLD_INFO } from '../replay/testUtils';
import type { Position, PositionPlan, PositionPlanStep } from '../gateway/types';
import {
  estimateStepLots,
  nextStepPrice,
  planSummary,
  stepAtR,
  validatePlanStep,
} from './plan';

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    ticket: 1,
    identifier: 1,
    symbol: 'XAUUSD',
    side: 'buy',
    volume: 1,
    openPrice: 100,
    sl: 90,
    tp: 130,
    profit: 0,
    swap: 0,
    commission: 0,
    magic: 0,
    comment: '',
    openTime: 0,
    ...overrides,
  };
}

function makeStep(overrides: Partial<PositionPlanStep> = {}): PositionPlanStep {
  return {
    id: 'a',
    price: 110,
    closePercent: 50,
    moveBreakeven: false,
    done: false,
    skipped: false,
    atR: 1,
    ...overrides,
  };
}

function makePlan(steps: PositionPlanStep[], overrides: Partial<PositionPlan> = {}): PositionPlan {
  return {
    entry: 100,
    risk: 10,
    side: 'buy',
    steps,
    source: 'manual',
    ...overrides,
  };
}

describe('nextStepPrice', () => {
  it('没有档位时放在 1R', () => {
    expect(nextStepPrice(makePosition(), null, GOLD_INFO)).toBe(110);
  });

  it('跳过已占用的 R', () => {
    const plan = makePlan([makeStep()]);
    expect(nextStepPrice(makePosition(), plan, GOLD_INFO)).toBe(120);
  });

  it('不超过最终止盈', () => {
    const position = makePosition({ tp: 115 });
    expect(nextStepPrice(position, makePlan([]), GOLD_INFO)).toBe(110);
  });

  it('空单向下取 R', () => {
    const position = makePosition({ side: 'sell', sl: 110, tp: 70 });
    expect(nextStepPrice(position, makePlan([], { side: 'sell' }), GOLD_INFO)).toBe(90);
  });
});

describe('validatePlanStep', () => {
  it('多单低于开仓价时拒绝', () => {
    expect(
      validatePlanStep({ price: 95, closePercent: 50 }, makePosition(), null, GOLD_INFO),
    ).toBe('多单的分批价必须高于开仓价');
  });

  it('空单高于开仓价时拒绝', () => {
    const position = makePosition({ side: 'sell', sl: 110 });
    expect(
      validatePlanStep(
        { price: 105, closePercent: 50 },
        position,
        makePlan([], { side: 'sell' }),
        GOLD_INFO,
      ),
    ).toBe('空单的分批价必须低于开仓价');
  });

  it('超出最终止盈时拒绝', () => {
    expect(
      validatePlanStep({ price: 130, closePercent: 50 }, makePosition(), null, GOLD_INFO),
    ).toBe('该档在最终止盈之后，不会触发');
  });

  it('与其它档同价时拒绝', () => {
    expect(
      validatePlanStep(
        { price: 110, closePercent: 50 },
        makePosition(),
        makePlan([makeStep()]),
        GOLD_INFO,
      ),
    ).toBe('已有一档在这个价位');
  });

  it('修改自身时可以保持原价', () => {
    expect(
      validatePlanStep(
        { price: 110, closePercent: 60 },
        makePosition(),
        makePlan([makeStep()]),
        GOLD_INFO,
        'a',
      ),
    ).toBeNull();
  });

  it('比例必须在 1–99 之间', () => {
    expect(
      validatePlanStep({ price: 110, closePercent: 0 }, makePosition(), null, GOLD_INFO),
    ).toBe('平仓比例需在 1–99% 之间');
    expect(
      validatePlanStep({ price: 110, closePercent: 100 }, makePosition(), null, GOLD_INFO),
    ).toBe('平仓比例需在 1–99% 之间');
  });
});

describe('estimateStepLots', () => {
  it('按当时剩余仓位逐档取整，剩最后 0.35 手', () => {
    const steps = [
      makeStep({ id: 'b', price: 120, atR: 2, closePercent: 30 }),
      makeStep({ id: 'a', price: 110, atR: 1, closePercent: 50 }),
    ];
    const { rows, remaining } = estimateStepLots(1, steps, GOLD_INFO);

    expect(rows.map((row) => [row.id, row.lots])).toEqual([
      ['a', 0.5],
      ['b', 0.15],
    ]);
    expect(remaining).toBeCloseTo(0.35, 6);
  });

  it('仓位拆不开时标记 skipped 且不扣减', () => {
    const steps = [makeStep({ closePercent: 50 })];
    const { rows, remaining } = estimateStepLots(0.01, steps, GOLD_INFO);

    expect(rows[0].skipped).toBe(true);
    expect(rows[0].lots).toBe(0);
    expect(remaining).toBe(0.01);
  });

  it('已完成/跳过的档位不消耗仓位', () => {
    const steps = [
      makeStep({ id: 'done', done: true, closePercent: 50 }),
      makeStep({ id: 'live', price: 120 }),
    ];
    const { rows, remaining } = estimateStepLots(1, steps, GOLD_INFO);

    expect(rows[0].lots).toBe(0);
    expect(rows[1].lots).toBe(0.5);
    expect(remaining).toBe(0.5);
  });
});

describe('stepAtR / planSummary', () => {
  it('没有 atR 时按价格与 1R 折算', () => {
    const position = makePosition();
    const plan = makePlan([makeStep({ atR: null, price: 125 })]);
    expect(stepAtR(plan.steps[0], position, plan)).toBeCloseTo(2.5, 6);
  });

  it('摘要只列未完成的档位', () => {
    const position = makePosition();
    const plan = makePlan([
      makeStep({ id: 'a', atR: 1, closePercent: 50 }),
      makeStep({ id: 'b', atR: 2, price: 120, closePercent: 30 }),
      makeStep({ id: 'c', atR: 3, price: 130, done: true }),
    ]);
    expect(planSummary(position, plan)).toBe('1.0R 平50% · 2.0R 平30%');
  });
});
