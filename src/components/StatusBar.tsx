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
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-tv-border bg-tv-panel px-3 text-[10px] text-tv-muted">
      <span className="flex items-center gap-1.5">
        <span
          className={clsx(
            'h-1.5 w-1.5 rounded-full',
            conn === 'open' ? 'bg-tv-up' : conn === 'connecting' ? 'bg-amber-400' : 'bg-tv-down',
          )}
        />
        {conn === 'open'
          ? '网关已连接'
          : conn === 'connecting'
            ? '重连网关中…'
            : '网关未连接 · 自动重连中'}
      </span>

      <span>
        MT5：
        {health?.connected
          ? `${health.terminal?.name ?? '已连接'} (build ${health.terminal?.build ?? '—'})`
          : '等待终端'}
      </span>

      {account && (
        <span>
          {account.login}@{account.server} · {account.accountType} · {account.marginMode}
        </span>
      )}

      <span className="flex-1" />

      {halted ? (
        <span className="rounded bg-tv-down/20 px-1.5 py-0.5 font-semibold text-tv-down">
          已停机：{riskStatus?.haltReason || '手动停机'}
          {positions.length > 0 ? ` · ${positions.length} 个仓位未平` : ''}
        </span>
      ) : (
        riskStatus?.blockReason && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-400">
            {riskStatus.blockReason}
          </span>
        )
      )}

      {mode === 'readonly' && <span>只读</span>}
      {mode === 'demo' && <span className="text-tv-up">模拟可交易</span>}
      {mode === 'live' && <span className="text-tv-down">实盘交易</span>}

      {health?.terminal && !health.terminal.tradeAllowed && (
        <span className="text-amber-400">MT5 未开启 Algo Trading</span>
      )}

      <span>延迟 {latency != null ? `${latency}ms` : '—'}</span>
      <span>v{health?.version ?? '0.1.0'}</span>
    </footer>
  );
}
