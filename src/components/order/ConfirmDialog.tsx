import { clsx } from 'clsx';
import { fmtMoney, fmtPrice, fmtVolume } from '../../lib/format';
import { fmtNum } from '../../lib/template';
import type {
  DisciplineGate,
  DisciplineRule,
  DraftOrder,
  Playbook,
  TradePreview,
  TradeTemplate,
} from '../../gateway/types';
import { ConfirmRow, RuleButton, inputClass } from './primitives';

/** 下单确认弹窗：订单摘要 + 开仓清单门禁 */
export function ConfirmDialog({
  symbol,
  draft,
  pendingLabel,
  digits,
  step,
  preview,
  orderTag,
  templateArmed,
  template,
  steps,
  riskDeviated,
  tpManual,
  disciplineEnabled,
  gate,
  gatePlaybooks,
  gateLoading,
  gateError,
  gateRules,
  gateMissing,
  gateViolated,
  gateShowConfirm,
  gateShowReason,
  gateProblem,
  gateConfirmed,
  gateReason,
  setGateConfirmed,
  setGateReason,
  busy,
  onSwitchPlaybook,
  onCheckRule,
  onOpenSettings,
  onCancel,
  onSend,
}: {
  symbol: string;
  draft: DraftOrder;
  pendingLabel: string;
  digits: number;
  step: number;
  preview: TradePreview | null;
  orderTag: string;
  templateArmed: boolean;
  template: TradeTemplate;
  steps: string;
  riskDeviated: boolean;
  tpManual: boolean;
  disciplineEnabled: boolean;
  gate: DisciplineGate | null;
  gatePlaybooks: Playbook[];
  gateLoading: boolean;
  gateError: string | null;
  gateRules: DisciplineRule[];
  gateMissing: string[];
  gateViolated: string[];
  gateShowConfirm: boolean;
  gateShowReason: boolean;
  gateProblem: string | null;
  gateConfirmed: boolean;
  gateReason: string;
  setGateConfirmed: (value: boolean) => void;
  setGateReason: (value: string) => void;
  busy: boolean;
  onSwitchPlaybook: (playbookId: string) => void;
  onCheckRule: (rule: string, followed: boolean | null) => void;
  onOpenSettings: () => void;
  onCancel: () => void;
  onSend: () => void;
}) {
  return (
    <div
      data-confirm="order"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6"
    >
      <div className="max-h-[88vh] w-[400px] max-w-[92vw] overflow-y-auto rounded-xl border border-tv-border bg-tv-panel p-5 shadow-[0_16px_48px_rgba(20,30,45,0.18)]">
        <div className="flex items-baseline justify-between">
          <span className="text-[14px] font-semibold text-tv-text">确认下单</span>
          <span className="num font-mono text-[11px] text-tv-muted">{symbol}</span>
        </div>
        <dl className="mt-4 space-y-2 text-[12px]">
          <ConfirmRow
            label="方向"
            value={draft.side === 'buy' ? '买入' : '卖出'}
            accent={draft.side === 'buy' ? 'text-tv-up' : 'text-tv-down'}
          />
          <ConfirmRow label="类型" value={draft.type === 'market' ? '市价' : pendingLabel} />
          <ConfirmRow label="手数" value={fmtVolume(draft.volume, step)} />
          <ConfirmRow
            label="价格"
            value={draft.type === 'market' ? '市价成交' : fmtPrice(draft.price, digits)}
          />
          <ConfirmRow label="止损" value={fmtPrice(draft.sl, digits)} />
          <ConfirmRow label="止盈" value={fmtPrice(draft.tp, digits)} />
          <ConfirmRow label="预估风险" value={fmtMoney(preview?.riskAmount)} />
          <ConfirmRow label="策略标签" value={orderTag.trim() || '—'} />
          <ConfirmRow label="模板" value={templateArmed ? template.name : '—'} />
          <ConfirmRow
            label="模板参数"
            value={
              templateArmed
                ? `${fmtNum(template.riskPercent)}% 风险 · ${
                    template.rewardR > 0 ? `止盈 ${fmtNum(template.rewardR)}R` : '不自动设止盈'
                  }`
                : '—'
            }
          />
          <ConfirmRow label="模板阶段" value={templateArmed ? steps : '—'} />
          {templateArmed && (riskDeviated || tpManual) && (
            <ConfirmRow
              label="模板偏离"
              value={[riskDeviated ? '风险已改' : '', tpManual ? '止盈已改' : '']
                .filter(Boolean)
                .join(' · ')}
              accent="text-tv-warn"
            />
          )}
        </dl>

        {disciplineEnabled && (
          <div className="mt-4 rounded-lg border border-tv-border bg-tv-raised px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-tv-text">开仓清单</span>
              <select
                value={gate?.playbookId ?? ''}
                onChange={(event) => onSwitchPlaybook(event.target.value)}
                disabled={gateLoading}
                aria-label="切换开仓清单"
                className="h-6 max-w-[180px] rounded border border-tv-border bg-tv-panel px-1 text-[11px] text-tv-text outline-none disabled:opacity-50"
              >
                <option value="">不关联清单</option>
                {gatePlaybooks.map((book) => (
                  <option key={book.id} value={book.id}>
                    {book.name}
                  </option>
                ))}
              </select>
            </div>

            {gateLoading && !gate ? (
              <div className="mt-2 text-[10px] text-tv-muted">读取清单…</div>
            ) : gateError ? (
              <div className="mt-2 text-[10px] leading-4 text-tv-warn">{gateError}</div>
            ) : gateRules.length === 0 ? (
              <div className="mt-2 space-y-1.5 text-[10px] text-tv-muted">
                <div>{gate?.playbookId ? '当前清单没有规则' : '未关联清单'}</div>
                <button
                  onClick={onOpenSettings}
                  className="rounded border border-tv-border px-1.5 py-0.5 text-[10px] text-tv-text transition-colors hover:bg-tv-hover"
                >
                  去设置开仓纪律
                </button>
              </div>
            ) : (
              <>
                <div className="mt-2 space-y-1">
                  {gateRules.map((item) => (
                    <div key={item.rule} className="flex items-center gap-1.5">
                      <span
                        className="min-w-0 flex-1 truncate text-[11px] text-tv-text"
                        title={item.rule}
                      >
                        {item.rule}
                      </span>
                      <div className="flex shrink-0 gap-0.5">
                        <RuleButton
                          active={item.evaluated && item.followed === true}
                          tone="up"
                          onClick={() => onCheckRule(item.rule, true)}
                        >
                          遵守
                        </RuleButton>
                        <RuleButton
                          active={item.evaluated && item.followed === false}
                          tone="down"
                          onClick={() => onCheckRule(item.rule, false)}
                        >
                          违反
                        </RuleButton>
                        <RuleButton
                          active={item.evaluated && item.followed === null}
                          tone="na"
                          onClick={() => onCheckRule(item.rule, null)}
                        >
                          不适用
                        </RuleButton>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-1.5 text-[10px] text-tv-muted">
                  已评估 {gateRules.length - gateMissing.length}/{gateRules.length} · 违反{' '}
                  {gateViolated.length}
                </div>
              </>
            )}

            {gateShowConfirm && (
              <label className="mt-2 flex items-start gap-1.5 text-[11px] leading-4 text-tv-text">
                <input
                  type="checkbox"
                  checked={gateConfirmed}
                  onChange={(event) => setGateConfirmed(event.target.checked)}
                  className="mt-0.5 accent-current"
                />
                我已复核清单，仍然下单
              </label>
            )}
            {gateShowReason && (
              <input
                type="text"
                value={gateReason}
                maxLength={500}
                placeholder="强行下单理由（写入审计）"
                onChange={(event) => setGateReason(event.target.value)}
                className={clsx(inputClass, 'mt-2 h-7 text-[11px]')}
              />
            )}
            {gateProblem && (
              <div className="mt-1.5 text-[10px] leading-4 text-tv-warn">{gateProblem}</div>
            )}
          </div>
        )}

        <div className="mt-5 flex gap-2">
          <button
            onClick={onCancel}
            className="h-9 flex-1 rounded-lg border border-tv-border text-[12px] text-tv-text transition-colors hover:bg-tv-hover"
          >
            取消
          </button>
          <button
            onClick={onSend}
            disabled={busy || !!gateProblem}
            className={clsx(
              'h-9 flex-1 rounded-lg text-[12px] font-medium text-white transition-colors',
              draft.side === 'buy' ? 'bg-tv-up' : 'bg-tv-down',
              (busy || !!gateProblem) && 'cursor-not-allowed opacity-50',
            )}
          >
            {busy ? '发送中…' : gateProblem ? '清单未完成' : '确认发送'}
          </button>
        </div>
      </div>
    </div>
  );
}
