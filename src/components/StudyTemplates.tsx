import { useEffect, useRef, useState } from 'react';
import { Activity, Trash2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useApp } from '../store/useApp';
import { Button } from './ui/button';
import type { IChartWidgetApi } from '../../public/charting_library/charting_library';

const LEGACY_KEY = 'mytrade.studyTemplates';
/** 每个图表槽位一套模板，避免四图布局互相覆盖 */
const storageKey = (slot: string) => `mytrade.studyTemplates:${slot}`;

export interface StudyTemplate {
  name: string;
  /** createStudyTemplate() 的原样结果（不含品种/周期） */
  content: object;
  savedAt: number;
}

type TemplateMap = Record<string, StudyTemplate>;

function parseTemplates(raw: string): TemplateMap {
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === 'object' ? (parsed as TemplateMap) : {};
}

function readTemplates(slot: string): TemplateMap {
  try {
    const raw = window.localStorage.getItem(storageKey(slot));
    if (raw) return parseTemplates(raw);
    if (slot !== 'main') {
      // 模板是不分品种/周期的指标组合：本槽位还没存过时沿用主图那套，
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
    /* 本地存储满/被禁用时不影响图表本身 */
  }
}

function fmtDate(ts: number): string {
  if (!Number.isFinite(ts)) return '';
  return new Date(ts).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

/**
 * 指标模板：把当前图表的指标组合存成命名模板，之后可以套到任意品种/图表。
 * 日常使用不用手动保存——ChartPanel 会按图表自动记住指标；
 * 这里是给「趋势一套、震荡一套」这种需要来回切换的场景用的。
 */
export function StudyTemplates({
  chart,
  slot = 'main',
}: {
  chart: IChartWidgetApi | null;
  slot?: string;
}) {
  const notify = useApp((s) => s.notify);
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<TemplateMap>(() => readTemplates(slot));
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [count, setCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // 槽位变化（例如布局从单图切成四图）时读对应槽位的模板
  useEffect(() => {
    setTemplates(readTemplates(slot));
    setPendingDelete(null);
  }, [slot]);

  const readCount = () => {
    if (!chart) {
      setCount(0);
      return;
    }
    try {
      // Volume 是库自带的默认成交量，不算用户加的指标
      setCount(chart.getAllStudies().filter((item) => item.name !== 'Volume').length);
    } catch {
      setCount(0);
    }
  };

  useEffect(() => {
    readCount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, open]);

  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const list = Object.values(templates).sort((a, b) => b.savedAt - a.savedAt);

  const save = () => {
    if (!chart) return;
    const trimmed = name.trim();
    if (!trimmed) {
      notify('error', '请输入模板名');
      inputRef.current?.focus();
      return;
    }
    try {
      const content = chart.createStudyTemplate({ saveSymbol: false, saveInterval: false });
      const next: TemplateMap = {
        ...templates,
        [trimmed]: { name: trimmed, content, savedAt: Date.now() },
      };
      writeTemplates(slot, next);
      setTemplates(next);
      setName('');
      notify('success', `已保存指标模板「${trimmed}」`);
    } catch (error) {
      notify('error', (error as Error).message || '保存模板失败');
    }
  };

  const apply = (template: StudyTemplate) => {
    if (!chart) return;
    try {
      chart.applyStudyTemplate(template.content);
      readCount();
      setOpen(false);
      notify('success', `已套用指标模板「${template.name}」`);
    } catch (error) {
      notify('error', (error as Error).message || '套用模板失败');
    }
  };

  const remove = (template: StudyTemplate) => {
    // 删除需要两次点击：第一次只进入待确认状态，避免误删
    if (pendingDelete !== template.name) {
      setPendingDelete(template.name);
      window.setTimeout(() => setPendingDelete((prev) => (prev === template.name ? null : prev)), 4000);
      return;
    }
    const next = { ...templates };
    delete next[template.name];
    writeTemplates(slot, next);
    setTemplates(next);
    setPendingDelete(null);
    notify('success', `已删除模板「${template.name}」`);
  };

  return (
    <div
      data-study-templates={slot}
      className="absolute bottom-8 left-[152px] z-30"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Button
        variant={open ? 'secondary' : 'outline'}
        size="sm"
        onClick={() => setOpen((value) => !value)}
        title="指标会自动记住；这里可以把指标组合存成命名模板，随时套用"
        className="h-7 gap-1.5 bg-card/95 px-2 text-[11px] font-normal"
      >
        <Activity size={14} strokeWidth={1.5} />
        指标模板
      </Button>

      {open && (
        <div className="absolute bottom-8 left-0 w-[272px] rounded-xl border border-border bg-popover p-3 shadow-lg/5">
          <div className="mb-2 flex items-center gap-1">
            <span className="text-[12px] font-medium text-foreground">指标模板</span>
            <span className="flex-1" />
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setOpen(false)}
              className="h-6 w-6 text-muted-foreground hover:text-foreground"
              title="关闭"
            >
              <X size={14} strokeWidth={1.5} />
            </Button>
          </div>

          <div className="mb-2 rounded-md bg-muted px-2.5 py-1.5 text-[11px] text-muted-foreground">
            当前图表有 <span className="num font-mono text-foreground">{count}</span> 个指标（不含成交量）
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
              placeholder="模板名，如「趋势组合」"
              className="h-7 min-w-0 flex-1 rounded-lg border border-input bg-background px-2 text-[11px] text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 placeholder:text-muted-foreground/60"
            />
            <Button
              size="sm"
              onClick={save}
              className="h-7 shrink-0 px-2.5 text-[11px]"
            >
              保存
            </Button>
          </div>

          <div className="mt-2 max-h-[210px] overflow-auto">
            {list.length === 0 ? (
              <div className="py-3 text-center text-[11px] text-muted-foreground">
                还没有保存过指标模板
              </div>
            ) : (
              list.map((template) => (
                <div
                  key={template.name}
                  className="group flex items-center gap-1 rounded-md px-1 py-1.5 hover:bg-accent"
                >
                  <button
                    onClick={() => apply(template)}
                    title="把这个指标组合套到当前图表"
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="truncate text-[11px] text-foreground">{template.name}</div>
                    <div className="truncate text-[11px] text-muted-foreground/60">
                      保存于 {fmtDate(template.savedAt)} · 点击套用
                    </div>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => remove(template)}
                    title={pendingDelete === template.name ? '再点一次删除' : '删除模板（需再点一次确认）'}
                    className={cn(
                      'h-6 w-6 shrink-0 hover:bg-destructive/10 hover:text-destructive-foreground',
                      pendingDelete === template.name
                        ? 'bg-destructive/10 text-destructive-foreground'
                        : 'text-muted-foreground opacity-0 group-hover:opacity-100',
                    )}
                  >
                    <Trash2 size={13} strokeWidth={1.5} />
                  </Button>
                </div>
              ))
            )}
          </div>

          <div className="mt-2 border-t border-border pt-2 text-[11px] leading-relaxed text-muted-foreground/60">
            指标会按图表自动保存在本机，重启后恢复；命名模板可以套用到任意品种和其他图表。
          </div>
        </div>
      )}
    </div>
  );
}
