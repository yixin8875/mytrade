/**
 * 把「画线模板」「价格告警」入口挂进库自带的浮动工具栏，位置和交互与
 * TradingView 原生一致：选中一条画线 → 浮动工具栏出现 → 最左边多出模板按钮
 * （以及告警按钮），点开对应菜单或面板。
 *
 * 库只暴露了画线模板的存储接口，没有对应的菜单 UI（drawing_templates
 * 特性只在 Trading Platform 构建里才有），所以菜单本身由 React 画，
 * 这里只负责在 same-origin iframe 里注入按钮并跟着工具栏一起出现/消失。
 */
import { watchChartFrame } from './chartFrame';

/** 注入按钮的标记：既是样式钩子，也是定位/测试时的查找依据 */
const BUTTON_ATTR = 'data-mytrade-toolbar-button';
const BUTTON_CLASS = 'floating-toolbar-react-widgets__button';
const STYLE_ID = 'mytrade-floating-template-style';
/** 只有选中画线时才有的那条浮动工具栏；收藏工具的工具栏没有 data-name */
const TOOLBAR_SELECTOR = '.tv-floating-toolbar[data-name="drawing-toolbar"]';
const GROUP_SELECTOR = '.floating-toolbar-react-widgets';
/** 工具栏被库重绘时会短暂移除子节点，等一小会儿再判断「真的没了」 */
const LOST_DELAY = 300;

export interface TemplatePanelSpot {
  left: number;
  top: number;
}

/** 菜单宽度，与 DrawingTemplates 的 w-[248px] 保持一致 */
export const TEMPLATE_PANEL_WIDTH = 248;
/** 量不到按钮时的退路：图表左上角 */
export const TEMPLATE_PANEL_FALLBACK: TemplatePanelSpot = { left: 8, top: 44 };

export interface FloatingToolbarActions {
  /** 画线模板：打开保存/套用菜单 */
  templates: (button: HTMLElement) => void;
  /** 价格告警：用选中画线的价位建告警；不传则不放告警按钮（复盘页没有告警） */
  alert?: (button: HTMLElement) => void;
}

export type FloatingButtonKind = 'templates' | 'alert';

/** 与原生「模板」按钮一致的 2×2 格子 + 右下角加号 */
const TEMPLATE_ICON = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28"',
  ' fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"',
  ' stroke-linejoin="round" aria-hidden="true">',
  '<rect x="4.5" y="4.5" width="7" height="7" rx="1.4"/>',
  '<rect x="16.5" y="4.5" width="7" height="7" rx="1.4"/>',
  '<rect x="4.5" y="16.5" width="7" height="7" rx="1.4"/>',
  '<path d="M20 15.8v8M16 19.8h8"/>',
  '</svg>',
].join('');

/** 铃铛：和应用里其他告警入口保持同一套图形语言 */
export const ALERT_ICON = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28"',
  ' fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"',
  ' stroke-linejoin="round" aria-hidden="true">',
  '<path d="M14 4.2c-3.7 0-6.2 2.8-6.2 6.3v4.8L6 18.6h16l-1.8-3.3V10.5c0-3.5-2.5-6.3-6.2-6.3Z"/>',
  '<path d="M11.4 21.1a2.8 2.8 0 0 0 5.2 0"/>',
  '</svg>',
].join('');

const BUTTONS: Record<
  FloatingButtonKind,
  { label: string; title: string; icon: string }
> = {
  templates: {
    label: '画线模板',
    title: '画线模板：保存或套用当前画线的样式',
    icon: TEMPLATE_ICON,
  },
  alert: {
    label: '价格告警',
    title: '价格告警：用选中画线的价位创建告警',
    icon: ALERT_ICON,
  },
};

/** 按钮样式注入图表 iframe；同文档只插一次 */
function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = [
    `[${BUTTON_ATTR}]{display:inline-flex;align-items:center;justify-content:center;`,
    'width:38px;height:38px;padding:0;border:0;background:transparent;color:inherit;',
    'cursor:pointer;border-radius:4px;flex:0 0 auto}',
    `[${BUTTON_ATTR}]:hover,[${BUTTON_ATTR}]:focus-visible{background:rgba(128,128,128,.16);outline:none}`,
    `[${BUTTON_ATTR}]:active{background:rgba(128,128,128,.24)}`,
    `[${BUTTON_ATTR}] svg{display:block;width:28px;height:28px}`,
  ].join('');
  (doc.head ?? doc.documentElement).appendChild(style);
}

