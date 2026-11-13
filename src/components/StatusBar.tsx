import { clsx } from 'clsx';
import { useApp } from '../store/useApp';

export function StatusBar() {
  const conn = useApp((s) => s.conn);
  const health = useApp((s) => s.health);
  const latency = useApp((s) => s.latency);
  const account = useApp((s) => s.account);
  const riskStatus = useApp((s) => s.riskStatus);
  const positions = useApp((s) => s.positions);

  const mode = health?.tradeMode ?? 'readonly';
  const halted = !!riskStatus?.halted;

  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-tv-border bg-tv-panel px-3 text-[11px] text-tv-muted">
      <span className="flex items-center gap-1.5">
        <span
          className={clsx(
            'h-1.5 w-1.5 rounded-full',
            conn === 'open' ? 'bg-tv-up' : conn === 'connecting' ? 'bg-tv-warn' : 'bg-tv-down',
          )}
        />
        {conn === 'open'
          ? '网关已连接'
          : conn === 'connecting'
            ? '重连网关中…'
            : '网关未连接 · 自动重连中'}
      </span>

      <span className="h-3 w-px bg-tv-border" />

      <span
        className={clsx('min-w-0', !health?.connected && 'max-w-[300px] truncate')}
        title={!health?.connected ? (health?.lastError?.message ?? undefined) : undefined}
      >
        {health?.connected ? (
          `${health.terminal?.name ?? 'MT5'} · build ${health.terminal?.build ?? '—'}`
        ) : health?.lastError ? (
          <span className="text-tv-warn">{health.lastError.message}</span>
        ) : (
          'MT5 等待终端'
        )}
      </span>

      {account && (
        <>
          <span className="h-3 w-px bg-tv-border" />
          <span className="num font-mono">
            {account.login}@{account.server} · {account.accountType}
          </span>
        </>
      )}

      <span className="flex-1" />

      {halted ? (
        <span className="flex items-center gap-1.5 font-medium text-tv-down">
          <span className="h-1.5 w-1.5 rounded-full bg-tv-down" />
          已停机：{riskStatus?.haltReason || '手动停机'}
          {positions.length > 0 ? ` · ${positions.length} 个仓位未平` : ''}
        </span>
      ) : (
        riskStatus?.blockReason && <span className="text-tv-warn">{riskStatus.blockReason}</span>
      )}

      <span className="h-3 w-px bg-tv-border" />

      {mode === 'readonly' && <span>只读</span>}
      {mode === 'demo' && <span className="text-tv-up">模拟可交易</span>}
      {mode === 'live' && <span className="font-medium text-tv-down">实盘交易</span>}

      {health?.terminal && !health.terminal.tradeAllowed && (
        <span className="text-tv-warn">Algo Trading 未开启</span>
      )}

      <span className="num font-mono">延迟 {latency != null ? `${latency}ms` : '—'}</span>
      <span className="num font-mono text-tv-faint">v{health?.version ?? '0.1.0'}</span>
    </footer>
  );
}
