import { useEffect, useRef } from 'react';
import { useApp } from '../store/useApp';
import { toastManager } from './ui/toast';

/**
 * 把应用内的一条提示桥接到 coss Toast。
 * 提示仍由 store 管理（自动 4.5s / 带动作 6s 清除），这里只负责渲染与关闭联动。
 */
export function Toast() {
  const toast = useApp((s) => s.toast);
  const clear = useApp((s) => s.clearToast);
  const activeId = useRef<string | null>(null);

  useEffect(() => {
    if (activeId.current) {
      toastManager.close(activeId.current);
      activeId.current = null;
    }
    if (!toast) return;

    const id = `app-toast-${toast.id}`;
    const isCurrent = () => useApp.getState().toast?.id === toast.id;
    let cancelled = false;
    // ToastProvider 在父级 effect 中订阅管理器；延后一个微任务，避免首屏提示丢失
    queueMicrotask(() => {
      if (cancelled || useApp.getState().toast?.id !== toast.id) return;
      toastManager.add({
        id,
        title: toast.text,
        type: toast.kind === 'error' ? 'error' : toast.kind === 'success' ? 'success' : 'info',
        timeout: toast.action ? 6000 : 4500,
        // 点击提示本体即关闭，保持原有交互
        data: {
          rootProps: {
            onClick: () => {
              if (isCurrent()) clear();
            },
          },
        },
        onClose: () => {
          if (isCurrent()) clear();
        },
        actionProps: toast.action
          ? {
              children: toast.action.label,
              onClick: (event: React.MouseEvent) => {
                event.stopPropagation();
                const action = toast.action;
                if (!isCurrent() || !action) return;
                clear();
                action.run();
              },
            }
          : undefined,
      });
      activeId.current = id;
    });

    return () => {
      cancelled = true;
      toastManager.close(id);
    };
  }, [toast, clear]);

  return null;
}
