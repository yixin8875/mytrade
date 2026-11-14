import { afterEach, describe, expect, it } from 'vitest';
import { fmtMoney, fmtSigned } from './format';
import { MONEY_MASK, maskMoneyText, privacyMasked, setPrivacyMask } from './privacy';
import { cardHeadline, reviewCardFileName, wrapText, type ReviewCardData } from './reviewCard';

afterEach(() => setPrivacyMask(false));

describe('隐私模式', () => {
  it('默认不遮金额', () => {
    expect(privacyMasked()).toBe(false);
    expect(fmtMoney(1234.5)).toBe('1,234.50');
    expect(fmtSigned(-20)).toBe('-20.00');
  });

  it('开启后金额与带符号数字都变成占位符', () => {
    setPrivacyMask(true);
    expect(privacyMasked()).toBe(true);
    expect(fmtMoney(1234.5)).toBe(MONEY_MASK);
    expect(fmtSigned(20)).toBe(MONEY_MASK);
    expect(maskMoneyText('anything')).toBe(MONEY_MASK);
  });

  it('空值仍然是 —，不因为遮金额变成占位符', () => {
    setPrivacyMask(true);
    expect(fmtMoney(null)).toBe('—');
    expect(fmtSigned(undefined)).toBe('—');
  });

  it('关闭后恢复原样', () => {
    setPrivacyMask(true);
    setPrivacyMask(false);
    expect(fmtMoney(10)).toBe('10.00');
  });
});

const card: ReviewCardData = {
  date: '2026-11-03',
  net: 120.5,
  trades: 4,
  wins: 3,
  losses: 1,
  winRate: 0.75,
  totalR: 2.1,
  rTrades: 3,
  best: 80,
  worst: -20,
  note: '盘前计划执行到位',
};

describe('复盘卡片', () => {
  it('文件名只保留日期', () => {
    expect(reviewCardFileName('2026-11-03')).toBe('tally-review-2026-11-03.png');
    expect(reviewCardFileName('11/03')).toBe('tally-review-1103.png');
    expect(reviewCardFileName('')).toBe('tally-review-day.png');
  });

  it('主数字带符号，赢了才加 +', () => {
    expect(cardHeadline(card)).toBe('+120.50');
    expect(cardHeadline({ ...card, net: -30 })).toBe('-30.00');
    expect(cardHeadline({ ...card, net: 0 })).toBe('0.00');
  });

  it('wrapText 按画布宽度折行，并保留手动换行', () => {
    const ctx = { measureText: (text: string) => ({ width: text.length * 10 }) } as unknown as
      CanvasRenderingContext2D;
    expect(wrapText(ctx, '一二三四五六', 40)).toEqual(['一二三四', '五六']);
    expect(wrapText(ctx, '上\n下', 100)).toEqual(['上', '下']);
  });
});
