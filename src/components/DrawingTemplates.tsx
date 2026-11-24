import { useEffect, useMemo, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useApp } from '../store/useApp';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import type {
  IChartWidgetApi,
  ILineDataSourceApi,
  SupportedLineTools,
} from '../../public/charting_library/charting_library';

const LEGACY_KEY = 'mytrade.drawTemplates';
/** 模板按图表槽位分开，四图布局互不影响 */
const storageKey = (slot: string) => `mytrade.drawTemplates:${slot}`;

/** 面板缺省位置：图表工具栏下方左侧 */
const DEFAULT_ANCHOR = { left: 8, top: 44 };

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

function parseTemplates(raw: string): TemplateMap {
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === 'object' ? (parsed as TemplateMap) : {};
}

function readTemplates(slot: string): TemplateMap {
  try {
    const raw = window.localStorage.getItem(storageKey(slot));
    if (raw) return parseTemplates(raw);
    if (slot !== 'main') {
      // 画线模板是不分品种/周期的样式组合：本槽位还没存过时沿用主图那套，
      // 在该槽位第一次保存或删除后才会分出自己的一份。
      const main = window.localStorage.getItem(storageKey('main'));
      return main ? parseTemplates(main) : {};
    }
    // 旧版本只有一份全局模板：迁移到主图槽位，旧键保留不删
    const legacy = window.localStorage.getItem(LEGACY_KEY);
    if (!legacy) return {};
    window.localStorage.setItem(storageKey('main'), legacy);
    return parseTemplates(legacy);
  } catch {
    return {};
  }
}

function writeTemplates(slot: string, map: TemplateMap): void {
  try {
    window.localStorage.setItem(storageKey(slot), JSON.stringify(map));
  } catch {
    /* 本地存储满/被禁用时不影响画线本身 */
  }
}

/**
 * 取某个画线类型的出厂默认属性：用相同点位临时创建一个同类型画线，
 * 读出它的属性后立刻删除。库没有直接暴露默认属性的 API。
 */
async function readDefaultProps(
  chart: IChartWidgetApi,
  shape: ILineDataSourceApi,
  type: string,
): Promise<Record<string, unknown>> {
  const id = await chart.createMultipointShape(shape.getPoints(), {
    // createMultipointShape 不接受光标/删除等工具，画线名称不会是它们
    shape: type as Exclude<
      SupportedLineTools,
      'cursor' | 'dot' | 'arrow_cursor' | 'eraser' | 'measure' | 'zoom'
    >,
    disableSave: true,
    disableSelection: true,
    disableUndo: true,
    lock: true,
    showInObjectsTree: false,
  });
  try {
    const temp = chart.getShapeById(id);
    if (!temp) throw new Error('读取默认样式失败');
    return temp.getProperties() as Record<string, unknown>;
  } finally {
    try {
      chart.removeEntity(id, { disableUndo: true });
    } catch {
      /* 临时画线已被移除时忽略 */
    }
  }
}

