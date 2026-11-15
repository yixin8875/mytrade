import { useEffect, useState } from 'react';
import { useApp } from '../store/useApp';
import { ReplayCreate } from './ReplayCreate';
import { ReplayList } from './ReplayList';
import { ReplayReport } from './ReplayReport';
import { ReplayWorkspace } from './ReplayWorkspace';
import { goReplayList, routeSessionId, useReplayRoute } from './route';
import { hasReplayBars } from './source';
import { useReplay } from './store';

/**
 * 复盘页入口：只在这里决定列表 / 工作台 / 报告，
 * 具体会话数据全部走 useReplay，不接触实盘 store。
 */
export function ReplayView() {
  const route = useReplayRoute();
  const loadSession = useReplay((s) => s.loadSession);
  const setActive = useReplay((s) => s.setActive);
  const sessions = useReplay((s) => s.sessions);
  const loading = useReplay((s) => s.loading);
  const hydrated = useReplay((s) => s.hydrated);
  const hydrate = useReplay((s) => s.hydrate);
  const login = useApp((s) => s.account?.login ?? 0);
  const [creating, setCreating] = useState(false);

  const sessionId = routeSessionId(route);
  const session = sessionId ? sessions.find((item) => item.id === sessionId) : undefined;

  useEffect(() => {
    // App 连上网关后会主动载入；直接进复盘页时在这里兜底
    if (!hydrated) void hydrate(login);
  }, [hydrated, hydrate, login]);

  useEffect(() => {
    setActive(sessionId);
  }, [sessionId, setActive]);

  useEffect(() => {
    if (!session || route.kind !== 'session') return;
    if (hasReplayBars(session.id)) return;
    if (loading?.id === session.id || session.status === 'error') return;
    void loadSession(session.id);
  }, [session, route.kind, loading, loadSession]);

  useEffect(() => {
    if (!sessionId || session) return;
    const timer = window.setTimeout(() => {
      const exists = useReplay.getState().sessions.some((item) => item.id === sessionId);
      if (!exists) goReplayList();
    }, 400);
    return () => window.clearTimeout(timer);
  }, [sessionId, session]);

  // 网关连上后先读回会话，避免先闪一屏「还没有复盘会话」
  if (!hydrated && route.kind === 'list') {
    return (
      <div className="h-full overflow-auto bg-console-canvas">
        <div className="mx-auto w-full max-w-[1320px] px-8 py-8">
          <div className="h-7 w-24 animate-pulse rounded bg-console-line" />
          <div className="mt-3 h-4 w-64 animate-pulse rounded bg-console-line" />
          <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <div
                key={index}
                className="h-24 animate-pulse rounded-[12px] border border-console-line bg-console-card"
              />
            ))}
          </div>
          <div className="mt-6 space-y-2">
            {Array.from({ length: 5 }, (_, index) => (
              <div
                key={index}
                className="h-12 animate-pulse rounded-[10px] border border-console-line bg-console-card"
              />
            ))}
          </div>
          <p className="mt-4 text-[11px] text-console-muted">正在从网关读取复盘会话…</p>
        </div>
      </div>
    );
  }

  return (
    <>
      {route.kind === 'list' && <ReplayList onCreate={() => setCreating(true)} />}
      {route.kind === 'session' && session && <ReplayWorkspace sessionId={route.id} />}
      {route.kind === 'report' && session && <ReplayReport sessionId={route.id} />}
      {route.kind !== 'list' && !session && (
        <div className="flex h-full items-center justify-center bg-console-canvas">
          <div className="text-[12px] text-console-muted">正在打开复盘会话…</div>
        </div>
      )}
      <ReplayCreate open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
