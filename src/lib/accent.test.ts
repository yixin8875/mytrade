import { afterEach, describe, expect, it } from 'vitest';
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  accentForTheme,
  applyAccent,
  contrastRatio,
  normalizeHex,
} from './accent';

afterEach(() => {
  document.documentElement.removeAttribute('style');
});

describe('normalizeHex', () => {
  it('统一成小写 #rrggbb', () => {
    expect(normalizeHex('#1F5FD6')).toBe('#1f5fd6');
    expect(normalizeHex('1f5fd6')).toBe('#1f5fd6');
    expect(normalizeHex('#ABC')).toBe('#aabbcc');
    expect(normalizeHex('  #fff  ')).toBe('#ffffff');
  });

  it('非法值返回 null', () => {
    expect(normalizeHex('#12345')).toBeNull();
    expect(normalizeHex('blue')).toBeNull();
    expect(normalizeHex(null)).toBeNull();
    expect(normalizeHex(123)).toBeNull();
  });
});

describe('contrastRatio', () => {
  it('黑白对比度为 21，同色为 1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#1f5fd6', '#1f5fd6')).toBeCloseTo(1, 10);
  });

  it('非法颜色按黑色处理', () => {
    expect(contrastRatio('nope', '#ffffff')).toBeCloseTo(21, 5);
  });
});

describe('accentForTheme', () => {
  it('已经够对比度的颜色原样返回', () => {
    expect(accentForTheme(DEFAULT_ACCENT, 'light')).toBe(DEFAULT_ACCENT);
    expect(accentForTheme('#ffffff', 'dark')).toBe('#ffffff');
  });

  it('对比度不足时向墨色/白色微调，直到达到 4.5', () => {
    const light = accentForTheme('#ffe066', 'light');
    expect(light).not.toBe('#ffe066');
    expect(contrastRatio(light, '#ffffff')).toBeGreaterThanOrEqual(4.5);

    const dark = accentForTheme('#445566', 'dark');
    expect(contrastRatio(dark, '#14161b')).toBeGreaterThanOrEqual(4.5);
  });

  it('非法输入回退到默认强调色', () => {
    expect(accentForTheme('not-a-color', 'light')).toBe(DEFAULT_ACCENT);
  });

  it('预设颜色在两种主题上都可读', () => {
    for (const preset of ACCENT_PRESETS) {
      expect(
        contrastRatio(accentForTheme(preset.value, 'light'), '#ffffff'),
      ).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(accentForTheme(preset.value, 'dark'), '#14161b')).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });
});

describe('applyAccent', () => {
  it('默认色不覆盖 CSS 变量', () => {
    const style = document.documentElement.style;
    style.setProperty('--color-tv-accent', '#ff0000');

    applyAccent(DEFAULT_ACCENT, 'light');

    expect(style.getPropertyValue('--color-tv-accent')).toBe('');
    expect(style.getPropertyValue('--color-console-accent')).toBe('');
  });

  it('自定义色写入四个变量，柔色底随主题变化', () => {
    applyAccent('#b4541f', 'light');
    const style = document.documentElement.style;

    expect(style.getPropertyValue('--color-tv-accent')).toBe(accentForTheme('#b4541f', 'light'));
    expect(style.getPropertyValue('--color-console-accent')).toBe(
      accentForTheme('#b4541f', 'light'),
    );
    expect(style.getPropertyValue('--color-tv-accent-soft')).toMatch(/^#[0-9a-f]{6}$/);

    const lightSoft = style.getPropertyValue('--color-tv-accent-soft');
    applyAccent('#b4541f', 'dark');
    expect(style.getPropertyValue('--color-tv-accent-soft')).not.toBe(lightSoft);
  });

  it('非法颜色等同默认色', () => {
    applyAccent('nope', 'dark');
    expect(document.documentElement.style.getPropertyValue('--color-tv-accent')).toBe('');
  });
});
