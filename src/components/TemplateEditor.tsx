import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useApp } from '../store/useApp';
import {
  DEFAULT_TEMPLATE,
  MAX_TEMPLATE_STEPS,
  fmtNum,
  normalizeTemplateSteps,
} from '../lib/template';
import type { TemplateStep } from '../gateway/types';

type Tone = 'console' | 'tv';

/** 设置页用暖纸（console），下单票弹层用冷光（tv）；结构与行为完全一致 */
const TONES: Record<
  Tone,
  {
    field: string;
    label: string;
    ink: string;
    muted: string;
    secondary: string;
    card: string;
    button: string;
    danger: string;
    check: string;
    numbered: string;
    dashed: string;
    divider: string;
  }
> = {
  console: {
    field:
      'h-8 rounded-lg border border-console-line bg-console-canvas px-2 font-mono text-[12px] text-console-ink outline-none transition-colors focus:border-console-accent',
    label: 'text-[11px] text-console-muted',
    ink: 'text-console-ink',
    muted: 'text-console-muted',
    secondary: 'text-console-ink-2',
    card: 'rounded-lg border border-console-line bg-console-canvas/60',
    button:
      'h-7 rounded-lg border border-console-line bg-console-card px-2.5 text-[11px] text-console-ink-2 transition-colors hover:bg-console-hover hover:text-console-ink disabled:cursor-not-allowed disabled:opacity-40',
    danger: 'hover:bg-console-hover hover:text-console-loss',
    check: 'accent-[var(--color-console-accent)]',
    numbered: 'bg-console-selected text-console-ink-2',
    dashed: 'border border-dashed border-console-line',
    divider: 'border-console-line',
  },
  tv: {
    field:
      'h-8 rounded-lg border border-tv-border bg-tv-raised px-2 font-mono text-[12px] text-tv-text outline-none transition-colors focus:border-tv-accent focus:bg-tv-panel',
    label: 'text-[11px] text-tv-muted',
    ink: 'text-tv-text',
    muted: 'text-tv-muted',
    secondary: 'text-tv-text/70',
    card: 'rounded-lg border border-tv-border bg-tv-raised/70',
    button:
      'h-7 rounded-lg border border-tv-border bg-tv-panel px-2.5 text-[11px] text-tv-muted transition-colors hover:bg-tv-hover hover:text-tv-text disabled:cursor-not-allowed disabled:opacity-40',
    danger: 'hover:bg-tv-hover hover:text-tv-down',
    check: 'accent-[var(--color-tv-accent)]',
    numbered: 'bg-tv-border/60 text-tv-text/70',
    dashed: 'border border-dashed border-tv-border',
    divider: 'border-tv-border',
  },
};

interface StepDraft {
  /** 稳定 key，重新排序时 React 不会把输入框换到另一行 */
  key: string;
  atR: string;
  closePercent: string;
  moveBreakeven: boolean;
}

let draftSeq = 0;

function nextKey(): string {
  draftSeq += 1;
  try {
    return `${crypto.randomUUID()}-${draftSeq}`;
  } catch {
    return `step-${Date.now()}-${draftSeq}`;
  }
}

function toDrafts(steps: TemplateStep[]): StepDraft[] {
  return steps.map((step) => ({
    key: nextKey(),
    atR: fmtNum(step.atR),
    closePercent: step.closePercent == null ? '' : fmtNum(step.closePercent),
    moveBreakeven: step.moveBreakeven,
  }));
}

interface TemplateEditorProps {
  /** 编辑哪个模板；缺省为当前选中的模板 */
  templateId?: string;
  tone?: Tone;
  /** 下单票弹层里用紧凑排版 */
  compact?: boolean;
}

/**
 * 模板编辑器：设置页与下单票弹层共用。
 *
 * 阶段输入先写本地 draft，失焦 / 回车才提交；提交后从 store 回读清洗过的
 * 结果重建 draft。这样改 atR 触发重新排序时，正在编辑的行不会被换掉。
 */
