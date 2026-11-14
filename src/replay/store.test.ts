import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Bar } from '../gateway/types';
import { useApp } from '../store/useApp';
import { setReplayBars } from './source';
import { useReplay, type OrderInput } from './store';
import { makeBar, makeSession } from './testUtils';
import type { ReplayPosition, ReplaySession } from './types';

const START = Date.UTC(2024, 0, 1) / 1000;

function state() {
  return useReplay.getState();
}

function activeSession() {
  return state().sessions.find((item) => item.id === state().activeId)!;
}

function setup(count = 6) {
  const bars = Array.from({ length: count }, (_, index) =>
    makeBar(START + index * 60, 2000 + index, 2001 + index, 1999 + index, 2000.5 + index),
  );
  const session = makeSession({
    startTs: START,
    endTs: START + (count - 1) * 60,
    fetchStartTs: START - 600,
    startIndex: 0,
    cursorIndex: 1,
    totalBars: count,
    cursorTs: START,
  });
  setReplayBars(session.id, bars);
  useReplay.setState({ sessions: [session], activeId: session.id });
  return session;
}

function input(overrides: Partial<OrderInput> = {}): OrderInput {
  return {
    side: 'buy',
    type: 'market',
    volume: 1,
    price: 0,
    sl: null,
    tp: null,
    tag: '',
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  useReplay.setState({
    sessions: [],
    activeId: null,
    playing: false,
    loading: null,
    speed: 5,
    follow: true,
    revision: 0,
    lastEvent: null,
  });
});

afterEach(() => {
  state().pause();
});

describe('submitOrder 校验', () => {
  it('没有活动会话、行情未就绪、手数非法都拒绝下单', () => {
    expect(state().submitOrder(input())).toBe('没有打开的回放会话');

    const session = setup();
    session.status = 'preparing';
    useReplay.setState({ sessions: [{ ...session }] });
    expect(state().submitOrder(input())).toBe('行情还在准备中');

    session.status = 'ready';
    useReplay.setState({ sessions: [{ ...session }] });
    expect(state().submitOrder(input({ volume: 0 }))).toBe('手数无效');
    expect(state().submitOrder(input({ volume: -1 }))).toBe('手数无效');
    expect(state().submitOrder(input({ volume: Number.NaN }))).toBe('手数无效');
  });

  it('已结束或已归档的复盘不能再下单', () => {
    const session = setup();
    session.status = 'finished';
    useReplay.setState({ sessions: [{ ...session }] });
    expect(state().submitOrder(input())).toBe('复盘已结束');
  });

  it('限价/停损价格必须在可成交的一侧', () => {
    setup(); // bid 2000.5、ask 2000.7
    expect(state().submitOrder(input({ type: 'limit', price: 2001 }))).toBe(
      '买入限价需要低于当前卖出价',
    );
    expect(state().submitOrder(input({ type: 'limit', side: 'sell', price: 2000 }))).toBe(
      '卖出限价需要高于当前买入价',
    );
    expect(state().submitOrder(input({ type: 'stop', price: 2000 }))).toBe(
      '买入停损需要高于当前卖出价',
    );
    expect(state().submitOrder(input({ type: 'stop', side: 'sell', price: 2002 }))).toBe(
      '卖出停损需要低于当前买入价',
    );
  });

  it('止损止盈必须放在盈利方向', () => {
    setup();
    expect(state().submitOrder(input({ type: 'limit', price: 1999, sl: 2000 }))).toBe(
      '多头止损需要低于入场价',
    );
    expect(state().submitOrder(input({ type: 'limit', price: 1999, tp: 1998 }))).toBe(
      '多头止盈需要高于入场价',
    );
  });

  it('市价单按当前 ask 记录委托价，下一根开盘成交', () => {
    setup();
    expect(state().submitOrder(input({ tag: '  突破回踩突破回踩突破回踩  ' }))).toBeNull();

    const order = activeSession().orders[0];
    expect(order.side).toBe('buy');
    expect(order.type).toBe('market');
    expect(order.volume).toBe(1);
    expect(order.price).toBeCloseTo(2000.7, 10);
    expect(order.tag).toBe('突破回踩突破回踩突破回踩'.slice(0, 16));

    state().step(1);

    const position = activeSession().positions[0];
    expect(position).toBeDefined();
    expect(position.entry).toBeCloseTo(2001.2, 10);
    expect(activeSession().orders).toHaveLength(0);
  });

  it('挂单带着模板阶段一起保存', () => {
    setup();
    state().submitOrder(
      input({
        type: 'limit',
        price: 1999,
        steps: [{ atR: 1, closePercent: 50, moveBreakeven: true }],
        templateName: '日内',
      }),
    );

    const order = activeSession().orders[0];
    expect(order.steps).toEqual([{ atR: 1, closePercent: 50, moveBreakeven: true }]);
    expect(order.templateName).toBe('日内');
  });
});

