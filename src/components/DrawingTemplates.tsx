import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { clsx } from 'clsx';
import { GripVertical, PencilRuler, Trash2, X } from 'lucide-react';
import { useApp } from '../store/useApp';
import type { IChartWidgetApi } from '../../public/charting_library/charting_library';

const STORAGE_KEY = 'mytrade.drawTemplates';
const POS_KEY = 'mytrade.drawTemplatesPos';

type PanelPos = { x: number; y: number };

function readPos(): PanelPos | null {
  try {
    const raw = window.localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const { x, y } = parsed as Partial<PanelPos>;
    if (typeof x !== 'number' || typeof y !== 'number') return null;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  } catch {
    return null;
  }
}

function writePos(pos: PanelPos): void {
  try {
    window.localStorage.setItem(POS_KEY, JSON.stringify(pos));
  } catch {
    /* 忽略 */
  }
}

/** getAllShapes() 的 name 是工具名（horizontal_line），面板里换成中文 */
const TOOL_LABELS: Record<string, string> = {
  trend_line: '趋势线',
  horizontal_line: '水平线',
  horizontal_ray: '水平射线',
  vertical_line: '垂直线',
  ray: '射线',
  extended_line: '延长线',
  parallel_channel: '平行通道',
  flat_channel: '水平通道',
  disjoint_channel: '不相交通道',
  regression_trend: '回归趋势',
  fib_retracement: '斐波那契回撤',
  fib_extension: '斐波那契扩展',
  fib_channel: '斐波那契通道',
  fib_time_zone: '斐波那契时间周期',
  rectangle: '矩形',
  rotated_rectangle: '旋转矩形',
  ellipse: '椭圆',
  triangle: '三角形',
  arc: '弧线',
  brush: '刷子',
  highlighter: '荧光笔',
  text: '文本',
  callout: '标注',
  arrow: '箭头',
  arrow_marker: '箭头标记',
  flag: '旗形',
  wave: '波浪',
  pitchfan: '速度扇形',
  pitchfork: '安德鲁音叉',
  schiff_pitchfork: 'Schiff 音叉',
  modified_schiff_pitchfork: '修正 Schiff 音叉',
  inside_pitchfork: '内部音叉',
  gann_fan: '江恩扇形',
  gann_box: '江恩箱',
  gann_square: '江恩方形',
  cross_line: '十字线',
  date_range: '日期范围',
  price_range: '价格范围',
  date_and_price_range: '日期和价格范围',
  long_position: '多头仓位',
  short_position: '空头仓位',
  polyline: '折线',
  path: '路径',
  circle: '圆',
  cyclic_lines: '循环线',
  sine_line: '正弦线',
  trend_angle: '趋势角度',
  anchored_volume_profile: '锚定成交量分布',
};

function toolLabel(type: string): string {
  return TOOL_LABELS[type] ?? type;
}

/** 样式模板不该带走文字、隐藏状态这些和具体画线绑定的字段 */
function styleProps(props: Record<string, unknown>): Record<string, unknown> {
  const { text: _text, ...rest } = props;
  return rest;
}

export interface DrawTemplate {
  name: string;
  /** 保存时画线的显示名，例如「趋势线」 */
  type: string;
  /** IShape.getProperties() 的原样结果 */
  props: Record<string, unknown>;
  savedAt: number;
}

type TemplateMap = Record<string, Record<string, DrawTemplate>>;

function readTemplates(): TemplateMap {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as TemplateMap) : {};
  } catch {
    return {};
  }
}

function writeTemplates(map: TemplateMap): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* 本地存储满/被禁用时不影响画线本身 */
  }
}

