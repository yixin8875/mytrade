import { describe, expect, it } from 'vitest';
import type { ReplayPosition, ReplaySession, ReplayTrade } from './types';
import {
  accountSummary,
  askPrice,
  calcProfit,
  calculateStats,
  cancelOrder,
  closePositionNow,
  currentExitPrice,
  finishAll,
  floatingProfit,
  marginFor,
  positionProfit,
  replayId,
  roundPrice,
  roundVolume,
  setOrderPrice,
  setPositionStops,
  stepSession,
} from './engine';
import { GOLD_INFO, makeBar, makeOrder, makeSession } from './testUtils';

const T0 = 1_700_000_000;
const SPREAD = 0.2; // 20 point × 0.01

function addPosition(
  session: ReplaySession,
  overrides: Partial<ReplayPosition> = {},
): ReplayPosition {
  const position: ReplayPosition = {
    id: 'pos-1',
    side: 'buy',
    volume: 1,
    entry: 2000,
    sl: null,
    tp: null,
    openTs: 0,
    initialRisk: null,
    initialRiskPrice: null,
    openCommission: 0,
    tag: '',
    mfe: 0,
    mae: 0,
    templateStep: 0,
    ...overrides,
  };
  session.positions.push(position);
  return position;
}

function trade(overrides: Partial<ReplayTrade> = {}): ReplayTrade {
  return {
    id: 't',
    side: 'buy',
    volume: 1,
    entry: 2000,
    exit: 2000,
    openTs: 0,
    closeTs: 0,
    profit: 0,
    commission: 0,
    r: null,
    tag: '',
    closedBy: 'manual',
    mfe: 0,
    mae: 0,
    ...overrides,
  };
}

describe('价格与手数取整', () => {
  it('按 tickSize 对齐价格，缺 tick 时退回 digits', () => {
    expect(roundPrice(2000.234, GOLD_INFO)).toBe(2000.23);
    expect(roundPrice(2000.235, GOLD_INFO)).toBe(2000.24);
    expect(
      roundPrice(1.0865471, { ...GOLD_INFO, tickSize: 0, point: 0.00001, digits: 5 }),
    ).toBe(1.08655);
  });

  it('手数向下取整到步长并夹在最小/最大之间', () => {
    expect(roundVolume(0.237, GOLD_INFO)).toBe(0.23);
    expect(roundVolume(0.001, GOLD_INFO)).toBe(0.01);
    expect(roundVolume(500, GOLD_INFO)).toBe(100);
  });

  it('ask = bid + 点差 × point', () => {
    expect(askPrice(2000, GOLD_INFO, 20)).toBeCloseTo(2000 + SPREAD, 10);
  });
});

describe('盈亏与保证金', () => {
  it('多头按卖出价、空头按买入价计算账户货币盈亏', () => {
    expect(calcProfit('buy', 1, 2000, 2001, GOLD_INFO)).toBe(100);
    expect(calcProfit('sell', 1, 2001, 2000, GOLD_INFO)).toBe(100);
    expect(calcProfit('buy', 0.5, 2000, 2001, GOLD_INFO)).toBe(50);
  });

  it('保证金 = 合约量 × 手数 × 价格 / 杠杆', () => {
    expect(marginFor(1, 2000, GOLD_INFO, 100)).toBe(2000);
    expect(marginFor(2, 2000, GOLD_INFO, 100)).toBe(4000);
    expect(marginFor(1, 2000, GOLD_INFO, 0)).toBe(0);
  });

  it('浮动盈亏：多头用 bid，空头用 ask', () => {
    const long = addPosition(makeSession(), { entry: 2000 });
    expect(positionProfit(long, 2010, GOLD_INFO, 20)).toBe(1000);

    const short = addPosition(makeSession(), { side: 'sell', entry: 2000 });
    expect(positionProfit(short, 1990, GOLD_INFO, 20)).toBeCloseTo(980, 8);
  });

  it('floatingProfit 汇总所有仓位', () => {
    const session = makeSession();
    addPosition(session, { entry: 2000, volume: 1 });
    addPosition(session, { id: 'pos-2', entry: 2000, volume: 0.5 });
    expect(floatingProfit(session, 2010)).toBe(1500);
  });
});

