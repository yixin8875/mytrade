import { beforeEach, describe, expect, it } from 'vitest';
import { isDesktopApp, settingsSnapshot } from './dataExport';

beforeEach(() => {
  window.localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe('isDesktopApp', () => {
  it('浏览器预览里不是桌面版', () => {
    expect(isDesktopApp()).toBe(false);
  });

  it('存在 Tauri 运行时标记时是桌面版', () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    expect(isDesktopApp()).toBe(true);
  });
});

describe('settingsSnapshot', () => {
  it('只导出 mytrade.* 键', () => {
    window.localStorage.setItem('mytrade.theme', 'dark');
    window.localStorage.setItem('mytrade.replay.sessions', '[]');
    window.localStorage.setItem('other.key', 'nope');

    expect(settingsSnapshot()).toEqual({
      'mytrade.theme': 'dark',
      'mytrade.replay.sessions': '[]',
    });
  });

  it('超长值截断到 200KB', () => {
    const long = 'x'.repeat(200_005);
    window.localStorage.setItem('mytrade.pine', long);

    expect(settingsSnapshot()['mytrade.pine']).toHaveLength(200_000);
  });

  it('没有设置时返回空对象', () => {
    expect(settingsSnapshot()).toEqual({});
  });
});
