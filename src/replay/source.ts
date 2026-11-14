import type { Bar } from '../gateway/types';

/**
 * 回放数据的运行时来源：K 线只在内存里，图表 datafeed 和撮合引擎共用。
 * 游标以前的数据才允许发给图表，避免任何未来数据泄漏。
 */

type SourceEvent =
  | { kind: 'tick'; bar: Bar | null; time: number }
  | { kind: 'reset' }
  | { kind: 'seek' };

type Listener = (event: SourceEvent) => void;

class ReplaySource {
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: SourceEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

const barStore = new Map<string, Bar[]>();
const sources = new Map<string, ReplaySource>();

export function setReplayBars(sessionId: string, bars: Bar[]): void {
  barStore.set(sessionId, bars);
}

export function replayBars(sessionId: string): Bar[] {
  return barStore.get(sessionId) ?? [];
}

export function hasReplayBars(sessionId: string): boolean {
  return (barStore.get(sessionId)?.length ?? 0) > 0;
}

export function sourceFor(sessionId: string): ReplaySource {
  let source = sources.get(sessionId);
  if (!source) {
    source = new ReplaySource();
    sources.set(sessionId, source);
  }
  return source;
}

export function dropReplaySource(sessionId: string): void {
  barStore.delete(sessionId);
  sources.delete(sessionId);
}
