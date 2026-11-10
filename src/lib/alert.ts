/** 告警的本机提醒：提示音 + 系统桌面通知（浏览器 Notification API） */

let audio: AudioContext | null = null;

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
  return typeof Notification !== 'undefined';
}

export function desktopPermission(): NotificationPermission {
  return typeof Notification === 'undefined' ? 'denied' : Notification.permission;
}

/** 用户点开「桌面通知」时调用；必须由点击触发才会弹权限框 */
export async function requestDesktopPermission(): Promise<boolean> {
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
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, tag: 'mytrade-alert' });
  } catch {
    /* 部分浏览器在非活动标签页会拒绝创建，忽略 */
  }
}
