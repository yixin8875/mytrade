import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { Check, ChevronDown, Pencil, Plus, Settings2 } from 'lucide-react';
import { fmtMoney, fmtPrice } from '../../lib/format';
import { fmtNum, templateSummary } from '../../lib/template';
import type { RiskSettings, TradeSizing, TradeTemplate } from '../../gateway/types';
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
        <button
          onClick={() => {
            setTemplateMenu((open) => !open);
            setEditorOpen(false);
          }}
          title={planTitle}
          aria-haspopup="listbox"
          aria-expanded={templateMenu}
          className={clsx(
            'flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-lg border px-2.5 text-left transition-colors',
            armed
              ? 'border-tv-accent/40 bg-tv-accent-soft'
              : 'border-tv-border bg-tv-panel hover:bg-tv-hover',
          )}
        >
          <span className="min-w-0 flex-1">
            <span
              className={clsx(
                'block truncate text-[12px] font-medium',
                armed ? 'text-tv-accent' : 'text-tv-text',
              )}
            >
              {template.name}
            </span>
            <span className="block truncate text-[10px] text-tv-muted">{summary}</span>
          </span>
          <ChevronDown
            size={13}
            strokeWidth={1.8}
            className={clsx('shrink-0', armed ? 'text-tv-accent/70' : 'text-tv-muted')}
          />
        </button>
        <button
          onClick={onApply}
          disabled={disabled}
          title={
            armed
              ? '停用模板：已填入的风险、手数与止损止盈保持不变'
              : '启用模板：带入风险比例、止盈与阶段计划'
          }
          className={clsx(
            'h-9 w-[62px] shrink-0 rounded-lg border text-[12px] transition-colors',
            armed
              ? 'border-tv-accent bg-tv-accent text-white hover:bg-tv-accent/90'
              : 'border-tv-border bg-tv-panel text-tv-text hover:bg-tv-hover',
            disabled && 'cursor-not-allowed opacity-40',
          )}
        >
          {armed ? '已启用' : '启用'}
        </button>
        <button
          onClick={() => {
            setEditorOpen((open) => !open);
            setTemplateMenu(false);
          }}
          title="编辑当前模板：风险 %、止盈 R、分批止盈"
          aria-label="编辑当前模板"
          className={clsx(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors',
            editorOpen
              ? 'border-tv-accent/40 bg-tv-accent-soft text-tv-accent'
              : 'border-tv-border bg-tv-panel text-tv-muted hover:bg-tv-hover hover:text-tv-text',
          )}
        >
          <Pencil size={13} strokeWidth={1.7} />
        </button>
      </div>

      {templateMenu && (
        <div
          data-modal
          className="absolute left-0 right-0 top-full z-30 mt-1 rounded-lg border border-tv-border bg-tv-panel p-1 shadow-[0_12px_32px_rgba(20,30,45,0.16)]"
        >
          <div className="max-h-56 overflow-y-auto">
            {templates.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  setTemplateMenu(false);
                  onSelect(item.id);
                }}
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-tv-hover"
              >
                <Check
                  size={13}
                  strokeWidth={2}
                  className={clsx(
                    'mt-0.5 shrink-0',
                    item.id === template.id ? 'text-tv-accent' : 'text-transparent',
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] text-tv-text">{item.name}</span>
                  <span className="block truncate text-[10px] text-tv-muted">
                    {templateSummary(item)}
                  </span>
                </span>
              </button>
            ))}
          </div>
          <div className="my-1 border-t border-tv-border" />
          <button
            onClick={() => {
              setTemplateMenu(false);
              onCreate();
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-tv-muted transition-colors hover:bg-tv-hover hover:text-tv-text"
          >
            <Plus size={13} strokeWidth={1.8} />
            新建模板
          </button>
          <button
            onClick={() => {
              setTemplateMenu(false);
              setEditorOpen(false);
              onOpenSettings();
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-tv-muted transition-colors hover:bg-tv-hover hover:text-tv-text"
          >
            <Settings2 size={13} strokeWidth={1.6} />
            管理模板（设置页）
          </button>
        </div>
      )}

      {editorOpen && (
        <div
          data-modal
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-[70vh] overflow-y-auto rounded-xl border border-tv-border bg-tv-panel p-3 shadow-[0_16px_48px_rgba(20,30,45,0.18)]"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="truncate text-[12px] font-medium text-tv-text">
              编辑「{template.name}」
            </span>
            <button
              onClick={() => setEditorOpen(false)}
              className="h-6 shrink-0 rounded-md border border-tv-border px-2 text-[11px] text-tv-muted transition-colors hover:bg-tv-hover hover:text-tv-text"
            >
              完成
            </button>
          </div>
          <TemplateEditor templateId={template.id} tone="tv" compact />
        </div>
      )}

      {armed && (
        <div className="mt-3 rounded-lg border border-tv-accent/25 bg-tv-accent-soft/50 px-2.5 py-2 text-[11px] leading-relaxed">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[12px] font-medium text-tv-accent">{template.name}</span>
            <span className="shrink-0 text-tv-muted">{summary}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-tv-muted">
            <span>
              风险 {fmtNum(risk.value)}%
              {sizing ? ` ≈ ${fmtMoney(sizing.targetRisk)}${currency}` : ''}
            </span>
            {tpTarget != null ? (
              <span>
                止盈 {fmtNum(template.rewardR)}R @ {fmtPrice(tpTarget, digits)}
              </span>
            ) : (
              <span>不自动设止盈</span>
            )}
          </div>
          <div className="mt-0.5 text-tv-muted">{steps}</div>
          {pending && <div className="mt-0.5 text-tv-muted">挂单成交后自动登记阶段计划</div>}
          {paused && (
            <div className="mt-0.5 text-tv-warn">
              阶段已暂停：{readonly ? '只读模式' : '风控急停'}，恢复可交易后继续
            </div>
          )}
          {riskDeviated && (
            <div className="mt-1 flex items-center justify-between gap-2 text-tv-warn">
              <span>
                已偏离模板：风险{' '}
                {risk.mode === 'percent'
                  ? `${fmtNum(risk.value)}%`
                  : `固定 ${fmtMoney(risk.value)}`}
                {risk.auto ? '' : ' · 手动手数'}
              </span>
              <button
                onClick={onRestoreRisk}
                className="shrink-0 rounded border border-tv-warn/40 px-1.5 py-0.5 text-[10px] text-tv-warn transition-colors hover:bg-tv-warn-soft"
              >
                恢复
              </button>
            </div>
          )}
          {tpManual && tpTarget != null && (
            <div className="mt-1 flex items-center justify-between gap-2 text-tv-warn">
              <span>止盈已手动调整（模板 {fmtPrice(tpTarget, digits)}）</span>
              <button
                onClick={onUseTemplateTp}
                className="shrink-0 rounded border border-tv-warn/40 px-1.5 py-0.5 text-[10px] text-tv-warn transition-colors hover:bg-tv-warn-soft"
              >
                用模板止盈
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
