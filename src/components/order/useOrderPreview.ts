import { useEffect, useState } from 'react';
import { gateway } from '../../gateway/client';
import type {
  DraftOrder,
  RiskSettings,
  SymbolInfo,
  TradePreview,
  TradeSizing,
} from '../../gateway/types';

/** 下单预览与按风险反推手数：都走 250ms 防抖，随草稿字段变化重算 */
export function useOrderPreview({
  ready,
  info,
  symbol,
  draft,
  risk,
  patchDraft,
  setPreview,
}: {
  ready: boolean;
  info: SymbolInfo | undefined;
  symbol: string;
  draft: DraftOrder;
  risk: RiskSettings;
  patchDraft: (patch: Partial<DraftOrder>) => void;
  setPreview: (preview: TradePreview | null) => void;
}) {
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [sizing, setSizing] = useState<TradeSizing | null>(null);

  useEffect(() => {
    if (!ready || !info || !draft.active) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    if (draft.type !== 'market' && !(draft.price > 0)) {
      setPreview(null);
      setPreviewError('请先设置委托价格');
      return;
    }
    const timer = window.setTimeout(() => {
      gateway
        .call<TradePreview>('trade.preview', {
          symbol,
          side: draft.side,
          type: draft.type,
          volume: draft.volume,
          price: draft.type === 'market' ? undefined : draft.price,
          sl: draft.sl ?? undefined,
          tp: draft.tp ?? undefined,
        })
        .then((result) => {
          setPreview(result);
          setPreviewError(null);
        })
        .catch((error: Error) => {
          setPreview(null);
          setPreviewError(error.message);
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    ready,
    info,
    symbol,
    draft.active,
    draft.side,
    draft.type,
    draft.price,
    draft.volume,
    draft.sl,
    draft.tp,
    setPreview,
  ]);

  // 按目标风险反推手数：止损一变就算一次，自动模式下直接套用
  useEffect(() => {
    if (!ready || !info || !draft.active || !draft.sl || !(draft.price > 0)) {
      setSizing(null);
      return;
    }
    const timer = window.setTimeout(() => {
      gateway
        .call<TradeSizing>('trade.size', {
          symbol,
          side: draft.side,
          type: draft.type,
          volume: Math.max(info.minVolume, draft.volume),
          price: draft.type === 'market' ? undefined : draft.price,
          sl: draft.sl ?? undefined,
          tp: draft.tp ?? undefined,
          riskMode: risk.mode,
          riskValue: risk.value,
        })
        .then((result) => {
          setSizing(result);
          if (risk.auto && Math.abs(result.volume - draft.volume) > 1e-9) {
            patchDraft({ volume: result.volume });
          }
        })
        .catch(() => setSizing(null));
    }, 250);
    return () => window.clearTimeout(timer);
    // draft.volume 只是输入值，不放进依赖，避免自己改手数又触发一轮
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    ready,
    info,
    symbol,
    draft.active,
    draft.side,
    draft.type,
    draft.price,
    draft.sl,
    draft.tp,
    risk.mode,
    risk.value,
    risk.auto,
    patchDraft,
  ]);

  return { previewError, sizing };
}
