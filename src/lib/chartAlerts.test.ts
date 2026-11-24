import { describe, expect, it } from 'vitest';
import type { PriceAlert } from '../gateway/types';
import { alertChipText, alertKindFor, alertsOnChart, drawingAlertPrice } from './chartAlerts';

function alert(overrides: Partial<PriceAlert> = {}): PriceAlert {
  return {
    id: 1,
    symbol: 'XAUUSD',
    kind: 'above',
    price: 3742,
    note: null,
    enabled: 1,
    repeat: 0,
    cooldown_sec: 0,
    created_at: 1763200000,
    triggered_at: null,
    trigger_count: 0,
    ...overrides,
  };
}

describe('alertsOnChart', () => {
  it('只保留当前品种且启用中的告警', () => {
    const list = [
      alert({ id: 1 }),
      alert({ id: 2, symbol: 'EURUSD' }),
      alert({ id: 3, enabled: 0 }),
    ];
    expect(alertsOnChart(list, 'XAUUSD').map((item) => item.id)).toEqual([1]);
  });

  it('没有品种时返回空', () => {
    expect(alertsOnChart([alert()], '')).toEqual([]);
  });
});

describe('drawingAlertPrice', () => {
  it('单点画线取该点价格', () => {
    expect(drawingAlertPrice([{ price: 3742.5 }])).toBe(3742.5);
  });

  it('多点画线取首尾中点', () => {
    // 首 3700、尾 3800，中间点不参与
    expect(drawingAlertPrice([{ price: 3700 }, { price: 3600 }, { price: 3800 }])).toBe(3750);
  });

  it('没有有效价格时返回 null', () => {
    expect(drawingAlertPrice(null)).toBeNull();
    expect(drawingAlertPrice([])).toBeNull();
    expect(drawingAlertPrice([{ price: Number.NaN }])).toBeNull();
  });
});

describe('alertKindFor', () => {
  it('拖到现价下方是下穿，现价上方是上穿，等于现价算上穿', () => {
    expect(alertKindFor(3610, 3620)).toBe('below');
    expect(alertKindFor(3630, 3620)).toBe('above');
    expect(alertKindFor(3620, 3620)).toBe('above');
  });

  it('没有有效买价时保持原方向', () => {
    expect(alertKindFor(3610, null)).toBeNull();
    expect(alertKindFor(3610, undefined)).toBeNull();
    expect(alertKindFor(3610, 0)).toBeNull();
    expect(alertKindFor(3610, Number.NaN)).toBeNull();
  });
});

describe('alertChipText', () => {
  it('按方向显示上穿 / 下穿，并按品种精度取价', () => {
    expect(alertChipText(alert(), 2)).toBe('上穿 3742.00');
    expect(alertChipText(alert({ kind: 'below', price: 3728.5 }), 1)).toBe('下穿 3728.5');
  });

  it('备注跟在价格后面，过长时截断', () => {
    expect(alertChipText(alert({ note: '前高' }), 2)).toBe('上穿 3742.00 · 前高');
    const long = alertChipText(alert({ note: '日线级别的前期高点压力位需要突破才算确认' }), 2);
    expect(long.startsWith('上穿 3742.00 · 日线级别的前期高点压力位需要')).toBe(true);
    expect(long.endsWith('…')).toBe(true);
  });
});
