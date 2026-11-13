import { invoke } from '@tauri-apps/api/core';

/** 桌面版才能定位文件或恢复备份；浏览器预览里只做导出。 */
export function isDesktopApp(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 把 localStorage 里 mytrade.* 的原始值打包，随设置 JSON / 备份一起导出。 */
export function settingsSnapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key || !key.startsWith('mytrade.')) continue;
      const value = window.localStorage.getItem(key);
      if (value == null) continue;
      // 单条超过 200KB 的（例如超长 Pine 脚本）截断，避免备份里全是脚本
      out[key] = value.length > 200_000 ? value.slice(0, 200_000) : value;
    }
  } catch {
    /* localStorage 不可用时导出空设置 */
  }
  return out;
}

export async function revealPath(path: string): Promise<void> {
  if (!isDesktopApp()) throw new Error('仅桌面版支持在资源管理器中定位');
  await invoke('reveal_path', { path });
}

export async function restoreBackup(name: string): Promise<string> {
  if (!isDesktopApp()) throw new Error('仅桌面版支持恢复备份');
  return invoke<string>('backup_restore', { name });
}