describe('回放推进', () => {
  it('step 推进游标，走到区间末尾自动结束', () => {
    setup(5);
    state().step(2);
    expect(activeSession().cursorIndex).toBe(3);
    expect(activeSession().status).toBe('ready');

    state().step(10);
    expect(activeSession().status).toBe('finished');
    expect(activeSession().cursorIndex).toBe(5);
  });

  it('play/pause 切换播放状态', () => {
    setup(10);
    state().play();
    expect(state().playing).toBe(true);
    expect(activeSession().status).toBe('running');

    state().pause();
    expect(state().playing).toBe(false);
    expect(activeSession().status).toBe('paused');
  });

  it('到区间末尾后不能再 play', () => {
    const session = setup(5);
    session.cursorIndex = 5;
    useReplay.setState({ sessions: [{ ...session }] });

    state().play();
    expect(state().playing).toBe(false);
  });
});

describe('手动操作', () => {
  it('手动平仓生成成交记录', () => {
    setup();
    state().submitOrder(input());
    state().step(1);

    const position = activeSession().positions[0];
    state().closePosition(position.id);

    const session = activeSession();
    expect(session.positions).toHaveLength(0);
    expect(session.trades).toHaveLength(1);
    expect(session.trades[0].closedBy).toBe('manual');
  });

  it('改止损止盈按 tick 对齐', () => {
    setup();
    state().submitOrder(input());
    state().step(1);

    const position = activeSession().positions[0];
    state().modifyStops(position.id, { sl: 2000.234, tp: 2020.567 });

    expect(activeSession().positions[0].sl).toBe(2000.23);
    expect(activeSession().positions[0].tp).toBe(2020.57);
  });

  it('改挂单价与撤单', () => {
    setup();
    state().submitOrder(input({ type: 'limit', price: 1999 }));
    const order = activeSession().orders[0];

    state().modifyOrder(order.id, 1998.567);
    expect(activeSession().orders[0].price).toBe(1998.57);

    state().cancelOrder(order.id);
    expect(activeSession().orders).toHaveLength(0);
  });

  it('笔记记录在当前 K 线之后的时间点', () => {
    setup();
    state().addNote('  这里放量  ', '盘感');

    const note = activeSession().notes[0];
    expect(note.text).toBe('这里放量');
    expect(note.tag).toBe('盘感');
    expect(note.time).toBe(START + 60);
  });

  it('空笔记不保存', () => {
    setup();
    state().addNote('   ', '');
    expect(activeSession().notes).toHaveLength(0);
  });

  it('restart 清空成交并回到区间起点', () => {
    setup();
    state().submitOrder(input());
    state().step(3);
    state().addNote('测试', '');

    state().restart();

    const session = activeSession();
    expect(session.cursorIndex).toBe(0);
    expect(session.trades).toHaveLength(0);
    expect(session.positions).toHaveLength(0);
    expect(session.orders).toHaveLength(0);
    expect(session.notes).toHaveLength(0);
    expect(session.balance).toBe(session.settings.initialBalance);
    expect(session.status).toBe('ready');
    expect(state().revision).toBeGreaterThan(0);
  });
});

