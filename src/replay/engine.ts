import type { Bar, Side, SymbolInfo } from '../gateway/types';
import type {
  ReplayOrder,
  ReplayPosition,
  ReplaySession,
  ReplayStats,
  ReplayTrade,
} from './types';

/**
 * 回放撮合引擎：纯函数，不 import gateway/client，不接触任何实盘订单接口。
 * 价格约定：M1 K 线是 bid；ask = bid + spreadPoints × point。
 * 买入开仓/买入平仓用 ask，卖出开仓/卖出平仓用 bid。
 */

let seq = 0;
export function replayId(prefix: string): string {
  seq += 1;
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}-${random}`;
}

export function roundPrice(value: number, info: SymbolInfo): number {
  const tick = info.tickSize || info.point || 0;
  if (!tick) return Number(value.toFixed(info.digits));
  return Number((Math.round(value / tick) * tick).toFixed(info.digits));
}

export function roundVolume(value: number, info: SymbolInfo): number {
  const step = info.volumeStep || 0.01;
  const steps = Math.floor(value / step + 1e-9);
  const rounded = Number((steps * step).toFixed(step >= 0.1 ? 1 : 2));
  return Math.min(info.maxVolume, Math.max(info.minVolume, rounded));
}

export function askPrice(bid: number, info: SymbolInfo, spreadPoints: number): number {
  return bid + spreadPoints * info.point;
}

/** 账户货币盈亏；tickSize/tickValue 已包含合约换算 */
export function calcProfit(
  side: Side,
  volume: number,
  entry: number,
  exit: number,
  info: SymbolInfo,
): number {
  const tick = info.tickSize || info.point || 1e-9;
  const diff = side === 'buy' ? exit - entry : entry - exit;
  return (diff / tick) * (info.tickValue || 0) * volume;
}

export function marginFor(
  volume: number,
  price: number,
  info: SymbolInfo,
  leverage: number,
): number {
  if (!leverage || leverage <= 0) return 0;
  return (info.contractSize * volume * price) / leverage;
}

function commissionFor(volume: number, perLot: number): number {
  return volume * perLot;
}

/** 当前这一笔仓位的浮动盈亏（多头按 bid，空头按 ask） */
export function positionProfit(
  position: ReplayPosition,
  bid: number,
  info: SymbolInfo,
  spreadPoints: number,
): number {
  const exit = position.side === 'buy' ? bid : askPrice(bid, info, spreadPoints);
  return calcProfit(position.side, position.volume, position.entry, exit, info);
}

export function floatingProfit(
  session: Pick<ReplaySession, 'positions' | 'symbolInfo' | 'settings'>,
  bid: number,
): number {
  return session.positions.reduce(
    (sum, position) =>
      sum + positionProfit(position, bid, session.symbolInfo, session.settings.spreadPoints),
    0,
  );
}

interface StepResult {
  session: ReplaySession;
  events: string[];
}

function openPosition(
  session: ReplaySession,
  order: ReplayOrder,
  entry: number,
  ts: number,
): void {
  const info = session.symbolInfo;
  const volume = roundVolume(order.volume, info);
  if (volume <= 0) return;
  const openCommission = commissionFor(volume, session.settings.commissionPerLot);
  session.balance -= openCommission;
  const risk =
    order.sl != null
      ? Math.abs(calcProfit(order.side, volume, entry, order.sl, info))
      : null;
  session.positions.push({
    id: replayId('pos'),
    side: order.side,
    volume,
    entry,
    sl: order.sl,
    tp: order.tp,
    openTs: ts,
    initialRisk: risk,
    initialRiskPrice: order.sl != null ? Math.abs(entry - order.sl) : null,
    openCommission,
    tag: order.tag,
    mfe: 0,
    mae: 0,
    templateStep: 0,
    steps: order.steps?.map((step) => ({ ...step })),
    templateName: order.templateName,
  });
  session.orders = session.orders.filter((item) => item.id !== order.id);
}

function closePosition(
  session: ReplaySession,
  positionId: string,
  volume: number,
  exit: number,
  ts: number,
  closedBy: ReplayTrade['closedBy'],
): void {
  const info = session.symbolInfo;
  // 0/负数会被 roundVolume 抬到最小手数，等于悄悄平掉一点仓位
  if (!(volume > 0)) return;
  const index = session.positions.findIndex((item) => item.id === positionId);
  if (index < 0) return;
  const position = session.positions[index];
  const closeVolume = Math.min(roundVolume(volume, info), position.volume);
  if (closeVolume <= 0) return;

  const share = closeVolume / position.volume;
  const openCommission = position.openCommission * share;
  const closeCommission = commissionFor(closeVolume, session.settings.commissionPerLot);
  const gross = calcProfit(position.side, closeVolume, position.entry, exit, info);
  const net = gross - openCommission - closeCommission;
  const risk = position.initialRisk != null ? position.initialRisk * share : null;

  session.balance += gross - closeCommission;
  session.trades.push({
    id: replayId('trade'),
    side: position.side,
    volume: closeVolume,
    entry: position.entry,
    exit,
    openTs: position.openTs,
    closeTs: ts,
    profit: net,
    commission: openCommission + closeCommission,
    r: risk != null && risk > 0 ? net / risk : null,
    tag: position.tag,
    closedBy,
    mfe: position.mfe,
    mae: position.mae,
    templateName: position.templateName,
  });

  if (closeVolume >= position.volume - 1e-9) {
    session.positions.splice(index, 1);
  } else {
    position.volume = Number((position.volume - closeVolume).toFixed(2));
    position.openCommission -= openCommission;
    if (position.initialRisk != null) position.initialRisk -= risk ?? 0;
  }
}

function markExcursion(session: ReplaySession, bar: Bar): void {
  const info = session.symbolInfo;
  const spread = session.settings.spreadPoints;
  for (const position of session.positions) {
    // 与浮动盈亏/平仓价同一口径：多头按 bid，空头按 ask（加回点差）
    const favorablePrice =
      position.side === 'buy' ? bar.high : askPrice(bar.low, info, spread);
    const adversePrice =
      position.side === 'buy' ? bar.low : askPrice(bar.high, info, spread);
    const favorable = calcProfit(
      position.side,
      position.volume,
      position.entry,
      favorablePrice,
      info,
    );
    const adverse = calcProfit(
      position.side,
      position.volume,
      position.entry,
      adversePrice,
      info,
    );
    position.mfe = Math.max(position.mfe, favorable);
    position.mae = Math.min(position.mae, adverse);
  }
}

/**
 * 订单模板阶段：浮盈达到 atR 时平掉 closePercent，或把止损移到开仓价。
 * 同一根 M1 内按有利极值判断，触发价用 R 对应的价格，保证结果可复现。
 * 每个阶段只执行一次（templateStep 记录进度）。
 */
function applyTemplateSteps(
  session: ReplaySession,
  position: ReplayPosition,
  bar: Bar,
  events: string[],
): void {
  const steps = position.steps;
  const riskPrice = position.initialRiskPrice;
  if (!steps?.length || !position.initialRisk || position.initialRisk <= 0) return;
  if (!riskPrice || riskPrice <= 0) return;
  const info = session.symbolInfo;
  const favorable =
    position.side === 'buy'
      ? bar.high
      : askPrice(bar.low, info, session.settings.spreadPoints);
  while (position.templateStep < steps.length) {
    const step = steps[position.templateStep];
    const profit = calcProfit(position.side, position.volume, position.entry, favorable, info);
    if (profit / position.initialRisk < step.atR - 1e-9) break;
    const direction = position.side === 'buy' ? 1 : -1;
    const trigger = roundPrice(position.entry + direction * riskPrice * step.atR, info);
    const ts = bar.time + 60;
    if (step.closePercent != null) {
      const before = position.volume;
      const closeVolume = Math.min(
        roundVolume((before * step.closePercent) / 100, info),
        before,
      );
      if (closeVolume > 0) {
        closePosition(session, position.id, closeVolume, trigger, ts, 'template');
        events.push(`模板 ${step.atR}R 平 ${step.closePercent}%`);
        // 手数太小时按 step 取整可能已把仓位平光
        if (closeVolume >= before - 1e-9) return;
      }
    }
    if (step.moveBreakeven) {
      position.sl = position.entry;
      events.push(`模板 ${step.atR}R 移到保本`);
    }
    position.templateStep += 1;
  }
}

/** 处理一根 M1；bar 必须是游标之后的下一根 */
export function stepSession(session: ReplaySession, bar: Bar): StepResult {
  const info = session.symbolInfo;
  const spread = session.settings.spreadPoints;
  const ask = (bid: number) => askPrice(bid, info, spread);
  const ts = bar.time + 60;
  const events: string[] = [];

  // 1. 市价单在下一根开盘成交
  for (const order of [...session.orders]) {
    if (order.type !== 'market') continue;
    const entry = order.side === 'buy' ? ask(bar.open) : bar.open;
    openPosition(session, order, roundPrice(entry, info), bar.time);
    events.push(`${order.side === 'buy' ? '买入' : '卖出'} ${order.volume} 手成交`);
  }

  // 2. 挂单触发；跳空时用开盘价，成交价可能比委托价更差/更优
  for (const order of [...session.orders]) {
    if (order.type === 'market') continue;
    const price = roundPrice(order.price, info);
    let fill: number | null = null;
    // 买入侧按 ask 判断：spreadPoints 是「点」，必须先换成价格（× point），
    // 不能把 20 个点直接加到 3980 这类价格上。
    if (order.type === 'limit' && order.side === 'buy' && ask(bar.low) <= price) {
      fill = Math.min(price, ask(bar.open));
    } else if (order.type === 'limit' && order.side === 'sell' && bar.high >= price) {
      fill = Math.max(price, bar.open);
    } else if (order.type === 'stop' && order.side === 'buy' && ask(bar.high) >= price) {
      fill = Math.max(price, ask(bar.open));
    } else if (order.type === 'stop' && order.side === 'sell' && bar.low <= price) {
      fill = Math.min(price, bar.open);
    }
    if (fill != null) {
      openPosition(session, order, roundPrice(fill, info), bar.time);
      events.push(`挂单触发 ${order.side === 'buy' ? '买入' : '卖出'} ${order.volume} 手`);
    }
  }

  // 3. 更新 MFE/MAE，再检查 SL/TP；同一根同时触发时先止损
  markExcursion(session, bar);
  for (const position of [...session.positions]) {
    const sl = position.sl;
    const tp = position.tp;
    if (position.side === 'buy') {
      if (sl != null && bar.open <= sl) {
        closePosition(session, position.id, position.volume, bar.open, ts, 'sl');
        events.push('止损');
        continue;
      }
      if (sl != null && bar.low <= sl) {
        closePosition(session, position.id, position.volume, sl, ts, 'sl');
        events.push('止损');
        continue;
      }
      if (tp != null && bar.open >= tp) {
        closePosition(session, position.id, position.volume, bar.open, ts, 'tp');
        events.push('止盈');
        continue;
      }
      if (tp != null && bar.high >= tp) {
        closePosition(session, position.id, position.volume, tp, ts, 'tp');
        events.push('止盈');
      }
    } else {
      if (sl != null && ask(bar.open) >= sl) {
        closePosition(session, position.id, position.volume, ask(bar.open), ts, 'sl');
        events.push('止损');
        continue;
      }
      if (sl != null && ask(bar.high) >= sl) {
        closePosition(session, position.id, position.volume, sl, ts, 'sl');
        events.push('止损');
        continue;
      }
      if (tp != null && ask(bar.open) <= tp) {
        closePosition(session, position.id, position.volume, ask(bar.open), ts, 'tp');
        events.push('止盈');
        continue;
      }
      if (tp != null && ask(bar.low) <= tp) {
        closePosition(session, position.id, position.volume, tp, ts, 'tp');
        events.push('止盈');
      }
    }
  }

  // 4. 模板阶段（到达 atR 时平仓/移保本）
  for (const position of [...session.positions]) {
    applyTemplateSteps(session, position, bar, events);
  }

  // 5. 收盘估值
  const floating = floatingProfit(session, bar.close);
  session.equity = session.balance + floating;
  session.peakEquity = Math.max(session.peakEquity, session.equity);
  if (session.peakEquity > 0) {
    const drawdown = ((session.peakEquity - session.equity) / session.peakEquity) * 100;
    session.maxDrawdownPct = Math.max(session.maxDrawdownPct, drawdown);
  }
  session.equityCurve.push({
    t: ts,
    v: session.equity,
    peak: session.peakEquity,
  });

  // 6. 推进游标
  session.cursorIndex += 1;
  session.updatedAt = Date.now();
  if (session.equity <= 0) events.push('模拟账户已爆仓');
  return { session, events };
}

/** 当前可成交价格：多头平仓用 bid，空头平仓用 ask */
export function currentExitPrice(session: ReplaySession, side: Side, bar: Bar): number {
  return side === 'buy'
    ? bar.close
    : askPrice(bar.close, session.symbolInfo, session.settings.spreadPoints);
}

export function closePositionNow(
  session: ReplaySession,
  positionId: string,
  volume: number,
  bar: Bar,
  closedBy: ReplayTrade['closedBy'] = 'manual',
): void {
  const position = session.positions.find((item) => item.id === positionId);
  if (!position) return;
  const exit = currentExitPrice(session, position.side, bar);
  closePosition(
    session,
    positionId,
    volume,
    roundPrice(exit, session.symbolInfo),
    bar.time + 60,
    closedBy,
  );
  const floating = floatingProfit(session, bar.close);
  session.equity = session.balance + floating;
}

export function finishAll(session: ReplaySession, bar: Bar): void {
  for (const position of [...session.positions]) {
    closePositionNow(session, position.id, position.volume, bar, 'finish');
  }
  session.orders = [];
  session.status = 'finished';
  session.finishedAt = Date.now();
  session.equity = session.balance;
  session.updatedAt = Date.now();
}

export function setPositionStops(
  session: ReplaySession,
  positionId: string,
  patch: { sl?: number | null; tp?: number | null },
): void {
  const position = session.positions.find((item) => item.id === positionId);
  if (!position) return;
  if (patch.sl !== undefined) position.sl = patch.sl;
  if (patch.tp !== undefined) position.tp = patch.tp;
  session.updatedAt = Date.now();
}

export function setOrderPrice(session: ReplaySession, orderId: string, price: number): void {
  const order = session.orders.find((item) => item.id === orderId);
  if (!order) return;
  order.price = price;
  session.updatedAt = Date.now();
}

export function cancelOrder(session: ReplaySession, orderId: string): void {
  session.orders = session.orders.filter((item) => item.id !== orderId);
  session.updatedAt = Date.now();
}

const R_BINS = [
  { label: '< -1', test: (r: number) => r < -1, negative: true },
  { label: '-1 ~ 0', test: (r: number) => r >= -1 && r < 0, negative: true },
  { label: '0 ~ 1', test: (r: number) => r >= 0 && r < 1, negative: false },
  { label: '1 ~ 2', test: (r: number) => r >= 1 && r < 2, negative: false },
  { label: '2 ~ 3', test: (r: number) => r >= 2 && r < 3, negative: false },
  { label: '> 3', test: (r: number) => r >= 3, negative: false },
];

export function calculateStats(session: ReplaySession): ReplayStats {
  const trades = session.trades;
  const netPnl = trades.reduce((sum, trade) => sum + trade.profit, 0);
  const wins = trades.filter((trade) => trade.profit > 0).length;
  const losses = trades.filter((trade) => trade.profit < 0).length;
  const grossProfit = trades
    .filter((trade) => trade.profit > 0)
    .reduce((sum, trade) => sum + trade.profit, 0);
  const grossLoss = Math.abs(
    trades.filter((trade) => trade.profit < 0).reduce((sum, trade) => sum + trade.profit, 0),
  );
  const rs = trades.map((trade) => trade.r).filter((r): r is number => r != null);
  const totalR = rs.reduce((sum, r) => sum + r, 0);
  const equityPnl = session.equity - session.settings.initialBalance;
  const byTag = new Map<string, { trades: number; totalR: number; pnl: number }>();
  for (const trade of trades) {
    const key = trade.tag || '未分类';
    const item = byTag.get(key) ?? { trades: 0, totalR: 0, pnl: 0 };
    item.trades += 1;
    item.totalR += trade.r ?? 0;
    item.pnl += trade.profit;
    byTag.set(key, item);
  }
  return {
    netPnl,
    equityPnl,
    returnPct:
      session.settings.initialBalance > 0
        ? (netPnl / session.settings.initialBalance) * 100
        : 0,
    maxDrawdownPct: session.maxDrawdownPct,
    trades: trades.length,
    wins,
    losses,
    winRate: trades.length ? wins / trades.length : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    avgR: rs.length ? totalR / rs.length : null,
    totalR,
    grossProfit,
    grossLoss,
    expectancy: trades.length ? netPnl / trades.length : null,
    byTag: [...byTag.entries()]
      .map(([tag, item]) => ({ tag, ...item }))
      .sort((a, b) => b.trades - a.trades),
    rBins: R_BINS.map((bin) => ({
      label: bin.label,
      count: rs.filter((r) => bin.test(r)).length,
      negative: bin.negative,
    })),
  };
}

export function accountSummary(session: ReplaySession, bid: number) {
  const floating = floatingProfit(session, bid);
  const equity = session.balance + floating;
  const margin = session.positions.reduce(
    (sum, position) =>
      sum +
      marginFor(
        position.volume,
        position.side === 'buy'
          ? askPrice(bid, session.symbolInfo, session.settings.spreadPoints)
          : bid,
        session.symbolInfo,
        session.settings.leverage,
      ),
    0,
  );
  return {
    floating,
    equity,
    margin,
    freeMargin: equity - margin,
    marginLevel: margin > 0 ? (equity / margin) * 100 : null,
  };
}