describe('市价单', () => {
  it('多头在下一根开盘按 ask 成交，并扣除开仓佣金', () => {
    const session = makeSession();
    session.orders.push(makeOrder({ side: 'buy', type: 'market', volume: 1 }));
    const bar = makeBar(T0, 2000, 2002, 1999, 2001);

    const { events } = stepSession(session, bar);

    expect(session.positions).toHaveLength(1);
    const position = session.positions[0];
    expect(position.entry).toBeCloseTo(2000.2, 10);
    expect(position.volume).toBe(1);
    expect(position.initialRisk).toBeNull();
    expect(position.initialRiskPrice).toBeNull();
    expect(session.orders).toHaveLength(0);
    expect(session.balance).toBe(9995);
    expect(position.mfe).toBeCloseTo(180, 10);
    expect(position.mae).toBeCloseTo(-120, 10);
    expect(session.equity).toBeCloseTo(10075, 10);
    expect(session.peakEquity).toBeCloseTo(10075, 10);
    expect(session.cursorIndex).toBe(1);
    const lastPoint = session.equityCurve.at(-1)!;
    expect(lastPoint.t).toBe(T0 + 60);
    expect(lastPoint.v).toBeCloseTo(10075, 8);
    expect(lastPoint.peak).toBeCloseTo(10075, 8);
    expect(events).toContain('买入 1 手成交');
  });

  it('空头按 bid 成交，MFE/MAE 也按 ask 平仓口径', () => {
    const session = makeSession();
    session.orders.push(makeOrder({ side: 'sell', type: 'market', volume: 1 }));
    const bar = makeBar(T0, 2000, 2001, 1998, 1999);

    stepSession(session, bar);

    const position = session.positions[0];
    expect(position.entry).toBe(2000);
    expect(position.mfe).toBeCloseTo(180, 10); // (2000 - ask(1998)) / 0.01
    expect(position.mae).toBeCloseTo(-120, 10); // (2000 - ask(2001)) / 0.01
    expect(session.equity).toBeCloseTo(10075, 10); // 9995 + (2000 - ask(1999)) / 0.01
  });
});

describe('挂单触发', () => {
  it('买入限价在 ask 触及委托价时成交，跳空按更好的开盘价', () => {
    const session = makeSession();
    session.orders.push(makeOrder({ type: 'limit', side: 'buy', price: 2000, volume: 1 }));

    stepSession(session, makeBar(T0, 1998, 1999, 1997, 1998.5));

    expect(session.positions[0].entry).toBeCloseTo(1998.2, 10);
  });

  it('价格没碰到就不成交', () => {
    const session = makeSession();
    session.orders.push(makeOrder({ type: 'limit', side: 'buy', price: 2000, volume: 1 }));

    stepSession(session, makeBar(T0, 2001, 2001.5, 2000.8, 2001.2));

    expect(session.positions).toHaveLength(0);
    expect(session.orders).toHaveLength(1);
  });

  it('卖出限价在 bid 触及委托价时成交，跳空按更好的开盘价', () => {
    const session = makeSession();
    session.orders.push(makeOrder({ type: 'limit', side: 'sell', price: 2000, volume: 1 }));

    stepSession(session, makeBar(T0, 2002, 2003, 2001, 2002.5));

    expect(session.positions[0].entry).toBe(2002);
  });

  it('买入停损跳空时按更差的开盘 ask 成交', () => {
    const session = makeSession();
    session.orders.push(makeOrder({ type: 'stop', side: 'buy', price: 2000, volume: 1 }));

    stepSession(session, makeBar(T0, 2002, 2003, 2001, 2002.5));

    expect(session.positions[0].entry).toBeCloseTo(2002.2, 10);
  });

  it('卖出停损跳空时按更差的开盘 bid 成交', () => {
    const session = makeSession();
    session.orders.push(makeOrder({ type: 'stop', side: 'sell', price: 2000, volume: 1 }));

    stepSession(session, makeBar(T0, 1998, 1999, 1997, 1998.5));

    expect(session.positions[0].entry).toBe(1998);
  });
});

