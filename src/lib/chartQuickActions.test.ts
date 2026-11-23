import { describe, expect, it } from 'vitest';
import type { Quote, SymbolInfo } from '../gateway/types';
import { buildQuickActionItems, fallbackQuickPrice, QUICK_ACTION_META } from './chartQuickActions';

const INFO: SymbolInfo = {
  name: 'XAUUSD',
  description: 'Gold vs US Dollar',
  digits: 2,
  point: 0.01,
  tickSize: 0.01,
  tickValue: 1,
  contractSize: 100,
  minVolume: 0.01,
  maxVolume: 100,
  volumeStep: 0.01,
  stopsLevelPoints: 0,
  freezeLevelPoints: 0,
  spreadPoints: 20,
  tradeMode: 4,
  fillingMode: 1,
  visible: true,
  currency: 'USD',
  marginMode: 'hedging',
};

const QUOTE: Quote = {
  symbol: 'XAUUSD',
  bid: 3980,
  ask: 3980.2,
  time: 1_700_000_000,
  timeMs: 1_700_000_000_000,
};

function itemsAt(price: number, quote: Quote | null = QUOTE) {
  return buildQuickActionItems({
    price,
    symbol: 'XAUUSD',
    volume: 0.5,
    digits: INFO.digits,
    step: INFO.volumeStep,
    quote,
    info: INFO,
  });
}

describe('buildQuickActionItems', () => {
  it('价格在买价下方：买入是限价、卖出是停损', () => {
    const [alert, buy, sell] = itemsAt(3970);

    expect(alert).toMatchObject({ action: 'alert', text: '以 3970.00 在 XAUUSD 添加警报' });
    expect(buy).toMatchObject({
      action: 'buy',
      label: '买入限价',
      type: 'limit',
      text: '买入 0.50 XAUUSD @ 3970.00 限价',
      disabled: false,
    });
    expect(sell).toMatchObject({ action: 'sell', label: '卖出停损', type: 'stop' });
  });

  it('价格在卖价上方：买入是停损、卖出是限价', () => {
    const [, buy, sell] = itemsAt(3990);

    expect(buy).toMatchObject({ type: 'stop', label: '买入停损' });
    expect(sell).toMatchObject({ type: 'limit', label: '卖出限价' });
  });

  it('价格落在点差内时买卖都不可用', () => {
    const [, buy, sell] = itemsAt(3980.1);

    expect(buy).toMatchObject({ type: null, label: '买入挂单', disabled: true });
    expect(sell).toMatchObject({ type: null, label: '卖出挂单', disabled: true });
    expect(buy.warning).toMatch(/点差/);
  });

  it('没有报价时给不出挂单类型，但警报仍可用', () => {
    const [alert, buy] = itemsAt(3970, null);

    expect(alert.disabled).toBe(false);
    expect(buy).toMatchObject({ type: null, disabled: true });
    expect(buy.warning).toBe('等待报价');
  });

  it('三项快捷键文案与常量一致', () => {
    expect(QUICK_ACTION_META).toEqual({
      alert: { label: '添加价格警报', hint: 'Alt+A' },
      buy: { label: '买入', hint: 'Alt+Shift+B' },
      sell: { label: '卖出', hint: 'Alt+Shift+S' },
    });
    expect(itemsAt(3970).map((item) => item.hint)).toEqual([
      'Alt+A',
      'Alt+Shift+B',
      'Alt+Shift+S',
    ]);
  });
});

describe('fallbackQuickPrice', () => {
  it('买用卖价、卖与警报用买价', () => {
    expect(fallbackQuickPrice('buy', QUOTE)).toBe(3980.2);
    expect(fallbackQuickPrice('sell', QUOTE)).toBe(3980);
    expect(fallbackQuickPrice('alert', QUOTE)).toBe(3980);
  });

  it('没有报价时返回 null', () => {
    expect(fallbackQuickPrice('buy', null)).toBeNull();
  });
});
