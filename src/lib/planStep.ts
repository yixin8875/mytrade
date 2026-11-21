/**
 * 分批计划共用的档位上限与平仓比例规则。
 *
 * 网关有两套校验：
 * - 模板 / 成交阶段（_normalize_plan_steps）允许 (0, 100)；
 * - 手动分批（_validate_plan_percent）要求 1–99。
 * 这里把两条规则集中到一处，前端不要各写一份。
 */

/** 模板阶段与持仓分批共用的档位上限，与网关 MAX_PLAN_STEPS 一致 */
export const MAX_STEP_COUNT = 8;

/** 模板 / 成交阶段：留空或 0 < 比例 < 100，与网关清洗规则一致 */
export function normalizeClosePercent(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 && value < 100 ? value : null;
}

/** 手动分批：必须是 1–99 的数字，与网关 _validate_plan_percent 一致 */
export function isValidPlanPercent(raw: unknown): boolean {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1 && value <= 99;
}