describe('会话管理', () => {
  it('归档当前会话会停止播放', () => {
    const session = setup(20);
    state().play();
    expect(state().playing).toBe(true);

    state().archive(session.id);

    expect(state().playing).toBe(false);
    expect(activeSession().status).toBe('archived');
  });

  it('删除非当前会话不会中断当前回放', async () => {
    const active = setup(30);
    const other = makeSession();
    useReplay.setState({ sessions: [active, other], activeId: active.id });

    state().play();
    const before = activeSession().cursorIndex;
    state().remove(other.id);

    expect(state().playing).toBe(true);
    expect(state().sessions).toHaveLength(1);

    await new Promise((done) => window.setTimeout(done, 450));
    expect(activeSession().cursorIndex).toBeGreaterThan(before);
  });

  it('删除当前会话会清空 activeId 并停止播放', () => {
    const session = setup(20);
    state().play();

    state().remove(session.id);

    expect(state().activeId).toBeNull();
    expect(state().playing).toBe(false);
    expect(state().sessions).toHaveLength(0);
  });

  it('重命名限制长度并忽略空白', () => {
    const session = setup();
    state().rename(session.id, '  新名字  ');
    expect(activeSession().name).toBe('新名字');

    state().rename(session.id, '   ');
    expect(activeSession().name).toBe('新名字');
  });

  it('重复复盘清空进度并选中新会话', () => {
    const source = setup();
    state().submitOrder(input());
    state().step(2);
    state().addNote('已复盘', '');

    const copyId = state().duplicateSession(source.id);

    expect(copyId).not.toBeNull();
    expect(state().activeId).toBe(copyId);
    const copy = state().sessions.find((item) => item.id === copyId)!;
    expect(copy.name).toBe('测试复盘 · 重练');
    expect(copy.cursorIndex).toBe(0);
    expect(copy.trades).toHaveLength(0);
    expect(copy.notes).toHaveLength(0);
    expect(copy.orders).toHaveLength(0);
  });
});

function setupBars(bars: Bar[], cursorIndex = 1): ReplaySession {
  const session = makeSession({
    startTs: bars[0].time,
    endTs: bars[bars.length - 1].time,
    fetchStartTs: bars[0].time - 600,
    startIndex: 0,
    cursorIndex,
    totalBars: bars.length,
    cursorTs: bars[cursorIndex - 1]?.time ?? bars[0].time,
  });
  setReplayBars(session.id, bars);
  useReplay.setState({ sessions: [session], activeId: session.id });
  return session;
}

function pushPosition(session: ReplaySession, overrides: Partial<ReplayPosition> = {}): void {
  session.positions.push({
    id: 'pos-1',
    side: 'buy',
    volume: 1,
    entry: 2000,
    sl: null,
    tp: null,
    openTs: START,
    initialRisk: null,
    initialRiskPrice: null,
    openCommission: 0,
    tag: '',
    mfe: 0,
    mae: 0,
    templateStep: 0,
    ...overrides,
  });
}

