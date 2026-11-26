import { beforeEach, describe, expect, it } from 'vitest';
import type { LineToolsAndGroupsState } from '../../../public/charting_library/charting_library';
import {
  chartSaveAdapter,
  deserializeLineTools,
  isEmptyLineTools,
  readSlotLineTools,
  readSlotLineToolsRaw,
  saveSlotLineTools,
  serializeLineTools,
  writeSlotLineTools,
} from './lineToolStore';

const KEY = 'mytrade.chartLines';

function state(sources: [string, unknown][], symbol?: string): LineToolsAndGroupsState {
  return {
    ...(symbol ? { symbol } : {}),
    sources: new Map(sources) as unknown as LineToolsAndGroupsState['sources'],
    groups: new Map() as unknown as LineToolsAndGroupsState['groups'],
  };
}

const LINE = { id: 'a1', state: { type: 'LineToolHorzLine' } };

/** EntityId 是图库的品牌类型，测试里按字符串查 Map 需先还原成普通 Map */
function sourceOf(state: Partial<LineToolsAndGroupsState> | null, id: string): unknown {
  return (state?.sources as Map<string, unknown> | null | undefined)?.get(id);
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('serializeLineTools / deserializeLineTools', () => {
  it('Map 往返后画线与 symbol 都不丢', () => {
    const raw = serializeLineTools(state([['a1', LINE]], 'USTEC'));
    expect(raw.symbol).toBe('USTEC');
    expect(raw.sources).toEqual([['a1', LINE]]);
    expect(raw.groups).toEqual([]);

    const back = deserializeLineTools(raw);
    expect(back?.symbol).toBe('USTEC');
    expect(sourceOf(back, 'a1')).toEqual(LINE);
    expect(back?.groups?.size).toBe(0);
  });

  it('sources 为 null 时保持 null，空输入返回 null', () => {
    const raw = serializeLineTools(state([]));
    expect(raw.sources).toEqual([]);
    const nullSources = serializeLineTools({
      sources: null,
      groups: new Map() as unknown as LineToolsAndGroupsState['groups'],
    });
    expect(nullSources.sources).toBeNull();
    expect(deserializeLineTools(undefined)).toBeNull();
  });
});

describe('writeSlotLineTools / readSlotLineTools', () => {
  it('按 slot 分开存，互不覆盖', () => {
    writeSlotLineTools('main', serializeLineTools(state([['a1', LINE]], 'USTEC')));
    writeSlotLineTools('c1', serializeLineTools(state([['b2', LINE]], 'EURUSD')));

    expect(readSlotLineToolsRaw('main')?.sources).toEqual([['a1', LINE]]);
    expect(readSlotLineToolsRaw('c1')?.symbol).toBe('EURUSD');
    expect(sourceOf(readSlotLineTools('c1'), 'b2')).toEqual(LINE);
  });

  it('墓碑不落盘；删光后整条 slot 移除', () => {
    writeSlotLineTools('main', serializeLineTools(state([['a1', LINE], ['dead', null]])));
    expect(readSlotLineToolsRaw('main')?.sources).toEqual([['a1', LINE]]);

    writeSlotLineTools('main', serializeLineTools(state([['a1', null]])));
    expect(readSlotLineToolsRaw('main')).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? '{}')).toEqual({});
  });

  it('读到只有墓碑的旧数据时顺手清掉', () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ main: { state: { sources: [['a1', null]], groups: [] }, savedAt: 1 } }),
    );

    expect(readSlotLineToolsRaw('main')).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBe('{}');
  });

  it('存储损坏时按空处理，之后仍能正常写入', () => {
    window.localStorage.setItem(KEY, '{not json');
    expect(readSlotLineToolsRaw('main')).toBeNull();

    saveSlotLineTools('main', state([['a1', LINE]]));
    expect(readSlotLineToolsRaw('main')?.sources).toEqual([['a1', LINE]]);
  });

  it('isEmptyLineTools 只看活条目和分组', () => {
    expect(isEmptyLineTools(serializeLineTools(state([])))).toBe(true);
    expect(isEmptyLineTools(serializeLineTools(state([['a1', null]])))).toBe(true);
    expect(isEmptyLineTools(serializeLineTools(state([['a1', LINE]])))).toBe(false);
  });
});

describe('chartSaveAdapter', () => {
  it('忽略 layoutId / chartId，按创建这张图时的 slot 存取', async () => {
    const adapter = chartSaveAdapter('c2');
    await adapter.saveLineToolsAndGroups('layout-a', 42, state([['x9', LINE]], 'USTEC'));

    expect(readSlotLineToolsRaw('c2')?.sources).toEqual([['x9', LINE]]);
    expect(readSlotLineToolsRaw('main')).toBeNull();

    const loaded = await adapter.loadLineToolsAndGroups(
      'another-layout',
      7,
      'mainSeriesLineTools',
      {},
    );
    expect(sourceOf(loaded, 'x9')).toEqual(LINE);
  });

  it('没有画线时 load 返回 null', async () => {
    const adapter = chartSaveAdapter('c3');
    expect(await adapter.loadLineToolsAndGroups(undefined, 1, 'allLineTools', {})).toBeNull();
  });
});
