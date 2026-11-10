/**
 * 多图联动：十字线位置在图表之间广播。
 * 走模块级事件而不是 Zustand，是因为十字线每秒要更新几十次，
 * 放进 store 会让整棵 React 树跟着重渲染。
 */

export interface CrosshairState {
  price: number;
  /** 十字线时间（UNIX 秒，UTC），取不到时为 null */
  time: number | null;
  /** 来源图表 id，来源图自己不再画幽灵线 */
  from: string;
}

type Listener = (state: CrosshairState | null) => void;

const listeners = new Set<Listener>();
let current: CrosshairState | null = null;

/** 广播十字线；传 null 表示离开图表，清掉其他图上的幽灵线 */
export function publishCrosshair(state: CrosshairState | null): void {
  current = state;
  for (const listener of listeners) listener(state);
}

export function subscribeCrosshair(listener: Listener): () => void {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
}
