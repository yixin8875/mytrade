import { afterEach, describe, expect, it, vi } from 'vitest';
import { alertPanelSpot, mountHeaderAlertButton } from './headerAlert';

const BUTTON_ID = 'header-toolbar-alerts';

function wrapsHtml(): string {
  return `
      <div class="wrap-n5bmFxyX" id="header-toolbar-indicators">
        <button type="button" class="button-merBkM5y" data-tooltip="指标">
          <div data-role="button" class="button-ptpAHg8E"><span role="img" class="icon-GwQQdU8S"></span></div>
        </button>
      </div>
      <div class="wrap-jiC5bgmi medium-jiC5bgmi wrap-n5bmFxyX" id="header-toolbar-study-templates">
        <button type="button" class="button-merBkM5y apply-common-tooltip accessible-merBkM5y"
          data-tooltip="指标模板" aria-label="指标模板" aria-haspopup="menu">
          <div data-role="button" class="button-ptpAHg8E withoutText-ptpAHg8E button-GwQQdU8S isInteractive-GwQQdU8S">
            <span role="img" class="icon-GwQQdU8S"></span>
          </div>
        </button>
      </div>`;
}

function headerHtml(): string {
  return `<div class="group-MBOVGQRI">${wrapsHtml()}</div>`;
}

function setup(html = headerHtml()) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const iframe = document.createElement('iframe');
  host.appendChild(iframe);
  const doc = iframe.contentDocument as Document;
  doc.body.innerHTML = html;
  return { host, doc };
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function groupChildren(doc: Document): string[] {
  const group = doc.querySelector('.group-MBOVGQRI');
  return group ? Array.from(group.children).map((el) => el.id || el.className) : [];
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('mountHeaderAlertButton', () => {
  it('把铃铛插在指标模板按钮之后，沿用原生按钮的类名', async () => {
    const { host, doc } = setup();
    const handle = mountHeaderAlertButton(host, { onPick: vi.fn() });
    await flush();

    expect(groupChildren(doc)).toEqual([
      'header-toolbar-indicators',
      'header-toolbar-study-templates',
      BUTTON_ID,
    ]);

    const wrap = doc.getElementById(BUTTON_ID) as HTMLElement;
    expect(wrap.className).toBe('wrap-jiC5bgmi medium-jiC5bgmi wrap-n5bmFxyX');
    const button = wrap.querySelector('button');
    expect(button?.className).toContain('button-merBkM5y');
    expect(button?.getAttribute('aria-label')).toBe('价格告警');
    expect(button?.getAttribute('data-tooltip')).toBe('价格告警');
    expect(button?.hasAttribute('aria-haspopup')).toBe(false);
    expect(button?.querySelector('svg')).toBeTruthy();
    expect(doc.querySelectorAll(`#${BUTTON_ID}`)).toHaveLength(1);
    handle.dispose();
  });

  it('角标跟随 setCount：0 时隐藏，大于 0 时显示数字', async () => {
    const { host, doc } = setup();
    const handle = mountHeaderAlertButton(host, { onPick: vi.fn(), count: 2 });
    await flush();

    const badge = () => doc.querySelector<HTMLElement>('[data-mytrade-alert-count]');
    expect(badge()?.textContent).toBe('2');
    expect(badge()?.hasAttribute('hidden')).toBe(false);

    handle.setCount(0);
    expect(badge()?.textContent).toBe('');
    expect(badge()?.hasAttribute('hidden')).toBe(true);

    handle.setCount(5);
    expect(badge()?.textContent).toBe('5');
    expect(badge()?.hasAttribute('hidden')).toBe(false);
    handle.dispose();
  });

  it('点击调用回调，事件不冒泡到图表面板', async () => {
    const { host, doc } = setup();
    const onPick = vi.fn();
    const parentClick = vi.fn();
    host.addEventListener('click', parentClick);
    const handle = mountHeaderAlertButton(host, { onPick });
    await flush();

    doc.querySelector<HTMLElement>(`#${BUTTON_ID} button`)?.click();
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(parentClick).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('顶栏重绘后自动补回，且不产生重复按钮', async () => {
    const { host, doc } = setup();
    const handle = mountHeaderAlertButton(host, { onPick: vi.fn() });
    await flush();

    doc.querySelector('.group-MBOVGQRI')!.innerHTML = wrapsHtml();
    await flush();

    expect(groupChildren(doc)).toEqual([
      'header-toolbar-indicators',
      'header-toolbar-study-templates',
      BUTTON_ID,
    ]);
    expect(doc.querySelectorAll(`#${BUTTON_ID}`)).toHaveLength(1);
    handle.dispose();
  });

  it('没有指标模板按钮时放到指标按钮组末尾', async () => {
    const { host, doc } = setup(
      '<div class="group-MBOVGQRI"><div id="header-toolbar-indicators"><button></button></div></div>',
    );
    const handle = mountHeaderAlertButton(host, { onPick: vi.fn() });
    await flush();

    expect(groupChildren(doc)).toEqual(['header-toolbar-indicators', BUTTON_ID]);
    handle.dispose();
  });

  it('alertPanelSpot 把 iframe 内铃铛坐标换算到页面坐标，落在按钮下方', async () => {
    const { host, doc } = setup();
    const handle = mountHeaderAlertButton(host, { onPick: vi.fn() });
    await flush();

    const frame = host.querySelector('iframe') as HTMLIFrameElement;
    const wrap = doc.getElementById(BUTTON_ID) as HTMLElement;
    const rect = (left: number, top: number, right: number, bottom: number): DOMRect =>
      ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON() {} }) as DOMRect;
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(rect(100, 50, 1000, 650));
    vi.spyOn(wrap, 'getBoundingClientRect').mockReturnValue(rect(40, 8, 78, 46));

    expect(alertPanelSpot(host)).toEqual({ left: 140, top: 102, width: 320 });
    handle.dispose();
    expect(alertPanelSpot(host)).toBeNull();
  });

  it('dispose 后移除按钮并停止观察', async () => {
    const { host, doc } = setup();
    const handle = mountHeaderAlertButton(host, { onPick: vi.fn() });
    await flush();

    handle.dispose();
    expect(doc.getElementById(BUTTON_ID)).toBeNull();

    doc.querySelector('.group-MBOVGQRI')!.innerHTML = headerHtml();
    await flush();
    expect(doc.getElementById(BUTTON_ID)).toBeNull();
  });
});
