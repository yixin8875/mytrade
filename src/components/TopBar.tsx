import { useState } from 'react';
import { clsx } from 'clsx';
import { Bell } from 'lucide-react';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import { fmtMoney, fmtPrice, fmtSigned, spreadPoints } from '../lib/format';
import { AccountSwitcher } from './AccountSwitcher';
import { LayoutPickerButton } from './LayoutPicker';
import type { RiskStatus, TradeMode } from '../gateway/types';

/** 亏损额度使用比例 → 状态点与文字色（绿 → 琥珀 → 红） */
function riskTone(risk: RiskStatus): { dot: string; text: string } {
  if (risk.halted) return { dot: 'bg-tv-down', text: 'text-tv-down' };
  if (risk.dailyLossLimit > 0) {
    const used = risk.dailyLoss / risk.dailyLossLimit;
    if (used >= 0.8) return { dot: 'bg-tv-down', text: 'text-tv-down' };
    if (used >= 0.5) return { dot: 'bg-tv-warn', text: 'text-tv-warn' };
  }
  // 冷却 / 次数用尽不算危险，用琥珀色提示即可
  if (!risk.canTrade) return { dot: 'bg-tv-warn', text: 'text-tv-warn' };
  return { dot: 'bg-tv-up', text: 'text-tv-text' };
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

export function TopBar() {
  const conn = useApp((s) => s.conn);
  const health = useApp((s) => s.health);
  const symbols = useApp((s) => s.symbols);
  const symbol = useApp((s) => s.symbol);
  const quote = useApp((s) => s.quote);
  const account = useApp((s) => s.account);
  const riskStatus = useApp((s) => s.riskStatus);
  const alerts = useApp((s) => s.alerts);
  const alertsOpen = useApp((s) => s.alertsOpen);
  const setAlertsOpen = useApp((s) => s.setAlertsOpen);
  const notify = useApp((s) => s.notify);
  const [confirmKill, setConfirmKill] = useState(false);
  const [confirmLive, setConfirmLive] = useState(false);

  const info = symbols.find((item) => item.name === symbol);
  const online = conn === 'open';
  const terminal = online && !!health?.connected;
  const mode = health?.tradeMode ?? 'readonly';
  const spread = quote && info ? spreadPoints(quote.bid, quote.ask, info.point) : null;
  const realAccount = account?.accountType === 'real';
  const allowLive = health?.config?.allow_live ?? false;
  // 实盘账户默认锁在只读，只有配置文件显式开启 allow_live 才允许切换
  const modeLocked = realAccount && !allowLive;
  const activeAlerts = alerts.filter((item) => item.enabled).length;

  const toggleMode = async () => {
    if (!terminal) {
      notify('error', 'MT5 终端未连接');
      return;
    }
    if (modeLocked) {
      notify('error', '实盘账户：请先在「设置 → 交易与风控」打开实盘开关');
      return;
    }
    if (health?.terminal && !health.terminal.tradeAllowed) {
      notify('error', '请在 MT5 工具栏打开 Algo Trading（自动交易）');
      return;
    }
    // 实盘账户切到 live，其它账户切到 demo
    const next: TradeMode = mode === 'readonly' ? (realAccount ? 'live' : 'demo') : 'readonly';
    if (next === 'live' && !confirmLive) {
      setConfirmLive(true);
      window.setTimeout(() => setConfirmLive(false), 4000);
      return;
    }
    setConfirmLive(false);
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

  const tone = riskStatus ? riskTone(riskStatus) : null;

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-tv-border bg-tv-panel px-3">
      <LayoutPickerButton />

      <div className="h-5 w-px bg-tv-border" />

      <div className="flex items-center gap-4 font-mono text-[12px]">
        <span className="flex items-baseline gap-1.5">
          <span className="font-sans text-[11px] text-tv-muted">Bid</span>
          <span className="num">{quote ? fmtPrice(quote.bid, info?.digits ?? 5) : '—'}</span>
        </span>
        <span className="flex items-baseline gap-1.5">
          <span className="font-sans text-[11px] text-tv-muted">Ask</span>
          <span className="num">{quote ? fmtPrice(quote.ask, info?.digits ?? 5) : '—'}</span>
        </span>
        <span className="flex items-baseline gap-1.5">
          <span className="font-sans text-[11px] text-tv-muted">点差</span>
          <span className="num">{spread != null ? spread.toFixed(0) : '—'}</span>
        </span>
      </div>

      <button
        onClick={() => setAlertsOpen(!alertsOpen)}
        aria-pressed={alertsOpen}
        data-alerts-toggle
        title="价格告警面板"
        className={clsx(
          'flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] transition-colors',
          alertsOpen
            ? 'bg-tv-raised text-tv-text'
            : 'text-tv-muted hover:bg-tv-hover hover:text-tv-text',
        )}
      >
        <Bell size={14} strokeWidth={1.5} />
        告警
        {activeAlerts > 0 && (
          <span className="num font-mono text-[11px] text-tv-faint">{activeAlerts}</span>
        )}
      </button>

      <div className="flex-1" />

      <AccountSwitcher />

      <div className="flex items-baseline gap-4 border-l border-tv-border pl-4 font-mono text-[12px]">
        <span className="flex items-baseline gap-1.5">
          <span className="font-sans text-[11px] text-tv-muted">余额</span>
          <span className="num">{fmtMoney(account?.balance)}</span>
        </span>
        <span className="flex items-baseline gap-1.5">
          <span className="font-sans text-[11px] text-tv-muted">净值</span>
          <span className="num text-tv-muted">{fmtMoney(account?.equity)}</span>
        </span>
      </div>

      {riskStatus && tone && (
        <div
          title={riskHint(riskStatus)}
          className="flex items-center gap-2 border-l border-tv-border pl-4"
        >
          <span className={clsx('h-1.5 w-1.5 rounded-full', tone.dot)} />
          <div className="leading-tight">
            <div className={clsx('num font-mono text-[12px]', tone.text)}>
              今日 {fmtSigned(riskStatus.dayPnl)}
              {riskStatus.dailyLossLimit > 0 && (
                <span className="ml-1 text-tv-faint">/ -{fmtMoney(riskStatus.dailyLossLimit)}</span>
              )}
            </div>
            <div className="text-[11px] text-tv-muted">
              {halted
                ? '已停机'
                : riskStatus.blockReason
                  ? riskStatus.blockReason
                  : riskStatus.dailyLossLimit > 0
                    ? `额度剩 ${fmtMoney(riskStatus.remaining)}`
                    : `开仓 ${riskStatus.tradesToday}`}
            </div>
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
          'h-7 shrink-0 rounded-lg border px-2.5 text-[12px] font-medium transition-colors',
          halted
            ? 'border-tv-warn/40 bg-tv-warn-soft text-tv-warn hover:bg-tv-warn/15'
            : confirmKill
              ? 'border-tv-down bg-tv-down text-white'
              : 'border-tv-down/35 text-tv-down hover:bg-tv-down-soft',
          !terminal && 'cursor-not-allowed opacity-40',
        )}
      >
        {halted ? '恢复交易' : confirmKill ? '确认平仓？' : '急停'}
      </button>

      <button
        onClick={toggleMode}
        disabled={!terminal || modeLocked}
        title={
          modeLocked
            ? '实盘账户：请先在「设置 → 交易与风控」打开实盘开关'
            : realAccount
              ? '切换只读 / 实盘交易（真实资金）'
              : '切换只读 / 模拟可交易'
        }
        className={clsx(
          'h-7 rounded-lg border px-2.5 text-[12px] font-medium transition-colors',
          mode === 'readonly' && 'border-tv-border bg-tv-raised text-tv-muted',
          mode === 'demo' && 'border-tv-up/35 bg-tv-up-soft text-tv-up',
          mode === 'live' && 'border-tv-down/35 bg-tv-down-soft text-tv-down',
          confirmLive && 'border-tv-down bg-tv-down text-white',
          (!terminal || modeLocked) && 'cursor-not-allowed opacity-40',
        )}
      >
        {confirmLive
          ? '确认实盘？'
          : mode === 'readonly'
            ? '只读'
            : mode === 'demo'
              ? '模拟可交易'
              : '实盘交易'}
      </button>

      <div className="flex items-center gap-1.5 pl-1 text-[11px] text-tv-muted">
        <span
          className={clsx(
            'h-1.5 w-1.5 rounded-full',
            terminal ? 'bg-tv-up' : online ? 'bg-tv-warn' : 'bg-tv-down',
          )}
        />
        {terminal ? '已连接' : online ? '等待终端' : '未连接'}
      </div>
    </header>
  );
}
