import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TEMPLATE_PANEL_WIDTH,
  mountFloatingToolbarButtons,
  templatePanelSpot,
} from './floatingTemplates';

const BUTTON = '[data-mytrade-toolbar-button]';

function groupHtml(): string {
  return `
    <div class="tv-floating-toolbar" data-name="drawing-toolbar">
      <div class="tv-floating-toolbar__widget-wrapper">
        <div class="floating-toolbar-react-widgets">
          <div class="floating-toolbar-react-widgets__button" data-name="line-tool-width"></div>
          <div class="floating-toolbar-react-widgets__button" data-name="settings"></div>
          <div class="floating-toolbar-react-widgets__button" data-name="lock"></div>
        </div>
      </div>
    </div>`;
}

function setup(html = groupHtml()) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const iframe = document.createElement('iframe');
  host.appendChild(iframe);
  const doc = iframe.contentDocument as Document;
  doc.body.innerHTML = html;
  return { host, iframe, doc };
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function actions(onTemplates = vi.fn(), onAlert?: (button: HTMLElement) => void) {
  return onAlert ? { templates: onTemplates, alert: onAlert } : { templates: onTemplates };
}

function names(doc: Document): string[] {
  return Array.from(
    doc.querySelectorAll<HTMLElement>(
      '.tv-floating-toolbar[data-name="drawing-toolbar"] .floating-toolbar-react-widgets > *',
    ),
  ).map(
    (el) =>
      el.getAttribute('data-mytrade-toolbar-button') ??
      el.getAttribute('data-name') ??
      el.className,
  );
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('mountFloatingToolbarButtons', () => {
  it('把模板与告警按钮插在浮动工具栏最前面，并注入一次样式', async () => {
    const { host, doc } = setup();
    const cleanup = mountFloatingToolbarButtons(host, actions(vi.fn(), vi.fn()));
    await flush();

    expect(names(doc)).toEqual([
      'templates',
      'alert',
      'line-tool-width',
      'settings',
      'lock',
    ]);

    const buttons = doc.querySelectorAll<HTMLElement>(BUTTON);
    expect(buttons).toHaveLength(2);
    expect(buttons[0].getAttribute('aria-label')).toBe('画线模板');
    expect(buttons[0].querySelectorAll('rect')).toHaveLength(3);
    expect(buttons[1].getAttribute('aria-label')).toBe('价格告警');
    expect(buttons[1].querySelector('svg path')).toBeTruthy();
    expect(doc.querySelectorAll('style#mytrade-floating-template-style')).toHaveLength(1);
    cleanup();
  });

  it('只传模板时不放告警按钮', async () => {
    const { host, doc } = setup();
    const cleanup = mountFloatingToolbarButtons(host, actions());
    await flush();

    expect(names(doc)).toEqual(['templates', 'line-tool-width', 'settings', 'lock']);
    cleanup();
  });

  it('点击按钮回传各自的按钮，并阻止事件冒到图表面板', async () => {
    const { host, doc } = setup();
    const onTemplates = vi.fn();
    const onAlert = vi.fn();
    const parentClick = vi.fn();
    host.addEventListener('click', parentClick);
    const cleanup = mountFloatingToolbarButtons(host, actions(onTemplates, onAlert));
    await flush();

    const [templates, alert] = Array.from(doc.querySelectorAll<HTMLElement>(BUTTON));
    templates.click();
    alert.click();

    expect(onTemplates).toHaveBeenCalledWith(templates);
    expect(onAlert).toHaveBeenCalledWith(alert);
    expect(parentClick).not.toHaveBeenCalled();
    cleanup();
  });

  it('库重绘工具栏后自动补回两个按钮', async () => {
    const { host, doc } = setup();
    const cleanup = mountFloatingToolbarButtons(host, actions(vi.fn(), vi.fn()));
    await flush();

    const group = doc.querySelector('.floating-toolbar-react-widgets') as HTMLElement;
    group.innerHTML =
      '<div data-name="settings"></div><div data-name="lock"></div>';
    await flush();

    expect(names(doc)).toEqual(['templates', 'alert', 'settings', 'lock']);
    cleanup();
  });

  it('工具栏消失后通知调用方；清理时移除按钮并停止观察', async () => {
    vi.useFakeTimers();
    try {
      const { host, doc } = setup();
      const onLost = vi.fn();
      const cleanup = mountFloatingToolbarButtons(host, actions(vi.fn(), vi.fn()), onLost);
      await flush();

      doc.querySelector('.tv-floating-toolbar')?.remove();
      await flush();
      expect(onLost).not.toHaveBeenCalled();

      vi.advanceTimersByTime(300);
      expect(onLost).toHaveBeenCalledTimes(1);
      cleanup();

      // 清理之后再出现工具栏也不会重新注入
      doc.body.innerHTML = groupHtml();
      await flush();
      expect(doc.querySelector(BUTTON)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('只认选中画线的那条工具栏，收藏工具工具栏不受影响', async () => {
    const { host, doc } = setup(`
      <div class="tv-floating-toolbar">
        <div class="floating-toolbar-react-widgets">
          <div data-name="settings"></div>
        </div>
      </div>`);
    const cleanup = mountFloatingToolbarButtons(host, actions(vi.fn(), vi.fn()));
    await flush();

    expect(doc.querySelector(BUTTON)).toBeNull();
    cleanup();
  });
});

describe('templatePanelSpot', () => {
  function rect(left: number, top: number, width: number, height: number) {
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  }

  function setupSpot(buttonLeft: number) {
    const { host, doc } = setup();
    const button =
      doc.querySelector<HTMLElement>('[data-mytrade-toolbar-button="templates"]') ??
      doc.createElement('button');
    if (!doc.contains(button)) doc.body.appendChild(button);
    button.getBoundingClientRect = () => rect(buttonLeft, 20, 38, 38);
    const frame = host.querySelector('iframe') as HTMLIFrameElement;
    frame.getBoundingClientRect = () => rect(20, 10, 760, 600);
    host.getBoundingClientRect = () => rect(10, 5, 800, 600);
    return { host, button };
  }

  it('菜单挂在按钮正下方（换算 iframe 偏移）', () => {
    const { host, button } = setupSpot(100);
    // 左：按钮 100 + iframe 偏移 10；上：按钮底边 58 + iframe 偏移 5 + 4
    expect(templatePanelSpot(host, button)).toEqual({ left: 110, top: 67 });
  });

  it('量不到按钮时退回左上角，靠右时把菜单收回容器内', () => {
    expect(templatePanelSpot(null, null)).toEqual({ left: 8, top: 44 });
    const { host, button } = setupSpot(900);
    expect(templatePanelSpot(host, button).left).toBe(800 - TEMPLATE_PANEL_WIDTH - 8);
  });

  it('按钮不属于图表 iframe 时退回左上角', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    const { host } = setupSpot(100);
    expect(templatePanelSpot(host, outside)).toEqual({ left: 8, top: 44 });
  });
});
