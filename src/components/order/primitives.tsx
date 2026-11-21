import { type ReactNode } from 'react';
import { clsx } from 'clsx';

export const inputClass =
  'h-8 w-full rounded-lg border border-tv-border bg-tv-raised px-2 font-mono text-[12px] text-tv-text outline-none transition-colors focus:border-tv-accent focus:bg-tv-panel';

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] text-tv-muted">{label}</span>
      {children}
    </label>
  );
}

export function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-tv-muted">{label}</span>
      <span className="num font-mono text-tv-text">{value}</span>
    </div>
  );
}

export function ConfirmRow({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-tv-muted">{label}</dt>
      <dd className={clsx('num font-mono', accent ?? 'text-tv-text')}>{value}</dd>
    </div>
  );
}

/** 清单规则的三态按钮：选中色与交易方向色一致，未评估时不亮 */
export function RuleButton({
  active,
  tone,
  onClick,
  children,
}: {
  active: boolean;
  tone: 'up' | 'down' | 'na';
  onClick: () => void;
  children: ReactNode;
}) {
  const activeClass =
    tone === 'up'
      ? 'border-tv-up/50 bg-tv-up/10 text-tv-up'
      : tone === 'down'
        ? 'border-tv-down/50 bg-tv-down/10 text-tv-down'
        : 'border-tv-border bg-tv-panel text-tv-muted';
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'h-5 rounded border px-1 text-[10px] leading-none transition-colors',
        active ? activeClass : 'border-transparent text-tv-faint hover:bg-tv-hover',
      )}
    >
      {children}
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-tv-border bg-tv-panel px-1 font-mono text-[11px] text-tv-muted">
      {children}
    </kbd>
  );
}
