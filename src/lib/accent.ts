import type { Theme } from '../store/useApp';

/** 浅色主题的原强调色；用户没改过时不做任何覆盖，交给 index.css 的默认值 */
export const DEFAULT_ACCENT = '#1f5fd6';

/** 预设都取中间调，浅色和深色底材上都站得住 */
export const ACCENT_PRESETS = [
  { name: '钴蓝', value: '#1f5fd6' },
  { name: '青瓷', value: '#11707a' },
  { name: '松绿', value: '#2f7050' },
  { name: '黛紫', value: '#6a4bbb' },
  { name: '赭石', value: '#b4541f' },
  { name: '墨灰', value: '#3f4a5a' },
] as const;

type Rgb = { r: number; g: number; b: number };

function parseHex(hex: string): Rgb | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  let body = match[1];
  if (body.length === 3) body = body.split('').map((c) => c + c).join('');
  return {
    r: parseInt(body.slice(0, 2), 16),
    g: parseInt(body.slice(2, 4), 16),
    b: parseInt(body.slice(4, 6), 16),
  };
}

function toHex({ r, g, b }: Rgb): string {
  const part = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** 统一成小写 #rrggbb；非法输入返回 null */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const rgb = parseHex(value);
  return rgb ? toHex(rgb) : null;
}

function mix(from: string, to: string, weight: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  if (!a || !b) return from;
  const blend = (x: number, y: number) => x + (y - x) * weight;
  return toHex({ r: blend(a.r, b.r), g: blend(a.g, b.g), b: blend(a.b, b.b) });
}

function luminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * 同一个强调色在两种底材上都要看得清：浅色底不够暗就往墨色压，
 * 深色底不够亮就往白提，只调到刚好够读，保留用户挑的色相。
 */
export function accentForTheme(hex: string, theme: Theme): string {
  const base = normalizeHex(hex) ?? DEFAULT_ACCENT;
  const background = theme === 'dark' ? '#14161b' : '#ffffff';
  if (contrastRatio(base, background) >= 4.5) return base;
  const toward = theme === 'dark' ? '#ffffff' : '#11161f';
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 14; i += 1) {
    const mid = (lo + hi) / 2;
    if (contrastRatio(mix(base, toward, mid), background) >= 4.5) hi = mid;
    else lo = mid;
  }
  return mix(base, toward, hi);
}

const PANELS: Record<Theme, { tv: string; console: string; soft: number }> = {
  light: { tv: '#ffffff', console: '#fffdf8', soft: 0.11 },
  white: { tv: '#ffffff', console: '#ffffff', soft: 0.11 },
  dark: { tv: '#1a1d23', console: '#211c16', soft: 0.16 },
};

/**
 * 把强调色写到根节点。默认色不做覆盖，index.css 里浅色/深色各自的默认值照常生效；
 * 用户改过才写入，强调色与柔色底随主题一起算。
 */
export function applyAccent(hex: string, theme: Theme): void {
  const root = document.documentElement.style;
  const accent = normalizeHex(hex);
  if (!accent || accent === DEFAULT_ACCENT) {
    root.removeProperty('--color-tv-accent');
    root.removeProperty('--color-console-accent');
    root.removeProperty('--color-tv-accent-soft');
    root.removeProperty('--color-console-accent-soft');
    return;
  }
  const resolved = accentForTheme(accent, theme);
  const panels = PANELS[theme];
  root.setProperty('--color-tv-accent', resolved);
  root.setProperty('--color-console-accent', resolved);
  root.setProperty('--color-tv-accent-soft', mix(panels.tv, resolved, panels.soft));
  root.setProperty('--color-console-accent-soft', mix(panels.console, resolved, panels.soft));
}
