import { describe, expect, it } from 'vitest';
import type { PineInputMeta, PineScriptRecord } from '../../lib/pineScripts';
import { noteKey, pickScript, pineColor, scriptsByName, toInputValue } from './pineRunner';

function inputMeta(id: string): PineInputMeta {
  return { id, title: id, type: 'int', defval: 0 };
}

function record(patch: Partial<PineScriptRecord>): PineScriptRecord {
  return {
    id: 'a',
    title: '完整标题',
    source: `//@version=6
indicator('x')
`,
    savedAt: 0,
    overlay: true,
    plots: [],
    inputs: [],
    ...patch,
  };
}

describe('scriptsByName', () => {
  it('matches a study by its full title or its shorttitle', () => {
    const byName = scriptsByName([
      record({ id: 'a', title: '完整 A', shortTitle: 'SHORT_A' }),
      record({ id: 'b', title: '完整 B' }),
    ]);

    // 图表库的 study.name 取 description：新模板是 shorttitle，旧模板是全名
    expect(byName.get('完整 A')?.map((script) => script.id)).toEqual(['a']);
    expect(byName.get('SHORT_A')?.map((script) => script.id)).toEqual(['a']);
    expect(byName.get('完整 B')?.map((script) => script.id)).toEqual(['b']);
  });

  it('keeps every script sharing the same shorttitle', () => {
    const byName = scriptsByName([
      record({ id: 'a', title: '脚本 A', shortTitle: 'DUP' }),
      record({ id: 'b', title: '脚本 B', shortTitle: 'DUP' }),
    ]);

    // 同名脚本（保存时标题加「(2)」、shorttitle 不变）以前会被整组跳过，
    // 导致已挂上的指标一直空着；现在保留候选，交给 pickScript 按输入挑
    expect(byName.get('DUP')?.map((script) => script.id)).toEqual(['a', 'b']);
    expect(byName.get('脚本 A')?.map((script) => script.id)).toEqual(['a']);
    expect(byName.get('脚本 B')?.map((script) => script.id)).toEqual(['b']);
  });
});

describe('pickScript', () => {
  it('prefers the script whose inputs match the study', () => {
    const older = record({
      id: 'a',
      shortTitle: 'DUP',
      savedAt: 2,
      inputs: [inputMeta('len')],
    });
    const newer = record({
      id: 'b',
      shortTitle: 'DUP',
      savedAt: 1,
      inputs: [inputMeta('len'), inputMeta('src')],
    });

    // 指标只有 len 输入 → 是用 older 创建的，即使 newer 保存得更晚也选 older
    expect(pickScript([older, newer], { len: 10 })?.id).toBe('a');
    expect(pickScript([older, newer], { len: 10, src: 'close' })?.id).toBe('b');
    expect(pickScript([older], {})?.id).toBe('a');
  });

  it('falls back to the newest copy when inputs cannot tell them apart', () => {
    const older = record({ id: 'a', shortTitle: 'DUP', savedAt: 1, inputs: [] });
    const newer = record({ id: 'b', shortTitle: 'DUP', savedAt: 5, inputs: [] });

    expect(pickScript([older, newer], {})?.id).toBe('b');
    expect(pickScript([], {})).toBeUndefined();
  });
});

describe('pineColor', () => {
  it('turns library color strings back into Piner hex+alpha', () => {
    expect(pineColor('rgba(76, 175, 80, 0.2)')).toBe('#4CAF5033');
    expect(pineColor('rgba(18, 52, 86, 1)')).toBe('#123456FF');
    expect(pineColor('#4CAF50')).toBe('#4CAF50FF');
    expect(pineColor('rgb(76, 175, 80)')).toBe('#4CAF50FF');
  });

  it('leaves unknown color strings untouched', () => {
    expect(pineColor('red')).toBe('red');
    expect(pineColor('#4CAF5033')).toBe('#4CAF5033');
  });
});

describe('noteKey', () => {
  it('leaves the last bar out so one warning is not re-toasted every tick', () => {
    const script = record({ id: 'a' });
    const inputs = { in_refresh: 0 };
    const first = noteKey(script, 'XAUUSD', '3M', inputs, ['不支持 3M']);

    // 行情跳动只改最后一根 K 线，不在键里 → 同一个提醒只弹一次
    expect(noteKey(script, 'XAUUSD', '3M', { ...inputs }, ['不支持 3M'])).toBe(first);
    // 输入 / 周期 / 提醒文字变了才重新提醒
    expect(noteKey(script, 'XAUUSD', '3M', { in_refresh: 1 }, ['不支持 3M'])).not.toBe(first);
    expect(noteKey(script, 'XAUUSD', '12M', inputs, ['不支持 3M'])).not.toBe(first);
    expect(noteKey(script, 'XAUUSD', '3M', inputs, ['不支持 12M'])).not.toBe(first);
  });
});

describe('toInputValue', () => {
  it('normalizes color inputs and keeps other types', () => {
    const meta = { id: 'c', title: 'c', type: 'color' as const, defval: '#123456' };
    expect(toInputValue(meta, 'rgba(18, 52, 86, 0.5)')).toBe('#12345680');
    expect(toInputValue({ ...meta, type: 'int' as const }, '14')).toBe(14);
    expect(toInputValue({ ...meta, type: 'bool' as const }, 1)).toBe(true);
  });
});
