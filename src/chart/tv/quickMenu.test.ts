import { describe, expect, it, vi } from 'vitest';
import type {
  ActionOptions,
  ActionsFactory,
  CreateContextMenuParams,
  IActionVariant,
  ISeparator,
} from '../../../public/charting_library/charting_library';
import type { QuickActionItem } from '../../lib/chartQuickActions';
import { contextMenuItems, makeQuickMenuProcessor, QUICK_MENU_NAMES } from './quickMenu';

const ITEMS: QuickActionItem[] = [
  {
    action: 'alert',
    label: '添加价格警报',
    hint: 'Alt+A',
    text: '以 3970.00 在 XAUUSD 添加警报',
    price: 3970,
  },
  {
    action: 'buy',
    label: '买入限价',
    hint: 'Alt+Shift+B',
    text: '买入 0.50 XAUUSD @ 3970.00 限价',
    price: 3970,
    type: 'limit',
  },
  {
    action: 'sell',
    label: '卖出停损',
    hint: 'Alt+Shift+S',
    text: '卖出 0.50 XAUUSD @ 3970.00 停损',
    price: 3970,
    type: 'stop',
  },
];

const NATIVE = { id: 'native' } as unknown as IActionVariant;

function makeFactory() {
  const created: ActionOptions[] = [];
  const factory = {
    createAction: vi.fn((options: ActionOptions) => {
      created.push(options);
      return { id: options.actionId } as unknown as IActionVariant;
    }),
    createSeparator: vi.fn(() => ({ kind: 'separator' }) as unknown as ISeparator),
    createAsyncAction: vi.fn(),
  } as unknown as ActionsFactory;
  return { factory, created };
}

function params(menuName: string): CreateContextMenuParams {
  return { menuName } as CreateContextMenuParams;
}

describe('makeQuickMenuProcessor', () => {
  it('主图菜单注入三项 + 分隔线，原生项保留在后面', async () => {
    const { factory, created } = makeFactory();
    const processor = makeQuickMenuProcessor(
      () => ITEMS,
      () => 3970,
      () => {},
    );

    const result = await processor([NATIVE], factory, params('ChartContextMenu'));

    expect(result).toHaveLength(5);
    expect(result[4]).toBe(NATIVE);
    expect(created.map((item) => item.actionId)).toEqual([
      'mytrade.quick.alert',
      'mytrade.quick.buy',
      'mytrade.quick.sell',
    ] as unknown[]);
    expect(created.map((item) => item.label)).toEqual(ITEMS.map((item) => item.text));
    expect(created.map((item) => item.shortcutHint)).toEqual([
      'Alt+A',
      'Alt+Shift+B',
      'Alt+Shift+S',
    ]);
    expect(factory.createSeparator).toHaveBeenCalledTimes(1);
  });

  it('白名单包含主图、价格轴与价格标签菜单', () => {
    expect([...QUICK_MENU_NAMES]).toEqual([
      'ChartContextMenu',
      'PriceScaleContextMenu',
      'PriceScaleLabelContextMenu',
    ]);
  });

  it('其他菜单原样返回，不额外创建动作', async () => {
    const { factory, created } = makeFactory();
    const processor = makeQuickMenuProcessor(
      () => ITEMS,
      () => 3970,
      () => {},
    );

    const result = await processor([NATIVE], factory, params('LegendContextMenu'));

    expect(result).toEqual([NATIVE]);
    expect(created).toHaveLength(0);
  });

  it('价格无效时不注入', async () => {
    const { factory, created } = makeFactory();
    const processor = makeQuickMenuProcessor(
      () => ITEMS,
      () => null,
      () => {},
    );

    const result = await processor([NATIVE], factory, params('ChartContextMenu'));

    expect(result).toEqual([NATIVE]);
    expect(created).toHaveLength(0);
  });

  it('点击动作时把菜单价传给 runner', async () => {
    const run = vi.fn();
    const { factory, created } = makeFactory();
    const processor = makeQuickMenuProcessor(
      () => ITEMS,
      () => 3970,
      run,
    );

    await processor([NATIVE], factory, params('PriceScaleContextMenu'));
    created[1].onExecute?.({} as never);

    expect(run).toHaveBeenCalledWith('buy', 3970);
  });

  it('构建或执行抛错时退回原生菜单，绝不 reject', async () => {
    const { factory } = makeFactory();
    const run = vi.fn(() => {
      throw new Error('boom');
    });
    const processor = makeQuickMenuProcessor(
      () => {
        throw new Error('boom');
      },
      () => 3970,
      run,
    );

    await expect(processor([NATIVE], factory, params('ChartContextMenu'))).resolves.toEqual([
      NATIVE,
    ]);

    const throwingFactory = {
      createAction: () => {
        throw new Error('boom');
      },
      createSeparator: () => {
        throw new Error('boom');
      },
    } as unknown as ActionsFactory;
    const second = makeQuickMenuProcessor(
      () => ITEMS,
      () => 3970,
      run,
    );
    await expect(
      second([NATIVE], throwingFactory, params('ChartContextMenu')),
    ).resolves.toEqual([NATIVE]);
  });

  it('disabled 状态透传给菜单项', async () => {
    const { factory, created } = makeFactory();
    const processor = makeQuickMenuProcessor(
      () => [{ ...ITEMS[1], disabled: true }],
      () => 3980.1,
      () => {},
    );

    await processor([NATIVE], factory, params('ChartContextMenu'));
    expect(created[0]).toMatchObject({ disabled: true });
  });
});

describe('contextMenuItems', () => {
  it('简单 API 兜底：文字带快捷键，点击执行', () => {
    const run = vi.fn();
    const items = contextMenuItems(3970, ITEMS, run);

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      position: 'top',
      text: '以 3970.00 在 XAUUSD 添加警报（Alt+A）',
    });
    items[1].click?.();
    expect(run).toHaveBeenCalledWith('buy', 3970);
  });
});
