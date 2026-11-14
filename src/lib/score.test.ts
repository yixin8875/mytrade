import { describe, expect, it } from 'vitest';
import type { ScoreComponent } from '../gateway/types';
import {
  componentBarWidth,
  componentValue,
  effectiveWeight,
  scoreTone,
  scoreWords,
} from './score';

function component(overrides: Partial<ScoreComponent> = {}): ScoreComponent {
  return {
    key: 'win_rate',
    label: '胜率',
    weight: 0.15,
    unit: '',
    rule: '胜率从 20% 到 70% 映射到 0–100',
    value: 0.6,
    score: 80,
    included: true,
    reason: null,
    ...overrides,
  };
}

describe('scoreTone', () => {
  it('按 75 / 50 分档', () => {
    expect(scoreTone(90)).toBe('text-console-gain');
    expect(scoreTone(75)).toBe('text-console-gain');
    expect(scoreTone(74.9)).toBe('text-console-accent');
    expect(scoreTone(50)).toBe('text-console-accent');
    expect(scoreTone(49.9)).toBe('text-console-warn');
  });

  it('没有分数时用弱化色', () => {
    expect(scoreTone(null)).toBe('text-console-faint');
  });
});

describe('scoreWords', () => {
  it('覆盖每个档位', () => {
    expect(scoreWords(null)).toBe('样本不足');
    expect(scoreWords(86)).toBe('过程稳定');
    expect(scoreWords(76)).toBe('大体稳定');
    expect(scoreWords(61)).toBe('有短板');
    expect(scoreWords(41)).toBe('需要收敛');
    expect(scoreWords(20)).toBe('先停下来检查流程');
  });
});

describe('effectiveWeight', () => {
  it('只累计参与的分量', () => {
    const list = [
      component({ weight: 0.25 }),
      component({ key: 'payoff', weight: 0.15, included: false, score: null }),
      component({ key: 'drawdown', weight: 0.15 }),
    ];
    expect(effectiveWeight(list)).toBeCloseTo(0.4, 6);
  });

  it('空数组为 0', () => {
    expect(effectiveWeight([])).toBe(0);
  });
});

describe('componentValue', () => {
  it('比率类按百分数显示', () => {
    expect(componentValue(component({ key: 'win_rate', value: 0.6 }))).toBe('60%');
    expect(componentValue(component({ key: 'discipline', value: 0.75 }))).toBe('75%');
    expect(componentValue(component({ key: 'concentration', value: 0.4 }))).toBe('40%');
  });

  it('倍数类带单位', () => {
    expect(componentValue(component({ key: 'payoff', value: 1.5 }))).toBe('1.50 倍');
    expect(componentValue(component({ key: 'recovery', value: 2 }))).toBe('2.00 倍');
  });

  it('R 类带正负号', () => {
    expect(componentValue(component({ key: 'expectancy', value: 0.12 }))).toBe('+0.12R');
    expect(componentValue(component({ key: 'expectancy', value: -0.3 }))).toBe('-0.30R');
    expect(componentValue(component({ key: 'drawdown', value: 2.5 }))).toBe('2.50R');
  });

  it('缺值时给破折号', () => {
    expect(componentValue(component({ value: null, score: null, included: false }))).toBe('—');
  });
});

describe('componentBarWidth', () => {
  it('分数被夹在 2%–100% 之间', () => {
    expect(componentBarWidth(80)).toBe('80%');
    expect(componentBarWidth(0)).toBe('2%');
    expect(componentBarWidth(140)).toBe('100%');
    expect(componentBarWidth(null)).toBe('0%');
  });
});
