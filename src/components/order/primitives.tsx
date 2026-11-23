import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { Kbd as CossKbd } from '../ui/kbd';

export const inputClass =
  'h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 font-mono text-[12px] text-foreground outline-none transition-[border-color,box-shadow,background-color] placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 disabled:opacity-60';

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="num font-mono text-foreground">{value}</span>
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
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('num font-mono', accent ?? 'text-foreground')}>{value}</dd>
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
      ? 'border-success/50 bg-success/10 text-success-foreground'
      : tone === 'down'
        ? 'border-destructive/50 bg-destructive/10 text-destructive-foreground'
        : 'border-border bg-card text-muted-foreground';
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      onClick={onClick}
      className={cn(
        'h-5 rounded border px-1 text-[10px] leading-none',
        active ? activeClass : 'border-transparent text-muted-foreground/60 hover:bg-accent',
      )}
    >
      {children}
    </Button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <CossKbd className="h-5 min-w-5 rounded border border-border bg-card font-mono text-[11px] text-muted-foreground">
      {children}
    </CossKbd>
  );
}
