import { describe, expect, it } from 'vitest';
import type { PineScriptRecord } from '../../lib/pineScripts';
import { noteKey, pineColor, scriptsByName, toInputValue } from './pineRunner';

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
    expect(byName.get('完整 A')?.id).toBe('a');
    expect(byName.get('SHORT_A')?.id).toBe('a');
    expect(byName.get('完整 B')?.id).toBe('b');
  });

  it('skips names shared by two scripts', () => {
    const byName = scriptsByName([
      record({ id: 'a', title: '脚本 A', shortTitle: 'DUP' }),
      record({ id: 'b', title: '脚本 B', shortTitle: 'DUP' }),
    ]);

    // 重名时无法判断这块指标属于哪个脚本，宁可跳过也不画错
    expect(byName.has('DUP')).toBe(false);
    expect(byName.get('脚本 A')?.id).toBe('a');
    expect(byName.get('脚本 B')?.id).toBe('b');
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
