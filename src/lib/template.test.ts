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

describe('模板清洗的边界', () => {
  it('数字字符串按数字处理', () => {
    expect(
      normalizeTemplateSteps([{ atR: '1.5', closePercent: '50', moveBreakeven: true }]),
    ).toEqual([{ atR: 1.5, closePercent: 50, moveBreakeven: true }]);
  });

  it('atR 正好 100 保留，超过 100 丢弃', () => {
    expect(normalizeTemplateSteps([{ atR: 100 }])).toHaveLength(1);
    expect(normalizeTemplateSteps([{ atR: 100.001 }])).toHaveLength(0);
  });

  it('平仓比例必须大于 0 且小于 100', () => {
    expect(normalizeTemplateSteps([{ atR: 1, closePercent: 0 }])[0].closePercent).toBeNull();
    expect(normalizeTemplateSteps([{ atR: 1, closePercent: 100 }])[0].closePercent).toBeNull();
    expect(normalizeTemplateSteps([{ atR: 1, closePercent: 0.5 }])[0].closePercent).toBe(0.5);
    expect(normalizeTemplateSteps([{ atR: 1, closePercent: 99 }])[0].closePercent).toBe(99);
  });

  it('缺 atR 的条目直接丢弃', () => {
    expect(normalizeTemplateSteps([{ closePercent: 50 }, { atR: 1, closePercent: 50 }])).toEqual([
      { atR: 1, closePercent: 50, moveBreakeven: false },
    ]);
  });
});

describe('templateTpTarget 的取整边界', () => {
  it('没有 tick 时返回原始价位', () => {
    expect(
      templateTpTarget({
        side: 'buy',
        price: 2000,
        sl: 1990.123,
        rewardR: 2,
        tick: 0,
        digits: 5,
      }),
    ).toBeCloseTo(2019.754, 8);
  });

  it('止损在反方向时按距离计算 R', () => {
    expect(
      templateTpTarget({ side: 'buy', price: 2000, sl: 2010, rewardR: 1.5, tick: 0.01, digits: 2 }),
    ).toBe(2015);
  });
});

describe('isRiskDeviated 的容差', () => {
  it('1e-9 以内不算偏离，超过则算', () => {
    expect(isRiskDeviated(DEFAULT_TEMPLATE, risk({ value: 0.5 + 5e-10 }))).toBe(false);
    expect(isRiskDeviated(DEFAULT_TEMPLATE, risk({ value: 0.5 + 5e-9 }))).toBe(true);
  });
});
