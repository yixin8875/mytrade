import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { Check, ChevronDown, Loader2 } from 'lucide-react';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import type { AccountOption, SwitchAccountResult } from '../gateway/types';

/** 顶部账户切换：accounts 在 gateway/config.json 里配置，每个账户一个 MT5 终端 */
export function AccountSwitcher() {
  const health = useApp((s) => s.health);
  const positions = useApp((s) => s.positions);
  const notify = useApp((s) => s.notify);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const accounts = health?.accounts ?? [];
  const activeId = health?.activeAccountId ?? '';
  const active = accounts.find((item) => item.id === activeId) ?? accounts[0] ?? null;

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!active) return null;

  const switchTo = async (next: AccountOption) => {
    if (next.id === activeId) {
      setOpen(false);
      return;
    }
    if (positions.length > 0) {
      const ok = window.confirm(
        `当前账户还有 ${positions.length} 个持仓。切换后移动止损和自动保本将停止管理这些仓位，` +
          '持仓仍会留在 MT5。继续切换？',
      );
      if (!ok) return;
    }

    setOpen(false);
    setBusy(true);
    const state = useApp.getState();
    try {
      const result = await gateway.call<SwitchAccountResult>(
        'account.switch',
        { id: next.id, force: true },
        90_000,
      );
      state.resetForAccountSwitch();
      if (result.health) state.setHealth(result.health);
      if (result.account) state.setAccount(result.account);
      state.notify('success', `已切换到 ${next.label}${next.login ? ` (${next.login})` : ''}`);
    } catch (error) {
      // 后端可能已写入新配置并在后台重连；清掉旧账户状态，让 refresh 显示真实情况
      state.resetForAccountSwitch();
      state.notify('error', (error as Error).message);
    } finally {
      setBusy(false);
      window.dispatchEvent(new Event('mytrade:account-switched'));
    }
  };

  const connected = !!health?.connected;

  return (
    <div ref={boxRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={busy}
        title={
          active.server
            ? `${active.label} · ${active.login || '未指定登录号'}@${active.server}`
            : `${active.label} · ${active.login || '未指定登录号'}`
        }
        className={clsx(
          'flex h-7 items-center gap-2 rounded-lg border border-tv-border bg-tv-raised px-2 text-[12px] text-tv-text transition-colors',
          busy ? 'cursor-wait opacity-70' : 'hover:bg-tv-hover',
        )}
      >
        <span
          className={clsx(
            'h-1.5 w-1.5 rounded-full',
            connected && active.connected ? 'bg-tv-up' : 'bg-tv-faint',
          )}
        />
        <span className="max-w-[104px] truncate">{active.label}</span>
        <span className="num font-mono text-[11px] text-tv-muted">{active.login || '—'}</span>
        {busy ? (
          <Loader2 size={14} className="animate-spin text-tv-muted" />
        ) : (
          <ChevronDown
            size={14}
            strokeWidth={1.5}
            className={clsx(
              'text-tv-muted transition-transform duration-150',
              open && 'rotate-180',
            )}
          />
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-9 z-50 w-72 overflow-hidden rounded-xl border border-tv-border bg-tv-panel shadow-[0_12px_32px_rgba(20,30,45,0.12)]">
          <div className="border-b border-tv-border px-3 py-2.5 text-[11px] text-tv-muted">
            切换 MT5 账户
          </div>
          <div className="max-h-72 overflow-auto p-1">
            {accounts.map((item) => {
              const current = item.id === activeId;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => void switchTo(item)}
                  disabled={busy}
                  className={clsx(
                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                    current ? 'bg-tv-raised' : 'hover:bg-tv-hover',
                    busy && 'cursor-wait',
                  )}
                >
                  <span
                    className={clsx(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      item.active && item.connected ? 'bg-tv-up' : 'bg-tv-faint',
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] text-tv-text">{item.label}</span>
                    <span className="block truncate font-mono text-[11px] text-tv-muted">
                      {item.login || '未指定登录号'}
                      {item.server ? ` · ${item.server}` : ''}
                    </span>
                  </span>
                  {current && <Check size={14} strokeWidth={1.5} className="shrink-0 text-tv-accent" />}
                </button>
              );
            })}
          </div>
          <div className="border-t border-tv-border px-3 py-2.5 text-[11px] leading-relaxed text-tv-muted">
            在「设置 → MT5 账户」里添加、修改或删除账户；保存后无需重启网关。
          </div>
        </div>
      )}
    </div>
  );
}
