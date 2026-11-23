import { useState } from 'react';
import { clsx } from 'clsx';
import { Bell, CalendarDays } from 'lucide-react';
import { cn } from '@/lib/utils';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import { fmtMoney, fmtSigned } from '../lib/format';
import { AccountSwitcher } from './AccountSwitcher';
import { LayoutPickerButton } from './LayoutPicker';
import { SymbolTabs } from './SymbolTabs';
import { Button } from './ui/button';
import { Separator } from './ui/separator';
import type { RiskStatus, TradeMode } from '../gateway/types';

/** 亏损额度使用比例 → 状态点与文字色（绿 → 琥珀 → 红） */
function riskTone(risk: RiskStatus): { dot: string; text: string } {
  if (risk.halted) return { dot: 'bg-destructive', text: 'text-destructive-foreground' };
  if (risk.dailyLossLimit > 0) {
    const used = risk.dailyLoss / risk.dailyLossLimit;
    if (used >= 0.8) return { dot: 'bg-destructive', text: 'text-destructive-foreground' };
    if (used >= 0.5) return { dot: 'bg-warning', text: 'text-warning-foreground' };
  }
  // 冷却 / 次数用尽不算危险，用琥珀色提示即可
  if (!risk.canTrade) return { dot: 'bg-warning', text: 'text-warning-foreground' };
  return { dot: 'bg-success', text: 'text-foreground' };
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
  const account = useApp((s) => s.account);
  const riskStatus = useApp((s) => s.riskStatus);
  const alerts = useApp((s) => s.alerts);
  const alertsOpen = useApp((s) => s.alertsOpen);
  const setAlertsOpen = useApp((s) => s.setAlertsOpen);
  const calendarOpen = useApp((s) => s.calendarOpen);
  const setCalendarOpen = useApp((s) => s.setCalendarOpen);
  const notify = useApp((s) => s.notify);
  const [confirmKill, setConfirmKill] = useState(false);
  const [confirmLive, setConfirmLive] = useState(false);
  const [busy, setBusy] = useState<'mode' | 'kill' | null>(null);

  const online = conn === 'open';
  const terminal = online && !!health?.connected;
  const mode = health?.tradeMode ?? 'readonly';
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
    setBusy('mode');
    try {
      await gateway.call('system.setTradeMode', { mode: next });
      notify('success', next === 'readonly' ? '已切到只读模式' : `已开启${next === 'live' ? '实盘' : '模拟'}交易`);
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const halted = !!riskStatus?.halted;

  const killSwitch = async () => {
    if (!terminal) {
      notify('error', 'MT5 终端未连接');
      return;
    }
    if (halted) {
      setBusy('kill');
      try {
        await gateway.call('system.resume', {});
        notify('success', '已恢复交易');
      } catch (error) {
        notify('error', (error as Error).message);
      } finally {
        setBusy(null);
      }
      return;
    }
    if (!confirmKill) {
      setConfirmKill(true);
      window.setTimeout(() => setConfirmKill(false), 4000);
      return;
    }
    setConfirmKill(false);
    setBusy('kill');
    try {
      const res = await gateway.call<{
        closed?: { error?: string }[];
        cancelled?: { error?: string }[];
      }>('system.halt', {
        closeAll: true,
        reason: '手动急停',
      });
      const closed = res?.closed ?? [];
      const cancelled = res?.cancelled ?? [];
      const closedOk = closed.filter((item) => !item.error).length;
      const cancelledOk = cancelled.filter((item) => !item.error).length;
      const failed = closed.length + cancelled.length - closedOk - cancelledOk;
      notify(
        failed ? 'error' : 'success',
        failed
          ? `已停机，平 ${closedOk} 个、撤 ${cancelledOk} 个挂单，${failed} 个失败`
          : `已停机，平 ${closedOk} 个、撤 ${cancelledOk} 个挂单`,
      );
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const tone = riskStatus ? riskTone(riskStatus) : null;

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-3">
      <LayoutPickerButton />

      <Separator orientation="vertical" className="h-5" />

      <SymbolTabs />

      <Button
        variant={alertsOpen ? 'secondary' : 'ghost'}
        size="sm"
        onClick={() => setAlertsOpen(!alertsOpen)}
        aria-pressed={alertsOpen}
        data-alerts-toggle
        title="价格告警面板"
        className="gap-1.5 px-2 font-normal text-[12px]"
      >
        <Bell size={14} strokeWidth={1.5} />
        告警
        {activeAlerts > 0 && (
          <span className="num font-mono text-[11px] text-muted-foreground/70">{activeAlerts}</span>
        )}
      </Button>

      <Button
        variant={calendarOpen ? 'secondary' : 'ghost'}
        size="sm"
        onClick={() => setCalendarOpen(!calendarOpen)}
        aria-pressed={calendarOpen}
        title="财经日历"
        className="gap-1.5 px-2 font-normal text-[12px]"
      >
        <CalendarDays size={14} strokeWidth={1.5} />
        日历
      </Button>

      <AccountSwitcher />

      <div className="flex shrink-0 items-baseline gap-1.5 border-l border-border pl-3 font-mono text-[12px]">
        <span className="font-sans text-[11px] text-muted-foreground">余额</span>
        <span className="num">{fmtMoney(account?.balance)}</span>
      </div>

      {riskStatus && tone && (
        <div
          title={riskHint(riskStatus)}
          className="flex shrink-0 items-center gap-2 border-l border-border pl-4"
        >
          <span className={clsx('h-1.5 w-1.5 rounded-full', tone.dot)} />
          <div className="leading-tight">
            <div className={clsx('num font-mono text-[12px]', tone.text)}>
              今日 {fmtSigned(riskStatus.dayPnl)}
              {riskStatus.dailyLossLimit > 0 && (
                <span className="ml-1 text-muted-foreground/60">/ -{fmtMoney(riskStatus.dailyLossLimit)}</span>
              )}
            </div>
            <div className="text-[11px] text-muted-foreground">
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

      <Button
        variant={halted ? 'outline' : confirmKill ? 'destructive' : 'destructive-outline'}
        size="sm"
        onClick={() => void killSwitch()}
        disabled={!terminal || busy === 'kill'}
        title={
          halted
            ? `已停机：${riskStatus?.haltReason || '手动停机'}，点击恢复`
            : '一键平掉全部仓位并禁止再开仓'
        }
        className={cn(
          'shrink-0 px-2.5 text-[12px]',
          halted && 'border-warning/40 bg-warning/10 text-warning-foreground hover:bg-warning/15',
          (!terminal || busy === 'kill') && 'cursor-not-allowed opacity-40',
        )}
      >
        {busy === 'kill' ? '处理中…' : halted ? '恢复交易' : confirmKill ? '确认平仓？' : '急停'}
      </Button>

      <Button
        variant={confirmLive ? 'destructive' : 'outline'}
        size="sm"
        onClick={() => void toggleMode()}
        disabled={!terminal || modeLocked || busy === 'mode'}
        title={
          modeLocked
            ? '实盘账户：请先在「设置 → 交易与风控」打开实盘开关'
            : realAccount
              ? '切换只读 / 实盘交易（真实资金）'
              : '切换只读 / 模拟可交易'
        }
        className={cn(
          'px-2.5 text-[12px]',
          !confirmLive && mode === 'readonly' && 'bg-muted text-muted-foreground',
          !confirmLive && mode === 'demo' && 'border-success/35 bg-success/10 text-success-foreground',
          !confirmLive &&
            mode === 'live' &&
            'border-destructive/35 bg-destructive/10 text-destructive-foreground',
          (!terminal || modeLocked || busy === 'mode') && 'cursor-not-allowed opacity-40',
        )}
      >
        {busy === 'mode'
          ? '切换中…'
          : confirmLive
            ? '确认实盘？'
            : mode === 'readonly'
              ? '只读'
              : mode === 'demo'
                ? '模拟可交易'
                : '实盘交易'}
      </Button>

      <div className="flex items-center gap-1.5 pl-1 text-[11px] text-muted-foreground">
        <span
          className={clsx(
            'h-1.5 w-1.5 rounded-full',
            terminal ? 'bg-success' : online ? 'bg-warning' : 'bg-destructive',
          )}
        />
        {terminal ? '已连接' : online ? '等待终端' : '未连接'}
      </div>
    </header>
  );
}
