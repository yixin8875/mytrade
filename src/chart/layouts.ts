/**
 * 多图布局预设。图表库的 Advanced Charts 版本不提供 Trading Platform 的
 * setLayout，所以布局由应用自己用 CSS Grid 实现。
 *
 * 每个预设用「格子编号矩阵」描述：同一编号占多行多列就会合并成一块。
 * 布局选择器里的小图标和实际图表容器共用同一份数据，保证所见即所得。
 */

export interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutPreset {
  id: string;
  /** 选择器里的悬浮提示 */
  label: string;
  /** 图表数量 */
  count: number;
  cols: number;
  rows: number;
  /** CSS grid-template-areas */
  areas: string;
  /** 归一化到 100×100 的格子矩形，用于画布局小图标 */
  rects: LayoutRect[];
}

type CellRows = number[][];

function make(id: string, label: string, rows: CellRows): LayoutPreset {
  const cols = rows[0].length;
  const count = new Set(rows.flat()).size;
  const bounds = new Map<number, { r0: number; r1: number; c0: number; c1: number }>();

  rows.forEach((row, r) => {
    row.forEach((cell, c) => {
      const box = bounds.get(cell);
      if (box) {
        box.r0 = Math.min(box.r0, r);
        box.r1 = Math.max(box.r1, r);
        box.c0 = Math.min(box.c0, c);
        box.c1 = Math.max(box.c1, c);
      } else {
        bounds.set(cell, { r0: r, r1: r, c0: c, c1: c });
      }
    });
  });

  const rects = Array.from({ length: count }, (_, index) => {
    const box = bounds.get(index);
    if (!box) return { x: 0, y: 0, width: 0, height: 0 };
    return {
      x: (box.c0 / cols) * 100,
      y: (box.r0 / rows.length) * 100,
      width: ((box.c1 - box.c0 + 1) / cols) * 100,
      height: ((box.r1 - box.r0 + 1) / rows.length) * 100,
    };
  });

  return {
    id,
    label,
    count,
    cols,
    rows: rows.length,
    areas: rows.map((row) => `"${row.map((cell) => `c${cell}`).join(' ')}"`).join(' '),
    rects,
  };
}

const column = (count: number): CellRows => [Array.from({ length: count }, (_, index) => index)];
const stack = (count: number): CellRows => Array.from({ length: count }, (_, index) => [index]);

export const LAYOUTS: LayoutPreset[] = [
  make('1', '单图', [[0]]),

  make('2h', '左右两图', [[0, 1]]),
  make('2v', '上下两图', [[0], [1]]),

  make('3h', '三列', [[0, 1, 2]]),
  make('3v', '三行', [[0], [1], [2]]),
  make('3l', '左大右二', [[0, 1], [0, 2]]),
  make('3r', '左二右大', [[0, 1], [2, 1]]),
  make('3t', '上大下二', [[0, 0], [1, 2]]),
  make('3b', '上二下大', [[0, 1], [2, 2]]),

  make('4', '2×2', [[0, 1], [2, 3]]),
  make('4h', '四列', column(4)),
  make('4v', '四行', stack(4)),
  make('4l', '左大右三', [[0, 1], [0, 2], [0, 3]]),
  make('4r', '左三右大', [[0, 1], [2, 1], [3, 1]]),
  make('4t', '上大下三', [[0, 0, 0], [1, 2, 3]]),
  make('4b', '上三下大', [[0, 1, 2], [3, 3, 3]]),

  make('5h', '五列', column(5)),
  make('5v', '五行', stack(5)),
  make('5l', '左大右四', [[0, 1, 2], [0, 3, 4]]),
  make('5t', '上大下四', [[0, 0, 0, 0], [1, 2, 3, 4]]),
  make('5b', '上四下大', [[0, 1, 2, 3], [4, 4, 4, 4]]),

  make('6', '3×2', [[0, 1, 2], [3, 4, 5]]),
  make('6v', '2×3', [[0, 1], [2, 3], [4, 5]]),
  make('6h', '六列', column(6)),
  make('6r', '六行', stack(6)),
  make('6l', '左大右五', [[0, 1, 2], [0, 3, 4], [0, 5, 5]]),
  make('6t', '上大下五', [[0, 0, 0, 0], [1, 2, 3, 4], [5, 5, 5, 5]]),

  make('7h', '七列', column(7)),
  make('7v', '七行', stack(7)),
  make('7l', '左大右六', [[0, 1, 2, 3], [0, 4, 5, 6]]),

  make('8', '4×2', [[0, 1, 2, 3], [4, 5, 6, 7]]),
  make('8v', '2×4', [[0, 1], [2, 3], [4, 5], [6, 7]]),
  make('8h', '八列', column(8)),
  make('8r', '八行', stack(8)),

  make('9', '3×3', [[0, 1, 2], [3, 4, 5], [6, 7, 8]]),
  make('9h', '九列', column(9)),
  make('9v', '九行', stack(9)),

  make('10', '5×2', [[0, 1, 2, 3, 4], [5, 6, 7, 8, 9]]),
  make('10h', '十列', column(10)),
  make('10v', '十行', stack(10)),

  make('12', '4×3', [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11]]),
  make('12v', '2×6', [[0, 1], [2, 3], [4, 5], [6, 7], [8, 9], [10, 11]]),
  make('12h', '十二列', column(12)),

  make('14', '7×2', [[0, 1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12, 13]]),
  make('14v', '2×7', [[0, 1], [2, 3], [4, 5], [6, 7], [8, 9], [10, 11], [12, 13]]),
  make('14h', '十四列', column(14)),

  make('16', '4×4', [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15]]),
  make('16v', '8×2', [[0, 1], [2, 3], [4, 5], [6, 7], [8, 9], [10, 11], [12, 13], [14, 15]]),
  make('16h', '十六列', column(16)),
];

const BY_ID = new Map(LAYOUTS.map((preset) => [preset.id, preset]));

/** 旧版本只存 single / quad 两个值 */
export function normalizeLayoutId(value: unknown): string {
  if (value === 'single') return '1';
  if (value === 'quad') return '4';
  return typeof value === 'string' && BY_ID.has(value) ? value : '1';
}

export function layoutById(id: string): LayoutPreset {
  return BY_ID.get(id) ?? BY_ID.get('1')!;
}

export function isLayoutId(value: unknown): value is string {
  return typeof value === 'string' && BY_ID.has(value);
}

/** 按图表数量分组，保持 LAYOUTS 里的顺序 */
export const LAYOUT_GROUPS: { count: number; presets: LayoutPreset[] }[] = (() => {
  const groups = new Map<number, LayoutPreset[]>();
  for (const preset of LAYOUTS) {
    const list = groups.get(preset.count);
    if (list) list.push(preset);
    else groups.set(preset.count, [preset]);
  }
  return Array.from(groups, ([count, presets]) => ({ count, presets }));
})();

/** 单元格数组固定长度的默认周期，超出布局数量的部分留着备用 */
export const DEFAULT_FRAMES = [
  '5',
  '15',
  '60',
  '240',
  '1',
  '30',
  '120',
  '1D',
  '1W',
  '4',
  '12',
  '2',
  '3',
  '6',
  '10',
  '20',
];
