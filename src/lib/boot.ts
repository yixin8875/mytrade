import { invoke } from '@tauri-apps/api/core';
import { useApp } from '../store/useApp';

interface GatewayStatus {
  listening: boolean;
  sidecar: boolean;
  logTail: string | null;
}

type Step = 'gateway' | 'terminal' | 'account';
type StepState = 'todo' | 'active' | 'done' | 'failed';

const LOG_HINT = '%LOCALAPPDATA%\\MyTrade\\gateway\\gateway.log';

function lastLogLine(log: string | null): string {
  if (!log) return '';
  const lines = log
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 180) : '';
}

function authHint(code: unknown): string {
  switch (String(code ?? '')) {
    case 'AUTH_FAILED':
      return ' 在「设置 → 账户」里检查密码，保存后会自动重试。';
    case 'NOT_LOGGED_IN':
      return ' 请在 MT5 里登录，或在「设置 → 账户」保存密码。';
    case 'ACCOUNT_MISMATCH':
      return ' 请检查登录号、服务器和终端路径。';
    case 'CREDENTIAL_STORE':
      return ' 凭据读取失败，请在「设置 → 账户」重新保存密码。';
    default:
      return '';
  }
}

/**
 * 启动页分阶段提示：本地网关 → MT5 终端 → 账户同步。
 * 失败时给出可操作的原因（网关日志 / 账户错误），而不是一直转圈。
 */
export function mountBootProgress(): () => void {
  const boot = document.getElementById('boot');
  if (!boot) return () => {};

  const title = document.getElementById('boot-sub');
  const note = document.getElementById('boot-note');
  const steps = new Map<Step, HTMLElement>();
  boot.querySelectorAll<HTMLElement>('[data-step]').forEach((element) => {
    const key = element.dataset.step as Step | undefined;
    if (key) steps.set(key, element);
  });

  const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const startedAt = Date.now();
  let status: GatewayStatus | null = null;
  let hidden = false;
  let disposed = false;
  let hideTimer = 0;
  let idleTimer = 0;

  const hide = () => {
    if (hidden) return;
    hidden = true;
    window.clearTimeout(idleTimer);
    boot.classList.add('boot-hide');
    hideTimer = window.setTimeout(() => boot.remove(), 520);
  };

  const setText = (element: HTMLElement | null, text: string) => {
    if (element && element.textContent !== text) element.textContent = text;
  };

  const paint = (marks: Record<Step, StepState>) => {
    steps.forEach((element, key) => {
      element.dataset.state = marks[key];
    });
  };

  const render = () => {
    if (hidden || disposed) return;
    const state = useApp.getState();
    const elapsed = Date.now() - startedAt;
    const marks: Record<Step, StepState> = {
      gateway: 'todo',
      terminal: 'todo',
      account: 'todo',
    };
    let line = '正在启动本地网关…';
    let detail = '';

    if (state.conn === 'open' && state.health?.connected && state.symbols.length > 0) {
      marks.gateway = 'done';
      marks.terminal = 'done';
      marks.account = 'done';
      paint(marks);
      hide();
      return;
    }

    if (state.conn === 'open') {
      marks.gateway = 'done';
      const health = state.health;
      if (!health) {
        marks.terminal = 'active';
        line = '正在读取 MT5 终端状态…';
        detail = '本地网关已连上，正在等第一份状态回报。';
      } else if (!health.connected) {
        marks.terminal = 'active';
        const error = health.lastError;
        if (error) {
          marks.terminal = 'failed';
          line = 'MT5 终端未连接';
          detail = `${error.message}${authHint(error.code)}`;
        } else {
          line = '正在连接 MT5 终端…';
          detail = '请确认 MT5 已启动并登录账户；首次启动通常需要十几秒。';
        }
      } else if (state.symbols.length === 0) {
        marks.terminal = 'done';
        marks.account = 'active';
        line = '正在同步账户与持仓…';
        detail = '读取品种、余额和仓位，马上就好。';
      }
    } else if (status && !status.sidecar) {
      marks.gateway = 'failed';
      line = '找不到本地网关程序';
      detail = '安装可能不完整，请重新安装 Tally。';
    } else if (status?.listening) {
      marks.gateway = 'active';
      line = '本地网关已就绪，正在建立连接…';
    } else if (elapsed > 6000) {
      marks.gateway = 'active';
      line = '本地网关启动较慢…';
      const tail = lastLogLine(status?.logTail ?? null);
      detail = tail ? `最近日志：${tail}` : `若持续无响应，查看日志 ${LOG_HINT}`;
    } else {
      marks.gateway = 'active';
      line = state.conn === 'connecting' ? '正在连接本地网关…' : '正在启动本地网关…';
      detail = 'Tally 会在后台启动本地行情与交易服务。';
    }

    // 终端连不上时不要一直挡在启动页：10 秒后放行，错误在状态栏继续显示
    if (state.conn === 'open' && state.health && !state.health.connected && idleTimer === 0) {
      idleTimer = window.setTimeout(hide, 10_000);
    }

    paint(marks);
    setText(title, line);
    setText(note, detail);
  };

  const poll = async () => {
    if (!isDesktop || disposed) return;
    try {
      status = await invoke<GatewayStatus>('gateway_status');
    } catch {
      status = null;
    }
    render();
  };

  void poll();
  const pollTimer = window.setInterval(poll, 1500);
  const tick = window.setInterval(render, 1000);
  const unsubscribe = useApp.subscribe(render);
  const watchdog = window.setTimeout(hide, 25_000);
  render();

  return () => {
    disposed = true;
    unsubscribe();
    window.clearInterval(pollTimer);
    window.clearInterval(tick);
    window.clearTimeout(watchdog);
    window.clearTimeout(idleTimer);
    window.clearTimeout(hideTimer);
  };
}
