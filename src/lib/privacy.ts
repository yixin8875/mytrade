import { useApp } from '../store/useApp';

/** 隐私模式下金额统一显示成这个占位，不留数字宽度线索 */
export const MONEY_MASK = '••••';

let masked = false;

/**
 * 格式化函数是普通函数，不能订阅 React 状态；页面在渲染前把当前
 * 「是否遮金额」写进这个模块级开关，随后的 fmtMoney / fmtSigned 就能生效。
 * 页面本身通过 usePrivacyMask() 订阅 privacy / page，切换时会重新渲染。
 */
export function setPrivacyMask(on: boolean): void {
  masked = on;
}

export function privacyMasked(): boolean {
  return masked;
}

export function maskMoneyText(text: string): string {
  return masked ? MONEY_MASK : text;
}

/**
 * 隐私模式只遮复盘与报表页，交易台的余额、报价、下单风险必须可读，
 * 否则会挡住真正的交易决策。返回是否正在遮。
 */
export function usePrivacyMask(): boolean {
  const privacy = useApp((s) => s.privacy);
  const page = useApp((s) => s.page);
  const on = privacy && page !== 'trade';
  setPrivacyMask(on);
  return on;
}
