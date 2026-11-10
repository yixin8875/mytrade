import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { LAYOUT_GROUPS, layoutById, type LayoutPreset } from '../chart/layouts';
import { useApp, type ChartSync } from '../store/useApp';

/** 用布局预设自己的格子矩形画小图标，和实际图表排列一致 */
export function LayoutIcon({
  preset,
  className = 'h-5 w-5',
}: {
  preset: LayoutPreset;
  className?: string;
}) {
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      {preset.rects.map((rect, index) => (
        <rect
          key={index}
          x={rect.x + 2}
          y={rect.y + 2}
          width={Math.max(rect.width - 4, 3)}
          height={Math.max(rect.height - 4, 3)}
          rx={4}
          fill="currentColor"
          fillOpacity="0.12"
          stroke="currentColor"
          strokeOpacity="0.72"
          strokeWidth="3"
        />
      ))}
    </svg>
  );
}

/** 按图表数量分行列出所有布局 */
export function LayoutGallery({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="space-y-1">
      {LAYOUT_GROUPS.map((group) => (
        <div key={group.count} className="flex items-center gap-2">
          <span className="w-4 shrink-0 select-none text-right font-mono text-[10px] text-tv-muted">
            {group.count}
          </span>
          <div className="flex flex-wrap items-center gap-0.5">
            {group.presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                title={`${preset.count} 图 · ${preset.label}`}
                aria-label={`${preset.count} 图 ${preset.label}`}
                aria-pressed={value === preset.id}
                onClick={() => onChange(preset.id)}
                className={clsx(
                  'rounded p-0.5 transition-colors',
                  value === preset.id
                    ? 'bg-tv-accent/20 text-tv-accent'
                    : 'text-tv-muted hover:bg-tv-hover hover:text-tv-text',
                )}
              >
                <LayoutIcon preset={preset} className="h-5 w-5" />
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const SYNC_ITEMS: { key: keyof ChartSync; label: string; hint: string }[] = [
  { key: 'symbol', label: '商品代码', hint: '在一个图表里切换品种时，其他图表一起切换' },
  { key: 'interval', label: '周期', hint: '在一个图表里切换周期时，其他图表一起切换' },
  { key: 'crosshair', label: '十字线', hint: '鼠标在图表上移动时，其他图表显示同一位置的十字线' },
  { key: 'time', label: '时间', hint: '滚动或缩放图表时，其他图表保持同一可视时间区间' },
  { key: 'dateRange', label: '日期范围', hint: '调整日期范围时，其他图表保持同一区间（与「时间」一致）' },
];

export function SyncToggles({ className }: { className?: string }) {
  const sync = useApp((s) => s.layoutSync);
  const setSync = useApp((s) => s.setLayoutSync);

  return (
    <div className={clsx('grid grid-cols-3 gap-x-1 gap-y-1', className)}>
      {SYNC_ITEMS.map((item) => {
        const on = sync[item.key];
        return (
          <button
            key={item.key}
            type="button"
            title={item.hint}
            aria-pressed={on}
            onClick={() => setSync({ [item.key]: !on } as Partial<ChartSync>)}
            className={clsx(
              'flex items-center gap-1 rounded px-1 py-0.5 text-left text-[10px] transition-colors',
              on ? 'text-tv-text' : 'text-tv-muted hover:text-tv-text',
            )}
          >
            <span
              className={clsx(
                'flex h-3 w-3 shrink-0 items-center justify-center rounded-[3px] border transition-colors',
                on ? 'border-tv-accent bg-tv-accent' : 'border-tv-border bg-tv-bg',
              )}
            >
              {on && (
                <svg viewBox="0 0 10 10" className="h-2 w-2 text-black" aria-hidden="true">
                  <path
                    d="M1.5 5.2 3.8 7.5 8.5 2.2"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </span>
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

/** 顶栏入口：布局网格 +「同步到所有图表」开关，交互参照 TradingView 的布局菜单 */
export function LayoutPickerButton() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const layout = useApp((s) => s.layout);
  const setLayout = useApp((s) => s.setLayout);
  const preset = layoutById(layout);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        title="图表布局与联动"
        aria-expanded={open}
        className={clsx(
          'flex h-6 items-center gap-1 rounded px-1.5 text-[10px] transition-colors',
          open ? 'bg-tv-border text-tv-text' : 'bg-tv-bg text-tv-text hover:bg-tv-border',
        )}
      >
        <LayoutIcon preset={preset} className="h-3.5 w-3.5" />
        布局
      </button>

      {open && (
        <div
          className="absolute left-0 top-full z-50 mt-1 w-[340px] overflow-y-auto rounded-lg border border-tv-border bg-tv-panel p-2 shadow-2xl"
          style={{ maxHeight: 'min(70vh, 520px)' }}
        >
          <div className="mb-1 flex items-center justify-between px-1">
            <span className="text-[10px] font-medium text-tv-text">图表布局</span>
            <span className="font-mono text-[10px] text-tv-muted">
              {preset.count} 图 · {preset.label}
            </span>
          </div>
          <LayoutGallery
            value={layout}
            onChange={(id) => {
              setLayout(id);
              setOpen(false);
            }}
          />
          <div className="mt-2 border-t border-tv-border pt-2">
            <div className="mb-1 px-1 text-[10px] font-medium text-tv-text">同步到所有图表</div>
            <SyncToggles className="px-1" />
          </div>
        </div>
      )}
    </div>
  );
}
