import { useCallback } from 'react';
import { gateway } from '../gateway/client';
import type { JournalRecord } from '../gateway/types';
import { activeTemplate, useApp } from '../store/useApp';
import {
  buildReferenceInput,
  findReferenceSession,
  referenceKey,
} from './reference';
import { goReplaySession } from './route';
import { setReplayBack } from './back';
import { SESSION_SOFT_LIMIT, useReplay } from './store';
import type { ReplaySession } from './types';

export type TradeReplayStart = 'opened' | 'failed';

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

/** 回放顶部「返回…」用的来源页名称 */
const PAGE_LABELS: Record<string, string> = {
  journal: '交易日志',
  diary: '盈亏日历',
  trends: '绩效趋势',
  analysis: '交易分析',
  executions: '执行质量',
  overview: '概览',
  missed: '错过的机会',
};

function rememberSource(record: JournalRecord): void {
  const page = useApp.getState().page;
  setReplayBack({
    page,
    positionId: record.position_id,
    label: PAGE_LABELS[page] ?? '交易日志',
  });
}

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
  const start = useCallback((record: JournalRecord): TradeReplayStart => {
    const app = useApp.getState();
    const key = referenceKey(record.login, record.position_id);
    const existing = findReferenceSession(useReplay.getState().sessions, key);
    if (existing) {
      rememberSource(record);
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
    if (useReplay.getState().sessions.length >= SESSION_SOFT_LIMIT) {
      app.notify('info', '复盘会话已超过 200 个，建议在列表里归档旧会话；本次仍会创建');
    }
    const input = buildReferenceInput(
      record,
      info,
      app.account,
      activeTemplate(app).riskPercent,
    );
    const id = useReplay.getState().createSession(input);
    void loadFills(record, id);
    rememberSource(record);
    goReplaySession(id);
    return 'opened';
  }, []);

  /** 从「错过的机会」开一段窗口回放：观察时间前 30 分钟 → 后 120 分钟 */
  const startWindow = useCallback(
    (input: { symbol: string; anchorTs: number; label: string }): TradeReplayStart => {
      const app = useApp.getState();
      const info = app.symbols.find((item) => item.name === input.symbol);
      if (!info) {
        app.notify('error', `当前 MT5 终端没有 ${input.symbol}，无法对齐行情`);
        return 'failed';
      }
      if (useReplay.getState().sessions.length >= SESSION_SOFT_LIMIT) {
        app.notify('info', '复盘会话已超过 200 个，建议在列表里归档旧会话；本次仍会创建');
      }
      const balance =
        app.account && Number.isFinite(app.account.balance) && app.account.balance > 0
          ? app.account.balance
          : 10_000;
      const risk = activeTemplate(app).riskPercent;
      const id = useReplay.getState().createSession({
        name: `${input.symbol} · 错过的机会 ${input.label}`.slice(0, 60),
        symbol: input.symbol,
        symbolInfo: info,
        startTs: Math.round(input.anchorTs) - 30 * 60,
        endTs: Math.round(input.anchorTs) + 120 * 60,
        settings: {
          initialBalance: balance,
          currency: (app.account?.currency || info.currency || 'USD').trim() || 'USD',
          leverage: 100,
          spreadPoints: info.spreadPoints > 0 ? info.spreadPoints : 20,
          commissionPerLot: 0,
          timeframe: '15',
          riskPercent: risk != null && Number.isFinite(risk) && risk > 0 ? risk : 0.5,
        },
        origin: 'missed',
      });
      setReplayBack({ page: 'missed', label: '错过的机会' });
      goReplaySession(id);
      return 'opened';
    },
    [],
  );

  return { start, startWindow };
}
