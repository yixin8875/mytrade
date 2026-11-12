/// <reference types="vite/client" />
import { invoke } from '@tauri-apps/api/core';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'none'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'error';

export interface UpdateState {
  phase: UpdatePhase;
  /** 手动点击「检查更新」触发；自动检查失败时静默 */
  manual: boolean;
  version?: string;
  currentVersion?: string;
  notes?: string;
  date?: string;
  received?: number;
  total?: number | null;
  percent?: number | null;
  message?: string;
}

const EVENT = 'mytrade:update';
const SKIP_KEY = 'mytrade.skipUpdate';

let state: UpdateState = { phase: 'idle', manual: false };
let pending: Update | null = null;
let autoTimer: number | null = null;

function emit(next: UpdateState): void {
  state = next;
  window.dispatchEvent(new CustomEvent<UpdateState>(EVENT, { detail: next }));
}

/** 是否运行在 Tauri 桌面壳里（浏览器里没有更新插件） */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * 更新界面是否可用。生产环境只在桌面壳里显示；开发环境可以用
 * localStorage.mytrade.forceUpdateUi = '1' 打开，方便调样式。
 */
export function isUpdateUiAvailable(): boolean {
  if (isTauri()) return true;
  try {
    return import.meta.env.DEV && localStorage.getItem('mytrade.forceUpdateUi') === '1';
  } catch {
    return false;
  }
}

export function currentUpdateState(): UpdateState {
  return state;
}

export function subscribeUpdateState(listener: (next: UpdateState) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<UpdateState>).detail);
  window.addEventListener(EVENT, handler);
  listener(state);
  return () => window.removeEventListener(EVENT, handler);
}

export function skippedVersion(): string {
  try {
    return localStorage.getItem(SKIP_KEY) ?? '';
  } catch {
    return '';
  }
}

export function skipVersion(version: string): void {
  try {
    localStorage.setItem(SKIP_KEY, version);
  } catch {
    /* 隐私模式下写不进去，忽略 */
  }
}

/** 关闭当前的更新提示，并释放已下载的更新资源 */
export function dismissUpdate(): void {
  const update = pending;
  pending = null;
  update?.close().catch(() => {});
  emit({ phase: 'idle', manual: false });
}

export async function checkForUpdates(manual = false): Promise<void> {
  if (!isTauri()) return;
  if (state.phase === 'checking') {
    // 自动检查还没返回时用户点了「检查更新」：把这次检查改成手动，
    // 让检查中和结果都能显示出来，而不是被静默掉。
    if (manual && !state.manual) emit({ ...state, manual: true });
    return;
  }
  if (state.phase === 'downloading' || state.phase === 'installing') {
    return;
  }
  if (pending) {
    const previous = pending;
    pending = null;
    void previous.close().catch(() => {});
  }

  emit({ phase: 'checking', manual });
  // 检查期间可能被用户的手动点击升级为手动检查，结果按最新意图提示
  const isManual = () => (state.phase === 'checking' ? state.manual : manual);
  try {
    const update = await check({ timeout: 20_000 });
    if (!update) {
      emit({ phase: 'none', manual: isManual() });
      return;
    }
    pending = update;
    emit({
      phase: 'available',
      manual: isManual(),
      version: update.version,
      currentVersion: update.currentVersion,
      notes: update.body ?? '',
      date: update.date,
    });
  } catch (error) {
    if (isManual()) {
      emit({
        phase: 'error',
        manual: true,
        message: (error as Error)?.message || '检查更新失败',
      });
    } else {
      // 自动检查失败通常是离线或还没发布 release，不打扰用户
      emit({ phase: 'idle', manual: false });
    }
  }
}

export async function installUpdate(): Promise<void> {
  const update = pending;
  if (!update || !isTauri()) return;
  const { version } = update;
  let received = 0;
  let total: number | null = null;

  emit({ phase: 'downloading', manual: true, version, received, total, percent: null });

  // 先下载，下载期间网关保持运行；安装前再停网关，缩短不可用时间
  try {
    await update.download(
      (event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? null;
          emit({
            phase: 'downloading',
            manual: true,
            version,
            received,
            total,
            percent: total ? 0 : null,
          });
        } else if (event.event === 'Progress') {
          received += event.data.chunkLength;
          emit({
            phase: 'downloading',
            manual: true,
            version,
            received,
            total,
            percent: total ? Math.min(100, (received / total) * 100) : null,
          });
        }
      },
      { timeout: 300_000 },
    );
  } catch (error) {
    emit({
      phase: 'error',
      manual: true,
      message: (error as Error)?.message || '更新下载失败',
    });
    return;
  }

  emit({ phase: 'installing', manual: true, version });

  // 安装器要覆盖 mytrade-gateway.exe。先把网关整棵进程树停掉并等到文件解锁，
  // 否则 Windows 会因文件被占用卡在安装阶段；失败时不要把安装器拉起来。
  try {
    const ready = await invoke<boolean>('gateway_prepare_update');
    if (!ready) {
      await invoke('gateway_start').catch(() => {});
      emit({
        phase: 'error',
        manual: true,
        message: '网关进程未能完全退出，安装包无法覆盖文件。请完全退出 MyTrade 后重试。',
      });
      return;
    }
  } catch (error) {
    await invoke('gateway_start').catch(() => {});
    emit({
      phase: 'error',
      manual: true,
      message: (error as Error)?.message || '停止网关失败，已取消安装',
    });
    return;
  }

  try {
    await update.install({ restartAfterInstall: true });
    // Windows 上安装器会先退出应用；macOS / Linux 需要手动重启
    await relaunch();
  } catch (error) {
    // 安装没有成功：把网关拉回来，当前应用还能继续用
    await invoke('gateway_start').catch(() => {});
    emit({
      phase: 'error',
      manual: true,
      message: (error as Error)?.message || '更新安装失败',
    });
  }
}

/** 启动后延迟做一次静默检查；返回取消函数 */
export function startAutoUpdateCheck(delayMs = 6000): () => void {
  if (!isTauri() || autoTimer != null) return () => {};
  autoTimer = window.setTimeout(() => {
    autoTimer = null;
    if (state.phase === 'idle') void checkForUpdates(false);
  }, delayMs);
  return () => {
    if (autoTimer != null) {
      window.clearTimeout(autoTimer);
      autoTimer = null;
    }
  };
}
