import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { AlertTriangle, CheckCircle2, Download, RefreshCw, X } from 'lucide-react';
import {
  checkForUpdates,
  currentUpdateState,
  dismissUpdate,
  installUpdate,
  isUpdateUiAvailable,
  skipVersion,
  skippedVersion,
  startAutoUpdateCheck,
  subscribeUpdateState,
  type UpdateState,
} from '../lib/updater';

function fmtBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/** 桌面版右下角的更新提示：启动静默检查 + 手动检查 + 下载安装进度 */
export function UpdatePanel() {
  const [state, setState] = useState<UpdateState>(currentUpdateState);

  useEffect(() => {
    if (!isUpdateUiAvailable()) return;
    const off = subscribeUpdateState(setState);
    const stopAuto = startAutoUpdateCheck();
    return () => {
      off();
      stopAuto();
    };
  }, []);

  // 「已是最新版本」只短暂停留
  useEffect(() => {
    if (state.phase !== 'none' || !state.manual) return;
    const timer = window.setTimeout(dismissUpdate, 3500);
    return () => window.clearTimeout(timer);
  }, [state.phase, state.manual]);

  if (!isUpdateUiAvailable() || state.phase === 'idle') return null;
  if (state.phase === 'available' && !state.manual && state.version === skippedVersion()) {
    return null;
  }

  const available = state.phase === 'available';
  const downloading = state.phase === 'downloading';

  return (
    <div className="fixed bottom-8 right-3 z-50 w-[318px] overflow-hidden rounded-lg border border-tv-border bg-tv-panel text-tv-text shadow-2xl">
      <div className="flex items-center gap-2 border-b border-tv-border bg-tv-bg/40 px-3 py-2">
        <Download size={13} className="text-tv-accent" />
        <span className="flex-1 text-[11px] font-semibold">软件更新</span>
        <button
          onClick={dismissUpdate}
          title="关闭"
          className="rounded p-0.5 text-tv-muted hover:bg-tv-border hover:text-tv-text"
        >
          <X size={12} />
        </button>
      </div>

      <div className="space-y-2.5 px-3 py-3">
        {state.phase === 'checking' && (
          <div className="flex items-center gap-2 text-[11px] text-tv-muted">
            <RefreshCw size={13} className="animate-spin" />
            正在检查更新…
          </div>
        )}

        {state.phase === 'none' && (
          <div className="flex items-center gap-2 text-[11px]">
            <CheckCircle2 size={13} className="text-tv-up" />
            已是最新版本
          </div>
        )}

        {available && (
          <>
            <div className="flex items-baseline gap-1.5">
              <span className="text-[12px] font-semibold">发现新版本 v{state.version}</span>
              <span className="text-[10px] text-tv-muted">当前 v{state.currentVersion}</span>
            </div>
            {state.notes && (
              <div className="max-h-28 overflow-auto whitespace-pre-wrap rounded bg-tv-bg px-2 py-1.5 text-[10px] leading-relaxed text-tv-muted">
                {state.notes}
              </div>
            )}
            <div className="flex items-center gap-2">
              <button
                onClick={() => void installUpdate()}
                className="h-6 rounded bg-tv-accent px-2.5 text-[10px] font-semibold text-white hover:opacity-90"
              >
                立即更新
              </button>
              <button
                onClick={dismissUpdate}
                className="h-6 rounded bg-tv-bg px-2 text-[10px] text-tv-text hover:bg-tv-border"
              >
                稍后
              </button>
              {!state.manual && (
                <button
                  onClick={() => {
                    if (state.version) skipVersion(state.version);
                    dismissUpdate();
                  }}
                  className="ml-auto text-[10px] text-tv-muted hover:text-tv-text"
                >
                  忽略此版本
                </button>
              )}
            </div>
          </>
        )}

        {downloading && (
          <>
            <div className="flex items-center justify-between text-[10px]">
              <span className="text-tv-text">
                {state.percent != null ? `下载中 ${state.percent.toFixed(0)}%` : '下载中…'}
              </span>
              <span className="font-mono text-tv-muted">
                {fmtBytes(state.received ?? 0)}
                {state.total ? ` / ${fmtBytes(state.total)}` : ''}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded bg-tv-bg">
              <div
                className={clsx(
                  'h-full rounded bg-tv-accent transition-[width] duration-150',
                  state.percent == null && 'animate-pulse',
                )}
                style={{ width: `${state.percent ?? 8}%` }}
              />
            </div>
            <div className="text-[10px] text-tv-muted">
              下载完成后会自动安装并重启，请勿关闭程序。
            </div>
          </>
        )}

        {state.phase === 'installing' && (
          <div className="flex items-center gap-2 text-[11px]">
            <RefreshCw size={13} className="animate-spin text-tv-accent" />
            正在停止网关并安装 v{state.version}，应用即将重启…
          </div>
        )}

        {state.phase === 'error' && (
          <>
            <div className="flex items-start gap-2 text-[11px]">
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-400" />
              <span className="break-all">{state.message || '更新失败'}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void checkForUpdates(true)}
                className="h-6 rounded bg-tv-bg px-2 text-[10px] text-tv-text hover:bg-tv-border"
              >
                重试
              </button>
              <button
                onClick={dismissUpdate}
                className="h-6 rounded bg-tv-bg px-2 text-[10px] text-tv-muted hover:bg-tv-border hover:text-tv-text"
              >
                关闭
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
