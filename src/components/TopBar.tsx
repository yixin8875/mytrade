import { useState } from 'react';
import { clsx } from 'clsx';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import { fmtMoney, fmtPrice, fmtSigned, spreadPoints } from '../lib/format';
import type { RiskStatus } from '../gateway/types';

/** 亏损额度使用比例 → 颜色（绿 → 琥珀 → 红） */
function riskTone(risk: RiskStatus): string {
  if (risk.halted) return 'bg-tv-down/15 text-tv-down';
  if (risk.dailyLossLimit > 0) {
    const used = risk.dailyLoss / risk.dailyLossLimit;
    if (used >= 0.8) return 'bg-tv-down/15 text-tv-down';
    if (used >= 0.5) return 'bg-amber-500/15 text-amber-400';
  }
  // 冷却 / 次数用尽不算危险，用琥珀色提示即可
  if (!risk.canTrade) return 'bg-amber-500/15 text-amber-400';
  return 'bg-tv-bg text-tv-text';
}

function riskHint(risk: RiskStatus): string {
  const parts = [
    `起始余额 ${fmtMoney(risk.dayStartBalance)}`,
    risk.dailyLossLimit > 0
      ? `今日亏损 ${fmtMoney(risk.dailyLoss)} / 上限 ${fmtMoney(risk.dailyLossLimit)}`
      : '未设置当日亏损上限',
    `今日开仓 ${risk.tradesToday}${risk.maxTrades ? ` / ${risk.maxTrades}` : ''}`,
    `连亏 ${risk.consecutiveLosses}${risk.maxConsecutiveLosses ? ` / ${risk.maxConsecutiveLosses}` : ''}`,
  ];
  if (risk.halted) parts.push(`已停机：${risk.haltReason}`);
  else if (risk.blockReason) parts.push(risk.blockReason);
  return parts.join('\n');
}

const TIMEFRAMES: [string, string][] = [
  ['1', '1m'],
  ['5', '5m'],
  ['15', '15m'],
  ['30', '30m'],
  ['60', '1h'],
  ['240', '4h'],
  ['1D', '1D'],
  ['1W', '1W'],
];

