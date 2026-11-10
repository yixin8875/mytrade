import { clsx } from 'clsx';
import { useApp } from '../store/useApp';

export function Toast() {
  const toast = useApp((s) => s.toast);
  const clear = useApp((s) => s.clearToast);
  if (!toast) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-9 z-[60] flex justify-center">
      <button
        onClick={clear}
        className={clsx(
          'pointer-events-auto max-w-lg rounded px-3 py-2 text-left text-[11px] text-white shadow-lg',
          toast.kind === 'error' && 'bg-tv-down',
          toast.kind === 'success' && 'bg-emerald-600',
          toast.kind === 'info' && 'bg-tv-accent',
        )}
      >
        {toast.text}
      </button>
    </div>
  );
}
