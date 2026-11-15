import { useCallback, useState } from 'react';
import { gateway } from '../gateway/client';
import type { JournalRecord } from '../gateway/types';
import { activeTemplate, useApp } from '../store/useApp';
import {
  buildReferenceInput,
  findReferenceSession,
  referenceKey,
  SESSION_LIMIT,
} from './reference';
import { goReplaySession } from './route';
import { useReplay } from './store';
import type { ReplaySession } from './types';

export type TradeReplayStart = 'opened' | 'pending' | 'failed';

interface PendingEviction {
  record: JournalRecord;
  oldest: ReplaySession;
}

/** executions.get 返回的 MT5 deal 中我们需要的字段 */
interface DealRow {
  ticket: number;
  positionId: number;
  volume: number;
  price: number;
  profit: number;
  time: number;
  /** 0 = 开仓成交，1 = 平仓成交 */
  entry: number;
}

/** 执行记录最多往前找 120 天；更早的交易只保留汇总口径 */
const FILLS_MAX_AGE_DAYS = 120;

/** 拉这笔持仓的逐笔成交，回填到参照层；失败不影响回放本身 */
async function loadFills(record: JournalRecord, sessionId: string): Promise<void> {
  const ageDays = Math.ceil((Date.now() / 1000 - record.close_time) / 86400) + 1;
  const days = Math.min(FILLS_MAX_AGE_DAYS, Math.max(1, ageDays));
  try {
    const deals = await gateway.call<DealRow[]>('executions.get', { days, limit: 2000 });
    const fills = deals
      .filter(
        (deal) =>
          Number(deal.positionId) === record.position_id &&
          (deal.entry === 0 || deal.entry === 1),
      )
      .map((deal) => ({
        ticket: deal.ticket,
        entry: deal.entry === 0 ? ('in' as const) : ('out' as const),
        volume: deal.volume,
        price: deal.price,
        time: deal.time,
        profit: deal.profit,
      }))
      .sort((a, b) => a.time - b.time);
    if (fills.length > 0) {
      useReplay.getState().setReferenceFills(sessionId, fills);
    }
  } catch {
    /* 拿不到执行记录时保持 JournalRecord 的汇总口径 */
  }
}

/**
 * 从一笔已平仓交易打开回放：
 * 已有同 key 会话就直接打开，没有就按「开仓前 30 分钟 → 平仓后 30 分钟」创建。
 */
export function useTradeReplay() {
  const [pending, setPending] = useState<PendingEviction | null>(null);

  const start = useCallback(
    (record: JournalRecord, evictId?: string): TradeReplayStart => {
      const app = useApp.getState();
      const key = referenceKey(record.login, record.position_id);
      const existing = findReferenceSession(useReplay.getState().sessions, key);
      if (existing) {
        goReplaySession(existing.id);
        return 'opened';
      }
      if (!app.symbols.length) {
        app.notify('error', '行情列表还没加载，请稍后再试');
        return 'failed';
      }
      const info = app.symbols.find((item) => item.name === record.symbol);
      if (!info) {
        app.notify('error', `当前 MT5 终端没有 ${record.symbol}，无法对齐行情`);
        return 'failed';
      }
      const sessions = useReplay.getState().sessions;
      if (sessions.length >= SESSION_LIMIT && !evictId) {
        const oldest = sessions.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
        setPending({ record, oldest });
        return 'pending';
      }
      if (evictId) useReplay.getState().remove(evictId);
      const input = buildReferenceInput(
        record,
        info,
        app.account,
        activeTemplate(app).riskPercent,
      );
      const id = useReplay.getState().createSession(input);
      setPending(null);
      void loadFills(record, id);
      goReplaySession(id);
      return 'opened';
    },
    [],
  );

  const confirm = useCallback((): TradeReplayStart | undefined => {
    if (!pending) return undefined;
    return start(pending.record, pending.oldest.id);
  }, [pending, start]);

  const cancel = useCallback(() => setPending(null), []);

  return { start, pending, confirm, cancel };
}

/** 会话满 60 个时的确认：说明会移除哪个，再让用户决定 */
export function ReferenceCapacityDialog({
  pending,
  onConfirm,
  onCancel,
}: {
  pending: PendingEviction | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!pending) return null;
  return (
    <div
      className="console-scope fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-4"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-label="复盘会话已满"
        className="w-[min(420px,92vw)] rounded-xl border border-console-line bg-console-card p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="text-[13px] font-medium text-console-ink">复盘会话已满 60 个</div>
        <p className="mt-2 text-[11px] leading-5 text-console-muted">
          再创建需要移除最旧的会话「{pending.oldest.name}」。移除后无法恢复。
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onCancel} className="console-btn console-btn-secondary">
            取消
          </button>
          <button onClick={onConfirm} className="console-btn console-btn-primary">
            移除并创建
          </button>
        </div>
      </div>
    </div>
  );
}
