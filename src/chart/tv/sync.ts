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

export interface RangeState {
  /** 可视区间起点（UNIX 秒） */
  from: number;
  /** 可视区间终点（UNIX 秒） */
  to: number;
  /** 来源图表 id，来源图不再应用自己的广播 */
  fromSlot: string;
}

type RangeListener = (state: RangeState | null) => void;

const rangeListeners = new Set<RangeListener>();

/** 广播可视时间区间；只在用户开启「时间/日期范围」同步时调用 */
export function publishRange(state: RangeState | null): void {
  for (const listener of rangeListeners) listener(state);
}

export function subscribeRange(listener: RangeListener): () => void {
  rangeListeners.add(listener);
  return () => {
    rangeListeners.delete(listener);
  };
}
