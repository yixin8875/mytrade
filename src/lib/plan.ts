import type {
  Position,
  PositionPlan,
  PositionPlanStep,
  Side,
  SymbolInfo,
} from '../gateway/types';
import { MAX_STEP_COUNT, isValidPlanPercent } from './planStep';

/**
 * 分批止盈的纯函数：默认价、校验、手数预估。
 * 不依赖图表和网关，服务端仍会再校验一遍。
 */

/** 与模板阶段、服务端共用 8 档上限 */
export const MAX_PLAN_STEPS = MAX_STEP_COUNT;

export interface PlanStepInput {
  price: number;
  closePercent: number | null;
}

export interface PlanLotEstimate {
  id: string;
  /** 预计平掉的手数；拆不开时为 0 */
  lots: number;
  /** 这一档之后剩余手数 */
  remaining: number;
  /** 仓位小到拆不开 */
  skipped: boolean;
}

function tickOf(info?: SymbolInfo): number {
  const tick = info?.tickSize || info?.point || 0;
  return tick > 0 ? tick : 0.00001;
}

export function roundToTick(value: number, info?: SymbolInfo): number {
  const tick = tickOf(info);
  const digits = Math.max(0, Math.min(8, info?.digits ?? 5));
  return Number((Math.round(value / tick) * tick).toFixed(digits));
}

export function halfTick(info?: SymbolInfo): number {
  return tickOf(info) / 2;
}

/** 未完成、未跳过的档位，才是图上要画的 */
export function activeSteps(plan: PositionPlan | null | undefined): PositionPlanStep[] {
  return (plan?.steps ?? []).filter((step) => !step.done && !step.skipped);
}

export function planSide(position: Position, plan?: PositionPlan | null): Side {
  return plan?.side ?? position.side;
}

/** 1R 的价格距离：优先计划里存下的，其次当前止损 */
export function planRisk(position: Position, plan?: PositionPlan | null): number {
  if (plan && plan.risk > 0) return plan.risk;
  if (position.sl != null) return Math.abs(position.openPrice - position.sl);
  return 0;
}

export function stepAtR(
  step: PositionPlanStep,
  position: Position,
  plan?: PositionPlan | null,
): number | null {
  if (step.atR != null) return step.atR;
  const risk = planRisk(position, plan);
  if (risk <= 0) return null;
  return Math.abs(step.price - position.openPrice) / risk;
}

function beforeTp(price: number, position: Position, side: Side, info?: SymbolInfo): boolean {
  if (position.tp == null) return true;
  const half = halfTick(info);
  return side === 'buy' ? price < position.tp - half : price > position.tp + half;
}

/**
 * 新增一档的默认价：从 1R、2R… 里挑第一个没被占用且早于最终止盈的价位；
 * 没有风险基准时退回到「开仓价与止盈的中点」，没有止盈就放 0.2%。
 */
export function nextStepPrice(
  position: Position,
  plan: PositionPlan | null | undefined,
  info?: SymbolInfo,
): number {
  const tick = tickOf(info);
  const side = planSide(position, plan);
  const entry = plan?.entry ?? position.openPrice;
  const risk = planRisk(position, plan);
  const used = new Set(
    activeSteps(plan).map((step) => Math.round(step.price / tick)),
  );

  if (risk > 0) {
    for (let index = 1; index <= 8; index++) {
      const raw = side === 'buy' ? entry + risk * index : entry - risk * index;
      const price = roundToTick(raw, info);
      if (used.has(Math.round(price / tick))) continue;
      if (!beforeTp(price, position, side, info)) break;
      return price;
    }
  }

  const raw = position.tp != null
    ? (entry + position.tp) / 2
    : side === 'buy'
      ? entry * 1.002
      : entry * 0.998;
  return roundToTick(raw, info);
}

/**
 * 添加/修改一档时的本地校验，规则与服务端一致：
 * 盈利方向、早于最终止盈、不与其它档同价、比例 1–99。
 */
export function validatePlanStep(
  input: PlanStepInput,
  position: Position,
  plan: PositionPlan | null | undefined,
  info?: SymbolInfo,
  excludeStepId?: string,
): string | null {
  if (!Number.isFinite(input.price) || input.price <= 0) return '触发价无效';
  const percent = input.closePercent;
  if (percent == null || !isValidPlanPercent(percent)) {
    return '平仓比例需在 1–99% 之间';
  }
  const side = planSide(position, plan);
  const entry = plan?.entry ?? position.openPrice;
  const half = halfTick(info);
  if (side === 'buy' && input.price < entry + half) return '多单的分批价必须高于开仓价';
  if (side === 'sell' && input.price > entry - half) return '空单的分批价必须低于开仓价';
  if (!beforeTp(input.price, position, side, info)) {
    return '该档在最终止盈之后，不会触发';
  }
  const duplicate = activeSteps(plan).some(
    (step) =>
      step.id !== excludeStepId &&
      Math.abs(step.price - input.price) < Math.max(half, tickOf(info) * 1e-6),
  );
  if (duplicate) return '已有一档在这个价位';
  return null;
}

/** 按执行顺序演示每一档的手数与剩余；比例作用在当时剩余仓位上 */
export function estimateStepLots(
  volume: number,
  steps: PositionPlanStep[],
  info?: SymbolInfo,
  side: Side = 'buy',
): { rows: PlanLotEstimate[]; remaining: number } {
  const step = info?.volumeStep && info.volumeStep > 0 ? info.volumeStep : 0.01;
  const min = Math.max(info?.minVolume ?? 0, step);
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  const round = (value: number) => Number(value.toFixed(decimals));

  // 多单从低价档先触发，空单从高价档先触发
  const ordered = [...steps].sort((a, b) => (side === 'sell' ? b.price - a.price : a.price - b.price));
  let remaining = volume;
  const rows = ordered.map((item) => {
    if (item.done || item.skipped || item.closePercent == null) {
      return { id: item.id, lots: 0, remaining, skipped: !!item.skipped };
    }
    const raw = Math.floor((remaining * item.closePercent) / 100 / step + 1e-9) * step;
    const lots = round(raw);
    if (lots < min - 1e-9 || remaining - lots < min - 1e-9) {
      return { id: item.id, lots: 0, remaining, skipped: true };
    }
    remaining = round(remaining - lots);
    return { id: item.id, lots, remaining, skipped: false };
  });
  return { rows, remaining };
}

/** 一句话摘要，例如 `1.0R 平50% · 2.0R 平30%` */
export function planSummary(
  position: Position,
  plan: PositionPlan | null | undefined,
): string {
  const steps = activeSteps(plan);
  if (steps.length === 0) return '—';
  return steps
    .map((step) => {
      const r = stepAtR(step, position, plan);
      const where = r != null ? `${r.toFixed(1)}R` : String(step.price);
      return step.closePercent != null ? `${where} 平${step.closePercent}%` : `${where} 移保本`;
    })
    .join(' · ');
}
