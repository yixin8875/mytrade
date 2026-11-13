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
  'h-8 w-full rounded-lg border border-console-line bg-console-canvas px-2.5 text-[12px] text-console-ink outline-none focus:border-console-accent';

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
      <section className="mb-4 rounded-xl border border-console-line bg-console-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[13px] font-semibold text-console-ink">MT5 账户</div>
            <p className="mt-1.5 max-w-[620px] text-[12px] leading-relaxed text-console-muted">
              保存登录号、服务器和密码后，网关会在启动或切换账户时自动登录 MT5。
              修改当前账户的连接信息或密码会立即重新连接。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void refresh()}
              disabled={!gatewayOnline}
              className="flex h-8 items-center gap-1.5 rounded-lg border border-console-line bg-console-card px-2.5 text-[12px] text-console-ink-2 transition-colors hover:bg-console-hover hover:text-console-ink disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RefreshCw size={14} strokeWidth={1.5} />
              刷新
            </button>
            <button
              onClick={() => setDraft(newDraft(active))}
              disabled={!gatewayOnline}
              className="flex h-8 items-center gap-1.5 rounded-lg bg-console-ink px-3 text-[12px] font-medium text-console-card transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus size={14} strokeWidth={1.5} />
              添加账户
            </button>
          </div>
        </div>

        {error && (
          <div
            className={clsx(
              'mt-4 rounded-lg border px-3 py-2 text-[11px] leading-relaxed',
              error.code === 'AUTH_FAILED'
                ? 'border-console-loss/30 bg-console-loss-soft text-console-loss'
                : 'border-console-warn/30 bg-console-warn-soft text-console-warn',
            )}
          >
            {error.message}
          </div>
        )}

        {draft && (
          <div className="mt-4 rounded-xl border border-console-line bg-console-canvas/60 p-4">
            <div className="flex items-center justify-between">
              <div className="text-[13px] font-medium text-console-ink">
                {draft.id ? `编辑账户 · ${editing?.label ?? draft.label}` : '添加 MT5 账户'}
              </div>
              <button
                onClick={() => setDraft(null)}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-console-muted transition-colors hover:bg-console-hover hover:text-console-ink"
                title="关闭"
              >
                <X size={14} strokeWidth={1.5} />
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
                  className={clsx(inputClass, 'font-mono text-[11px]')}
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
                  <label className="flex items-center gap-2 text-[11px] text-console-muted">
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
                  <span className="text-[11px] leading-relaxed text-console-muted">
                    同一终端可以配置多个登录号；切换时 MT5 会退出当前账户并登录目标账户。
                  </span>
                )}
              </div>
            </div>

            <div className="mt-4 flex items-center gap-2">
              <button
                onClick={() => void save()}
                disabled={busy === 'save'}
                className="flex h-8 items-center gap-1.5 rounded-lg bg-console-ink px-3 text-[12px] font-medium text-console-card transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
              >
                {busy === 'save' && <Loader2 size={13} className="animate-spin" />}
                保存
              </button>
              <button
                onClick={() => setDraft(null)}
                className="h-8 rounded-lg border border-console-line bg-console-card px-3 text-[12px] text-console-ink-2 transition-colors hover:bg-console-hover hover:text-console-ink"
              >
                取消
              </button>
              <span className="ml-auto text-[11px] text-console-faint">
                保存后如需使用新账户，请在列表里点「使用」。
              </span>
            </div>
          </div>
        )}

        <div className="mt-4 divide-y divide-console-line/70 border-t border-console-line">
          {accounts.length === 0 && (
            <div className="py-8 text-center text-[12px] leading-relaxed text-console-muted">
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
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="text-[13px] font-medium text-console-ink">{item.label}</span>
                    {current && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-console-accent">
                        <span className="h-1.5 w-1.5 rounded-full bg-console-accent" />
                        当前
                      </span>
                    )}
                    {item.hasPassword ? (
                      <span className="inline-flex items-center gap-1 text-[11px] text-console-gain">
                        <ShieldCheck size={12} strokeWidth={1.5} />
                        自动登录
                      </span>
                    ) : (
                      <span className="text-[11px] text-console-faint">终端登录</span>
                    )}
                    {item.connected && (
                      <span className="flex items-center gap-1 text-[11px] text-console-gain">
                        <span className="h-1.5 w-1.5 rounded-full bg-console-gain" />
                        已连接
                      </span>
                    )}
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-console-muted">
                    {item.login || '未设置登录号'}
                    {item.server ? ` · ${item.server}` : ' · 未设置服务器'}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-console-faint">
                    {item.terminalPath || '未设置终端路径'}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => void switchTo(item)}
                    disabled={current || !gatewayOnline || !!busy}
                    className={clsx(
                      'h-7 rounded-lg border px-2.5 text-[11px] transition-colors',
                      current
                        ? 'cursor-default border-console-line text-console-faint'
                        : 'border-console-line text-console-ink-2 hover:bg-console-hover hover:text-console-ink',
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
                    className="flex h-7 w-7 items-center justify-center rounded-lg border border-console-line text-console-muted transition-colors hover:bg-console-hover hover:text-console-ink disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Pencil size={13} strokeWidth={1.5} />
                  </button>
                  <button
                    onClick={() => void remove(item)}
                    disabled={current || accounts.length <= 1 || !gatewayOnline || !!busy}
                    title={current ? '请先切换到其他账户再删除' : '删除账户'}
                    className="flex h-7 w-7 items-center justify-center rounded-lg border border-console-line text-console-muted transition-colors hover:bg-console-loss-soft hover:text-console-loss disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    {rowBusy && busy?.startsWith('delete:') ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Trash2 size={13} strokeWidth={1.5} />
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-4 text-[11px] leading-relaxed text-console-faint">
          顶部账户菜单也可快速切换。账户列表写入 gateway/config.json；密码单独保存到
          gateway/data/credentials.json，仅当前 Windows 用户可解密。
        </div>
      </section>

      <section className="mb-4 rounded-xl border border-console-line bg-console-card p-5">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-console-ink">
          <KeyRound size={16} strokeWidth={1.5} className="text-console-muted" />
          自动登录说明
        </div>
        <ul className="mt-3.5 space-y-2 text-[12px] leading-relaxed text-console-muted">
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
      <span className="mb-1.5 block text-[11px] text-console-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[11px] leading-relaxed text-console-faint">{hint}</span>}
    </label>
  );
}
