import type { IChartingLibraryWidget } from '../../../public/charting_library/charting_library';

/**
 * 图表实例登记表：交易日志要在成交后截一张图，
 * 而 ChartPanel 可能同时存在 1~4 个，按 slot 找到主图即可。
 */
const widgets = new Map<string, IChartingLibraryWidget>();

export function registerWidget(slot: string, widget: IChartingLibraryWidget | null): void {
  if (widget) widgets.set(slot, widget);
  else widgets.delete(slot);
}

export function widgetFor(slot: string): IChartingLibraryWidget | null {
  return widgets.get(slot) ?? null;
}

/** 主图优先；四图模式下取第一个创建出来的图表 */
export function primaryWidget(): IChartingLibraryWidget | null {
  const main = widgets.get('main');
  if (main) return main;
  const first = widgets.values().next();
  return first.done ? null : first.value;
}
