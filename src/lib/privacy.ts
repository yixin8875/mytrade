import { useApp } from '../store/useApp';

/** 隐私模式下金额统一显示成这个占位，不留数字宽度线索 */
export const MONEY_MASK = '••••';

/**
 * 隐私模式只遮复盘与报表页，交易台的余额、报价、下单风险必须可读，
 * 否则会挡住真正的交易决策。
 */
function shouldMask(privacy: boolean, page: string): boolean {
  return privacy && page !== 'trade';
}

/**
 * 格式化函数是普通函数，不能订阅 React 状态；这里直接读 store 当前值，
 * 不再由渲染期回写模块级开关。页面通过 usePrivacyMask() 订阅 privacy / page
 * 重新渲染即可。
 */
export function privacyMasked(): boolean {
  const state = useApp.getState();
  return shouldMask(state.privacy, state.page);
}

export function maskMoneyText(text: string): string {
  return privacyMasked() ? MONEY_MASK : text;
}

/** 订阅开关本身：隐私模式或当前页面变化时让调用方重新渲染 */
export function usePrivacyMask(): boolean {
  return useApp((state) => shouldMask(state.privacy, state.page));
}
