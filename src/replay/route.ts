import { useEffect, useState } from 'react';

/** 回放页内部的三个路由：列表 / 工作台 / 报告 */
export type ReplayRoute =
  | { kind: 'list' }
  | { kind: 'session'; id: string }
  | { kind: 'report'; id: string };

export function parseReplayRoute(hash = window.location.hash): ReplayRoute {
  const raw = hash.replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean);
  if (parts[0] !== 'replay') return { kind: 'list' };
  if (parts.length >= 3 && parts[2] === 'report' && parts[1]) {
    return { kind: 'report', id: parts[1] };
  }
  if (parts.length >= 2 && parts[1]) return { kind: 'session', id: parts[1] };
  return { kind: 'list' };
}

export function useReplayRoute(): ReplayRoute {
  const [route, setRoute] = useState(parseReplayRoute);
  useEffect(() => {
    const onHash = () => setRoute(parseReplayRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}

export function goReplayList(): void {
  window.location.hash = '#/replay';
}

export function goReplaySession(id: string): void {
  window.location.hash = `#/replay/${id}`;
}

export function goReplayReport(id: string): void {
  window.location.hash = `#/replay/${id}/report`;
}

/** 会话 id 位于当前回放路由里时返回，否则 null */
export function routeSessionId(route: ReplayRoute): string | null {
  return route.kind === 'list' ? null : route.id;
}
