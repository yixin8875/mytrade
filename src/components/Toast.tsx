import { clsx } from 'clsx';
import { useApp } from '../store/useApp';

export function Toast() {
  const toast = useApp((s) => s.toast);
  const clear = useApp((s) => s.clearToast);
  if (!toast) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-10 z-[60] flex justify-center px-4">
      <button
        onClick={clear}
        className="pointer-events-auto flex max-w-lg items-start gap-2.5 rounded-lg border border-tv-border bg-tv-panel px-3.5 py-2.5 text-left text-[12px] leading-relaxed text-tv-text shadow-[0_12px_32px_-12px_rgba(0,0,0,0.35)]"
      >
        <span
          className={clsx(
            'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
            toast.kind === 'error' && 'bg-tv-down',
            toast.kind === 'success' && 'bg-tv-up',
            toast.kind === 'info' && 'bg-tv-accent',
          )}
        />
        <span className="break-words">{toast.text}</span>
      </button>
    </div>
  );
}
