import { useEffect, useState } from 'react';
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
  const [creating, setCreating] = useState(false);

  const sessionId = routeSessionId(route);
  const session = sessionId ? sessions.find((item) => item.id === sessionId) : undefined;

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
