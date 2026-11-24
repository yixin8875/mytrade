import type { ResolutionString } from '../../../public/charting_library/charting_library';

/**
 * 周期菜单里默认展示的周期。网关只提供下面 GATEWAY_RESOLUTIONS 这几种，
 * 其余周期（2/3/10/45 分、2 小时、12 月、以及用户在「添加自定义周期」里
 * 输入的任何周期）由图表库用 multipliers 从基础周期合成，不需要网关认识。
 */
export const SUPPORTED_RESOLUTIONS = [
  '1',
  '2',
  '3',
  '5',
  '10',
  '15',
  '30',
  '45',
  '60',
  '120',
  '240',
  '1D',
  '1W',
  '1M',
  '3M',
  '12M',
] as ResolutionString[];

/** 网关真正能取到的周期（3M 由 1M 聚合），写进 symbolInfo 的 *_multipliers */
export const GATEWAY_RESOLUTIONS = ['1', '5', '15', '30', '60', '240', '1D', '1W', '1M', '3M'];

/** 设置页 / 下拉里显示的短标签：7 -> 7m，120 -> 2h，1D / 1W / 1M 原样 */
export function resolutionLabel(resolution: string): string {
  const value = String(resolution || '').trim();
  if (!value) return '';
  const unit = value.slice(-1).toUpperCase();
  const amount = Number(value.slice(0, -1));
  if (unit === 'S' && Number.isFinite(amount)) return `${amount}秒`;
  if (unit === 'D' && Number.isFinite(amount)) return `${amount}D`;
  if (unit === 'W' && Number.isFinite(amount)) return `${amount}W`;
  if (unit === 'M' && Number.isFinite(amount)) return `${amount}M`;
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return value;
  if (minutes < 60) return `${minutes}m`;
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}