describe('止损与止盈', () => {
  it('多头盘中触发止损，按止损价成交', () => {
    const session = makeSession();
    addPosition(session, {
      entry: 2000,
      sl: 1995,
      tp: 2010,
      initialRisk: 500,
      openCommission: 5,
    });

    const { events } = stepSession(session, makeBar(T0, 1996, 2001, 1994, 1995));

    expect(session.positions).toHaveLength(0);
    expect(session.trades).toHaveLength(1);
    const closed = session.trades[0];
    expect(closed.closedBy).toBe('sl');
    expect(closed.exit).toBe(1995);
    expect(closed.profit).toBe(-510);
    expect(closed.r).toBeCloseTo(-1.02, 10);
    expect(closed.mfe).toBeCloseTo(100, 10);
    expect(closed.mae).toBeCloseTo(-600, 10);
    expect(session.balance).toBe(9495);
    expect(events).toContain('止损');
  });

  it('跳空越过止损时按开盘价成交（更差）', () => {
    const session = makeSession();
    addPosition(session, { entry: 2000, sl: 1995, initialRisk: 500, openCommission: 5 });

    stepSession(session, makeBar(T0, 1990, 1995, 1989, 1992));

    expect(session.trades[0].exit).toBe(1990);
    expect(session.trades[0].profit).toBe(-1010);
    expect(session.balance).toBe(8995);
  });

  it('多头盘中触发止盈', () => {
    const session = makeSession();
    addPosition(session, { entry: 2000, tp: 2010, openCommission: 5 });

    stepSession(session, makeBar(T0, 2000.5, 2011, 1999, 2010.5));

    expect(session.trades[0].closedBy).toBe('tp');
    expect(session.trades[0].exit).toBe(2010);
    expect(session.trades[0].profit).toBe(990);
    expect(session.balance).toBe(10995);
  });

  it('同一根同时触发时先止损', () => {
    const session = makeSession();
    addPosition(session, {
      entry: 2000,
      sl: 1995,
      tp: 2010,
      initialRisk: 500,
      openCommission: 5,
    });

    stepSession(session, makeBar(T0, 2000, 2011, 1994, 2005));

    expect(session.trades[0].closedBy).toBe('sl');
    expect(session.trades[0].exit).toBe(1995);
  });

  it('空头止损按 ask 判断，点差计入', () => {
    const session = makeSession();
    addPosition(session, {
      side: 'sell',
      entry: 2000,
      sl: 2005,
      tp: 1990,
      initialRisk: 500,
      openCommission: 5,
    });

    stepSession(session, makeBar(T0, 2003, 2004.8, 1998, 2003));

    expect(session.trades[0].closedBy).toBe('sl');
    expect(session.trades[0].exit).toBe(2005);
    expect(session.trades[0].profit).toBe(-510);
    expect(session.trades[0].mfe).toBeCloseTo(180, 10);
    expect(session.trades[0].mae).toBeCloseTo(-500, 10);
  });

  it('空头止盈按 ask 判断', () => {
    const session = makeSession();
    addPosition(session, { side: 'sell', entry: 2000, tp: 1990, openCommission: 5 });

    stepSession(session, makeBar(T0, 1995, 1996, 1989, 1990));

    expect(session.trades[0].closedBy).toBe('tp');
    expect(session.trades[0].exit).toBe(1990);
    expect(session.trades[0].profit).toBe(990);
  });
});

