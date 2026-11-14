import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beep,
  desktopNotify,
  desktopPermission,
  desktopSupported,
  requestDesktopPermission,
} from './alert';

const created: { title: string; body?: string }[] = [];

class FakeNotification {
  static permission: NotificationPermission = 'default';
  static requestPermission = vi.fn<() => Promise<NotificationPermission>>();
  static failOnCreate = false;

  constructor(title: string, options?: NotificationOptions) {
    if (FakeNotification.failOnCreate) throw new Error('blocked');
    created.push({ title, body: options?.body });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  created.length = 0;
  FakeNotification.permission = 'default';
  FakeNotification.failOnCreate = false;
});

describe('desktopSupported / desktopPermission', () => {
  it('没有 Notification API 时视为不支持', () => {
    vi.stubGlobal('Notification', undefined);
    expect(desktopSupported()).toBe(false);
    expect(desktopPermission()).toBe('denied');
  });

  it('有 API 时返回浏览器权限', () => {
    FakeNotification.permission = 'granted';
    vi.stubGlobal('Notification', FakeNotification);
    expect(desktopSupported()).toBe(true);
    expect(desktopPermission()).toBe('granted');
  });
});

describe('requestDesktopPermission', () => {
  it('没有 API 时直接 false', async () => {
    vi.stubGlobal('Notification', undefined);
    await expect(requestDesktopPermission()).resolves.toBe(false);
  });

  it('已授权/已拒绝不再弹窗', async () => {
    vi.stubGlobal('Notification', FakeNotification);
    FakeNotification.permission = 'granted';
    await expect(requestDesktopPermission()).resolves.toBe(true);

    FakeNotification.permission = 'denied';
    await expect(requestDesktopPermission()).resolves.toBe(false);
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });

  it('默认状态下请求权限', async () => {
    vi.stubGlobal('Notification', FakeNotification);
    FakeNotification.requestPermission.mockResolvedValue('granted');
    await expect(requestDesktopPermission()).resolves.toBe(true);

    FakeNotification.requestPermission.mockResolvedValue('denied');
    await expect(requestDesktopPermission()).resolves.toBe(false);
  });

  it('请求权限抛错时返回 false', async () => {
    vi.stubGlobal('Notification', FakeNotification);
    FakeNotification.requestPermission.mockRejectedValue(new Error('nope'));
    await expect(requestDesktopPermission()).resolves.toBe(false);
  });
});

describe('desktopNotify', () => {
  it('只在已授权时发系统通知', () => {
    vi.stubGlobal('Notification', FakeNotification);
    FakeNotification.permission = 'default';
    desktopNotify('XAUUSD', '触价 3980');
    expect(created).toHaveLength(0);

    FakeNotification.permission = 'granted';
    desktopNotify('XAUUSD', '触价 3980');
    expect(created).toEqual([{ title: 'XAUUSD', body: '触价 3980' }]);
  });

  it('创建通知失败时静默', () => {
    vi.stubGlobal('Notification', FakeNotification);
    FakeNotification.permission = 'granted';
    FakeNotification.failOnCreate = true;

    expect(() => desktopNotify('XAUUSD', '触价')).not.toThrow();
  });
});

describe('beep', () => {
  it('没有音频设备时静默失败', () => {
    expect(() => beep()).not.toThrow();
  });
});
