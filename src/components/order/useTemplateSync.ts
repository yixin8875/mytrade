import { useEffect, useState } from 'react';
import { templateTpTarget } from '../../lib/template';
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
}) {
  /** 用户手动改过止盈后，模板不再抢回；改入场价/止损时重新跟随 */
  const [tpTouched, setTpTouched] = useState(false);

  // 风险计算表格里手数只能由风险反算：启动时恢复成该模式也强制打开自动手数
  useEffect(() => {
    if (entryMode === 'risk' && !risk.auto) patchRisk({ auto: true });
  }, [entryMode, risk.auto, patchRisk]);

  // 模板启用期间在设置或票内改了风险比例，这里跟着套用；手动改风险不会被覆盖
  useEffect(() => {
    if (!armed) return;
    if (risk.mode === 'percent' && risk.value === template.riskPercent && risk.auto) return;
    patchRisk({ mode: 'percent', value: template.riskPercent, auto: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, template.id, template.riskPercent, patchRisk]);

  // 改入场价 / 止损 / 方向 / 类型后，止盈重新跟随模板（手动改过的 TP 此时让位）
  useEffect(() => {
    setTpTouched(false);
  }, [draft.side, draft.type, draft.price, draft.sl]);

  // 切换模板时同样重新跟随
  useEffect(() => {
    setTpTouched(false);
  }, [template.id]);

  // 模板：止损设定后按设置的 R 倍数自动放止盈；用户手动改过就不抢回
  useEffect(() => {
    if (!armed || tpTouched || !info || !draft.active) return;
    const target = templateTpTarget({
      side: draft.side,
      price: rulerEntry,
      sl: draft.sl,
      rewardR: template.rewardR,
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
    tpTouched,
    template.rewardR,
    draft.active,
    draft.side,
    draft.price,
    draft.sl,
    info,
    tick,
    digits,
    patchDraft,
  ]);

  return { tpTouched, setTpTouched };
}
