import { useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import {
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { GatewayRequestError, gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import type {
  AccountMutationResult,
  AccountOption,
  GatewayHealth,
  SwitchAccountResult,
} from '../gateway/types';

const inputClass =
  'h-8 w-full rounded-lg border border-tv-border bg-tv-bg px-2 text-[11px] text-tv-text outline-none focus:border-tv-accent';

type Draft = {
  id?: string;
  label: string;
  login: string;
  server: string;
  terminalPath: string;
  password: string;
  clearPassword: boolean;
};

function newDraft(active: AccountOption | null): Draft {
  return {
    label: '',
    login: '',
    server: active?.server ?? '',
    terminalPath: active?.terminalPath ?? '',
    password: '',
    clearPassword: false,
  };
}

/** 设置页的 MT5 账户管理：凭证自动登录、增删改与切换 */
export function AccountManager() {
  const conn = useApp((s) => s.conn);
  const health = useApp((s) => s.health);
  const positions = useApp((s) => s.positions);
  const notify = useApp((s) => s.notify);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const accounts = health?.accounts ?? [];
  const activeId = health?.activeAccountId ?? '';
  const active = accounts.find((item) => item.id === activeId) ?? accounts[0] ?? null;
  const editing = draft?.id ? accounts.find((item) => item.id === draft.id) ?? null : null;
  const gatewayOnline = conn === 'open';
  const error = health?.lastError;

  const applyHealth = (next: GatewayHealth) => {
    const state = useApp.getState();
    state.setHealth(next);
    state.setAccount(next.account);
  };

  const refresh = async () => {
    try {
      const next = await gateway.call<GatewayHealth>('system.health');
      applyHealth(next);
    } catch {
      /* 网关离线时保留旧列表 */
    }
  };

  const afterMutation = () => {
    window.dispatchEvent(new Event('mytrade:account-switched'));
  };

  const save = async () => {
    if (!draft) return;
    const login = Number(draft.login);
    if (!Number.isInteger(login) || login <= 0) {
      notify('error', '请输入有效的 MT5 登录号');
      return;
    }
    if (!draft.label.trim()) {
      notify('error', '请输入账户名称');
      return;
    }
    if (!draft.server.trim()) {
      notify('error', '请输入服务器名');
      return;
    }
    if (!draft.terminalPath.trim()) {
      notify('error', '请输入 MT5 终端路径');
      return;
    }

    setBusy('save');
    try {
      const params: Record<string, unknown> = {
        label: draft.label.trim(),
        login,
        server: draft.server.trim(),
        terminalPath: draft.terminalPath.trim(),
      };
      if (draft.password) params.password = draft.password;
      if (draft.clearPassword) params.clearPassword = true;

      const result = draft.id
        ? await gateway.call<AccountMutationResult>(
            'accounts.update',
            { id: draft.id, ...params },
            90_000,
          )
        : await gateway.call<AccountMutationResult>('accounts.create', params);
      applyHealth(result.health);
      setDraft(null);
      notify('success', draft.id ? '账户已保存' : '账户已添加');
      afterMutation();
    } catch (error) {
      const failure = error as GatewayRequestError;
      if (failure.code === 'ACCOUNT_RECONNECT_FAILED') {
        const detail = failure.detail as { health?: GatewayHealth } | undefined;
        if (detail?.health) applyHealth(detail.health);
        else await refresh();
        setDraft(null);
        afterMutation();
      }
      notify('error', failure.message);
    } finally {
      setBusy(null);
    }
  };

  const switchTo = async (item: AccountOption) => {
    if (item.id === activeId) return;
    if (positions.length > 0) {
      const ok = window.confirm(
        `当前账户还有 ${positions.length} 个持仓。切换后移动止损和自动保本将停止管理这些仓位，` +
          '持仓仍会留在 MT5。继续切换？',
      );
      if (!ok) return;
    }
    setBusy(`switch:${item.id}`);
    try {
      const result = await gateway.call<SwitchAccountResult>(
        'account.switch',
        { id: item.id, force: true },
        90_000,
      );
      const state = useApp.getState();
      state.resetForAccountSwitch();
      applyHealth(result.health);
      if (result.account) state.setAccount(result.account);
      notify('success', `已切换到 ${item.label}${item.login ? ` (${item.login})` : ''}`);
    } catch (error) {
      const failure = error as GatewayRequestError;
      await refresh();
      notify('error', failure.message);
    } finally {
      afterMutation();
      setBusy(null);
    }
  };

  const remove = async (item: AccountOption) => {
    if (
      !window.confirm(
        `删除账户「${item.label}」？本机保存的密码也会一起清除，交易日志与历史数据不会删除。`,
      )
    ) {
      return;
    }
    setBusy(`delete:${item.id}`);
    try {
      const result = await gateway.call<AccountMutationResult>('accounts.delete', { id: item.id });
      applyHealth(result.health);
      setDraft(null);
      notify('success', `已删除账户 ${item.label}`);
      afterMutation();
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <section className="mb-4 rounded-xl border border-tv-border bg-tv-panel p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[13px] font-semibold">MT5 账户</div>
            <p className="mt-1 max-w-[620px] text-[11px] leading-relaxed text-tv-muted">
              保存登录号、服务器和密码后，网关会在启动或切换账户时自动登录 MT5。
              修改当前账户的连接信息或密码会立即重新连接。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void refresh()}
              disabled={!gatewayOnline}
              className="flex h-7 items-center gap-1.5 rounded-lg border border-tv-border px-2.5 text-[10.5px] text-tv-muted hover:bg-tv-hover hover:text-tv-text disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RefreshCw size={12} />
              刷新
            </button>
            <button
              onClick={() => setDraft(newDraft(active))}
              disabled={!gatewayOnline}
              className="flex h-7 items-center gap-1.5 rounded-lg bg-tv-accent px-2.5 text-[10.5px] font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus size={12} />
              添加账户
            </button>
          </div>
        </div>

        {error && (
          <div
            className={clsx(
              'mt-4 rounded-lg border px-3 py-2 text-[10.5px] leading-relaxed',
              error.code === 'AUTH_FAILED'
                ? 'border-tv-down/30 bg-tv-down/10 text-tv-down'
                : 'border-amber-500/30 bg-amber-500/10 text-amber-500',
            )}
          >
            {error.message}
          </div>
        )}

        {draft && (
          <div className="mt-4 rounded-xl border border-tv-accent/40 bg-tv-bg/60 p-4">
            <div className="flex items-center justify-between">
              <div className="text-[12px] font-medium">
                {draft.id ? `编辑账户 · ${editing?.label ?? draft.label}` : '添加 MT5 账户'}
              </div>
              <button
                onClick={() => setDraft(null)}
                className="flex h-6 w-6 items-center justify-center rounded text-tv-muted hover:bg-tv-hover hover:text-tv-text"
                title="关闭"
              >
                <X size={13} />
              </button>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="账户名称" hint="只用于界面显示，例如「主账户」「模拟 B」">
                <input
                  autoFocus
                  maxLength={40}
                  value={draft.label}
                  placeholder="主账户"
                  onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                  className={inputClass}
                />
              </Field>
              <Field label="MT5 登录号">
                <input
                  type="number"
                  min={1}
                  value={draft.login}
                  placeholder="10000001"
                  onChange={(event) => setDraft({ ...draft, login: event.target.value })}
                  className={clsx(inputClass, 'font-mono')}
                />
              </Field>
              <Field label="服务器" hint="必须与 MT5 登录窗口里的服务器名一致">
                <input
                  value={draft.server}
                  placeholder="Broker-Demo"
                  onChange={(event) => setDraft({ ...draft, server: event.target.value })}
                  className={inputClass}
                />
              </Field>
              <Field label="终端路径" hint="通常以 terminal64.exe 结尾">
                <input
                  value={draft.terminalPath}
                  placeholder="C:\\Program Files\\MetaTrader 5\\terminal64.exe"
                  onChange={(event) => setDraft({ ...draft, terminalPath: event.target.value })}
                  className={clsx(inputClass, 'font-mono text-[10px]')}
                />
              </Field>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field
                label={draft.id ? '密码（留空不修改）' : '密码（留空则使用终端已登录账户）'}
                hint={
                  draft.id && editing?.hasPassword
                    ? '本机已保存密码，输入新密码可覆盖'
                    : '密码经 Windows DPAPI 加密保存，不会写入 config.json'
                }
              >
                <input
                  type="password"
                  autoComplete="new-password"
                  value={draft.password}
                  disabled={draft.clearPassword}
                  placeholder={editing?.hasPassword ? '••••••••' : 'MT5 登录密码'}
                  onChange={(event) => setDraft({ ...draft, password: event.target.value })}
                  className={clsx(inputClass, draft.clearPassword && 'opacity-40')}
                />
              </Field>
              <div className="flex items-end pb-1">
                {draft.id && editing?.hasPassword ? (
                  <label className="flex items-center gap-2 text-[10.5px] text-tv-muted">
                    <input
                      type="checkbox"
                      checked={draft.clearPassword}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          clearPassword: event.target.checked,
                          password: event.target.checked ? '' : draft.password,
                        })
                      }
                    />
                    清除已保存的密码
                  </label>
                ) : (
                  <span className="text-[9.5px] leading-relaxed text-tv-muted">
                    同一终端可以配置多个登录号；切换时 MT5 会退出当前账户并登录目标账户。
                  </span>
                )}
              </div>
            </div>

            <div className="mt-4 flex items-center gap-2">
              <button
                onClick={() => void save()}
                disabled={busy === 'save'}
                className="flex h-7 items-center gap-1.5 rounded-lg bg-tv-accent px-3 text-[10.5px] font-medium text-white hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
              >
                {busy === 'save' && <Loader2 size={11} className="animate-spin" />}
                保存
              </button>
              <button
                onClick={() => setDraft(null)}
                className="h-7 rounded-lg border border-tv-border px-3 text-[10.5px] text-tv-muted hover:bg-tv-hover hover:text-tv-text"
              >
                取消
              </button>
              <span className="ml-auto text-[9.5px] text-tv-muted">
                保存后如需使用新账户，请在列表里点「使用」。
              </span>
            </div>
          </div>
        )}

        <div className="mt-4 divide-y divide-tv-border/60 border-t border-tv-border/60">
          {accounts.length === 0 && (
            <div className="py-8 text-center text-[10.5px] leading-relaxed text-tv-muted">
              没有读取到账户信息。
              <br />
              请确认网关已启动；升级后需要重启一次网关。
            </div>
          )}
          {accounts.map((item) => {
            const current = item.id === activeId;
            const rowBusy = busy === `switch:${item.id}` || busy === `delete:${item.id}`;
            return (
              <div key={item.id} className="flex flex-wrap items-start gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11.5px] font-medium text-tv-text">{item.label}</span>
                    {current && (
                      <span className="rounded-full bg-tv-accent/15 px-1.5 py-0.5 text-[9px] text-tv-accent">
                        当前
                      </span>
                    )}
                    {item.hasPassword ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-tv-up/10 px-1.5 py-0.5 text-[9px] text-tv-up">
                        <ShieldCheck size={9} />
                        自动登录
                      </span>
                    ) : (
                      <span className="rounded-full bg-tv-border px-1.5 py-0.5 text-[9px] text-tv-muted">
                        终端登录
                      </span>
                    )}
                    {item.connected && (
                      <span className="flex items-center gap-1 text-[9px] text-tv-up">
                        <span className="h-1.5 w-1.5 rounded-full bg-tv-up" />
                        已连接
                      </span>
                    )}
                  </div>
                  <div className="mt-1 font-mono text-[10px] text-tv-muted">
                    {item.login || '未设置登录号'}
                    {item.server ? ` · ${item.server}` : ' · 未设置服务器'}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[9.5px] text-tv-muted/80">
                    {item.terminalPath || '未设置终端路径'}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => void switchTo(item)}
                    disabled={current || !gatewayOnline || !!busy}
                    className={clsx(
                      'h-6 rounded border px-2 text-[9.5px]',
                      current
                        ? 'cursor-default border-tv-border text-tv-muted/50'
                        : 'border-tv-border text-tv-text hover:bg-tv-hover',
                    )}
                  >
                    {busy === `switch:${item.id}` ? '切换中…' : current ? '使用中' : '使用'}
                  </button>
                  <button
                    onClick={() =>
                      setDraft({
                        id: item.id,
                        label: item.label,
                        login: item.login ? String(item.login) : '',
                        server: item.server,
                        terminalPath: item.terminalPath ?? '',
                        password: '',
                        clearPassword: false,
                      })
                    }
                    disabled={!gatewayOnline || !!busy}
                    title="编辑账户"
                    className="flex h-6 w-6 items-center justify-center rounded border border-tv-border text-tv-muted hover:bg-tv-hover hover:text-tv-text disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Pencil size={10} />
                  </button>
                  <button
                    onClick={() => void remove(item)}
                    disabled={current || accounts.length <= 1 || !gatewayOnline || !!busy}
                    title={current ? '请先切换到其他账户再删除' : '删除账户'}
                    className="flex h-6 w-6 items-center justify-center rounded border border-tv-border text-tv-muted hover:bg-tv-down/15 hover:text-tv-down disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    {rowBusy && busy?.startsWith('delete:') ? (
                      <Loader2 size={10} className="animate-spin" />
                    ) : (
                      <Trash2 size={10} />
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-3 text-[9.5px] leading-relaxed text-tv-muted">
          顶部账户菜单也可快速切换。账户列表写入 gateway/config.json；密码单独保存到
          gateway/data/credentials.json，仅当前 Windows 用户可解密。
        </div>
      </section>

      <section className="mb-4 rounded-xl border border-tv-border bg-tv-panel p-5 shadow-sm">
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <KeyRound size={14} className="text-tv-muted" />
          自动登录说明
        </div>
        <ul className="mt-3 space-y-1.5 text-[11px] leading-relaxed text-tv-muted">
          <li>· 保存密码后，网关启动时会先连接终端，再用登录号/服务器/密码登录目标账户。</li>
          <li>· 同一 terminal64.exe 可配置多个账户；切换会改变该终端当前登录的账户。</li>
          <li>· 希望多个账户同时在线时，请为每个账户使用不同的 terminal64.exe 路径。</li>
          <li>· 连续 3 次自动登录失败后网关会暂停重试，避免反复试错；修改密码后会重新尝试。</li>
        </ul>
      </section>
    </>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10.5px] text-tv-text">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[9.5px] leading-relaxed text-tv-muted">{hint}</span>}
    </label>
  );
}
