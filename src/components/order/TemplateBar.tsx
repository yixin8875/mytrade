import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Pencil, Plus, Settings2, Star } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fmtMoney, fmtPrice } from '../../lib/format';
import { fmtNum, templateSummary } from '../../lib/template';
import type { RiskSettings, TradeSizing, TradeTemplate } from '../../gateway/types';
import { Button } from '../ui/button';
import { TemplateEditor } from '../TemplateEditor';

export function TemplateBar({
  template,
  templates,
  armed,
  summary,
  steps,
  planTitle,
  tpTarget,
  tpManual,
  risk,
  riskDeviated,
  paused,
  readonly,
  pending,
  sizing,
  currency,
  digits,
  disabled,
  onApply,
  onSelect,
  onCreate,
  onOpenSettings,
  onToggleDefault,
  onRestoreRisk,
  onUseTemplateTp,
}: {
  template: TradeTemplate;
  templates: TradeTemplate[];
  armed: boolean;
  summary: string;
  steps: string;
  planTitle: string;
  tpTarget: number | null;
  tpManual: boolean;
  risk: RiskSettings;
  riskDeviated: boolean;
  paused: boolean;
  readonly: boolean;
  pending: boolean;
  sizing: TradeSizing | null;
  currency: string;
  digits: number;
  disabled: boolean;
  onApply: () => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onOpenSettings: () => void;
  /** 把当前模板设为/取消「下单默认启用」 */
  onToggleDefault: () => void;
  onRestoreRisk: () => void;
  onUseTemplateTp: () => void;
}) {
  /** 下拉与票内编辑弹层互斥；点外部或 Esc 关闭 */
  const [templateMenu, setTemplateMenu] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const templateWrapRef = useRef<HTMLDivElement>(null);

  // 点模板栏外面关闭下拉/编辑器；点栏内的输入框不关闭
  useEffect(() => {
    if (!templateMenu && !editorOpen) return;
    const onDown = (event: MouseEvent) => {
      if (templateWrapRef.current?.contains(event.target as Node)) return;
      setTemplateMenu(false);
      setEditorOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [templateMenu, editorOpen]);

  // Esc 只关闭模板下拉/编辑器，不取消草稿。
  // 全局快捷键监听在 window 上，这里挂 document 捕获阶段，先截住事件。
  useEffect(() => {
    if (!templateMenu && !editorOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setTemplateMenu(false);
      setEditorOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [templateMenu, editorOpen]);

  return (
    <div className="relative" ref={templateWrapRef}>
      <div className="flex gap-1.5">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setTemplateMenu((open) => !open);
            setEditorOpen(false);
          }}
          title={planTitle}
          aria-haspopup="listbox"
          aria-expanded={templateMenu}
          className={cn(
            'h-9 min-w-0 flex-1 justify-start gap-1.5 rounded-lg px-2.5 text-left font-normal',
            armed && 'border-brand/40 bg-brand/10 hover:bg-brand/10',
          )}
        >
          <span className="min-w-0 flex-1">
            <span
              className={cn(
                'block truncate text-[12px] font-medium',
                armed ? 'text-brand' : 'text-foreground',
              )}
            >
              {template.name}
            </span>
            <span className="block truncate text-[10px] text-muted-foreground">{summary}</span>
          </span>
          <ChevronDown
            size={13}
            strokeWidth={1.8}
            className={cn('shrink-0', armed ? 'text-brand/70' : 'text-muted-foreground')}
          />
        </Button>
        <Button
          variant={armed ? 'default' : 'outline'}
          size="sm"
          onClick={onApply}
          disabled={disabled}
          aria-pressed={armed}
          title={
            armed
              ? '停用模板：已填入的风险、手数与止损止盈保持不变'
              : '启用模板：带入风险比例、止盈与阶段计划'
          }
          className="h-9 w-[62px] shrink-0 text-[12px]"
        >
          {armed ? '已启用' : '启用'}
        </Button>
        <Button
          variant={editorOpen ? 'secondary' : 'outline'}
          size="icon-sm"
          onClick={() => {
            setEditorOpen((open) => !open);
            setTemplateMenu(false);
          }}
          title="编辑当前模板：风险 %、止盈 R、分批止盈"
          aria-label="编辑当前模板"
          className="h-9 w-9 shrink-0"
        >
          <Pencil size={13} strokeWidth={1.7} />
        </Button>
      </div>

      {templateMenu && (
        <div
          data-modal
          className="absolute left-0 right-0 top-full z-30 mt-1 rounded-lg border border-border bg-popover p-1 shadow-lg/5"
        >
          <div className="max-h-56 overflow-y-auto">
            {templates.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  setTemplateMenu(false);
                  onSelect(item.id);
                }}
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
              >
                <Check
                  size={13}
                  strokeWidth={2}
                  className={cn(
                    'mt-0.5 shrink-0',
                    item.id === template.id ? 'text-brand' : 'text-transparent',
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-[12px] text-foreground">
                    <span className="truncate">{item.name}</span>
                    {item.autoApply && (
                      <span className="shrink-0 rounded bg-brand/10 px-1 py-px text-[10px] text-brand">
                        默认
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {templateSummary(item, currency)}
                  </span>
                </span>
              </button>
            ))}
          </div>
          <div className="my-1 border-t border-border" />
          <button
            onClick={() => {
              setTemplateMenu(false);
              onCreate();
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Plus size={13} strokeWidth={1.8} />
            新建模板
          </button>
          <button
            onClick={() => {
              setTemplateMenu(false);
              onToggleDefault();
            }}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-accent hover:text-foreground',
              template.autoApply ? 'text-brand' : 'text-muted-foreground',
            )}
          >
            <Star
              size={13}
              strokeWidth={1.6}
              fill={template.autoApply ? 'currentColor' : 'none'}
            />
            {template.autoApply ? '取消下单默认启用' : '设为下单默认启用'}
          </button>
          <button
            onClick={() => {
              setTemplateMenu(false);
              setEditorOpen(false);
              onOpenSettings();
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Settings2 size={13} strokeWidth={1.6} />
            管理模板（设置页）
          </button>
        </div>
      )}

      {editorOpen && (
        <div
          data-modal
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-[70vh] overflow-y-auto rounded-xl border border-border bg-popover p-3 shadow-lg/5"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="truncate text-[12px] font-medium text-foreground">
              编辑「{template.name}」
            </span>
            <Button
              variant="outline"
              size="xs"
              onClick={() => setEditorOpen(false)}
              className="h-6 shrink-0 px-2 text-[11px] font-normal"
            >
              完成
            </Button>
          </div>
          <TemplateEditor templateId={template.id} tone="tv" compact />
        </div>
      )}

      {armed && (
        <div className="mt-3 rounded-lg border border-brand/25 bg-brand/5 px-2.5 py-2 text-[11px] leading-relaxed">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[12px] font-medium text-brand">{template.name}</span>
            <span className="shrink-0 text-muted-foreground">{summary}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
            <span>
              风险{' '}
              {risk.mode === 'percent'
                ? `${fmtNum(risk.value)}%`
                : `固定 ${fmtMoney(risk.value)}${currency}`}
              {risk.mode === 'percent' && sizing
                ? ` ≈ ${fmtMoney(sizing.targetRisk)}${currency}`
                : ''}
            </span>
            {tpTarget != null ? (
              <span>
                止盈 {fmtNum(template.rewardR)}R @ {fmtPrice(tpTarget, digits)}
              </span>
            ) : (
              <span>不自动设止盈</span>
            )}
          </div>
          <div className="mt-0.5 text-muted-foreground">{steps}</div>
          {pending && <div className="mt-0.5 text-muted-foreground">挂单成交后自动登记阶段计划</div>}
          {paused && (
            <div className="mt-0.5 text-warning-foreground">
              阶段已暂停：{readonly ? '只读模式' : '风控急停'}，恢复可交易后继续
            </div>
          )}
          {riskDeviated && (
            <div className="mt-1 flex items-center justify-between gap-2 text-warning-foreground">
              <span>
                已偏离模板：风险{' '}
                {risk.mode === 'percent'
                  ? `${fmtNum(risk.value)}%`
                  : `固定 ${fmtMoney(risk.value)}`}
                {risk.auto ? '' : ' · 手动手数'}
              </span>
              <Button
                variant="outline"
                size="xs"
                onClick={onRestoreRisk}
                className="h-auto shrink-0 rounded border-warning/40 bg-transparent px-1.5 py-0.5 text-[10px] font-normal text-warning-foreground hover:bg-warning/12"
              >
                恢复
              </Button>
            </div>
          )}
          {tpManual && tpTarget != null && (
            <div className="mt-1 flex items-center justify-between gap-2 text-warning-foreground">
              <span>止盈已手动调整（模板 {fmtPrice(tpTarget, digits)}）</span>
              <Button
                variant="outline"
                size="xs"
                onClick={onUseTemplateTp}
                className="h-auto shrink-0 rounded border-warning/40 bg-transparent px-1.5 py-0.5 text-[10px] font-normal text-warning-foreground hover:bg-warning/12"
              >
                用模板止盈
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
