import type { Account, Bar, JournalRecord, SymbolInfo } from '../gateway/types';
import type { NewSessionInput } from './store';
import type { ReplayReference, ReplaySession } from './types';

/** 开仓前 / 平仓后各留的观察窗 */
export const REFERENCE_PAD_SEC = 30 * 60;
/** 剥头皮交易也至少给一小时，免得只有几根 K 线 */
export const REFERENCE_MIN_SEC = 60 * 60;

export function referenceKey(login: number, positionId: number): string {
  return `${login}:${positionId}`;
}

export function referenceFromRecord(record: JournalRecord): ReplayReference {
  const risk = record.risk;
  return {
    kind: 'journal',
    login: record.login,
    positionId: record.position_id,
    symbol: record.symbol,
    openTs: record.open_time,
    closeTs: record.close_time,
    side: record.side,
    volume: record.volume,
    entry: record.entry_price,
    exit: record.exit_price,
    sl: record.sl,
    tp: record.tp,
    profit: record.profit,
    r: risk != null && risk > 0 ? record.profit / risk : null,
    mfe: record.mfe,
    mae: record.mae,
    tag: record.tag,
    closedBy: record.closed_by,
    hasShot: !!record.has_shot,
    key: referenceKey(record.login, record.position_id),
  };
}

/** 可见区间：开仓前 30 分钟 → 平仓后 30 分钟，至少 60 分钟 */
export function referenceWindow(
  openTs: number,
  closeTs: number,
): { startTs: number; endTs: number } {
  return {
    startTs: openTs - REFERENCE_PAD_SEC,
    endTs: Math.max(closeTs + REFERENCE_PAD_SEC, openTs + REFERENCE_MIN_SEC),
  };
}

/** 同 key 的会话去重：优先最新一个，已归档的不算 */
export function findReferenceSession(
  sessions: ReplaySession[],
  key: string,
): ReplaySession | undefined {
  let found: ReplaySession | undefined;
  for (const session of sessions) {
    if (session.reference?.key !== key || session.status === 'archived') continue;
    if (!found || session.createdAt > found.createdAt) found = session;
  }
  return found;
}

/**
 * 参照层默认显示；demo 数据不是真实行情，默认隐藏，要求用户手动打开。
 * 用户手动切换过就以后存下来的值为准。
 */
export function referenceVisible(session: ReplaySession): boolean {
  return session.referenceVisible ?? session.dataSource !== 'demo';
}

/** 用交易记录拼出创建会话的入参；账户不可用时退回 10000 / USD */
export function buildReferenceInput(
  record: JournalRecord,
  symbolInfo: SymbolInfo,
  account: Account | null,
  riskPercent: number | null | undefined,
): NewSessionInput {
  const { startTs, endTs } = referenceWindow(record.open_time, record.close_time);
  const balance =
    account && Number.isFinite(account.balance) && account.balance > 0 ? account.balance : 10_000;
  const currency = (account?.currency || symbolInfo.currency || 'USD').trim() || 'USD';
  const spreadPoints = symbolInfo.spreadPoints > 0 ? symbolInfo.spreadPoints : 20;
  return {
    name: `${record.symbol} 实盘复盘 #${record.position_id}`,
    symbol: record.symbol,
    symbolInfo,
    startTs,
    endTs,
    settings: {
      initialBalance: balance,
      currency,
      leverage: 100,
      spreadPoints,
      commissionPerLot: 0,
      timeframe: '15',
      riskPercent:
        riskPercent != null && Number.isFinite(riskPercent) && riskPercent > 0 ? riskPercent : 0.5,
    },
    origin: 'journal',
    reference: referenceFromRecord(record),
    referenceVisible: true,
  };
}

/**
 * 持仓区间到游标为止的价格范围，给参照层底色用。
 * 不取未来的出场价，避免图上看一眼就知道结果。
 */
export function holdingRange(
  bars: Bar[],
  openTs: number,
  cursorTs: number,
  entry: number,
): { high: number; low: number } | null {
  let high = entry;
  let low = entry;
  let seen = false;
  for (const bar of bars) {
    if (bar.time < openTs || bar.time > cursorTs) continue;
    high = Math.max(high, bar.high);
    low = Math.min(low, bar.low);
    seen = true;
  }
  return seen ? { high, low } : null;
}

/** 重演前判断要不要跳转，以及已经晚于原始入场多少分钟 */
export function retryTiming(
  reference: ReplayReference,
  cursorTs: number,
): { needsSeek: boolean; lateMinutes: number } {
  if (cursorTs < reference.openTs) return { needsSeek: true, lateMinutes: 0 };
  return {
    needsSeek: false,
    lateMinutes: Math.max(0, Math.round((cursorTs - reference.openTs) / 60)),
  };
}