function fmtDate(ts: number): string {
  if (!Number.isFinite(ts)) return '';
  return new Date(ts).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

/**
 * 画线样式模板：这个版本的 TradingView 自带「模板」菜单只有「应用默认」，
 * 保存/读取入口没有接出来，所以在这里直接基于公开的画线 API 做一套。
 *
 * 保存：选中一条画线 → 读它的属性 → 存进 localStorage
 * 应用：把模板属性写回选中画线，并同时设为该类型画线的默认样式
 */
export function DrawingTemplates({
  chart,
  slot = 'main',
}: {
  chart: IChartWidgetApi | null;
  slot?: string;
}) {
  const notify = useApp((s) => s.notify);
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<TemplateMap>(() => readTemplates());
  const [selection, setSelection] = useState<{ id: string; name: string } | null>(null);
  const [name, setName] = useState('');
  const [asDefault, setAsDefault] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  // 面板位置：默认左下角，拖过之后用 localStorage 里记住的位置
  const [pos, setPos] = useState<PanelPos | null>(() => readPos());
  const wrapRef = useRef<HTMLDivElement>(null);
  const movedRef = useRef(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    hostW: number;
    hostH: number;
    width: number;
    height: number;
    moved: boolean;
  } | null>(null);

  const dragStart = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const wrap = wrapRef.current;
    const host = wrap?.parentElement;
    if (!wrap || !host) return;
    const hostRect = host.getBoundingClientRect();
    const rect = wrap.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: rect.left - hostRect.left,
      originY: rect.top - hostRect.top,
      hostW: hostRect.width,
      hostH: hostRect.height,
      width: rect.width,
      height: rect.height,
      moved: false,
    };
    movedRef.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const dragMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    movedRef.current = true;
    setPos({
      x: Math.min(Math.max(drag.originX + dx, 0), Math.max(0, drag.hostW - drag.width)),
      y: Math.min(Math.max(drag.originY + dy, 0), Math.max(0, drag.hostH - drag.height)),
    });
    event.preventDefault();
    event.stopPropagation();
  };

  const dragEnd = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* 指针已释放 */
    }
    if (!drag.moved) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    const next: PanelPos = {
      x: Math.min(Math.max(drag.originX + dx, 0), Math.max(0, drag.hostW - drag.width)),
      y: Math.min(Math.max(drag.originY + dy, 0), Math.max(0, drag.hostH - drag.height)),
    };
    setPos(next);
    writePos(next);
    event.preventDefault();
    event.stopPropagation();
  };

  // 窗口变小或图表切到四图时，把记住的位置收回可视范围
  useEffect(() => {
    if (!pos) return;
    const wrap = wrapRef.current;
    const host = wrap?.parentElement;
    if (!wrap || !host) return;
    const rect = host.getBoundingClientRect();
    const maxX = Math.max(0, rect.width - wrap.offsetWidth);
    const maxY = Math.max(0, rect.height - wrap.offsetHeight);
    if (pos.x > maxX || pos.y > maxY) {
      const next = { x: Math.min(pos.x, maxX), y: Math.min(pos.y, maxY) };
      setPos(next);
      writePos(next);
    }
  }, [pos]);

  // 选中画线：监听图表选择变化，只认画线（指标不在 getAllShapes 里）
  useEffect(() => {
    if (!chart) {
      setSelection(null);
      return;
    }
    const read = () => {
      try {
        const shapes = chart.getAllShapes();
        const selected = chart.selection().allItems() as unknown[];
        const hit = shapes.find((item) => selected.includes(item.id));
        setSelection(hit ? { id: String(hit.id), name: hit.name } : null);
      } catch {
        setSelection(null);
      }
    };
    read();
    const sub = chart.selection().onChanged();
    sub.subscribe(null, read);
    return () => {
      try {
        sub.unsubscribe(null, read);
      } catch {
        /* 图表销毁时订阅可能已失效 */
      }
    };
  }, [chart]);

  // 当前类型可用的模板；没选中画线时把所有类型都列出来
  const list = useMemo(() => {
    const rows: DrawTemplate[] = [];
    for (const [type, group] of Object.entries(templates)) {
      if (selection && type !== selection.name) continue;
      for (const item of Object.values(group)) rows.push(item);
    }
    return rows.sort((a, b) => b.savedAt - a.savedAt);
  }, [templates, selection]);

  // 打开面板时自动聚焦模板名输入框
  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const save = () => {
    if (!chart || !selection) {
      notify('error', '先在图上点选一条画线');
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      notify('error', '请输入模板名');
      inputRef.current?.focus();
      return;
    }
    try {
      const shape = chart.getShapeById(selection.id as never);
      if (!shape) {
        notify('error', '找不到选中的画线');
        return;
      }
      const props = styleProps(shape.getProperties() as Record<string, unknown>);
      const next: TemplateMap = {
        ...templates,
        [selection.name]: {
          ...(templates[selection.name] ?? {}),
          [trimmed]: {
            name: trimmed,
            type: selection.name,
            props: props as Record<string, unknown>,
            savedAt: Date.now(),
          },
        },
      };
      writeTemplates(next);
      setTemplates(next);
      setName('');
      notify('success', `已保存模板「${trimmed}」`);
    } catch (error) {
      notify('error', (error as Error).message || '保存模板失败');
    }
  };

  const apply = (template: DrawTemplate) => {
    if (!chart) return;
    const ids = (chart.selection().allItems() as unknown[]).map(String);
    if (ids.length === 0) {
      notify('error', '先在图上点选一条画线');
      return;
    }
    let applied = 0;
    const failed: string[] = [];
    for (const id of ids) {
      try {
        const shape = chart.getShapeById(id as never);
        if (!shape) continue;
        shape.setProperties(styleProps(template.props), asDefault);
        applied += 1;
      } catch (error) {
        failed.push((error as Error).message);
      }
    }
    if (applied > 0) {
      notify(
        'success',
        `已应用「${template.name}」到 ${applied} 条画线${asDefault ? '，并设为默认样式' : ''}`,
      );
    }
    if (failed.length > 0) notify('error', failed[0]);
  };

  const remove = (template: DrawTemplate) => {
    const next: TemplateMap = { ...templates };
    const group = { ...(next[template.type] ?? {}) };
    delete group[template.name];
    if (Object.keys(group).length === 0) delete next[template.type];
    else next[template.type] = group;
    writeTemplates(next);
    setTemplates(next);
    notify('success', `已删除模板「${template.name}」`);
  };

  // 靠近底部时往上展开，靠近顶部时往下展开
  const openUp = !pos || pos.y > 240;

  return (
    <div
      ref={wrapRef}
      data-draw-templates={slot}
      className={clsx('absolute z-30', !pos && 'bottom-8 left-[58px]')}
      style={pos ? { left: pos.x, top: pos.y } : undefined}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        onClick={() => {
          // 拖动结束后的 click 不要误触发开合
          if (movedRef.current) {
            movedRef.current = false;
            return;
          }
          setOpen((value) => !value);
        }}
        onPointerDown={dragStart}
        onPointerMove={dragMove}
        onPointerUp={dragEnd}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
        title="单击开合模板面板；按住拖动可移动位置"
        style={{ touchAction: 'none' }}
        className={clsx(
          'flex h-7 cursor-move select-none items-center gap-1.5 rounded-lg border border-tv-border px-2 text-[11px] transition-colors',
          open ? 'bg-tv-hover text-tv-text' : 'bg-tv-panel/95 text-tv-muted hover:text-tv-text',
        )}
      >
        <GripVertical size={13} strokeWidth={1.5} className="opacity-60" />
        <PencilRuler size={14} strokeWidth={1.5} />
        画线模板
      </button>

      {open && (
        <div
          className={clsx(
            'absolute left-0 w-[272px] rounded-xl border border-tv-border bg-tv-panel p-3 shadow-[0_18px_48px_-16px_rgba(0,0,0,0.35)]',
            openUp ? 'bottom-8' : 'top-8',
          )}
        >
          <div className="mb-2 flex items-center gap-1">
            <span className="text-[12px] font-medium text-tv-text">画线模板</span>
            <span className="flex-1" />
            <button
              onClick={() => setOpen(false)}
              className="flex h-6 w-6 items-center justify-center rounded-md text-tv-muted transition-colors hover:bg-tv-hover hover:text-tv-text"
              title="关闭"
            >
              <X size={14} strokeWidth={1.5} />
            </button>
          </div>

          <div className="mb-2 rounded-md bg-tv-raised px-2.5 py-1.5 text-[11px] text-tv-muted">
            {selection ? (
              <span className="text-tv-text">已选中：{toolLabel(selection.name)}</span>
            ) : (
              '在图上点选一条画线，再保存它的样式'
            )}
          </div>

          <div className="flex gap-1.5">
            <input
              ref={inputRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') save();
                if (event.key === 'Escape') setOpen(false);
              }}
              placeholder="模板名，如「红色粗线」"
              className="h-7 min-w-0 flex-1 rounded-lg border border-tv-border bg-tv-raised px-2 text-[11px] text-tv-text outline-none focus:border-tv-accent"
            />
            <button
              onClick={save}
              disabled={!selection}
              className="h-7 shrink-0 rounded-lg bg-tv-text px-2.5 text-[11px] font-medium text-tv-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              保存
            </button>
          </div>

          <label className="mt-2 flex cursor-pointer items-center gap-2 text-[11px] leading-relaxed text-tv-muted">
            <input
              type="checkbox"
              checked={asDefault}
              onChange={(event) => setAsDefault(event.target.checked)}
              className="h-3.5 w-3.5 accent-tv-accent"
            />
            应用时也设为该类型画线的默认样式
          </label>

          <div className="mt-2 max-h-[210px] overflow-auto">
            {list.length === 0 ? (
              <div className="py-3 text-center text-[11px] text-tv-muted">
                {selection ? `还没有「${toolLabel(selection.name)}」的模板` : '还没有保存过模板'}
              </div>
            ) : (
              list.map((template) => (
                <div
                  key={`${template.type}:${template.name}`}
                  className="group flex items-center gap-1 rounded-md px-1 py-1.5 hover:bg-tv-hover"
                >
                  <button
                    onClick={() => apply(template)}
                    title="应用到当前选中的画线"
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="truncate text-[11px] text-tv-text">{template.name}</div>
                    <div className="truncate text-[11px] text-tv-faint">
                      {toolLabel(template.type)} · {fmtDate(template.savedAt)}
                    </div>
                  </button>
                  <button
                    onClick={() => remove(template)}
                    title="删除模板"
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-tv-muted opacity-0 transition-colors hover:bg-tv-down-soft hover:text-tv-down group-hover:opacity-100"
                  >
                    <Trash2 size={13} strokeWidth={1.5} />
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="mt-2 border-t border-tv-border pt-2 text-[11px] leading-relaxed text-tv-faint">
            模板保存在本机。勾选「默认样式」后，之后新画的同类线也会用这套颜色、线宽和字体。
          </div>
        </div>
      )}
    </div>
  );
}
