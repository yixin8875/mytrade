/**
 * 把「价格告警」铃铛挂到图表顶栏，紧跟库自带的「指标模板」按钮。
 * 顶栏按钮由库的 React 渲染，公开的 createButton 只能把按钮放到工具栏两端，
 * 所以这里按原生按钮的类名克隆一套结构插进去，再由 MutationObserver 跟着重绘补回。
 */
import { ALERT_ICON } from './floatingTemplates';
import { watchChartFrame } from './chartFrame';

const ID = 'header-toolbar-alerts';
const COUNT_ATTR = 'data-mytrade-alert-count';
const STYLE_ID = 'mytrade-header-alert-style';
const TEMPLATE_ID = 'header-toolbar-study-templates';
const INDICATORS_ID = 'header-toolbar-indicators';

export interface HeaderAlertHandle {
  /** 角标数量：启用中的告警数，0 时隐藏 */
  setCount(count: number): void;
  dispose(): void;
}

/** 告警面板展开位置（页面坐标） */
export interface AlertsPanelSpot {
  left: number;
  top: number;
  width: number;
}

export const ALERT_PANEL_WIDTH = 320;
const PANEL_GAP = 6;

/**
 * 告警面板该出现在图表顶栏铃铛的正下方：把 iframe 里的按钮坐标换算到页面坐标，
 * 并夹在视口内。铃铛还没挂上时返回 null，调用方退回默认位置。
 */
export function alertPanelSpot(
  host: HTMLElement | null | undefined,
  width = ALERT_PANEL_WIDTH,
): AlertsPanelSpot | null {
  try {
    const frame = host?.querySelector('iframe');
    const button = frame?.contentDocument?.getElementById(ID);
    if (!frame || !button) return null;
    const frameBox = frame.getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    const left = Math.min(
      Math.max(8, frameBox.left + buttonBox.left),
      Math.max(8, window.innerWidth - width - 8),
    );
    return { left, top: frameBox.top + buttonBox.bottom + PANEL_GAP, width };
  } catch {
    /* 图表正在销毁时跨文档访问会抛错 */
    return null;
  }
}

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = [
    `#${ID}{position:relative}`,
    `#${ID} [${COUNT_ATTR}]{position:absolute;top:2px;right:2px;min-width:13px;height:13px;`,
    'padding:0 3px;border-radius:7px;background:#b45309;color:#fff;box-sizing:border-box;',
    'font:600 9px/13px ui-sans-serif,system-ui,sans-serif;text-align:center;pointer-events:none}',
    `[${COUNT_ATTR}][hidden]{display:none}`,
  ].join('');
  (doc.head ?? doc.documentElement).appendChild(style);
}

function updateCount(wrap: HTMLElement, count: number): void {
  const badge = wrap.querySelector<HTMLElement>(`[${COUNT_ATTR}]`);
  if (!badge) return;
  if (count > 0) {
    const text = String(count);
    if (badge.textContent !== text) badge.textContent = text;
    badge.removeAttribute('hidden');
  } else {
    if (badge.textContent) badge.textContent = '';
    badge.setAttribute('hidden', '');
  }
}

function build(doc: Document, source: HTMLElement, onPick: () => void): HTMLElement {
  const wrap = doc.createElement('div');
  wrap.id = ID;
  wrap.className = source.className;

  const sourceButton = source.querySelector<HTMLButtonElement>('button');
  const button = sourceButton
    ? (sourceButton.cloneNode(false) as HTMLButtonElement)
    : doc.createElement('button');
  button.removeAttribute('aria-haspopup');
  button.setAttribute('aria-label', '价格告警');
  button.setAttribute('data-tooltip', '价格告警');
  button.setAttribute('title', '价格告警');

  const sourceInner = source.querySelector<HTMLElement>('[data-role="button"]');
  const inner = sourceInner
    ? (sourceInner.cloneNode(false) as HTMLElement)
    : doc.createElement('div');
  const iconClass = source.querySelector<HTMLElement>('[role="img"]')?.className;
  inner.innerHTML =
    `<span role="img"${iconClass ? ` class="${iconClass}"` : ''} aria-hidden="true">` +
    `${ALERT_ICON}</span><span ${COUNT_ATTR} hidden></span>`;
  button.appendChild(inner);

  // 顶栏上的点击不要传给图表（会被当成图表操作并取消选中）
  button.addEventListener('pointerdown', (event) => event.stopPropagation());
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onPick();
  });
  wrap.appendChild(button);
  return wrap;
}

/**
 * 在图表顶栏「指标模板」之后维持一个告警铃铛。
 * 返回的 handle 用来更新角标数量（告警列表变化时）和销毁按钮。
 */
export function mountHeaderAlertButton(
  host: HTMLElement | null | undefined,
  options: { onPick: () => void; count?: number },
): HeaderAlertHandle {
  let count = Math.max(0, Math.floor(options.count ?? 0));
  let disposed = false;

  const stopFrame = watchChartFrame(host, (doc) => {
    if (disposed || !doc) return;
    const template = doc.getElementById(TEMPLATE_ID);
    const source = template ?? doc.getElementById(INDICATORS_ID);
    if (!source?.parentElement) return;
    ensureStyle(doc);
    const existing = doc.getElementById(ID);
    if (existing) {
      updateCount(existing, count);
      return;
    }
    const wrap = build(doc, source, options.onPick);
    updateCount(wrap, count);
    // 指标模板按钮存在就紧跟其后；旧构建没有该按钮时放到指标按钮组的末尾
    if (template) template.insertAdjacentElement('afterend', wrap);
    else source.parentElement.appendChild(wrap);
  });

  return {
    setCount(next: number) {
      count = Math.max(0, Math.floor(next) || 0);
      if (disposed) return;
      const doc = host?.querySelector('iframe')?.contentDocument;
      const existing = doc?.getElementById(ID);
      if (existing) updateCount(existing, count);
    },
    dispose() {
      disposed = true;
      stopFrame();
      try {
        host
          ?.querySelector('iframe')
          ?.contentDocument?.getElementById(ID)
          ?.remove();
      } catch {
        /* 图表已销毁时文档可能不可访问 */
      }
    },
  };
}
