import { useEffect, useState } from 'react';
import { templateRisk, templateTpTarget } from '../../lib/template';
import type { DraftOrder, RiskSettings, SymbolInfo, TradeTemplate } from '../../gateway/types';

/**
 * 模板与草稿的双向同步：
 * - 启用模板时强制风险自动手数，改模板风险比例时跟随；
 * - 按模板 R 自动放止盈，用户手动改过后不再抢回；
 * - 改入场价 / 止损 / 方向 / 类型或切换模板时，止盈重新跟随。
 */
export function useTemplateSync({
  info,
  tick,
  digits,
  template,
  armed,
  draft,
  risk,
  rulerEntry,
  entryMode,
  patchDraft,
  patchRisk,
  /** 没有启用模板时的基础止盈倍数（默认 1R） */
  fallbackRewardR,
}: {
  info: SymbolInfo | undefined;
  tick: number;
  digits: number;
  template: TradeTemplate;
  armed: boolean;
  draft: DraftOrder;
  risk: RiskSettings;
  rulerEntry: number;
  entryMode: string;
  patchDraft: (patch: Partial<DraftOrder>) => void;
  patchRisk: (patch: Partial<RiskSettings>) => void;
  fallbackRewardR?: number;
}) {
  /** 用户手动改过止盈后，模板不再抢回；改入场价/止损时重新跟随 */
  const [tpTouched, setTpTouched] = useState(false);

  // 风险计算表格里手数只能由风险反算：启动时恢复成该模式也强制打开自动手数
  useEffect(() => {
    if (entryMode === 'risk' && !risk.auto) patchRisk({ auto: true });
  }, [entryMode, risk.auto, patchRisk]);

  // 模板启用期间在设置或票内改了风险口径/数值，这里跟着套用；手动改风险不会被覆盖
  useEffect(() => {
    if (!armed) return;
    const target = templateRisk(template);
    if (risk.mode === target.mode && risk.value === target.value && risk.auto) return;
    patchRisk(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, template.id, template.riskMode, template.riskPercent, template.riskAmount, patchRisk]);

  // 改入场价 / 止损 / 方向 / 类型后，止盈重新跟随模板（手动改过的 TP 此时让位）
  useEffect(() => {
    setTpTouched(false);
  }, [draft.side, draft.type, draft.price, draft.sl]);

  // 切换模板时同样重新跟随
  useEffect(() => {
    setTpTouched(false);
  }, [template.id]);

  // 止损设定后按模板的 R 倍数自动放止盈；用户手动改过就不抢回。
  // 没有启用模板时按基础 1R 止盈（对应「没有模板默认 1% + 1R」）。
  // 市价单的 rulerEntry 跟着报价走，所以价格一动止盈就按新的 1R 距离重算。
  useEffect(() => {
    if (tpTouched || !info || !draft.active) return;
    const rewardR = armed ? template.rewardR : (fallbackRewardR ?? 1);
    if (!(rewardR > 0)) return;
    const target = templateTpTarget({
      side: draft.side,
      price: rulerEntry,
      sl: draft.sl,
      rewardR,
      tick,
      digits,
    });
    if (target == null) return;
    if (draft.tp == null || Math.abs(draft.tp - target) > (tick || 1e-9) / 2) {
      patchDraft({ tp: target });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    armed,
    fallbackRewardR,
    tpTouched,
    template.rewardR,
    draft.active,
    draft.side,
    draft.price,
    draft.sl,
    rulerEntry,
    info,
    tick,
    digits,
    patchDraft,
  ]);

  return { tpTouched, setTpTouched };
}
