/**
 * 挂单类型的本地推导：用户只填方向 + 价格，
 * 由价格相对市价的高低决定这是限价单还是停损单（与 Exness 一致）。
 * 价格落在当前点差内时无法挂单，返回 null 并给出提示。
 */

import type { Side } from '../gateway/types';

export type PendingType = 'limit' | 'stop';

export interface PendingInput {
  side: Side;
  /** 用户填写的委托价；0 = 还没填 */
  price: number;
  bid?: number | null;
  ask?: number | null;
  /** 券商要求的最小挂单距离（点）；0 表示不检查 */
  stopsLevelPoints?: number;
  /** 一个点的小数位价格，如 XAUUSD 的 0.01 */
  point?: number;
}

export interface PendingClassification {
  /** 推导出的挂单类型；价格无效时为 null，此时不能提交 */
  type: PendingType | null;
  /** 面板与图上使用的短名：限价买入 / 停损卖出 / 待定价 */
  label: string;
  /** 不能提交或需要提醒的原因；正常时为 null */
  warning: string | null;
}

function pendingLabel(side: Side, type: PendingType | null): string {
  if (!type) return '待定价';
  return `${type === 'limit' ? '限价' : '停损'}${side === 'buy' ? '买入' : '卖出'}`;
}

export function classifyPending({
  side,
  price,
  bid,
  ask,
  stopsLevelPoints = 0,
  point = 0,
}: PendingInput): PendingClassification {
  if (!Number.isFinite(price) || !(price > 0)) {
    return { type: null, label: pendingLabel(side, null), warning: '请输入委托价格' };
  }
  const bidPx = typeof bid === 'number' && Number.isFinite(bid) && bid > 0 ? bid : null;
  const askPx = typeof ask === 'number' && Number.isFinite(ask) && ask > 0 ? ask : null;
  if (bidPx == null || askPx == null) {
    return { type: null, label: pendingLabel(side, null), warning: '等待报价' };
  }

  // 挂单必须落在当前点差之外，否则和市价没有区别
  const low = Math.min(bidPx, askPx);
  const high = Math.max(bidPx, askPx);
  if (price >= low && price <= high) {
    return {
      type: null,
      label: pendingLabel(side, null),
      warning: '价格在点差内，请高于买价或低于卖价',
    };
  }

  const ref = side === 'buy' ? askPx : bidPx;
  // 买入：低于市价等回落 = 限价，高于市价追突破 = 停损；卖出相反
  const type: PendingType =
    side === 'buy' ? (price < ref ? 'limit' : 'stop') : price > ref ? 'limit' : 'stop';

  let warning: string | null = null;
  if (stopsLevelPoints > 0 && point > 0 && Math.abs(price - ref) < stopsLevelPoints * point) {
    warning = `距市价不足 ${stopsLevelPoints} 点，券商可能拒绝挂单`;
  }

  return { type, label: pendingLabel(side, type), warning };
}
