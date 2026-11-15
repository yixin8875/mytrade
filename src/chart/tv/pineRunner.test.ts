import { describe, expect, it } from 'vitest';
import { pineColor, toInputValue } from './pineRunner';

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

describe('toInputValue', () => {
  it('normalizes color inputs and keeps other types', () => {
    const meta = { id: 'c', title: 'c', type: 'color' as const, defval: '#123456' };
    expect(toInputValue(meta, 'rgba(18, 52, 86, 0.5)')).toBe('#12345680');
    expect(toInputValue({ ...meta, type: 'int' as const }, '14')).toBe(14);
    expect(toInputValue({ ...meta, type: 'bool' as const }, 1)).toBe(true);
  });
});
