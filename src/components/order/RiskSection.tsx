import { cn } from '@/lib/utils';
import { fmtMoney, fmtVolume } from '../../lib/format';
import type { RiskSettings, TradeSizing } from '../../gateway/types';
import { Button } from '../ui/button';
import { SegmentedControl, SegmentedControlItem } from '../ui/segmented-control';
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
          <SegmentedControl size="sm" className="w-full">
            {(
              [
                ['amount', '固定金额'],
                ['percent', '余额 %'],
              ] as const
            ).map(([value, label]) => {
              const active = risk.mode === value;
              return (
                <SegmentedControlItem
                  key={value}
                  data-checked={active ? '' : undefined}
                  aria-pressed={active}
                  onClick={() => patchRisk({ mode: value })}
                  className="h-7 flex-1 text-[12px]"
                >
                  {label}
                </SegmentedControlItem>
              );
            })}
          </SegmentedControl>
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
              className={cn(inputClass, 'text-center')}
            />
            <Button
              variant={risk.auto ? 'secondary' : 'outline'}
              onClick={() => patchRisk({ auto: !risk.auto })}
              aria-pressed={risk.auto}
              className={cn(
                'h-8 w-[92px] shrink-0 text-[12px]',
                risk.auto && 'border-brand/40 bg-brand/10 text-brand hover:bg-brand/10',
              )}
            >
              {risk.auto ? '自动手数' : '手动手数'}
            </Button>
          </div>
          <div className="text-[11px] leading-relaxed text-muted-foreground">
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
            <div className="text-[11px] text-destructive-foreground">{sizing.warnings.join('；')}</div>
          ) : null}
        </div>
      </Field>
  );
}