describe('订单模板阶段', () => {
  const steps = [{ atR: 1, closePercent: 50, moveBreakeven: true }];

  function openWithTemplate() {
    const session = makeSession();
    session.orders.push(
      makeOrder({ side: 'buy', type: 'market', volume: 1, sl: 1990, steps }),
    );
    stepSession(session, makeBar(T0, 2000, 2000.5, 1999.5, 2000));
    return session;
  }

  it('到达 1R 平掉一半并移到保本', () => {
    const session = openWithTemplate();
    const position = session.positions[0];
    expect(position.initialRisk).toBeCloseTo(1020, 10);
    expect(position.initialRiskPrice).toBeCloseTo(10.2, 10);
    expect(session.trades).toHaveLength(0);

    const { events } = stepSession(session, makeBar(T0 + 60, 2000, 2011, 1999, 2010.5));

    expect(session.trades).toHaveLength(1);
    const closed = session.trades[0];
    expect(closed.closedBy).toBe('template');
    expect(closed.exit).toBeCloseTo(2010.4, 10);
    expect(closed.volume).toBe(0.5);
    expect(closed.profit).toBeCloseTo(505, 10);
    expect(closed.r).toBeCloseTo(505 / 510, 10);

    expect(session.positions).toHaveLength(1);
    const rest = session.positions[0];
    expect(rest.volume).toBe(0.5);
    expect(rest.sl).toBeCloseTo(position.entry, 10);
    expect(rest.templateStep).toBe(1);
    expect(rest.initialRisk).toBeCloseTo(510, 10);
    expect(session.balance).toBeCloseTo(10502.5, 10);
    expect(session.equity).toBeCloseTo(11017.5, 10);
    expect(events).toContain('模板 1R 平 50%');
    expect(events).toContain('模板 1R 移到保本');
  });

  it('移到保本后下一根回踩开仓价就止损离场', () => {
    const session = openWithTemplate();
    stepSession(session, makeBar(T0 + 60, 2000, 2011, 1999, 2010.5));

    stepSession(session, makeBar(T0 + 120, 2001, 2002, 2000, 2001.5));

    expect(session.positions).toHaveLength(0);
    expect(session.trades[1].closedBy).toBe('sl');
    expect(session.trades[1].exit).toBeCloseTo(2000.2, 10);
    expect(session.trades[1].profit).toBe(-5);
    expect(session.balance).toBeCloseTo(10500, 8);
  });

  it('多个阶段在同一根里依次执行，最后一档平光仓位', () => {
    const session = makeSession();
    session.orders.push(
      makeOrder({
        side: 'buy',
        type: 'market',
        volume: 1,
        sl: 1990,
        steps: [
          { atR: 1, closePercent: 50, moveBreakeven: true },
          { atR: 2, closePercent: 100, moveBreakeven: false },
        ],
      }),
    );
    stepSession(session, makeBar(T0, 2000, 2000.5, 1999.5, 2000));
    stepSession(session, makeBar(T0 + 60, 2000, 2021, 1999, 2020));

    expect(session.positions).toHaveLength(0);
    expect(session.trades).toHaveLength(2);
    expect(session.trades[1].closedBy).toBe('template');
    expect(session.trades[1].exit).toBeCloseTo(2020.6, 10);
    expect(session.trades[1].volume).toBe(0.5);
    expect(session.trades[1].profit).toBeCloseTo(1015, 10);
  });

  it('没有止损就没有 R，模板不动作', () => {
    const session = makeSession();
    session.orders.push(
      makeOrder({ side: 'buy', type: 'market', volume: 1, sl: null, steps }),
    );
    stepSession(session, makeBar(T0, 2000, 2000.5, 1999.5, 2000));
    stepSession(session, makeBar(T0 + 60, 2000, 2100, 1999, 2090));

    expect(session.trades).toHaveLength(0);
    expect(session.positions[0].volume).toBe(1);
    expect(session.positions[0].templateStep).toBe(0);
  });
});

describe('手动平仓与结束', () => {
  it('当前可成交价：多头 bid、空头 ask', () => {
    const session = makeSession();
    const bar = makeBar(T0, 2000, 2001, 1999, 2000.5);
    expect(currentExitPrice(session, 'buy', bar)).toBe(2000.5);
    expect(currentExitPrice(session, 'sell', bar)).toBeCloseTo(2000.7, 10);
  });

  it('手动平仓按当前价成交并更新净值', () => {
    const session = makeSession();
    addPosition(session, { entry: 2000, volume: 1 });
    const bar = makeBar(T0, 2000, 2001, 1999, 2005);

    closePositionNow(session, 'pos-1', 1, bar);

    expect(session.positions).toHaveLength(0);
    expect(session.trades[0].closedBy).toBe('manual');
    expect(session.trades[0].exit).toBe(2005);
    expect(session.trades[0].profit).toBe(495);
    expect(session.balance).toBe(10495);
    expect(session.equity).toBe(10495);
  });

  it('部分平仓保留剩余手数与按比例分摊的佣金', () => {
    const session = makeSession();
    addPosition(session, { entry: 2000, volume: 1, openCommission: 10 });
    closePositionNow(session, 'pos-1', 0.4, makeBar(T0, 2000, 2001, 1999, 2010));

    expect(session.trades[0].volume).toBe(0.4);
    expect(session.trades[0].commission).toBe(6); // 4 + 2
    expect(session.positions[0].volume).toBe(0.6);
    expect(session.positions[0].openCommission).toBe(6);
  });

  it('finishAll 平掉所有仓位、撤销挂单并标记结束', () => {
    const session = makeSession();
    addPosition(session, { entry: 2000 });
    session.orders.push(makeOrder({ type: 'limit', price: 1900 }));

    finishAll(session, makeBar(T0, 2000, 2001, 1999, 2002));

    expect(session.positions).toHaveLength(0);
    expect(session.orders).toHaveLength(0);
    expect(session.trades[0].closedBy).toBe('finish');
    expect(session.status).toBe('finished');
    expect(session.equity).toBe(session.balance);
    expect(session.finishedAt).toBeTypeOf('number');
  });

  it('改止损/改挂单/撤单', () => {
    const session = makeSession();
    addPosition(session, { entry: 2000 });
    const order = makeOrder({ type: 'limit', price: 1900 });
    session.orders.push(order);

    setPositionStops(session, 'pos-1', { sl: 1995, tp: 2020 });
    expect(session.positions[0].sl).toBe(1995);
    expect(session.positions[0].tp).toBe(2020);

    setOrderPrice(session, order.id, 1890);
    expect(session.orders[0].price).toBe(1890);

    cancelOrder(session, order.id);
    expect(session.orders).toHaveLength(0);
  });
});

