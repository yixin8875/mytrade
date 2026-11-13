import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { Activity, Trash2, X } from 'lucide-react';
import { useApp } from '../store/useApp';
import type { IChartWidgetApi } from '../../public/charting_library/charting_library';

const STORAGE_KEY = 'mytrade.studyTemplates';

export interface StudyTemplate {
  name: string;
  /** createStudyTemplate() 的原样结果（不含品种/周期） */
  content: object;
  savedAt: number;
}

type TemplateMap = Record<string, StudyTemplate>;

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
  const [templates, setTemplates] = useState<TemplateMap>(() => readTemplates());
  const [name, setName] = useState('');
  const [count, setCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

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
      writeTemplates(next);
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
    const next = { ...templates };
    delete next[template.name];
    writeTemplates(next);
    setTemplates(next);
    notify('success', `已删除模板「${template.name}」`);
  };

  return (
    <div
      data-study-templates={slot}
      className="absolute bottom-8 left-[152px] z-30"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        onClick={() => setOpen((value) => !value)}
        title="指标会自动记住；这里可以把指标组合存成命名模板，随时套用"
        className={clsx(
          'flex h-7 select-none items-center gap-1.5 rounded-lg border border-tv-border px-2 text-[11px] transition-colors',
          open
            ? 'bg-tv-hover text-tv-text'
            : 'bg-tv-panel/95 text-tv-muted hover:text-tv-text',
        )}
      >
        <Activity size={14} strokeWidth={1.5} />
        指标模板
      </button>

      {open && (
        <div className="absolute bottom-8 left-0 w-[272px] rounded-xl border border-tv-border bg-tv-panel p-3 shadow-[0_18px_48px_-16px_rgba(0,0,0,0.35)]">
          <div className="mb-2 flex items-center gap-1">
            <span className="text-[12px] font-medium text-tv-text">指标模板</span>
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
            当前图表有 <span className="num font-mono text-tv-text">{count}</span> 个指标（不含成交量）
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
              className="h-7 min-w-0 flex-1 rounded-lg border border-tv-border bg-tv-raised px-2 text-[11px] text-tv-text outline-none focus:border-tv-accent"
            />
            <button
              onClick={save}
              className="h-7 shrink-0 rounded-lg bg-tv-text px-2.5 text-[11px] font-medium text-tv-bg transition-opacity hover:opacity-90"
            >
              保存
            </button>
          </div>

          <div className="mt-2 max-h-[210px] overflow-auto">
            {list.length === 0 ? (
              <div className="py-3 text-center text-[11px] text-tv-muted">
                还没有保存过指标模板
              </div>
            ) : (
              list.map((template) => (
                <div
                  key={template.name}
                  className="group flex items-center gap-1 rounded-md px-1 py-1.5 hover:bg-tv-hover"
                >
                  <button
                    onClick={() => apply(template)}
                    title="把这个指标组合套到当前图表"
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="truncate text-[11px] text-tv-text">{template.name}</div>
                    <div className="truncate text-[11px] text-tv-faint">
                      保存于 {fmtDate(template.savedAt)} · 点击套用
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
            指标会按图表自动保存在本机，重启后恢复；命名模板可以套用到任意品种和其他图表。
          </div>
        </div>
      )}
    </div>
  );
}
