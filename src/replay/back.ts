/**
 * 回放返回路径：用 sessionStorage 记住「从哪个页面进来的」，
 * 刷新回放页仍能返回；不用 URL query，避免破坏 #/replay/<id> 的现有解析。
 */

const KEY = 'mytrade.replay.back';

export interface ReplayBack {
  page: string;
  positionId?: number;
  label: string;
}

export function setReplayBack(back: ReplayBack): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(back));
  } catch {
    /* 隐私模式下写不进去就放弃返回入口 */
  }
}

export function getReplayBack(): ReplayBack | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ReplayBack>;
    if (!parsed || typeof parsed.page !== 'string' || typeof parsed.label !== 'string') return null;
    return {
      page: parsed.page,
      label: parsed.label,
      positionId: typeof parsed.positionId === 'number' ? parsed.positionId : undefined,
    };
  } catch {
    return null;
  }
}

export function clearReplayBack(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
