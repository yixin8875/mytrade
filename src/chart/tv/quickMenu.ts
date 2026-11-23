import type {
  ActionId,
  ActionsFactory,
  ContextMenuItem,
  ContextMenuItemsProcessor,
  IActionVariant,
} from '../../../public/charting_library/charting_library';
import type { ChartQuickAction, QuickActionItem } from '../../lib/chartQuickActions';

/**
 * 只给主图 / 价格轴相关菜单注入快捷项；图例、时间轴、绘图对象的菜单保持原样。
 * 菜单名是库内部字符串（v32.1.0 的 bundle 里核实过），升级后若不匹配会静默退回原生菜单。
 */
export const QUICK_MENU_NAMES: ReadonlySet<string> = new Set([
  'ChartContextMenu',
  'PriceScaleContextMenu',
  'PriceScaleLabelContextMenu',
]);

export type QuickActionRunner = (action: ChartQuickAction, price: number) => void;

/** 把我们的三项插到右键菜单顶部；任何异常都退回原生菜单，不让图表菜单失效 */
export function makeQuickMenuProcessor(
  getItems: (price: number) => QuickActionItem[],
  getPrice: () => number | null,
  run: QuickActionRunner,
): ContextMenuItemsProcessor {
  return (items, actionsFactory, params) => {
    try {
      if (!QUICK_MENU_NAMES.has(params?.menuName ?? '')) return Promise.resolve(items);
      const price = getPrice();
      if (price == null || !Number.isFinite(price) || !(price > 0)) {
        return Promise.resolve(items);
      }
      const actions = getItems(price).map((item) =>
        createQuickAction(actionsFactory, item, price, run),
      );
      return Promise.resolve([...actions, actionsFactory.createSeparator(), ...items]);
    } catch {
      return Promise.resolve(items);
    }
  };
}

function createQuickAction(
  actionsFactory: ActionsFactory,
  item: QuickActionItem,
  price: number,
  run: QuickActionRunner,
): IActionVariant {
  return actionsFactory.createAction({
    // 类型定义只列了库内置枚举，但官方示例就用自定义字符串，运行时按任意 id 处理
    actionId: `mytrade.quick.${item.action}` as ActionId,
    label: item.text,
    shortcutHint: item.hint,
    disabled: item.disabled ?? false,
    onExecute: () => {
      try {
        run(item.action, price);
      } catch {
        /* 快捷动作失败不应影响图表本身 */
      }
    },
  });
}

/**
 * 兜底路径：库的简单 onContextMenu 只支持「文字 + 点击」，
 * 快捷键提示只能写进文字里。
 */
export function contextMenuItems(
  price: number,
  items: QuickActionItem[],
  run: QuickActionRunner,
): ContextMenuItem[] {
  return items.map((item) => ({
    position: 'top' as const,
    text: `${item.text}（${item.hint}）`,
    click: () => {
      try {
        run(item.action, price);
      } catch {
        /* ignore */
      }
    },
  }));
}