function MenuItem({
  disabled,
  onClick,
  children,
}: {
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] text-foreground outline-none hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/**
 * 画线样式模板。这个版本的 TradingView 自带「模板」菜单只存在于 Trading Platform，
 * Charting Library 里没有对应 UI，所以入口挂在选中画线的浮动工具栏上
 * （见 chart/tv/floatingTemplates.ts），菜单按原生样子自己做：
 * 保存模板为… / 应用默认模板 / 当前工具的模板列表。
 *
 * 保存：选中一条画线 → 读它的属性 → 存进 localStorage
 * 应用：把模板属性写回选中画线，可选同时设为该类型画线的默认样式
 */
export function DrawingTemplates({
  chart,
  slot = 'main',
  open,
  onClose,
  anchor,
}: {
  chart: IChartWidgetApi | null;
  slot?: string;
  /** 由选中画线后浮动工具栏里的模板按钮控制开合 */
  open: boolean;
  onClose: () => void;
  /** 面板相对图表容器的位置；缺省时放到工具栏下方左侧 */
  anchor?: { left: number; top: number } | null;
}) {
  const notify = useApp((s) => s.notify);
  const [templates, setTemplates] = useState<TemplateMap>(() => readTemplates(slot));
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ id: string; name: string } | null>(null);
  const [view, setView] = useState<'list' | 'save'>('list');
  const [name, setName] = useState('');
  const [asDefault, setAsDefault] = useState(true);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // 槽位变化时切到对应槽位的模板
  useEffect(() => {
    setTemplates(readTemplates(slot));
    setPendingDelete(null);
  }, [slot]);

  // 每次打开都从菜单首页开始
  useEffect(() => {
    if (!open) return;
    setView('list');
    setName('');
    window.setTimeout(() => panelRef.current?.focus(), 0);
  }, [open]);

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

  // 点面板外关闭（图表内部的点击在 iframe 里，收不到）
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (panelRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, onClose]);

  // 进入保存视图时聚焦名称输入框
  useEffect(() => {
    if (open && view === 'save') window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open, view]);

  // 当前类型可用的模板；没选中画线时把所有类型都列出来
  const groups = useMemo(() => {
    return Object.entries(templates)
      .filter(([type]) => !selection || type === selection.name)
      .map(([type, group]) => ({
        type,
        items: Object.values(group).sort((a, b) => b.savedAt - a.savedAt),
      }))
      .filter((group) => group.items.length > 0);
  }, [templates, selection]);

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
      writeTemplates(slot, next);
      setTemplates(next);
      setName('');
      setView('list');
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

  /** 把选中画线恢复成该工具类型的出厂样式 */
  const applyDefaults = async () => {
    if (!chart || busy) return;
    const ids = (chart.selection().allItems() as unknown[]).map(String);
    if (ids.length === 0) {
      notify('error', '先在图上点选一条画线');
      return;
    }
    const names = new Map<string, string>();
    for (const shape of chart.getAllShapes()) names.set(String(shape.id), shape.name);
    const defaults = new Map<string, Record<string, unknown>>();
    let applied = 0;
    const failed: string[] = [];
    setBusy(true);
    try {
      for (const id of ids) {
        try {
          const type = names.get(id);
          const shape = chart.getShapeById(id as never);
          if (!type || !shape) continue;
          let props = defaults.get(type);
          if (!props) {
            props = await readDefaultProps(chart, shape, type);
            defaults.set(type, props);
          }
          shape.setProperties(styleProps(props), asDefault);
          applied += 1;
        } catch (error) {
          failed.push((error as Error).message);
        }
      }
    } finally {
      setBusy(false);
    }
    if (applied > 0) {
      notify(
        'success',
        `已恢复 ${applied} 条画线的默认样式${asDefault ? '，并设为默认样式' : ''}`,
      );
    }
    if (failed.length > 0) {
      notify('error', failed[0] || '该画线类型暂不支持恢复默认样式');
    }
  };

  const remove = (template: DrawTemplate) => {
    // 两次点击确认，避免误删
    if (pendingDelete !== template.name) {
      setPendingDelete(template.name);
      window.setTimeout(
        () => setPendingDelete((prev) => (prev === template.name ? null : prev)),
        4000,
      );
      return;
    }
    const next: TemplateMap = { ...templates };
    const group = { ...(next[template.type] ?? {}) };
    delete group[template.name];
    if (Object.keys(group).length === 0) delete next[template.type];
    else next[template.type] = group;
    writeTemplates(slot, next);
    setTemplates(next);
    setPendingDelete(null);
    notify('success', `已删除模板「${template.name}」`);
  };

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      role="menu"
      tabIndex={-1}
      data-draw-templates={slot}
      className="absolute z-30 w-[248px] rounded-lg border border-border bg-popover p-1 text-foreground shadow-lg/10 outline-none"
      style={anchor ?? DEFAULT_ANCHOR}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          if (view === 'save') setView('list');
          else onClose();
        }
      }}
    >
      {view === 'save' ? (
        <div className="p-1.5">
          <div className="px-0.5 pb-2 text-[12px] font-medium">保存模板为</div>
          <input
            ref={inputRef}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') save();
            }}
            placeholder="模板名称"
            className="h-8 w-full rounded-lg border border-input bg-background px-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25"
          />
          <div className="mt-2 flex justify-end gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setView('list')}
              className="h-7 px-2.5 text-[11px]"
            >
              取消
            </Button>
            <Button
              size="sm"
              onClick={save}
              disabled={!selection || !name.trim()}
              className="h-7 px-2.5 text-[11px]"
            >
              保存
            </Button>
          </div>
        </div>
      ) : (
        <>
          <MenuItem disabled={!selection} onClick={() => setView('save')}>
            保存模板为…
          </MenuItem>
          <MenuItem disabled={!selection || busy} onClick={() => void applyDefaults()}>
            应用默认模板
          </MenuItem>

          {!selection && (
            <div className="px-2.5 pb-1 pt-0.5 text-[10px] leading-relaxed text-muted-foreground/70">
              在图上选择一条画线后，可保存或恢复默认样式
            </div>
          )}

          <div className="my-1 h-px bg-border" />

          <div className="max-h-[260px] overflow-auto">
            {groups.length === 0 ? (
              <div className="px-2.5 py-2 text-[11px] text-muted-foreground">
                {selection ? `还没有「${toolLabel(selection.name)}」的模板` : '还没有保存过模板'}
              </div>
            ) : (
              groups.map((group) => (
                <div key={group.type} className="py-0.5">
                  <div className="px-2.5 pb-0.5 pt-1 text-[10px] text-muted-foreground/70">
                    {toolLabel(group.type)}
                  </div>
                  {group.items.map((template) => (
                    <div
                      key={template.name}
                      className="group flex items-center rounded-md hover:bg-accent"
                    >
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => apply(template)}
                        title="应用到当前选中的画线"
                        className="min-w-0 flex-1 truncate px-2.5 py-1.5 text-left text-[12px] text-foreground outline-none"
                      >
                        {template.name}
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(template)}
                        title={
                          pendingDelete === template.name ? '再点一次删除' : '删除模板（需再点一次确认）'
                        }
                        aria-label={`删除模板「${template.name}」`}
                        className={cn(
                          'mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-destructive/10 hover:text-destructive-foreground',
                          pendingDelete === template.name
                            ? 'bg-destructive/10 text-destructive-foreground'
                            : 'text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                        )}
                      >
                        <Trash2 size={12} strokeWidth={1.5} />
                      </button>
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>

          <div className="my-1 h-px bg-border" />
          <label className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[11px] text-muted-foreground hover:bg-accent/60">
            <Checkbox
              checked={asDefault}
              onCheckedChange={(checked) => setAsDefault(checked === true)}
              aria-label="应用时也设为该类型画线的默认样式"
              className="size-3.5"
            />
            套用时设为默认样式
          </label>
        </>
      )}
    </div>
  );
}