export function TopBar() {
  const conn = useApp((s) => s.conn);
  const health = useApp((s) => s.health);
  const symbols = useApp((s) => s.symbols);
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const resolution = useApp((s) => s.resolution);
  const setResolution = useApp((s) => s.setResolution);
  const quote = useApp((s) => s.quote);
  const account = useApp((s) => s.account);
  const riskStatus = useApp((s) => s.riskStatus);
  const notify = useApp((s) => s.notify);
  const layout = useApp((s) => s.layout);
  const setLayout = useApp((s) => s.setLayout);
  const [confirmKill, setConfirmKill] = useState(false);

  const info = symbols.find((item) => item.name === symbol);
  const online = conn === 'open';
  const terminal = online && !!health?.connected;
  const mode = health?.tradeMode ?? 'readonly';
  const spread = quote && info ? spreadPoints(quote.bid, quote.ask, info.point) : null;
  const realAccount = account?.accountType === 'real';

  const toggleMode = async () => {
    if (!terminal) {
      notify('error', 'MT5 终端未连接');
      return;
    }
    const next = mode === 'readonly' ? 'demo' : 'readonly';
    try {
      await gateway.call('system.setTradeMode', { mode: next });
    } catch (error) {
      notify('error', (error as Error).message);
    }
  };

  const halted = !!riskStatus?.halted;

  const killSwitch = async () => {
    if (!terminal) {
      notify('error', 'MT5 终端未连接');
      return;
    }
    if (halted) {
      try {
        await gateway.call('system.resume', {});
        notify('success', '已恢复交易');
      } catch (error) {
        notify('error', (error as Error).message);
      }
      return;
    }
    if (!confirmKill) {
      setConfirmKill(true);
      window.setTimeout(() => setConfirmKill(false), 4000);
      return;
    }
    setConfirmKill(false);
    try {
      const res = await gateway.call<{ closed?: { error?: string }[] }>('system.halt', {
        closeAll: true,
        reason: '手动急停',
      });
      const closed = res?.closed?.length ?? 0;
      const failed = res?.closed?.filter((item) => item.error).length ?? 0;
      notify(
        failed ? 'error' : 'success',
        failed ? `已停机，${failed} 个仓位平仓失败` : `已停机并平掉 ${closed} 个仓位`,
      );
    } catch (error) {
      notify('error', (error as Error).message);
    }
  };

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-tv-border bg-tv-panel px-3">
      <div className="flex items-center gap-2">
        <span className="text-[15px] font-bold tracking-wide text-tv-text">MyTrade</span>
        <span className="rounded bg-tv-bg px-1 py-0.5 text-[9px] text-tv-muted">MT5</span>
      </div>

      <div className="h-5 w-px bg-tv-border" />

      <select
        value={symbol}
        onChange={(event) => setSymbol(event.target.value)}
        className="h-7 w-[140px] rounded border border-tv-border bg-tv-bg px-2 text-[11px] text-tv-text outline-none focus:border-tv-accent"
      >
        {symbols.length === 0 && <option value="">无品种</option>}
        {symbols.map((item) => (
          <option key={item.name} value={item.name}>
            {item.name} · {item.description}
          </option>
        ))}
      </select>

      {layout === 'single' && (
        <div className="flex items-center gap-0.5">
          {TIMEFRAMES.map(([value, label]) => (
            <button
              key={value}
              onClick={() => setResolution(value)}
              className={clsx(
                'h-6 rounded px-1.5 text-[10px] transition-colors',
                resolution === value
                  ? 'bg-tv-border text-tv-text'
                  : 'text-tv-muted hover:bg-tv-border/60 hover:text-tv-text',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <button
        onClick={() => setLayout(layout === 'single' ? 'quad' : 'single')}
        title={layout === 'single' ? '切换 2×2 多周期同屏（十字线联动）' : '回到单图'}
        className="h-6 rounded bg-tv-bg px-2 text-[10px] text-tv-text hover:bg-tv-border"
      >
        {layout === 'single' ? '四图' : '单图'}
      </button>

      <div className="h-5 w-px bg-tv-border" />

      <div className="flex items-center gap-3 font-mono text-[11px]">
        <span className="flex items-center gap-1">
          <span className="text-tv-muted">Bid</span>
          <span className="text-tv-text">{quote ? fmtPrice(quote.bid, info?.digits ?? 5) : '—'}</span>
        </span>
        <span className="flex items-center gap-1">
          <span className="text-tv-muted">Ask</span>
          <span className="text-tv-text">{quote ? fmtPrice(quote.ask, info?.digits ?? 5) : '—'}</span>
        </span>
        <span className="flex items-center gap-1">
          <span className="text-tv-muted">点差</span>
          <span className="text-tv-text">{spread != null ? spread.toFixed(0) : '—'}</span>
        </span>
      </div>

      <div className="flex-1" />

      <div className="text-right leading-tight">
        <div className="font-mono text-[11px] text-tv-text">余额 {fmtMoney(account?.balance)}</div>
        <div className="font-mono text-[10px] text-tv-muted">净值 {fmtMoney(account?.equity)}</div>
      </div>

      {riskStatus && (
        <div
          title={riskHint(riskStatus)}
          className={clsx(
            'rounded px-2 py-0.5 text-right font-mono leading-tight',
            riskTone(riskStatus),
          )}
        >
          <div className="text-[10px]">
            今日 {fmtSigned(riskStatus.dayPnl)}
            {riskStatus.dailyLossLimit > 0 && (
              <span className="ml-1 opacity-60">/ -{fmtMoney(riskStatus.dailyLossLimit)}</span>
            )}
          </div>
          <div className="text-[9px] opacity-70">
            {halted
              ? '已停机'
              : riskStatus.blockReason
                ? riskStatus.blockReason
                : riskStatus.dailyLossLimit > 0
                  ? `额度剩 ${fmtMoney(riskStatus.remaining)}`
                  : `开仓 ${riskStatus.tradesToday}`}
          </div>
        </div>
      )}

      <button
        onClick={killSwitch}
        disabled={!terminal}
        title={
          halted
            ? `已停机：${riskStatus?.haltReason || '手动停机'}，点击恢复`
            : '一键平掉全部仓位并禁止再开仓'
        }
        className={clsx(
          'h-6 shrink-0 rounded px-2 text-[10px] font-semibold transition-colors',
          halted
            ? 'bg-amber-500 text-black hover:bg-amber-400'
            : confirmKill
              ? 'bg-tv-down text-white'
              : 'bg-tv-down/15 text-tv-down hover:bg-tv-down hover:text-white',
          !terminal && 'cursor-not-allowed opacity-40',
        )}
      >
        {halted ? '恢复交易' : confirmKill ? '确认平仓？' : '急停'}
      </button>

      <button
        onClick={toggleMode}
        disabled={!terminal || realAccount}
        title={realAccount ? '实盘账户需修改 gateway/config.json 开启实盘' : '切换只读 / 模拟可交易'}
        className={clsx(
          'h-6 rounded px-2 text-[10px] font-medium transition-colors',
          mode === 'readonly' && 'bg-tv-border text-tv-text',
          mode === 'demo' && 'bg-emerald-600 text-white',
          mode === 'live' && 'bg-red-600 text-white',
          (!terminal || realAccount) && 'cursor-not-allowed opacity-40',
        )}
      >
        {mode === 'readonly' ? '只读' : mode === 'demo' ? '模拟可交易' : '实盘交易'}
      </button>

      <div className="flex items-center gap-1.5 text-[10px] text-tv-muted">
        <span
          className={clsx(
            'h-2 w-2 rounded-full',
            terminal ? 'bg-tv-up' : online ? 'bg-amber-400' : 'bg-tv-down',
          )}
        />
        {terminal ? '已连接' : online ? '等待终端' : '未连接'}
      </div>
    </header>
  );
}
