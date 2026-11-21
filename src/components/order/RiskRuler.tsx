import { fmtPrice } from '../../lib/format';

/**
 * 风险尺：把入场、止损、止盈按 R 排成一条细尺。
 * 止损永远是 −1R，止盈按实际距离换算；只读展示，不改任何下单字段。
 */
export function RiskRuler({
  entry,
  sl,
  tp,
  digits,
  active,
}: {
  entry: number;
  sl: number | null;
  tp: number | null;
  digits: number;
  active: boolean;
}) {
  if (!active || !(entry > 0) || sl == null) {
    return (
      <div className="rounded-lg border border-dashed border-tv-border px-3 py-2.5 text-[11px] leading-relaxed text-tv-muted">
        风险尺：设置止损后，这里显示 −1R / 入场 / 止盈 的位置
      </div>
    );
  }
  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return null;

  const low = Math.min(entry, sl, tp ?? entry);
  const high = Math.max(entry, sl, tp ?? entry);
  const span = high - low || 1;
  const pct = (price: number) => ((price - low) / span) * 100;
  const entryPct = pct(entry);
  const slPct = pct(sl);
  const tpPct = tp != null ? pct(tp) : null;
  const tpR = tp != null ? Math.abs(tp - entry) / risk : null;

  return (
    <div aria-label="风险尺">
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="text-tv-muted">风险尺 · 止损为 1R</span>
        <span className="num font-mono text-tv-faint">入场 {fmtPrice(entry, digits)}</span>
      </div>
      <div className="relative mt-2 h-1.5 rounded-full bg-tv-raised">
        <span
          className="absolute inset-y-0 rounded-full bg-tv-down/70"
          style={{
            left: `${Math.min(entryPct, slPct)}%`,
            width: `${Math.abs(entryPct - slPct)}%`,
          }}
        />
        {tpPct != null && (
          <span
            className="absolute inset-y-0 rounded-full bg-tv-up/70"
            style={{
              left: `${Math.min(entryPct, tpPct)}%`,
              width: `${Math.abs(entryPct - tpPct)}%`,
            }}
          />
        )}
        <span
          className="absolute -top-1 h-3.5 w-px bg-tv-text"
          style={{ left: `${entryPct}%` }}
        />
      </div>
      <div className="mt-1.5 flex items-baseline justify-between gap-3 text-[11px]">
        <span className="num font-mono text-tv-down">
          止损 {fmtPrice(sl, digits)} · -1.0R
        </span>
        <span className="num font-mono text-tv-up">
          {tp != null ? `止盈 ${fmtPrice(tp, digits)} · +${tpR?.toFixed(1)}R` : '未设止盈'}
        </span>
      </div>
    </div>
  );
}
