import { describe, expect, it } from 'vitest';
import { classifyPending } from './pendingOrder';

const quote = { bid: 2000, ask: 2000.5 };
const gold = { point: 0.01 };

describe('classifyPending 挂单类型推导', () => {
  it('买入低于市价是限价买入', () => {
    const result = classifyPending({ side: 'buy', price: 1999, ...quote, ...gold });
    expect(result.type).toBe('limit');
    expect(result.label).toBe('限价买入');
    expect(result.warning).toBeNull();
  });

  it('买入高于市价是停损买入', () => {
    const result = classifyPending({ side: 'buy', price: 2001, ...quote, ...gold });
    expect(result.type).toBe('stop');
    expect(result.label).toBe('停损买入');
  });

  it('卖出高于市价是限价卖出', () => {
    const result = classifyPending({ side: 'sell', price: 2001, ...quote, ...gold });
    expect(result.type).toBe('limit');
    expect(result.label).toBe('限价卖出');
  });

  it('卖出低于市价是停损卖出', () => {
    const result = classifyPending({ side: 'sell', price: 1999, ...quote, ...gold });
    expect(result.type).toBe('stop');
    expect(result.label).toBe('停损卖出');
  });

  it('价格落在点差内不能挂单', () => {
    const result = classifyPending({ side: 'buy', price: 2000.2, ...quote, ...gold });
    expect(result.type).toBeNull();
    expect(result.label).toBe('待定价');
    expect(result.warning).toContain('点差内');
  });

  it('未填价格时提示输入', () => {
    const result = classifyPending({ side: 'buy', price: 0, ...quote, ...gold });
    expect(result.type).toBeNull();
    expect(result.warning).toBe('请输入委托价格');
  });

  it('缺报价时不下结论', () => {
    const result = classifyPending({ side: 'sell', price: 2001, bid: null, ask: null });
    expect(result.type).toBeNull();
    expect(result.warning).toBe('等待报价');
  });

  it('距离市价不足最小挂单点数时给出提醒', () => {
    const result = classifyPending({
      side: 'buy',
      price: 2000.6,
      ...quote,
      point: 0.01,
      stopsLevelPoints: 20,
    });
    expect(result.type).toBe('stop');
    expect(result.warning).toContain('20 点');
  });
});
