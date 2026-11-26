import type {
  IExternalSaveLoadAdapter,
  LineToolsAndGroupsLoadRequestContext,
  LineToolsAndGroupsLoadRequestType,
  LineToolsAndGroupsState,
} from '../../../public/charting_library/charting_library';
import { templateStore } from './templateStore';

/**
 * 画线（绘图对象）持久化。
 *
 * 图表库开启 `saveload_separate_drawings_storage` 后，保存图表时会把画线
 * 单独交给 `save_load_adapter.saveLineToolsAndGroups`。应用没有布局服务，
 * 库里传的 layoutId / chartId 每次启动都会变，所以给每张图一个自己的
 * 适配器（创建 widget 时传入），直接按 slot 存取——只有 slot 是稳定的。
 */

const LINES_KEY = 'mytrade.chartLines';

/** 图表库的 state 里 sources / groups 是 Map，存 localStorage 前转成数组 */
interface StoredLineTools {
  state: {
    symbol?: string;
    sources: [string, unknown][] | null;
    groups: [string, unknown][];
  };
  savedAt: number;
}

type LineToolsMap = Record<string, StoredLineTools>;

function readMap(): LineToolsMap {
  try {
    const raw = window.localStorage.getItem(LINES_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as LineToolsMap) : {};
  } catch {
    return {};
  }
}

function writeMap(map: LineToolsMap): void {
  try {
    window.localStorage.setItem(LINES_KEY, JSON.stringify(map));
  } catch {
    /* 存储满/被禁用时不影响图表本身 */
  }
}

export function serializeLineTools(state: LineToolsAndGroupsState): StoredLineTools['state'] {
  return {
    ...(state.symbol ? { symbol: state.symbol } : {}),
    sources: state.sources ? Array.from(state.sources.entries()) : null,
    groups: Array.from(state.groups.entries()),
  };
}

export function deserializeLineTools(
  raw: StoredLineTools['state'] | undefined,
): Partial<LineToolsAndGroupsState> | null {
  if (!raw) return null;
  return {
    ...(raw.symbol ? { symbol: raw.symbol } : {}),
    sources: raw.sources
      ? (new Map(raw.sources) as unknown as LineToolsAndGroupsState['sources'])
      : null,
    groups: new Map(raw.groups ?? []) as unknown as LineToolsAndGroupsState['groups'],
  };
}

/** 删掉的画线在 DTO 里是 [id, null] 墓碑；只认活着的条目 */
function liveSources(state: StoredLineTools['state']): [string, unknown][] {
  return state.sources ? state.sources.filter(([, value]) => value !== null) : [];
}

export function isEmptyLineTools(state: StoredLineTools['state']): boolean {
  return liveSources(state).length === 0 && state.groups.length === 0;
}

/** 直接写序列化后的画线状态（轮询快照用，避免反复转换） */
export function writeSlotLineTools(slot: string, state: StoredLineTools['state']): void {
  const map = readMap();
  // 墓碑只对图库自己的增量合并有意义；这里存的是整图快照，墓碑一律不落盘
  const clean: StoredLineTools['state'] = {
    ...state,
    sources: state.sources ? liveSources(state) : null,
  };
  if (isEmptyLineTools(clean)) delete map[slot];
  else map[slot] = { state: clean, savedAt: Date.now() };
  writeMap(map);
}

export function readSlotLineToolsRaw(slot: string): StoredLineTools['state'] | null {
  const map = readMap();
  const entry = map[slot];
  if (!entry) return null;
  // 旧版本可能存下只有墓碑的条目，读到就顺手清掉，免得恢复时白白过一遍空状态
  if (!entry.state || isEmptyLineTools(entry.state)) {
    delete map[slot];
    writeMap(map);
    return null;
  }
  return entry.state;
}

/** 按图表 slot 保存画线状态（main / c1…），重启后同一张图恢复 */
export function saveSlotLineTools(slot: string, state: LineToolsAndGroupsState): void {
  writeSlotLineTools(slot, serializeLineTools(state));
}

export function readSlotLineTools(slot: string): Partial<LineToolsAndGroupsState> | null {
  return deserializeLineTools(readSlotLineToolsRaw(slot) ?? undefined);
}

/**
 * 每张图一个保存适配器：指标模板等能力沿用 templateStore，只接管画线。
 * 图表库调用 `saveLineToolsAndGroups` 时不做 id 匹配，按创建这张图时的 slot 落盘。
 */
export function chartSaveAdapter(slot: string): IExternalSaveLoadAdapter {
  return {
    ...templateStore,
    async saveLineToolsAndGroups(
      _layoutId: string | undefined,
      _chartId: string | number,
      state: LineToolsAndGroupsState,
    ): Promise<void> {
      saveSlotLineTools(slot, state);
    },
    async loadLineToolsAndGroups(
      _layoutId: string | undefined,
      _chartId: string | number,
      _requestType: LineToolsAndGroupsLoadRequestType,
      _requestContext: LineToolsAndGroupsLoadRequestContext,
    ): Promise<Partial<LineToolsAndGroupsState> | null> {
      return readSlotLineTools(slot);
    },
  } as unknown as IExternalSaveLoadAdapter;
}
