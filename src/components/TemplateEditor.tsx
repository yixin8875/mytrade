import { useEffect, useState } from 'react';
import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useApp } from '../store/useApp';
import {
  DEFAULT_TEMPLATE,
  MAX_TEMPLATE_STEPS,
  fmtNum,
  normalizeTemplateSteps,
} from '../lib/template';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { SegmentedControl, SegmentedControlItem } from './ui/segmented-control';
import { Switch } from './ui/switch';
import type { TemplateStep } from '../gateway/types';

type Tone = 'console' | 'tv';

/** 设置页与下单票弹层共用；两侧都使用语义 token，密度保持一致 */
const TONES: Record<
  Tone,
  {
    field: string;
    label: string;
    ink: string;
    muted: string;
    secondary: string;
    card: string;
    numbered: string;
    dashed: string;
    divider: string;
  }
> = {
  console: {
    field:
      'h-8 rounded-lg border border-input bg-background px-2 font-mono text-[12px] text-foreground outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25',
    label: 'text-[11px] text-muted-foreground',
    ink: 'text-foreground',
    muted: 'text-muted-foreground',
    secondary: 'text-foreground/70',
    card: 'rounded-lg border border-border bg-muted/60',
    numbered: 'bg-muted text-foreground/70',
    dashed: 'border border-dashed border-border',
    divider: 'border-border',
  },
  tv: {
    field:
      'h-8 rounded-lg border border-input bg-muted px-2 font-mono text-[12px] text-foreground outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25',
    label: 'text-[11px] text-muted-foreground',
    ink: 'text-foreground',
    muted: 'text-muted-foreground',
    secondary: 'text-foreground/70',
    card: 'rounded-lg border border-border bg-muted/70',
    numbered: 'bg-border/60 text-foreground/70',
    dashed: 'border border-dashed border-border',
    divider: 'border-border',
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
  const setAutoApply = useApp((s) => s.setAutoApply);
  const currency = useApp((s) => s.account?.currency ?? '');
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

  const commitReward = (raw: string, input: HTMLInputElement) => {
    const value = Number(raw);
    const next =
      raw.trim() === '' || !Number.isFinite(value)
        ? template.rewardR
        : Math.min(50, Math.max(0, value));
    updateTemplate(template.id, { rewardR: next });
    input.value = fmtNum(next);
  };

  /** 风险按当前口径写回：百分比存 riskPercent，固定金额存 riskAmount */
  const commitRisk = (raw: string, input: HTMLInputElement) => {
    const isAmount = template.riskMode === 'amount';
    const current = isAmount ? template.riskAmount : template.riskPercent;
    const value = Number(raw);
    const next =
      raw.trim() === '' || !Number.isFinite(value)
        ? current
        : Math.min(isAmount ? 1_000_000_000 : 100, Math.max(0.01, value));
    updateTemplate(template.id, isAmount ? { riskAmount: next } : { riskPercent: next });
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
        <span className={cn('mb-1.5 block', styles.label)}>模板名</span>
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
          className={cn(styles.field, 'w-full font-sans')}
        />
      </label>

      <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
        <div className="min-w-0">
          <div className={cn('text-[12px]', styles.ink)}>下单默认启用</div>
          <div className={cn('mt-0.5 text-[11px] leading-relaxed', styles.muted)}>
            新开单直接带入这个模板的风险、止盈和阶段；同时只能有一个默认模板。
          </div>
        </div>
        <Switch
          checked={template.autoApply}
          onCheckedChange={(value) => setAutoApply(value ? template.id : null)}
          aria-label="下单默认启用"
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <span className={styles.label}>单笔风险</span>
        <SegmentedControl size="sm" className="h-7">
          {(
            [
              ['percent', '净值 %'],
              ['amount', '固定金额'],
            ] as const
          ).map(([value, label]) => (
            <SegmentedControlItem
              key={value}
              onClick={() => updateTemplate(template.id, { riskMode: value })}
              data-checked={template.riskMode === value ? '' : undefined}
              aria-pressed={template.riskMode === value}
              className="h-6 px-2 text-[11px]"
            >
              {label}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className={cn('mb-1.5 block', styles.label)}>
            {template.riskMode === 'amount' ? '单笔亏损' : '风险比例'}
          </span>
          <div className="flex items-center gap-1.5">
            <input
              key={`${template.id}-risk-${template.riskMode}`}
              type="number"
              min={0.01}
              step={template.riskMode === 'amount' ? 10 : 0.1}
              defaultValue={fmtNum(
                template.riskMode === 'amount' ? template.riskAmount : template.riskPercent,
              )}
              onBlur={(event) => commitRisk(event.currentTarget.value, event.currentTarget)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
              className={cn(styles.field, 'w-full text-right')}
            />
            <span className={cn('shrink-0', styles.muted)}>
              {template.riskMode === 'amount' ? currency || '金额' : '%'}
            </span>
          </div>
        </label>
        <label className="block">
          <span className={cn('mb-1.5 block', styles.label)}>最终止盈</span>
          <div className="flex items-center gap-1.5">
            <input
              key={`${template.id}-reward`}
              type="number"
              min={0}
              max={50}
              step={0.1}
              defaultValue={fmtNum(template.rewardR)}
              onBlur={(event) => commitReward(event.currentTarget.value, event.currentTarget)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
              className={cn(styles.field, 'w-full text-right')}
            />
            <span className={cn('shrink-0', styles.muted)}>R</span>
          </div>
        </label>
      </div>

      {template.riskMode === 'amount' && !compact && (
        <p className={cn('text-[11px] leading-relaxed', styles.muted)}>
          固定亏损按账户货币计：启用后手数由「亏损金额 ÷ 止损距离」反算。
        </p>
      )}

      <div className={cn('border-t pt-3', styles.divider)}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className={cn('text-[12px]', styles.ink)}>分批止盈</div>
            {!compact && (
              <div className={cn('mt-1 text-[11px] leading-relaxed', styles.muted)}>
                到某个 R 时平掉当时剩余仓位的一部分，再按需把止损移到开仓价；按 R 从小到大执行。
              </div>
            )}
          </div>
          <Button
            variant="outline"
            size="xs"
            onClick={addStep}
            disabled={template.steps.length >= MAX_TEMPLATE_STEPS}
            title={
              template.steps.length >= MAX_TEMPLATE_STEPS
                ? `最多 ${MAX_TEMPLATE_STEPS} 个阶段`
                : '添加一个阶段'
            }
            className="h-7 shrink-0 gap-1 px-2.5 text-[11px] font-normal"
          >
            <Plus size={12} strokeWidth={1.8} className="size-3" />
            添加阶段
          </Button>
        </div>

        <div className={cn('mt-3', compact ? 'space-y-1.5' : 'space-y-2')}>
          {drafts.map((draft, index) => (
            <div
              key={draft.key}
              className={cn(
                'flex flex-wrap items-center gap-2 px-2.5',
                styles.card,
                compact ? 'py-1.5' : 'py-2',
              )}
            >
              <span
                className={cn(
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
                className={cn(styles.field, 'w-14 text-right')}
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
                className={cn(styles.field, 'w-14 text-right')}
              />
              <span className={styles.muted}>%</span>
              <label className={cn('flex items-center gap-1.5', styles.secondary)}>
                <Checkbox
                  checked={draft.moveBreakeven}
                  onCheckedChange={(checked) => toggleBreakeven(index, checked === true)}
                  aria-label="移到开仓价"
                  className="size-3.5"
                />
                移到开仓价
              </label>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => removeStep(index)}
                title="删除阶段"
                aria-label="删除阶段"
                className="ml-auto h-6 w-6 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive-foreground"
              >
                <Trash2 size={13} strokeWidth={1.6} />
              </Button>
            </div>
          ))}
          {!template.steps.length && (
            <div
              className={cn(
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
          <span className={cn('text-[11px]', styles.muted)}>
            最多 {MAX_TEMPLATE_STEPS} 个阶段，按 R 自动排序
          </span>
          <Button
            variant="outline"
            size="xs"
            onClick={() =>
              updateTemplate(template.id, {
                riskMode: DEFAULT_TEMPLATE.riskMode,
                riskPercent: DEFAULT_TEMPLATE.riskPercent,
                riskAmount: DEFAULT_TEMPLATE.riskAmount,
                rewardR: DEFAULT_TEMPLATE.rewardR,
                steps: DEFAULT_TEMPLATE.steps,
              })
            }
            className="h-7 gap-1 px-2.5 text-[11px] font-normal"
            title="恢复为 0.5% / 2R / 1R 保本"
          >
            <RotateCcw size={12} strokeWidth={1.7} className="size-3" />
            恢复默认
          </Button>
        </div>
      </div>
    </div>
  );
}
