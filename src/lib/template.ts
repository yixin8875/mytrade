import type { RiskSettings, Side, TemplateStep, TradeTemplate } from '../gateway/types';

/** 模板最多带多少个阶段，与网关的清洗上限一致 */
export const MAX_TEMPLATE_STEPS = 8;

/** 全新安装的默认模板：0.5% 风险 + 2R 止盈 + 1R 移到保本 */
export const DEFAULT_TEMPLATE: TradeTemplate = {
  id: 'default',
  name: '默认模板',
  riskPercent: 0.5,
  rewardR: 2,
  steps: [{ atR: 1, closePercent: null, moveBreakeven: true }],
};

/** 模板里的数字显示：2 → "2"，0.50 → "0.5" */
export function fmtNum(value: number): string {
  return `${Number(value.toFixed(2))}`;
}

/** 单个阶段：1R 平50%→保本 */
export function stepSummary(step: TemplateStep): string {
  return `${fmtNum(step.atR)}R${
    step.closePercent != null ? ` 平${fmtNum(step.closePercent)}%` : ''
  }${step.moveBreakeven ? '→保本' : ''}`;
}

/** 阶段一行摘要：1R 平50%→保本 · 2R→保本；没有阶段时说明成交后不管理 */
export function templateStepsSummary(template: TradeTemplate): string {
  if (!template.steps.length) return '成交后不管理';
  return template.steps.map(stepSummary).join(' · ');
}

/** 模板一行摘要：0.5% · 2R · 1R→保本 */
export function templateSummary(template: TradeTemplate): string {
  const parts = [`${fmtNum(template.riskPercent)}%`];
  if (template.rewardR > 0) parts.push(`${fmtNum(template.rewardR)}R`);
  parts.push(templateStepsSummary(template));
  return parts.join(' · ');
}

/**
 * 阶段清洗：R 必须为正、平仓比例留空或 0–100 之间（不含端点）、
 * 按 R 升序、最多 MAX_TEMPLATE_STEPS 条。
 * 存储层和编辑器都走同一份规则，避免设置页与下单票算出不同的结果。
 */
export function normalizeTemplateSteps(raw: unknown): TemplateStep[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const source = (item ?? {}) as Record<string, unknown>;
      const atR = Number(source.atR);
      if (!Number.isFinite(atR) || atR <= 0 || atR > 100) return null;
      const close = source.closePercent == null ? null : Number(source.closePercent);
      const closePercent =
        close != null && Number.isFinite(close) && close > 0 && close < 100 ? close : null;
      return { atR, closePercent, moveBreakeven: source.moveBreakeven === true };
    })
    .filter((item): item is TemplateStep => item !== null)
    .sort((a, b) => a.atR - b.atR)
    .slice(0, MAX_TEMPLATE_STEPS);
}

export interface TpTargetInput {
  side: Side;
  /** 入场价（市价单跟随报价，挂单用委托价） */
  price: number;
  sl: number | null;
  rewardR: number;
  tick: number;
  digits: number;
}

/**
 * 按模板 R 倍数算止盈价：入场到止损的距离记作 1R，按 tick 对齐。
 * 缺入场价/止损、或模板不自动设止盈时返回 null。
 */
export function templateTpTarget({
  side,
  price,
  sl,
  rewardR,
  tick,
  digits,
}: TpTargetInput): number | null {
  if (!(price > 0) || sl == null || !(rewardR > 0)) return null;
  const risk = Math.abs(price - sl);
  if (!(risk > 0)) return null;
  const raw = side === 'buy' ? price + risk * rewardR : price - risk * rewardR;
  return tick > 0 ? Number((Math.round(raw / tick) * tick).toFixed(digits)) : raw;
}

/** 启用模板后风险被改过（换模式、关自动手数、改数值）都算偏离 */
export function isRiskDeviated(template: TradeTemplate, risk: RiskSettings): boolean {
  return (
    risk.mode !== 'percent' ||
    !risk.auto ||
    Math.abs(risk.value - template.riskPercent) > 1e-9
  );
}

/** 模板止盈是否被手动改过；半跳以内视为一致 */
export function isTpManual(tpTarget: number | null, tp: number | null, tick: number): boolean {
  if (tpTarget == null || tp == null) return false;
  return Math.abs(tp - tpTarget) > (tick || 1e-9) / 2;
}
