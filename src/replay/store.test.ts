import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setReplayBars } from './source';
import { useReplay, type OrderInput } from './store';
import { makeBar, makeSession } from './testUtils';

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