describe('统计', () => {
  it('胜率、盈亏比、R 分布与标签汇总', () => {
    const session = makeSession();
    session.trades = [
      trade({ profit: 100, r: 1, tag: 'A' }),
      trade({ profit: -50, r: -0.5, tag: 'A' }),
      trade({ profit: 200, r: 2, tag: 'B' }),
      trade({ profit: 0, r: 0, tag: '' }),
    ];
    session.equity = 10250;

    const stats = calculateStats(session);

    expect(stats.netPnl).toBe(250);
    expect(stats.equityPnl).toBe(250);
    expect(stats.returnPct).toBe(2.5);
    expect(stats.trades).toBe(4);
    expect(stats.wins).toBe(2);
    expect(stats.losses).toBe(1);
    expect(stats.winRate).toBe(0.5);
    expect(stats.grossProfit).toBe(300);
    expect(stats.grossLoss).toBe(50);
    expect(stats.profitFactor).toBe(6);
    expect(stats.totalR).toBe(2.5);
    expect(stats.avgR).toBeCloseTo(0.625, 10);
    expect(stats.expectancy).toBe(62.5);
    expect(stats.byTag).toEqual([
      { tag: 'A', trades: 2, totalR: 0.5, pnl: 50 },
      { tag: 'B', trades: 1, totalR: 2, pnl: 200 },
      { tag: '未分类', trades: 1, totalR: 0, pnl: 0 },
    ]);
    expect(stats.rBins.map((bin) => bin.count)).toEqual([0, 1, 1, 1, 1, 0]);
  });

  it('没有成交时比率类指标为空', () => {
    const stats = calculateStats(makeSession());
    expect(stats.winRate).toBeNull();
    expect(stats.profitFactor).toBeNull();
    expect(stats.avgR).toBeNull();
    expect(stats.expectancy).toBeNull();
  });

  it('账户摘要给出浮盈、保证金与强平比例', () => {
    const session = makeSession();
    addPosition(session, { entry: 2000, volume: 1 });

    const summary = accountSummary(session, 2010);

    expect(summary.floating).toBe(1000);
    expect(summary.equity).toBe(11000);
    expect(summary.margin).toBeCloseTo(2010.2, 8);
    expect(summary.freeMargin).toBeCloseTo(11000 - 2010.2, 8);
    expect(summary.marginLevel).toBeCloseTo((11000 / 2010.2) * 100, 8);
  });

  it('没有持仓时保证金与强平比例为空', () => {
    const summary = accountSummary(makeSession(), 2010);
    expect(summary.margin).toBe(0);
    expect(summary.marginLevel).toBeNull();
    expect(summary.floating).toBe(0);
  });
});

describe('replayId', () => {
  it('带前缀且不重复', () => {
    const first = replayId('pos');
    const second = replayId('pos');
    expect(first.startsWith('pos-')).toBe(true);
    expect(first).not.toBe(second);
  });
});