export function TemplateEditor({
  templateId,
  tone = 'console',
  compact = false,
}: TemplateEditorProps) {
  const templates = useApp((s) => s.templates);
  const activeTemplateId = useApp((s) => s.activeTemplateId);
  const updateTemplate = useApp((s) => s.updateTemplate);
  const template =
    templates.find((item) => item.id === (templateId ?? activeTemplateId)) ?? templates[0];

  const styles = TONES[tone];
  const signature = template.steps
    .map((step) => `${step.atR}|${step.closePercent ?? ''}|${step.moveBreakeven}`)
    .join(',');
  const [drafts, setDrafts] = useState<StepDraft[]>(() => toDrafts(template.steps));

  useEffect(() => {
    setDrafts(toDrafts(template.steps));
    // 只在模板或阶段内容真正变化时重建；draft 本身不参与比较
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template.id, signature]);

  const commitNumber = (
    field: 'riskPercent' | 'rewardR',
    raw: string,
    input: HTMLInputElement,
  ) => {
    const value = Number(raw);
    const [min, max] = field === 'riskPercent' ? [0.01, 100] : [0, 50];
    const next =
      raw.trim() === '' || !Number.isFinite(value)
        ? template[field]
        : Math.min(max, Math.max(min, value));
    updateTemplate(template.id, { [field]: next });
    input.value = fmtNum(next);
  };

  const commitAtR = (index: number, raw: string, input: HTMLInputElement) => {
    const current = template.steps[index];
    const value = Number(raw);
    if (!current || raw.trim() === '' || !Number.isFinite(value) || value <= 0) {
      input.value = fmtNum(current?.atR ?? 1);
      return;
    }
    const atR = Math.min(100, value);
    updateTemplate(template.id, {
      steps: template.steps.map((step, i) => (i === index ? { ...step, atR } : step)),
    });
    input.value = fmtNum(atR);
  };

  const commitClosePercent = (index: number, raw: string, input: HTMLInputElement) => {
    const current = template.steps[index];
    if (!current) return;
    const trimmed = raw.trim();
    if (trimmed === '') {
      updateTemplate(template.id, {
        steps: template.steps.map((step, i) =>
          i === index ? { ...step, closePercent: null } : step,
        ),
      });
      input.value = '';
      return;
    }
    const value = Number(trimmed);
    if (!Number.isFinite(value)) {
      input.value = current.closePercent == null ? '' : fmtNum(current.closePercent);
      return;
    }
    const closePercent = Math.min(99, Math.max(1, value));
    updateTemplate(template.id, {
      steps: template.steps.map((step, i) => (i === index ? { ...step, closePercent } : step)),
    });
    input.value = fmtNum(closePercent);
  };

  const toggleBreakeven = (index: number, moveBreakeven: boolean) => {
    updateTemplate(template.id, {
      steps: template.steps.map((step, i) => (i === index ? { ...step, moveBreakeven } : step)),
    });
  };

  const addStep = () => {
    const last = template.steps[template.steps.length - 1];
    const steps = normalizeTemplateSteps([
      ...template.steps,
      { atR: last ? last.atR + 1 : 1, closePercent: 50, moveBreakeven: true },
    ]);
    updateTemplate(template.id, { steps });
  };

  const removeStep = (index: number) => {
    updateTemplate(template.id, {
      steps: template.steps.filter((_, i) => i !== index),
    });
  };

  return (
    <div className="space-y-3">
      <label className="block">
        <span className={clsx('mb-1.5 block', styles.label)}>模板名</span>
        <input
          value={template.name}
          maxLength={24}
          onChange={(event) => {
            const name = event.target.value;
            if (name.length <= 24) updateTemplate(template.id, { name });
          }}
          onBlur={(event) => {
            const name = event.target.value.trim();
            updateTemplate(template.id, { name: name || template.name });
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
          className={clsx(styles.field, 'w-full font-sans')}
        />
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className={clsx('mb-1.5 block', styles.label)}>单笔风险</span>
          <div className="flex items-center gap-1.5">
            <input
              key={`${template.id}-risk`}
              type="number"
              min={0.01}
              max={100}
              step={0.1}
              defaultValue={fmtNum(template.riskPercent)}
              onBlur={(event) =>
                commitNumber('riskPercent', event.currentTarget.value, event.currentTarget)
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
              className={clsx(styles.field, 'w-full text-right')}
            />
            <span className={clsx('shrink-0', styles.muted)}>%</span>
          </div>
        </label>
        <label className="block">
          <span className={clsx('mb-1.5 block', styles.label)}>最终止盈</span>
          <div className="flex items-center gap-1.5">
            <input
              key={`${template.id}-reward`}
              type="number"
              min={0}
              max={50}
              step={0.1}
              defaultValue={fmtNum(template.rewardR)}
              onBlur={(event) =>
                commitNumber('rewardR', event.currentTarget.value, event.currentTarget)
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
              className={clsx(styles.field, 'w-full text-right')}
            />
            <span className={clsx('shrink-0', styles.muted)}>R</span>
          </div>
        </label>
      </div>

      <div className={clsx('border-t pt-3', styles.divider)}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className={clsx('text-[12px]', styles.ink)}>分批止盈</div>
            {!compact && (
              <div className={clsx('mt-1 text-[11px] leading-relaxed', styles.muted)}>
                到某个 R 时平掉当时剩余仓位的一部分，再按需把止损移到开仓价；按 R 从小到大执行。
              </div>
            )}
          </div>
          <button
            onClick={addStep}
            disabled={template.steps.length >= MAX_TEMPLATE_STEPS}
            title={
              template.steps.length >= MAX_TEMPLATE_STEPS
                ? `最多 ${MAX_TEMPLATE_STEPS} 个阶段`
                : '添加一个阶段'
            }
            className={clsx(styles.button, 'flex shrink-0 items-center gap-1')}
          >
            <Plus size={12} strokeWidth={1.8} />
            添加阶段
          </button>
        </div>

        <div className={clsx('mt-3', compact ? 'space-y-1.5' : 'space-y-2')}>
          {drafts.map((draft, index) => (
            <div
              key={draft.key}
              className={clsx(
                'flex flex-wrap items-center gap-2 px-2.5',
                styles.card,
                compact ? 'py-1.5' : 'py-2',
              )}
            >
              <span
                className={clsx(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px]',
                  styles.numbered,
                )}
              >
                {index + 1}
              </span>
              <input
                type="number"
                min={0.1}
                max={100}
                step={0.1}
                value={draft.atR}
                title="触发倍数：1R = 入场到止损的距离"
                onChange={(event) => {
                  const value = event.target.value;
                  setDrafts((list) =>
                    list.map((item) => (item.key === draft.key ? { ...item, atR: value } : item)),
                  );
                }}
                onBlur={(event) => commitAtR(index, event.currentTarget.value, event.currentTarget)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
                className={clsx(styles.field, 'w-14 text-right')}
              />
              <span className={styles.muted}>R 时平</span>
              <input
                type="number"
                min={1}
                max={99}
                step={5}
                value={draft.closePercent}
                placeholder="—"
                title="平掉当时剩余仓位的百分比；留空 = 只动止损"
                onChange={(event) => {
                  const value = event.target.value;
                  setDrafts((list) =>
                    list.map((item) =>
                      item.key === draft.key ? { ...item, closePercent: value } : item,
                    ),
                  );
                }}
                onBlur={(event) =>
                  commitClosePercent(index, event.currentTarget.value, event.currentTarget)
                }
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
                className={clsx(styles.field, 'w-14 text-right')}
              />
              <span className={styles.muted}>%</span>
              <label className={clsx('flex items-center gap-1.5', styles.secondary)}>
                <input
                  type="checkbox"
                  checked={draft.moveBreakeven}
                  onChange={(event) => toggleBreakeven(index, event.target.checked)}
                  className={clsx('h-3.5 w-3.5', styles.check)}
                />
                移到开仓价
              </label>
              <button
                onClick={() => removeStep(index)}
                title="删除阶段"
                aria-label="删除阶段"
                className={clsx(
                  'ml-auto flex h-6 w-6 items-center justify-center rounded-md transition-colors',
                  styles.muted,
                  styles.danger,
                )}
              >
                <Trash2 size={13} strokeWidth={1.6} />
              </button>
            </div>
          ))}
          {!template.steps.length && (
            <div
              className={clsx(
                'px-3 py-2.5 text-[11px] leading-relaxed',
                styles.dashed,
                styles.muted,
              )}
            >
              还没有阶段：成交后不自动平仓，也不移动止损。
            </div>
          )}
        </div>

        <div className="mt-3 flex items-center justify-between gap-2">
          <span className={clsx('text-[11px]', styles.muted)}>
            最多 {MAX_TEMPLATE_STEPS} 个阶段，按 R 自动排序
          </span>
          <button
            onClick={() =>
              updateTemplate(template.id, {
                riskPercent: DEFAULT_TEMPLATE.riskPercent,
                rewardR: DEFAULT_TEMPLATE.rewardR,
                steps: DEFAULT_TEMPLATE.steps,
              })
            }
            className={clsx(styles.button, 'flex items-center gap-1')}
            title="恢复为 0.5% / 2R / 1R 保本"
          >
            <RotateCcw size={12} strokeWidth={1.7} />
            恢复默认
          </button>
        </div>
      </div>
    </div>
  );
}
