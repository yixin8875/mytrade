import type { GatewayClient } from '../gateway/client';

export interface ClientErrorRecord {
  at: number;
  kind: 'error' | 'rejection';
  message: string;
  stack?: string;
}

const MAX_ERRORS = 30;
const errors: ClientErrorRecord[] = [];
let installed = false;

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function record(kind: ClientErrorRecord['kind'], value: unknown): void {
  const entry: ClientErrorRecord = { at: Date.now(), kind, message: describe(value) };
  if (value instanceof Error && value.stack) entry.stack = value.stack;
  errors.push(entry);
  if (errors.length > MAX_ERRORS) errors.shift();
}

/** 记录未捕获异常与 Promise 拒绝，供诊断包使用（只保留最近 30 条）。 */
export function installDiagnostics(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('error', (event) => {
    record('error', event.error ?? event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    record('rejection', event.reason);
  });
}

export function clientErrors(): ClientErrorRecord[] {
  return [...errors];
}

function stamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

function saveJson(payload: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 汇总前端状态与网关诊断，直接下载成 JSON；网关不可用时也照样能导出。 */
export async function downloadDiagnostics(client: GatewayClient): Promise<Record<string, unknown>> {
  const base: Record<string, unknown> = {
    kind: 'tally-client-diagnostics',
    version: 1,
    createdAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    url: window.location.href,
    errors: clientErrors(),
  };
  let payload: Record<string, unknown>;
  try {
    const gateway = await client.call<Record<string, unknown>>('diagnostics.get');
    payload = { ...base, gateway };
  } catch (error) {
    payload = { ...base, gateway: null, gatewayError: describe(error) };
  }
  saveJson(payload, `tally-diagnostics-${stamp()}.json`);
  return payload;
}
