import { clsx } from 'clsx';
import { X } from 'lucide-react';
import { fmtMoney, fmtVolume } from '../../lib/format';
import type { PendingClassification } from '../../lib/pendingOrder';
import type {
  DraftOrder,
  RiskSettings,
  SymbolInfo,
  TradePreview,
  TradeSizing,
} from '../../gateway/types';
import { SegmentedControl, SegmentedControlItem } from '../ui/segmented-control';
import { PreviewRow, inputClass } from './primitives';

/** 下单表单：委托价、手数 / 止损止盈，或风险计算表格 */
export function OrderFields({
  draft,
  info,
  pendingInfo,
  risk,
  riskMode,
  riskStep,
  balance,
  currency,
  slSet,
  slDistancePoints,
  rrShown,
  riskPctShown,
  sizing,
  preview,
  autoLots,
  step,
  patchDraft,
  patchRisk,
  patchOrder,
  changeVolume,
  applySlPoints,
  applyTpR,
  bumpRisk,
  onTouchTp,
}: {
  draft: DraftOrder;
  info: SymbolInfo | undefined;
  pendingInfo: PendingClassification;
  risk: RiskSettings;
  riskMode: boolean;
  riskStep: number;
  balance: number | null;
  currency: string;
  slSet: boolean;
  slDistancePoints: number | null;
  rrShown: number | null;
  riskPctShown: number | null;
  sizing: TradeSizing | null;
  preview: TradePreview | null;
  autoLots: boolean;
  step: number;
  patchDraft: (patch: Partial<DraftOrder>) => void;
  patchRisk: (patch: Partial<RiskSettings>) => void;
  patchOrder: (patch: Partial<DraftOrder>) => void;
  changeVolume: (delta: number) => void;
  applySlPoints: (points: number) => void;
  applyTpR: (multiple: number) => void;
  bumpRisk: (delta: number) => void;
  onTouchTp: () => void;
}) {
  return (
    <>
        {draft.type !== 'market' && (
          <div className="rounded-lg border border-border bg-card p-2">
            <div className="flex items-center gap-1.5">
              <span className="w-10 shrink-0 text-[11px] text-muted-foreground">委托价</span>
              <input
                type="number"
                step={info?.tickSize ?? 0.00001}
                value={draft.price || ''}
                aria-label="委托价格"
                onChange={(event) => {
                  const value = event.target.value === '' ? 0 : Number(event.target.value);
                  patchDraft({ price: Number.isFinite(value) ? value : 0 });
                }}
                className="h-7 min-w-0 flex-1 rounded border border-border bg-muted px-1.5 font-mono text-[11px] text-foreground outline-none focus:border-brand"
              />
              <span
                className={clsx(
                  'shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium',
                  pendingInfo.type
                    ? 'border-brand/40 bg-brand/10 text-brand'
                    : 'border-warning/40/40 bg-warning/12 text-warning-foreground',
                )}
              >
                {pendingInfo.label}
              </span>
            </div>
            <div
              className={clsx(
                'mt-1 text-[10px] leading-4',
                pendingInfo.warning ? 'text-warning-foreground' : 'text-muted-foreground',
              )}
            >
              {pendingInfo.warning ??
                (draft.side === 'buy'
                  ? '高于买价 = 停损买入，低于买价 = 限价买入'
                  : '低于卖价 = 停损卖出，高于卖价 = 限价卖出')}
            </div>
          </div>
        )}

        {riskMode ? (
          <div data-risk-table className="space-y-2 rounded-lg border border-border bg-card p-2">
            <SegmentedControl className="w-full">
              {(
                [
                  ['amount', '固定金额'],
                  ['percent', '余额 %'],
                ] as const
              ).map(([value, label]) => (
                <SegmentedControlItem
                  key={value}
                  onClick={() => patchRisk({ mode: value })}
                  aria-pressed={risk.mode === value}
                  className="h-7 flex-1 text-[12px]"
                >
                  {label}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>

            <div>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="text-[11px] text-muted-foreground">
                  {risk.mode === 'percent' ? '风险比例' : '风险金额'}
                </span>
                <span className="text-[10px] text-muted-foreground/60">
                  余额 {fmtMoney(balance)} {currency}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => bumpRisk(-riskStep)}
                  aria-label="减少风险"
                  className="h-8 w-8 shrink-0 rounded-lg bg-muted text-[14px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  −
                </button>
                <div className="relative min-w-0 flex-1">
                  <input
                    type="number"
                    min={0}
                    step={riskStep}
                    value={risk.value}
                    aria-label={risk.mode === 'percent' ? '风险比例' : '风险金额'}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (Number.isFinite(value)) patchRisk({ value });
                    }}
                    className={clsx(inputClass, 'pr-7 text-center')}
                  />
                  <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/60">
                    {risk.mode === 'percent' ? '%' : currency}
                  </span>
                </div>
                <button
                  onClick={() => bumpRisk(riskStep)}
                  aria-label="增加风险"
                  className="h-8 w-8 shrink-0 rounded-lg bg-muted text-[14px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  +
                </button>
              </div>
            </div>

            <div>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="text-[11px] text-warning-foreground">止损价</span>
                <span
                  className={clsx(
                    'text-[10px]',
                    slSet ? 'text-muted-foreground/60' : 'text-warning-foreground',
                  )}
                >
                  {slDistancePoints != null
                    ? `距现价 ${slDistancePoints.toFixed(0)} 点`
                    : '必填 · 决定手数'}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  step={info?.tickSize ?? 0.00001}
                  value={draft.sl ?? ''}
                  placeholder="未设置"
                  aria-label="止损价格"
                  onChange={(event) => {
                    const value = event.target.value === '' ? null : Number(event.target.value);
                    patchOrder({ sl: Number.isFinite(value as number) ? value : null });
                  }}
                  className="h-7 min-w-0 flex-1 rounded border border-border bg-muted px-1.5 font-mono text-[11px] text-warning-foreground outline-none focus:border-brand"
                />
                {[100, 300, 500].map((points) => (
                  <button
                    key={points}
                    onClick={() => applySlPoints(points)}
                    title={`按现价偏移 ${points} 点`}
                    className="h-7 shrink-0 rounded border border-border bg-card px-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    {points}点
                  </button>
                ))}
                {draft.sl != null && (
                  <button
                    onClick={() => patchOrder({ sl: null })}
                    aria-label="清除止损"
                    title="清除止损"
                    className="flex h-7 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 hover:text-destructive-foreground"
                  >
                    <X size={11} strokeWidth={2} />
                  </button>
                )}
              </div>
            </div>

            <div>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="text-[11px] text-brand">止盈价</span>
                <span className="text-[10px] text-muted-foreground/60">
                  {rrShown != null ? `1 : ${rrShown.toFixed(2)}` : '可选'}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  step={info?.tickSize ?? 0.00001}
                  value={draft.tp ?? ''}
                  placeholder="未设置"
                  aria-label="止盈价格"
                  onChange={(event) => {
                    onTouchTp();
                    const value = event.target.value === '' ? null : Number(event.target.value);
                    patchOrder({ tp: Number.isFinite(value as number) ? value : null });
                  }}
                  className="h-7 min-w-0 flex-1 rounded border border-border bg-muted px-1.5 font-mono text-[11px] text-brand outline-none focus:border-brand"
                />
                {[1, 2, 3].map((multiple) => (
                  <button
                    key={multiple}
                    onClick={() => applyTpR(multiple)}
                    title={`按止损距离设置 ${multiple}R 止盈`}
                    className="h-7 shrink-0 rounded border border-border bg-card px-1.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    {multiple}R
                  </button>
                ))}
                {draft.tp != null && (
                  <button
                    onClick={() => {
                      onTouchTp();
                      patchOrder({ tp: null });
                    }}
                    aria-label="清除止盈"
                    title="清除止盈"
                    className="flex h-7 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 hover:text-destructive-foreground"
                  >
                    <X size={11} strokeWidth={2} />
                  </button>
                )}
              </div>
            </div>

            <div className="space-y-1 border-t border-border pt-1.5">
              <PreviewRow
                label="自动手数"
                value={slSet ? `${fmtVolume(sizing?.volume ?? draft.volume, step)} 手` : '—'}
              />
              <PreviewRow
                label="风险占比"
                value={riskPctShown != null ? `${riskPctShown.toFixed(2)}%` : '—'}
              />
              <PreviewRow label="保证金" value={fmtMoney(preview?.margin)} />
              <PreviewRow
                label="R:R"
                value={rrShown != null ? `1 : ${rrShown.toFixed(2)}` : '—'}
              />
            </div>
            {!slSet && (
              <div className="text-[10px] leading-4 text-muted-foreground/60">
                填写止损价后按风险金额自动算手数
              </div>
            )}
            {sizing?.warnings?.length ? (
              <div className="text-[11px] text-warning-foreground">{sizing.warnings.join('；')}</div>
            ) : null}
            {sizing?.capped?.length ? (
              <div className="text-[11px] text-warning-foreground">
                手数已按 {sizing.capped.join(' / ')} 限制
              </div>
            ) : null}
          </div>
        ) : (
        <>
        <div className="rounded-lg border border-border bg-card p-2">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">手数</span>
            <span
              className={clsx(
                'rounded px-1 py-px text-[9px] font-medium',
                autoLots
                  ? 'bg-brand/10 text-brand'
                  : risk.auto
                    ? 'bg-muted text-muted-foreground'
                    : 'text-muted-foreground/60',
              )}
            >
              {autoLots ? '模板自动' : risk.auto ? '风险自动' : '手动'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => changeVolume(-1)}
              className="h-8 w-8 shrink-0 rounded-lg bg-muted text-[14px] text-muted-foreground transition-colors hover:text-foreground"
              aria-label="减少手数"
            >
              −
            </button>
            <input
              type="number"
              step={step}
              min={info?.minVolume}
              max={info?.maxVolume}
              value={draft.volume}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value)) patchDraft({ volume: value });
                patchRisk({ auto: false });
              }}
              className={clsx(inputClass, 'text-center')}
            />
            <button
              onClick={() => changeVolume(1)}
              className="h-8 w-8 shrink-0 rounded-lg bg-muted text-[14px] text-muted-foreground transition-colors hover:text-foreground"
              aria-label="增加手数"
            >
              +
            </button>
          </div>
          {risk.auto && !draft.sl && (
            <div className="mt-1 text-[10px] leading-4 text-muted-foreground/60">
              设置止损后按模板风险自动算手数
            </div>
          )}
        </div>

        <div className="space-y-1.5 rounded-lg border border-border bg-card p-2">
          <div className="flex items-center gap-1">
            <span className="w-7 shrink-0 text-[11px] text-warning-foreground">止损</span>
            <input
              type="number"
              step={info?.tickSize ?? 0.00001}
              value={draft.sl ?? ''}
              placeholder="未设置"
              aria-label="止损价格"
              onChange={(event) => {
                const value = event.target.value === '' ? null : Number(event.target.value);
                patchOrder({ sl: Number.isFinite(value as number) ? value : null });
              }}
              className="h-7 min-w-0 flex-1 rounded border border-border bg-muted px-1.5 font-mono text-[11px] text-warning-foreground outline-none focus:border-brand"
            />
            {[100, 300, 500].map((points) => (
              <button
                key={points}
                onClick={() => applySlPoints(points)}
                title={`按现价偏移 ${points} 点`}
                className="h-7 shrink-0 rounded border border-border bg-card px-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {points}点
              </button>
            ))}
            {draft.sl != null && (
              <button
                onClick={() => patchOrder({ sl: null })}
                aria-label="清除止损"
                title="清除止损"
                className="flex h-7 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 hover:text-destructive-foreground"
              >
                <X size={11} strokeWidth={2} />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1">
            <span className="w-7 shrink-0 text-[11px] text-brand">止盈</span>
            <input
              type="number"
              step={info?.tickSize ?? 0.00001}
              value={draft.tp ?? ''}
              placeholder="未设置"
              aria-label="止盈价格"
              onChange={(event) => {
                onTouchTp();
                const value = event.target.value === '' ? null : Number(event.target.value);
                patchOrder({ tp: Number.isFinite(value as number) ? value : null });
              }}
              className="h-7 min-w-0 flex-1 rounded border border-border bg-muted px-1.5 font-mono text-[11px] text-brand outline-none focus:border-brand"
            />
            {[1, 2, 3].map((multiple) => (
              <button
                key={multiple}
                onClick={() => applyTpR(multiple)}
                title={`按止损距离设置 ${multiple}R 止盈`}
                className="h-7 shrink-0 rounded border border-border bg-card px-1.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {multiple}R
              </button>
            ))}
            {draft.tp != null && (
              <button
                onClick={() => {
                  onTouchTp();
                  patchOrder({ tp: null });
                }}
                aria-label="清除止盈"
                title="清除止盈"
                className="flex h-7 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 hover:text-destructive-foreground"
              >
                <X size={11} strokeWidth={2} />
              </button>
            )}
          </div>
        </div>
        </>
        )}
    </>
  );
}
