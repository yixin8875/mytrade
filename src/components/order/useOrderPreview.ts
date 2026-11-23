import { useEffect, useRef, useState } from 'react';
import { gateway } from '../../gateway/client';
import type {
  DraftOrder,
  RiskSettings,
  SymbolInfo,
  TradePreview,
  TradeSizing,
} from '../../gateway/types';

/** 价格跳动时最多每 400ms 重算一次，避免逐笔成交把网关刷爆 */
const LIVE_REFRESH_GAP_MS = 400;

/**
 * 下单预览与按风险反推手数：
 * - 草稿字段改动走 250ms 防抖；
 * - 市价单还跟随 `liveEntry`（当前买卖价）刷新，但最多 400ms 一次，
 *   这样移动中的止盈距离会即时反映到风险、手数与 R:R。
 */
export function useOrderPreview({
  ready,
  info,
  symbol,
  draft,
  risk,
  liveEntry,
  patchDraft,
  setPreview,
}: {
  ready: boolean;
  info: SymbolInfo | undefined;
  symbol: string;
  draft: DraftOrder;
  risk: RiskSettings;
  /** 市价单的当前入场价（买=ask / 卖=bid）；挂单传 null */
  liveEntry: number | null;
  patchDraft: (patch: Partial<DraftOrder>) => void;
  setPreview: (preview: TradePreview | null) => void;
}) {
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [sizing, setSizing] = useState<TradeSizing | null>(null);
  const previewRanAt = useRef(0);
  const sizingRanAt = useRef(0);

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
    // 防抖 250ms；如果上一轮刚跑过，最多等到 400ms 的时间点就再跑
    const elapsed = Date.now() - previewRanAt.current;
    const delay = elapsed >= LIVE_REFRESH_GAP_MS ? 250 : Math.max(0, LIVE_REFRESH_GAP_MS - elapsed);
    const timer = window.setTimeout(() => {
      previewRanAt.current = Date.now();
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
    }, delay);
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
    liveEntry,
    setPreview,
  ]);

  // 按目标风险反推手数：止损一变就算一次，市价单随价格刷新，自动模式下直接套用
  useEffect(() => {
    if (!ready || !info || !draft.active || !draft.sl || !(draft.price > 0)) {
      setSizing(null);
      return;
    }
    const elapsed = Date.now() - sizingRanAt.current;
    const delay = elapsed >= LIVE_REFRESH_GAP_MS ? 250 : Math.max(0, LIVE_REFRESH_GAP_MS - elapsed);
    const timer = window.setTimeout(() => {
      sizingRanAt.current = Date.now();
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
    }, delay);
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
    liveEntry,
    risk.mode,
    risk.value,
    risk.auto,
    patchDraft,
  ]);

  return { previewError, sizing };
}
