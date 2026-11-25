/**
 * 告警的本机提醒：提示音 + 系统桌面通知。
 * 桌面端（Tauri）走 plugin-notification，WebView2 自带的 Notification 不会弹系统通知；
 * 浏览器开发态继续用 Web Notification API。
 */

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';

let audio: AudioContext | null = null;

/** 是否运行在 Tauri 桌面壳里 */
function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 两声短促提示音；没有音频设备或被浏览器策略限制时静默 */
export function beep(): void {
  try {
    audio ??= new AudioContext();
    void audio.resume();
    const start = audio.currentTime;
    [880, 1180].forEach((frequency, index) => {
      const at = start + index * 0.18;
      const osc = audio!.createOscillator();
      const gain = audio!.createGain();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.18, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.14);
      osc.connect(gain);
      gain.connect(audio!.destination);
      osc.start(at);
      osc.stop(at + 0.15);
    });
  } catch {
    /* 静默失败，不影响告警本身 */
  }
}

export function desktopSupported(): boolean {
  return inTauri() || typeof Notification !== 'undefined';
}

export async function desktopPermission(): Promise<NotificationPermission> {
  if (inTauri()) {
    try {
      return (await isPermissionGranted()) ? 'granted' : 'default';
    } catch {
      return 'denied';
    }
  }
  return typeof Notification === 'undefined' ? 'denied' : Notification.permission;
}

/** 用户点开「桌面通知」时调用；必须由点击触发才会弹权限框 */
export async function requestDesktopPermission(): Promise<boolean> {
  if (inTauri()) {
    try {
      if (await isPermissionGranted()) return true;
      return (await requestPermission()) === 'granted';
    } catch {
      return false;
    }
  }
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

export function desktopNotify(title: string, body: string): void {
  try {
    if (inTauri()) {
      // 插件会注入 window.Notification；权限没落定前不发，避免后端拒绝产生未处理异常
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      sendNotification({ title, body });
      return;
    }
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    new Notification(title, { body, tag: 'mytrade-alert' });
  } catch {
    /* 系统关闭了通知、或页面非活动时创建失败，忽略 */
  }
}
