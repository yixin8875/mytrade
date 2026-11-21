import { clsx } from 'clsx';
import { fmtMoney, fmtVolume } from '../../lib/format';
import type { RiskSettings, TradeSizing } from '../../gateway/types';
import { Field, inputClass } from './primitives';

/** 附加设置里的风险开仓：固定金额 / 余额 %、自动手数与反算说明 */
export function RiskSection({
  risk,
  currency,
  step,
  sizing,
  sl,
  patchRisk,
}: {
  risk: RiskSettings;
  currency: string;
  step: number;
  sizing: TradeSizing | null;
  sl: number | null;
  patchRisk: (patch: Partial<RiskSettings>) => void;
}) {
  return (
      <Field label="风险开仓">
        <div className="space-y-2">
          <div className="flex rounded-lg border border-tv-border bg-tv-raised p-0.5">
            {(
              [
                ['amount', '固定金额'],
                ['percent', '余额 %'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                onClick={() => patchRisk({ mode: value })}
                className={clsx(
                  'h-7 flex-1 rounded-md text-[12px] transition-colors',
                  risk.mode === value
                    ? 'bg-tv-panel text-tv-text shadow-[0_1px_2px_rgba(20,30,45,0.06)]'
                    : 'text-tv-muted hover:text-tv-text',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              step={risk.mode === 'percent' ? 0.1 : 10}
              value={risk.value}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value)) patchRisk({ value });
              }}
              className={clsx(inputClass, 'text-center')}
            />
            <button
              onClick={() => patchRisk({ auto: !risk.auto })}
              className={clsx(
                'h-8 w-[92px] shrink-0 rounded-lg border text-[12px] transition-colors',
                risk.auto
                  ? 'border-tv-accent/40 bg-tv-accent-soft text-tv-accent'
                  : 'border-tv-border bg-tv-panel text-tv-muted hover:text-tv-text',
              )}
            >
              {risk.auto ? '自动手数' : '手动手数'}
            </button>
          </div>
          <div className="text-[11px] leading-relaxed text-tv-muted">
            {!sl
              ? '设置止损后自动算手数'
              : sizing
                ? `目标 ${fmtMoney(sizing.targetRisk)}${currency} → ${fmtVolume(
                    sizing.volume,
                    step,
                  )} 手（实际 ${fmtMoney(sizing.riskAmount)}${currency}）`
                : '计算中…'}
          </div>
          {sizing?.warnings?.length ? (
            <div className="text-[11px] text-tv-down">{sizing.warnings.join('；')}</div>
          ) : null}
        </div>
      </Field>
  );
}
