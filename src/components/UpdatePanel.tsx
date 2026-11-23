import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, RefreshCw, X } from 'lucide-react';
import { Button } from './ui/button';
import { Progress, ProgressIndicator, ProgressTrack } from './ui/progress';
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
    <div className="fixed bottom-8 right-3 z-50 w-[324px] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg/5">
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
        <Download size={14} strokeWidth={1.5} className="text-muted-foreground" />
        <span className="flex-1 text-[12px] font-medium">软件更新</span>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={dismissUpdate}
          title="关闭"
          aria-label="关闭更新提示"
          className="text-muted-foreground hover:text-foreground"
        >
          <X size={14} strokeWidth={1.5} />
        </Button>
      </div>

      <div className="space-y-3 px-3.5 py-3.5">
        {state.phase === 'checking' && (
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <RefreshCw size={14} strokeWidth={1.5} className="animate-spin" />
            正在检查更新…
          </div>
        )}

        {state.phase === 'none' && (
          <div className="flex items-center gap-2 text-[12px]">
            <CheckCircle2 size={14} strokeWidth={1.5} className="text-success-foreground" />
            已是最新版本
          </div>
        )}

        {available && (
          <>
            <div className="flex items-baseline gap-2">
              <span className="text-[13px] font-medium">发现新版本 v{state.version}</span>
              <span className="num font-mono text-[11px] text-muted-foreground">
                当前 v{state.currentVersion}
              </span>
            </div>
            {state.notes && (
              <div className="max-h-28 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
                {state.notes}
              </div>
            )}
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => void installUpdate()}
                className="h-7 px-3 text-[12px]"
              >
                立即更新
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={dismissUpdate}
                className="h-7 px-2.5 text-[12px]"
              >
                稍后
              </Button>
              {!state.manual && (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    if (state.version) skipVersion(state.version);
                    dismissUpdate();
                  }}
                  className="ml-auto h-7 px-2 text-[11px] font-normal text-muted-foreground hover:text-foreground"
                >
                  忽略此版本
                </Button>
              )}
            </div>
          </>
        )}

        {downloading && (
          <>
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-foreground">
                {state.percent != null ? `下载中 ${state.percent.toFixed(0)}%` : '下载中…'}
              </span>
              <span className="font-mono text-muted-foreground">
                {fmtBytes(state.received ?? 0)}
                {state.total ? ` / ${fmtBytes(state.total)}` : ''}
              </span>
            </div>
            <Progress value={Math.max(state.percent ?? 8, 2)} aria-label="下载进度">
              <ProgressTrack className="h-1 bg-muted">
                <ProgressIndicator className="bg-brand" />
              </ProgressTrack>
            </Progress>
            <div className="text-[11px] leading-relaxed text-muted-foreground">
              下载完成后会自动安装并重启，请勿关闭程序。
            </div>
          </>
        )}

        {state.phase === 'installing' && (
          <div className="flex items-center gap-2 text-[12px]">
            <RefreshCw size={14} strokeWidth={1.5} className="animate-spin text-muted-foreground" />
            正在停止网关并安装 v{state.version}，应用即将重启…
          </div>
        )}

        {state.phase === 'error' && (
          <>
            <div className="flex items-start gap-2 text-[12px] leading-relaxed">
              <AlertTriangle
                size={14}
                strokeWidth={1.5}
                className="mt-0.5 shrink-0 text-warning-foreground"
              />
              <span className="break-all">{state.message || '更新失败'}</span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void checkForUpdates(true)}
                className="h-7 px-2.5 text-[12px]"
              >
                重试
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={dismissUpdate}
                className="h-7 px-2 text-[12px] font-normal text-muted-foreground hover:text-foreground"
              >
                关闭
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
