import type { IChartingLibraryWidget } from '../../../public/charting_library/charting_library';

/**
 * 图表实例登记表：交易日志要在成交后截一张图，
 * 而 ChartPanel 可能同时存在 1~4 个，按 slot 找到主图即可。
 */
const widgets = new Map<string, IChartingLibraryWidget>();
const hosts = new Map<string, HTMLElement>();

export function registerWidget(
  slot: string,
  widget: IChartingLibraryWidget | null,
  host?: HTMLElement | null,
): void {
  if (widget) {
    widgets.set(slot, widget);
    if (host) hosts.set(slot, host);
  } else {
    widgets.delete(slot);
    hosts.delete(slot);
  }
}

/** 主图容器：截图时要读它里面的 iframe/canvas 几何 */
export function primaryHost(): HTMLElement | null {
  const main = hosts.get('main');
  if (main) return main;
  const first = hosts.values().next();
  return first.done ? null : first.value;
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

/**
 * 最近操作的图表。图表 iframe 里的点击不会冒泡到外层，
 * 由 ChartPanel 在 iframe 内监听 pointerdown 后写入这里；
 * 自选列表等图表外部入口据此决定把品种送到哪一格。
 */
let activeSlot = 'main';

export function setActiveSlot(slot: string): void {
  activeSlot = slot;
}

export function currentSlot(): string {
  return activeSlot;
}

type SymbolRequestListener = (symbol: string) => void;
const symbolRequests = new Set<SymbolRequestListener>();

/** 订阅「切换当前图表品种」请求，返回取消函数 */
export function subscribeSymbolRequest(listener: SymbolRequestListener): () => void {
  symbolRequests.add(listener);
  return () => {
    symbolRequests.delete(listener);
  };
}

/**
 * 请当前图表切换品种。
 * 返回 false 表示当前没有图表接收（例如交易台还没挂载），调用方应回退到全局 setSymbol。
 */
export function requestSymbol(symbol: string): boolean {
  if (symbolRequests.size === 0) return false;
  for (const listener of symbolRequests) listener(symbol);
  return true;
}
