import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Check, ChevronDown, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
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

  const accounts = health?.accounts ?? [];
  const activeId = health?.activeAccountId ?? '';
  const active = accounts.find((item) => item.id === activeId) ?? accounts[0] ?? null;

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
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        disabled={busy}
        title={
          active.server
            ? `${active.label} · ${active.login || '未指定登录号'}@${active.server}`
            : `${active.label} · ${active.login || '未指定登录号'}`
        }
        render={
          <Button
            variant="outline"
            size="sm"
            className={cn(
              'h-7 shrink-0 gap-2 px-2 text-[12px] font-normal',
              busy && 'cursor-wait opacity-70',
            )}
          />
        }
      >
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            connected && active.connected ? 'bg-success' : 'bg-muted-foreground/40',
          )}
        />
        <span className="max-w-[104px] truncate">{active.label}</span>
        <span className="font-mono text-[11px] text-muted-foreground">{active.login || '—'}</span>
        {busy ? (
          <Loader2 size={14} className="animate-spin text-muted-foreground" />
        ) : (
          <ChevronDown
            size={14}
            strokeWidth={1.5}
            className={cn(
              'text-muted-foreground transition-transform duration-150',
              open && 'rotate-180',
            )}
          />
        )}
      </MenuTrigger>

      <MenuPopup align="end" sideOffset={6} className="w-72">
        <div className="px-2 py-1.5 text-[11px] text-muted-foreground">切换 MT5 账户</div>
        {accounts.map((item) => {
          const current = item.id === activeId;
          return (
            <MenuItem
              key={item.id}
              onClick={() => void switchTo(item)}
              disabled={busy}
              closeOnClick={false}
              className={cn(
                'gap-2.5 rounded-lg px-2.5 py-2 sm:py-2',
                current && 'bg-accent',
                busy && 'cursor-wait',
              )}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  item.active && item.connected ? 'bg-success' : 'bg-muted-foreground/40',
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-foreground">{item.label}</span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                  {item.login || '未指定登录号'}
                  {item.server ? ` · ${item.server}` : ''}
                </span>
              </span>
              {current && <Check size={14} strokeWidth={1.5} className="shrink-0 text-brand" />}
            </MenuItem>
          );
        })}
        <MenuSeparator />
        <div className="px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
          在「设置 → MT5 账户」里添加、修改或删除账户；保存后无需重启网关。
        </div>
      </MenuPopup>
    </Menu>
  );
}
