import { useEffect, useState } from 'react';
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
  // 自动检查保持静默：没有新版本（或正在检查）时不出任何弹窗，
  // 只有真的有新版本才提示；手动检查仍显示检查中和已是最新。
  if (!state.manual && (state.phase === 'checking' || state.phase === 'none')) return null;
  if (state.phase === 'available' && !state.manual && state.version === skippedVersion()) {
    return null;
  }

  const available = state.phase === 'available';
  const downloading = state.phase === 'downloading';

  return (
    <div className="fixed bottom-8 right-3 z-50 w-[324px] overflow-hidden rounded-xl border border-tv-border bg-tv-panel text-tv-text shadow-[0_18px_48px_-16px_rgba(0,0,0,0.35)]">
      <div className="flex items-center gap-2 border-b border-tv-border px-3.5 py-2.5">
        <Download size={14} strokeWidth={1.5} className="text-tv-muted" />
        <span className="flex-1 text-[12px] font-medium">软件更新</span>
        <button
          onClick={dismissUpdate}
          title="关闭"
          aria-label="关闭更新提示"
          className="rounded-md p-1 text-tv-muted transition-colors hover:bg-tv-hover hover:text-tv-text"
        >
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>

      <div className="space-y-3 px-3.5 py-3.5">
        {state.phase === 'checking' && (
          <div className="flex items-center gap-2 text-[12px] text-tv-muted">
            <RefreshCw size={14} strokeWidth={1.5} className="animate-spin" />
            正在检查更新…
          </div>
        )}

        {state.phase === 'none' && (
          <div className="flex items-center gap-2 text-[12px]">
            <CheckCircle2 size={14} strokeWidth={1.5} className="text-tv-up" />
            已是最新版本
          </div>
        )}

        {available && (
          <>
            <div className="flex items-baseline gap-2">
              <span className="text-[13px] font-medium">发现新版本 v{state.version}</span>
              <span className="num font-mono text-[11px] text-tv-muted">
                当前 v{state.currentVersion}
              </span>
            </div>
            {state.notes && (
              <div className="max-h-28 overflow-auto whitespace-pre-wrap rounded-lg border border-tv-border bg-tv-raised px-2.5 py-2 text-[11px] leading-relaxed text-tv-muted">
                {state.notes}
              </div>
            )}
            <div className="flex items-center gap-2">
              <button
                onClick={() => void installUpdate()}
                className="h-7 rounded-lg bg-tv-text px-3 text-[12px] font-medium text-tv-bg transition-opacity hover:opacity-90"
              >
                立即更新
              </button>
              <button
                onClick={dismissUpdate}
                className="h-7 rounded-lg border border-tv-border bg-tv-panel px-2.5 text-[12px] text-tv-text transition-colors hover:bg-tv-hover"
              >
                稍后
              </button>
              {!state.manual && (
                <button
                  onClick={() => {
                    if (state.version) skipVersion(state.version);
                    dismissUpdate();
                  }}
                  className="ml-auto text-[11px] text-tv-muted transition-colors hover:text-tv-text"
                >
                  忽略此版本
                </button>
              )}
            </div>
          </>
        )}

        {downloading && (
          <>
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-tv-text">
                {state.percent != null ? `下载中 ${state.percent.toFixed(0)}%` : '下载中…'}
              </span>
              <span className="font-mono text-tv-muted">
                {fmtBytes(state.received ?? 0)}
                {state.total ? ` / ${fmtBytes(state.total)}` : ''}
              </span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-tv-raised">
              <div
                className="h-full origin-left rounded-full bg-tv-accent transition-transform duration-200"
                style={{ transform: `scaleX(${Math.max(state.percent ?? 8, 2) / 100})` }}
              />
            </div>
            <div className="text-[11px] leading-relaxed text-tv-muted">
              下载完成后会自动安装并重启，请勿关闭程序。
            </div>
          </>
        )}

        {state.phase === 'installing' && (
          <div className="flex items-center gap-2 text-[12px]">
            <RefreshCw size={14} strokeWidth={1.5} className="animate-spin text-tv-muted" />
            正在停止网关并安装 v{state.version}，应用即将重启…
          </div>
        )}

        {state.phase === 'error' && (
          <>
            <div className="flex items-start gap-2 text-[12px] leading-relaxed">
              <AlertTriangle size={14} strokeWidth={1.5} className="mt-0.5 shrink-0 text-tv-warn" />
              <span className="break-all">{state.message || '更新失败'}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void checkForUpdates(true)}
                className="h-7 rounded-lg border border-tv-border bg-tv-panel px-2.5 text-[12px] text-tv-text transition-colors hover:bg-tv-hover"
              >
                重试
              </button>
              <button
                onClick={dismissUpdate}
                className="h-7 rounded-lg px-2 text-[12px] text-tv-muted transition-colors hover:bg-tv-hover hover:text-tv-text"
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