describe('下单校验的细节', () => {
  it('限价/停损价格正好落在点差边界上会被拒绝', () => {
    setup(); // bid 2000.5、ask 2000.7、半跳容差 0.005
    expect(state().submitOrder(input({ type: 'limit', price: 2000.7 }))).toBe(
      '买入限价需要低于当前卖出价',
    );
    expect(state().submitOrder(input({ type: 'limit', price: 2000.69 }))).toBeNull();

    expect(state().submitOrder(input({ type: 'limit', side: 'sell', price: 2000.5 }))).toBe(
      '卖出限价需要高于当前买入价',
    );
    expect(state().submitOrder(input({ type: 'limit', side: 'sell', price: 2000.51 }))).toBeNull();

    expect(state().submitOrder(input({ type: 'stop', price: 2000.7 }))).toBe(
      '买入停损需要高于当前卖出价',
    );
    expect(state().submitOrder(input({ type: 'stop', price: 2000.71 }))).toBeNull();

    expect(state().submitOrder(input({ type: 'stop', side: 'sell', price: 2000.5 }))).toBe(
      '卖出停损需要低于当前买入价',
    );
    expect(state().submitOrder(input({ type: 'stop', side: 'sell', price: 2000.49 }))).toBeNull();
  });

  it('市价单的止损止盈也按当前 ask/bid 校验', () => {
    setup();
    expect(state().submitOrder(input({ sl: 2000.7 }))).toBe('多头止损需要低于入场价');
    expect(state().submitOrder(input({ tp: 2000.6 }))).toBe('多头止盈需要高于入场价');
    expect(state().submitOrder(input({ side: 'sell', sl: 2000.5 }))).toBe(
      '空头止损需要高于入场价',
    );
    expect(state().submitOrder(input({ side: 'sell', tp: 2000.5 }))).toBe(
      '空头止盈需要低于入场价',
    );
  });

  it('非法委托价直接拒绝', () => {
    setup();
    expect(state().submitOrder(input({ type: 'limit', price: 0 }))).toBe('请填写委托价');
    expect(state().submitOrder(input({ type: 'limit', price: -5 }))).toBe('请填写委托价');
  });

  it('手数按步长取整，上限夹到最大手数', () => {
    setup();
    state().submitOrder(input({ volume: 0.004 }));
    expect(activeSession().orders[0].volume).toBe(0.01);

    state().submitOrder(input({ volume: 500 }));
    expect(activeSession().orders[1].volume).toBe(100);
  });

  it('没有行情时拒绝下单', () => {
    const session = setup();
    setReplayBars(session.id, []);
    expect(state().submitOrder(input())).toBe('还没有可用行情');
  });

  it('运行中的会话允许下单，已归档的拒绝', () => {
    const session = setup();
    session.status = 'running';
    useReplay.setState({ sessions: [{ ...session }] });
    expect(state().submitOrder(input())).toBeNull();

    session.status = 'archived';
    useReplay.setState({ sessions: [{ ...session }] });
    expect(state().submitOrder(input())).toBe('复盘已结束');
  });

  it('模板阶段是深拷贝，提交后再改原数组不影响订单', () => {
    setup();
    const steps = [{ atR: 1, closePercent: 50, moveBreakeven: true }];
    state().submitOrder(input({ steps }));

    steps[0].atR = 9;
    expect(activeSession().orders[0].steps?.[0].atR).toBe(1);
  });

  it('空头市价按当前 bid 记录委托价，并在下一根开盘按 bid 成交', () => {
    setup();
    state().submitOrder(input({ side: 'sell' }));
    expect(activeSession().orders[0].price).toBe(2000.5);

    state().step(1);

    expect(activeSession().positions[0].entry).toBe(2001);
    expect(activeSession().positions[0].side).toBe('sell');
  });
});