function createButton(
  doc: Document,
  kind: FloatingButtonKind,
  onPick: (button: HTMLElement) => void,
): HTMLElement {
  const { label, title, icon } = BUTTONS[kind];
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = BUTTON_CLASS;
  button.setAttribute(BUTTON_ATTR, kind);
  button.setAttribute('aria-label', label);
  button.setAttribute('title', title);
  button.innerHTML = icon;
  // 库在浮动工具栏上监听按下事件（拖拽/选中），别让这次点击变成对图表的操作
  button.addEventListener('pointerdown', (event) => event.stopPropagation());
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onPick(button);
  });
  return button;
}

/**
 * 在选中画线的浮动工具栏里维持模板 / 告警按钮。
 * 库重绘工具栏、切换工具栏实例后都会自动补回；工具栏消失后调用 onLost，
 * 用来关掉已经悬空的 React 菜单。返回的函数用于图表销毁前清理。
 */
export function mountFloatingToolbarButtons(
  host: HTMLElement | null | undefined,
  actions: FloatingToolbarActions,
  onLost: () => void = () => {},
): () => void {
  if (!host) return () => {};
  const root: HTMLElement = host;
  let disposed = false;
  let lostTimer = 0;

  const clearLost = () => {
    if (!lostTimer) return;
    window.clearTimeout(lostTimer);
    lostTimer = 0;
  };

  const scheduleLost = () => {
    if (disposed || lostTimer) return;
    lostTimer = window.setTimeout(() => {
      lostTimer = 0;
      if (disposed) return;
      if (root.querySelector('iframe')?.contentDocument?.querySelector(TOOLBAR_SELECTOR)) {
        return;
      }
      onLost();
    }, LOST_DELAY);
  };

  const stopFrame = watchChartFrame(root, (doc) => {
    if (disposed || !doc) return;
    const group = doc
      .querySelector<HTMLElement>(TOOLBAR_SELECTOR)
      ?.querySelector<HTMLElement>(GROUP_SELECTOR);
    if (!group) {
      scheduleLost();
      return;
    }
    clearLost();
    ensureStyle(doc);
    // 和原生一致：模板按钮排最前，告警紧随其后
    let anchor: Element | null = null;
    const kinds: FloatingButtonKind[] = actions.alert ? ['templates', 'alert'] : ['templates'];
    for (const kind of kinds) {
      const handler = kind === 'templates' ? actions.templates : actions.alert;
      if (!handler) continue;
      let button = group.querySelector<HTMLElement>(`[${BUTTON_ATTR}="${kind}"]`);
      if (!button) {
        button = createButton(doc, kind, handler);
        if (anchor) anchor.insertAdjacentElement('afterend', button);
        else group.insertBefore(button, group.firstChild);
      }
      anchor = button;
    }
  });

  return () => {
    disposed = true;
    clearLost();
    stopFrame();
    try {
      root
        .querySelector('iframe')
        ?.contentDocument?.querySelectorAll(`[${BUTTON_ATTR}]`)
        .forEach((button) => button.remove());
    } catch {
      /* 图表已销毁时文档可能不可访问 */
    }
  };
}

/**
 * 把浮动工具栏按钮的位置换算成图表容器内坐标，菜单左对齐挂在按钮下方。
 * 量不到按钮或按钮不在图表 iframe 里时退回左上角。
 */
export function templatePanelSpot(
  host: HTMLElement | null | undefined,
  button: HTMLElement | null | undefined,
  fallback: TemplatePanelSpot = TEMPLATE_PANEL_FALLBACK,
): TemplatePanelSpot {
  if (!host || !button) return fallback;
  const frame = host.querySelector('iframe');
  const doc = frame?.contentDocument;
  if (!frame || !doc || !doc.contains(button)) return fallback;
  const buttonRect = button.getBoundingClientRect();
  const frameRect = frame.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  const maxLeft = Math.max(8, hostRect.width - TEMPLATE_PANEL_WIDTH - 8);
  const offset = frameRect.left - hostRect.left;
  const left = buttonRect.left + offset;
  // 靠右的按钮没法让菜单左对齐：改成右对齐到按钮，别把菜单甩到图表另一侧
  const clamped =
    left > maxLeft
      ? Math.max(8, Math.min(maxLeft, buttonRect.right + offset - TEMPLATE_PANEL_WIDTH))
      : Math.max(left, 8);
  return {
    left: clamped,
    top: buttonRect.bottom + (frameRect.top - hostRect.top) + 4,
  };
}
