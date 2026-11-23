import { clsx } from 'clsx';
import { useApp } from '../store/useApp';
import { fmtMoney } from '../lib/format';
import { Separator } from './ui/separator';

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
    <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-border bg-card px-3 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span
          className={clsx(
            'h-1.5 w-1.5 rounded-full',
            conn === 'open' ? 'bg-success' : conn === 'connecting' ? 'bg-warning' : 'bg-destructive',
          )}
        />
        {conn === 'open'
          ? '网关已连接'
          : conn === 'connecting'
            ? '重连网关中…'
            : '网关未连接 · 自动重连中'}
      </span>

      <Separator orientation="vertical" className="h-3" />

      <span
        className={clsx('min-w-0', !health?.connected && 'max-w-[300px] truncate')}
        title={!health?.connected ? (health?.lastError?.message ?? undefined) : undefined}
      >
        {health?.connected ? (
          `${health.terminal?.name ?? 'MT5'} · build ${health.terminal?.build ?? '—'}`
        ) : health?.lastError ? (
          <span className="text-warning-foreground">{health.lastError.message}</span>
        ) : (
          'MT5 等待终端'
        )}
      </span>

      {account && (
        <>
          <Separator orientation="vertical" className="h-3" />
          <span className="num font-mono">
            {account.login}@{account.server} · {account.accountType}
          </span>
        </>
      )}

      <span className="flex-1" />

      {halted ? (
        <span className="flex items-center gap-1.5 font-medium text-destructive-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
          已停机：{riskStatus?.haltReason || '手动停机'}
          {positions.length > 0 ? ` · ${positions.length} 个仓位未平` : ''}
        </span>
      ) : (
        riskStatus?.blockReason && (
          <span className="text-warning-foreground">{riskStatus.blockReason}</span>
        )
      )}

      <Separator orientation="vertical" className="h-3" />

      {mode === 'readonly' && <span>只读</span>}
      {mode === 'demo' && <span className="text-success-foreground">模拟可交易</span>}
      {mode === 'live' && <span className="font-medium text-destructive-foreground">实盘交易</span>}

      {health?.terminal && !health.terminal.tradeAllowed && (
        <span className="text-warning-foreground">Algo Trading 未开启</span>
      )}

      <span className="num font-mono">延迟 {latency != null ? `${latency}ms` : '—'}</span>
      <span className="num font-mono text-muted-foreground/60">v{health?.version ?? '0.1.0'}</span>

      <div className="ml-1 hidden shrink-0 items-center gap-3 border-l border-border pl-3 xl:flex">
        <StatusMetric label="净值" value={fmtMoney(account?.equity)} strong />
        <StatusMetric label="可用保证金" value={fmtMoney(account?.freeMargin)} />
        <StatusMetric label="余额" value={fmtMoney(account?.balance)} />
        <StatusMetric label="保证金" value={fmtMoney(account?.margin)} />
        <StatusMetric
          label="保证金比例"
          value={
            account?.marginLevel != null && Number.isFinite(account.marginLevel)
              ? `${account.marginLevel.toFixed(1)}%`
              : '—'
          }
        />
      </div>
    </footer>
  );
}

function StatusMetric({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <span className="flex items-baseline gap-1" title={label}>
      <span className="text-[10px] text-muted-foreground/60">{label}</span>
      <span className={clsx('num font-mono', strong ? 'text-foreground' : 'text-muted-foreground')}>
        {value}
      </span>
    </span>
  );
}