describe('成交后的交易路径', () => {
  it('市价成交的同一根 K 线就能触发止盈', () => {
    setupBars([
      makeBar(START, 2000, 2000.6, 1999.8, 2000.4),
      makeBar(START + 60, 2000.5, 2005, 2000, 2004),
      makeBar(START + 120, 2004, 2005, 2003, 2004),
    ]);
    state().submitOrder(input({ sl: 1998, tp: 2002 }));

    state().step(1);

    const session = activeSession();
    expect(session.positions).toHaveLength(0);
    expect(session.trades).toHaveLength(1);
    expect(session.trades[0].closedBy).toBe('tp');
    expect(session.trades[0].entry).toBeCloseTo(2000.7, 10);
    expect(session.trades[0].exit).toBe(2002);
    expect(session.trades[0].profit).toBeCloseTo(120, 8);
    expect(session.balance).toBeCloseTo(10120, 8);
  });

  it('持仓浮亏计入净值和最大回撤，回升后回撤不减少', () => {
    setupBars([
      makeBar(START, 2000, 2000.6, 1999.8, 2000.4),
      makeBar(START + 60, 2000.5, 2001, 1989, 1990),
      makeBar(START + 120, 1990, 2006, 1989, 2005),
      makeBar(START + 180, 2005, 2006, 2004, 2005),
    ]);
    state().submitOrder(input());

    state().step(1);
    let session = activeSession();
    expect(session.positions[0].entry).toBeCloseTo(2000.7, 10);
    expect(session.equity).toBeCloseTo(8925, 8);
    expect(session.maxDrawdownPct).toBeCloseTo(10.75, 8);

    state().step(1);
    session = activeSession();
    expect(session.equity).toBeCloseTo(10425, 8);
    expect(session.peakEquity).toBeCloseTo(10425, 8);
    expect(session.maxDrawdownPct).toBeCloseTo(10.75, 8);
  });

  it('净值归零时暂停回放并提示爆仓', () => {
    const session = setupBars([
      makeBar(START, 2000, 2000.6, 1999.8, 2000.4),
      makeBar(START + 60, 2000.5, 2001, 1989, 1990),
      makeBar(START + 120, 1990, 1991, 1989, 1990),
    ]);
    session.balance = 300;
    session.equity = 300;
    session.peakEquity = 300;
    useReplay.setState({ sessions: [{ ...session }], activeId: session.id });
    useApp.getState().clearToast();

    state().submitOrder(input());
    state().step(1);

    expect(activeSession().status).toBe('paused');
    expect(state().playing).toBe(false);
    expect(activeSession().positions).toHaveLength(1);
    expect(useApp.getState().toast).toMatchObject({
      kind: 'error',
      text: '模拟账户已爆仓，回放已暂停',
    });
    useApp.getState().clearToast();
  });

  it('结束复盘按最后价格平掉持仓并撤掉挂单', () => {
    setup();
    state().submitOrder(input());
    state().submitOrder(input({ type: 'limit', price: 1990 }));
    state().step(1);

    state().finish();

    const session = activeSession();
    expect(session.status).toBe('finished');
    expect(session.orders).toHaveLength(0);
    expect(session.positions).toHaveLength(0);
    expect(session.trades).toHaveLength(1);
    expect(session.trades[0].closedBy).toBe('finish');
    expect(session.trades[0].exit).toBeCloseTo(2001.5, 10);
    expect(session.equity).toBeCloseTo(session.balance, 10);
  });

  it('部分平仓由 store 透传给引擎', () => {
    setup();
    state().submitOrder(input());
    state().step(1);
    const position = activeSession().positions[0];

    state().closePosition(position.id, 0.4);

    const session = activeSession();
    expect(session.trades[0].volume).toBe(0.4);
    expect(session.positions[0].volume).toBe(0.6);
  });

  it('改止损止盈支持清空，未知仓位/挂单不会报错', () => {
    setup();
    state().submitOrder(input());
    state().step(1);
    const position = activeSession().positions[0];

    state().modifyStops(position.id, { sl: 1990, tp: 2020 });
    expect(activeSession().positions[0].sl).toBe(1990);

    state().modifyStops(position.id, { sl: null, tp: null });
    expect(activeSession().positions[0].sl).toBeNull();
    expect(activeSession().positions[0].tp).toBeNull();

    expect(() => state().modifyStops('missing', { sl: 1 })).not.toThrow();
    expect(() => state().modifyOrder('missing', 1234.567)).not.toThrow();
    expect(() => state().cancelOrder('missing')).not.toThrow();
  });

  it('没有当前 K 线时手动平仓不动仓位', () => {
    const session = setup();
    pushPosition(session);
    setReplayBars(session.id, []);
    useReplay.setState({ sessions: [{ ...session }], activeId: session.id });

    state().closePosition('pos-1');

    expect(activeSession().positions).toHaveLength(1);
    expect(activeSession().trades).toHaveLength(0);
  });

  it('下单模板跟随成交单在回放里执行', () => {
    setupBars([
      makeBar(START, 2000, 2000.4, 1999.6, 2000),
      makeBar(START + 60, 2000, 2002, 1999.8, 2001),
      makeBar(START + 120, 2001, 2015, 2000.5, 2014),
      makeBar(START + 180, 2014, 2015, 2010, 2012),
      makeBar(START + 240, 2012, 2013, 2010, 2011),
    ]);
    state().submitOrder(
      input({
        sl: 1990,
        steps: [{ atR: 1, closePercent: 50, moveBreakeven: true }],
        templateName: '日内',
      }),
    );

    state().step(1);
    expect(activeSession().positions[0].entry).toBeCloseTo(2000.2, 10);
    expect(activeSession().positions[0].templateName).toBe('日内');

    state().step(2);

    const session = activeSession();
    expect(session.trades).toHaveLength(1);
    expect(session.trades[0].closedBy).toBe('template');
    expect(session.trades[0].volume).toBe(0.5);
    expect(session.trades[0].exit).toBeCloseTo(2010.4, 10);
    expect(session.positions).toHaveLength(1);
    expect(session.positions[0].volume).toBe(0.5);
    expect(session.positions[0].sl).toBeCloseTo(2000.2, 10);
    expect(session.positions[0].templateStep).toBe(1);
  });
});
