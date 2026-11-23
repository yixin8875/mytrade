/** 过程评分的展示辅助：分数语气、分量数值格式、参与权重合计。 */

import type { ScoreComponent } from '../gateway/types';

export function scoreTone(score: number | null): string {
  if (score == null) return 'text-muted-foreground/60';
  if (score >= 75) return 'text-success-foreground';
  if (score >= 50) return 'text-brand';
  return 'text-warning-foreground';
}

export function scoreWords(score: number | null): string {
  if (score == null) return '样本不足';
  if (score >= 85) return '过程稳定';
  if (score >= 75) return '大体稳定';
  if (score >= 60) return '有短板';
  if (score >= 40) return '需要收敛';
  return '先停下来检查流程';
}

/** 未参与的分量不计入分母 */
export function effectiveWeight(components: ScoreComponent[]): number {
  return components.reduce((sum, item) => sum + (item.included ? item.weight : 0), 0);
}

export function componentValue(component: ScoreComponent): string {
  if (component.value == null) return '—';
  const value = component.value;
  switch (component.key) {
    case 'win_rate':
    case 'discipline':
    case 'concentration':
      return `${(value * 100).toFixed(0)}%`;
    case 'payoff':
    case 'recovery':
      return `${value.toFixed(2)} 倍`;
    case 'drawdown':
      return `${value.toFixed(2)}R`;
    case 'expectancy':
      return `${value >= 0 ? '+' : ''}${value.toFixed(2)}R`;
    default:
      return String(value);
  }
}

export function componentBarWidth(score: number | null): string {
  if (score == null) return '0%';
  return `${Math.max(2, Math.min(100, score))}%`;
}
