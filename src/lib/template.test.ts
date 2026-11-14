import { describe, expect, it } from 'vitest';
import type { RiskSettings } from '../gateway/types';
import {
  DEFAULT_TEMPLATE,
  MAX_TEMPLATE_STEPS,
  isRiskDeviated,
  isTpManual,
  normalizeTemplateSteps,
  stepSummary,
  templateStepsSummary,
  templateSummary,
  templateTpTarget,
} from './template';

const risk = (overrides: Partial<RiskSettings> = {}): RiskSettings => ({
  mode: 'percent',
  value: 0.5,
  auto: true,
  ...overrides,
});

describe('normalizeTemplateSteps', () => {
  it('丢弃非法 R、按 R 升序排列', () => {
    const steps = normalizeTemplateSteps([
      { atR: 2, closePercent: 50, moveBreakeven: false },
      { atR: 0, closePercent: 40, moveBreakeven: true },
      { atR: -1, closePercent: 40, moveBreakeven: true },
      { atR: 101, closePercent: 40, moveBreakeven: true },
      { atR: 'abc', closePercent: 40, moveBreakeven: true },
      { atR: 1, closePercent: 30, moveBreakeven: true },
    ]);
    expect(steps).toEqual([
      { atR: 1, closePercent: 30, moveBreakeven: true },
      { atR: 2, closePercent: 50, moveBreakeven: false },
    ]);
  });

  it('平仓比例只在 1–99 之间保留', () => {
    const steps = normalizeTemplateSteps([
      { atR: 1, closePercent: 0, moveBreakeven: true },
      { atR: 2, closePercent: 100, moveBreakeven: true },
      { atR: 3, closePercent: 99.9, moveBreakeven: true },
      { atR: 4, closePercent: null, moveBreakeven: false },
    ]);
    expect(steps.map((step) => step.closePercent)).toEqual([null, null, 99.9, null]);
  });

  it('moveBreakeven 必须是布尔 true', () => {
    const steps = normalizeTemplateSteps([
      { atR: 1, closePercent: null, moveBreakeven: 1 },
      { atR: 2, closePercent: null, moveBreakeven: 'yes' },
    ]);
    expect(steps.every((step) => step.moveBreakeven === false)).toBe(true);
  });

  it('最多保留 MAX_TEMPLATE_STEPS 条', () => {
    const raw = Array.from({ length: 20 }, (_, index) => ({
      atR: index + 1,
      closePercent: null,
      moveBreakeven: true,
    }));
    const steps = normalizeTemplateSteps(raw);
    expect(steps).toHaveLength(MAX_TEMPLATE_STEPS);
    expect(steps[0].atR).toBe(1);
    expect(steps[steps.length - 1].atR).toBe(MAX_TEMPLATE_STEPS);
  });

  it('非数组返回空', () => {
    expect(normalizeTemplateSteps(null)).toEqual([]);
    expect(normalizeTemplateSteps({ atR: 1 })).toEqual([]);
  });
});

describe('templateTpTarget', () => {
  const base = { price: 2000, sl: 1990, rewardR: 2, tick: 0.01, digits: 2 };

  it('多头按 R 倍数向上、空头向下', () => {
    expect(templateTpTarget({ ...base, side: 'buy' })).toBe(2020);
    expect(templateTpTarget({ ...base, side: 'sell' })).toBe(1980);
  });

  it('按 tick 对齐', () => {
    expect(
      templateTpTarget({
        side: 'buy',
        price: 1.08654,
        sl: 1.08554,
        rewardR: 1.5,
        tick: 0.00001,
        digits: 5,
      }),
    ).toBe(1.08804);
  });

  it('缺价、缺止损、模板不设止盈时返回 null', () => {
    expect(templateTpTarget({ ...base, side: 'buy', price: 0 })).toBeNull();
    expect(templateTpTarget({ ...base, side: 'buy', sl: null })).toBeNull();
    expect(templateTpTarget({ ...base, side: 'buy', sl: 2000 })).toBeNull();
    expect(templateTpTarget({ ...base, side: 'buy', rewardR: 0 })).toBeNull();
  });
});

describe('isRiskDeviated', () => {
  it('模式、自动手数或数值任一不符都算偏离', () => {
    expect(isRiskDeviated(DEFAULT_TEMPLATE, risk())).toBe(false);
    expect(isRiskDeviated(DEFAULT_TEMPLATE, risk({ mode: 'amount' }))).toBe(true);
    expect(isRiskDeviated(DEFAULT_TEMPLATE, risk({ auto: false }))).toBe(true);
    expect(isRiskDeviated(DEFAULT_TEMPLATE, risk({ value: 1 }))).toBe(true);
  });
});

describe('isTpManual', () => {
  it('半跳以内视为一致', () => {
    expect(isTpManual(2020, 2020.004, 0.01)).toBe(false);
    expect(isTpManual(2020, 2020.02, 0.01)).toBe(true);
  });

  it('任一侧为空都不算手动改过', () => {
    expect(isTpManual(null, 2020, 0.01)).toBe(false);
    expect(isTpManual(2020, null, 0.01)).toBe(false);
  });
});

describe('模板摘要', () => {
  it('单个阶段摘要', () => {
    expect(stepSummary({ atR: 1, closePercent: 50, moveBreakeven: true })).toBe('1R 平50%→保本');
    expect(stepSummary({ atR: 2, closePercent: null, moveBreakeven: false })).toBe('2R');
  });

  it('没有阶段时说明成交后不管理', () => {
    expect(templateStepsSummary({ ...DEFAULT_TEMPLATE, steps: [] })).toBe('成交后不管理');
  });

  it('整体摘要包含风险、R 倍数与阶段', () => {
    expect(templateSummary(DEFAULT_TEMPLATE)).toBe('0.5% · 2R · 1R→保本');
    expect(
      templateSummary({
        id: 't',
        name: 't',
        riskPercent: 1,
        rewardR: 0,
        steps: [{ atR: 1, closePercent: 50, moveBreakeven: true }],
      }),
    ).toBe('1% · 1R 平50%→保本');
  });
});
