import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useApp } from '../store/useApp';
import { MONEY_MASK, maskMoneyText, privacyMasked, setPrivacyMask, usePrivacyMask } from './privacy';

afterEach(() => {
  setPrivacyMask(false);
  useApp.setState({ privacy: false, page: 'overview' });
});

describe('隐私模式遮罩', () => {
  it('隐私模式打开时，复盘与报表页遮住金额', () => {
    useApp.setState({ privacy: true, page: 'records' });

    const { result } = renderHook(() => usePrivacyMask());

    expect(result.current).toBe(true);
    expect(privacyMasked()).toBe(true);
    expect(maskMoneyText('1,234.00')).toBe(MONEY_MASK);
  });

  it('交易台不遮金额，避免挡住下单决策', () => {
    useApp.setState({ privacy: true, page: 'trade' });

    const { result } = renderHook(() => usePrivacyMask());

    expect(result.current).toBe(false);
    expect(privacyMasked()).toBe(false);
    expect(maskMoneyText('1,234.00')).toBe('1,234.00');
  });

  it('隐私模式关闭时所有页面都是明文', () => {
    useApp.setState({ privacy: false, page: 'insights' });

    const { result } = renderHook(() => usePrivacyMask());

    expect(result.current).toBe(false);
    expect(maskMoneyText('88.00')).toBe('88.00');
  });
});
