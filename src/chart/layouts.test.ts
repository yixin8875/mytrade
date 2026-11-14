import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FRAMES,
  LAYOUTS,
  LAYOUT_GROUPS,
  isLayoutId,
  layoutById,
  normalizeLayoutId,
} from './layouts';

describe('布局预设', () => {
  it('id 唯一且都有标签', () => {
    const ids = LAYOUTS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of LAYOUTS) expect(preset.label.length).toBeGreaterThan(0);
  });

  it('每套布局的格子数量、矩形与 areas 自洽', () => {
    for (const preset of LAYOUTS) {
      expect(preset.count).toBeGreaterThan(0);
      expect(preset.rects).toHaveLength(preset.count);

      for (const rect of preset.rects) {
        expect(rect.width).toBeGreaterThan(0);
        expect(rect.height).toBeGreaterThan(0);
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width).toBeLessThanOrEqual(100 + 1e-9);
        expect(rect.y + rect.height).toBeLessThanOrEqual(100 + 1e-9);
      }

      const rows = preset.areas.match(/"([^"]*)"/g) ?? [];
      expect(rows).toHaveLength(preset.rows);
      const cells = new Set<string>();
      for (const row of rows) {
        const labels = row.slice(1, -1).split(' ');
        expect(labels).toHaveLength(preset.cols);
        for (const label of labels) cells.add(label);
      }
      expect(cells.size).toBe(preset.count);
    }
  });

  it('分组按图表数量聚合，覆盖所有预设', () => {
    expect(LAYOUT_GROUPS.reduce((sum, group) => sum + group.presets.length, 0)).toBe(
      LAYOUTS.length,
    );
    expect(LAYOUT_GROUPS.map((group) => group.count)).toEqual([
      ...new Set(LAYOUTS.map((preset) => preset.count)),
    ]);
  });
});

describe('normalizeLayoutId', () => {
  it('兼容旧版 single / quad', () => {
    expect(normalizeLayoutId('single')).toBe('1');
    expect(normalizeLayoutId('quad')).toBe('4');
  });

  it('合法 id 原样返回，其余回退到单图', () => {
    expect(normalizeLayoutId('2h')).toBe('2h');
    expect(normalizeLayoutId('16h')).toBe('16h');
    expect(normalizeLayoutId('unknown')).toBe('1');
    expect(normalizeLayoutId(null)).toBe('1');
    expect(normalizeLayoutId(4)).toBe('1');
  });

  it('isLayoutId 只认预设 id', () => {
    expect(isLayoutId('3l')).toBe(true);
    expect(isLayoutId('single')).toBe(false);
    expect(isLayoutId(undefined)).toBe(false);
  });
});

describe('layoutById', () => {
  it('未知 id 回退到单图', () => {
    expect(layoutById('6r').count).toBe(6);
    expect(layoutById('missing').id).toBe('1');
  });
});

describe('DEFAULT_FRAMES', () => {
  it('至少覆盖最大布局的图表数量', () => {
    const maxCount = Math.max(...LAYOUTS.map((preset) => preset.count));
    expect(DEFAULT_FRAMES.length).toBeGreaterThanOrEqual(maxCount);
    expect(new Set(DEFAULT_FRAMES).size).toBe(DEFAULT_FRAMES.length);
  });
});
