import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { clsx } from 'clsx';
import { ChevronDown, ChevronUp, RefreshCw, X } from 'lucide-react';
import { gateway } from '../gateway/client';
import { useApp, type DockTab } from '../store/useApp';
import {
  fmtMoney,
  fmtPrice,
  fmtSigned,
  fmtVolume,
  roundVolume,
  signedClass,
} from '../lib/format';
import { validateStops } from '../lib/stops';
import {
  activeSteps,
  equalSharePercent,
  MAX_PLAN_STEPS,
  nextStepPrice,
  validatePlanStep,
} from '../lib/plan';
import { cancelOrderWithUndo } from '../lib/orderActions';
import type {
  BreakevenResult,
  FlattenResult,
  JournalRecord,
  Order,
  Position,
  PositionPlanStep,
} from '../gateway/types';
import { Button } from './ui/button';
import { Tabs, TabsList, TabsTab } from './ui/tabs';

interface Deal {
  ticket: number;
  order: number;
  positionId: number;
  symbol: string;
  side: 'buy' | 'sell';
  volume: number;
  price: number;
  profit: number;
  commission: number;
  swap: number;
  time: number;
  comment: string;
  magic: number;
  entry: number;
}

const TABS: { key: DockTab; label: string }[] = [
  { key: 'positions', label: '持仓' },
  { key: 'orders', label: '挂单' },
  { key: 'deals', label: '成交' },
  { key: 'closed', label: '已平仓' },
];

// 操作列要同时放下「保本 / 平掉一半 / 平仓」三个按钮。
// 按钮的 text-[10px] 会被基类的 sm:text-sm 顶成 14px，所以还要加 sm:text-[10px]
// 压回 10px；否则三个按钮约 144px，90px 的操作列装不下，会向左盖住盈亏数字。
// 其余列按比例分配宽度并带最小宽度：窗口变窄时一起收缩、变宽时一起铺开，
// 不会像固定 112px + 单列 1fr 那样把空档全堆在「品种/方向」和「手数」之间。
const GRID_POSITION =
  'grid-cols-[minmax(96px,1.2fr)_minmax(52px,0.8fr)_minmax(64px,1fr)_minmax(76px,1fr)_minmax(76px,1fr)_minmax(76px,1fr)_minmax(82px,1fr)_minmax(112px,1fr)]';
// 三张记录表沿用持仓表的思路：每列带最小宽度按比例铺开。
// 原来的固定宽度 + 单列 1fr 在宽托盘上会把空档全堆进「类型 / 品种」列，
// 窄托盘上又把那一列压到放不下文字，表头和数据一起挤位。
const GRID_ORDER =
  'grid-cols-[minmax(96px,1.2fr)_minmax(60px,0.8fr)_minmax(52px,0.7fr)_minmax(72px,1fr)_minmax(80px,1fr)_minmax(80px,1fr)_minmax(72px,0.9fr)_minmax(68px,0.8fr)]';
const GRID_DEAL =
  'grid-cols-[minmax(92px,0.9fr)_minmax(96px,1.4fr)_minmax(44px,0.6fr)_minmax(52px,0.7fr)_minmax(76px,1fr)_minmax(76px,1fr)_minmax(88px,1.1fr)_minmax(56px,0.6fr)]';
const GRID_CLOSED =
  'grid-cols-[minmax(92px,1fr)_minmax(96px,1.3fr)_minmax(44px,0.5fr)_minmax(52px,0.6fr)_minmax(140px,1.6fr)_minmax(76px,1fr)_minmax(56px,0.6fr)_minmax(48px,0.5fr)]';

function fmtTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  const date = new Date(ts * 1000);
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** 交易台底部托盘：持仓 / 挂单 / 成交 / 已平仓，高度可拖、可收起 */
export function TradeDock() {
  const positions = useApp((s) => s.positions);
  const orders = useApp((s) => s.orders);
  const symbols = useApp((s) => s.symbols);
  const symbol = useApp((s) => s.symbol);
  const quote = useApp((s) => s.quote);
  const notify = useApp((s) => s.notify);
  const breakevenOffset = useApp((s) => s.breakevenOffset);
  const dockTab = useApp((s) => s.dockTab);
  const setDockTab = useApp((s) => s.setDockTab);
  const dockHeight = useApp((s) => s.dockHeight);
  const setDockHeight = useApp((s) => s.setDockHeight);
  const dockCollapsed = useApp((s) => s.dockCollapsed);
  const setDockCollapsed = useApp((s) => s.setDockCollapsed);

  const [busy, setBusy] = useState<number | null>(null);
  const [confirmClose, setConfirmClose] = useState<number | null>(null);
  const [confirmHalf, setConfirmHalf] = useState<number | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [confirmFlatten, setConfirmFlatten] = useState(false);
  const [detailFor, setDetailFor] = useState<number | null>(null);
  const [slInput, setSlInput] = useState('');
  const [tpInput, setTpInput] = useState('');
  const [trailDist, setTrailDist] = useState('20');
  const [deals, setDeals] = useState<Deal[]>([]);
  const [closed, setClosed] = useState<JournalRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const infoOf = (name: string) => symbols.find((item) => item.name === name);
  const digitsOf = (name: string) => infoOf(name)?.digits ?? 5;

  const priceOf = (position: Position): number | null => {
    if (quote?.symbol !== position.symbol) return null;
    return position.side === 'buy' ? quote.bid : quote.ask;
  };

  const loadHistory = useCallback(async () => {
    if (dockTab !== 'deals' && dockTab !== 'closed') return;
    setLoading(true);
    try {
      if (dockTab === 'deals') {
        const rows = await gateway.call<Deal[]>('executions.get', { days: 7, limit: 100 });
        setDeals(rows);
      } else {
        const rows = await gateway.call<JournalRecord[]>('journal.list', { days: 30, limit: 100 });
        setClosed(rows);
      }
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [dockTab, notify]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory, tick]);

  const close = async (ticket: number) => {
    if (confirmClose !== ticket) {
      setConfirmClose(ticket);
      window.setTimeout(
        () => setConfirmClose((current) => (current === ticket ? null : current)),
        4000,
      );
      return;
    }
    setConfirmClose(null);
    setBusy(ticket);
    try {
      await gateway.call('position.close', { ticket });
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const breakeven = async (position: Position) => {
    setBusy(position.ticket);
    try {
      const res = await gateway.call<BreakevenResult>('position.breakeven', {
        ticket: position.ticket,
        offsetPoints: breakevenOffset,
      });
      if (res.changed)
        notify('success', `止损已移到开仓价 ${fmtPrice(res.sl, digitsOf(position.symbol))}`);
      else if (res.reason === 'not_in_profit') notify('info', '当前未回本，止损保持原值');
      else if (res.reason === 'too_close') notify('info', '离保本还差一点，止损保持原值');
      else notify('info', '止损已经在开仓价或更好，无需移动');
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const closeHalf = async (position: Position) => {
    const info = infoOf(position.symbol);
    const step = info?.volumeStep ?? 0.01;
    const min = info?.minVolume ?? 0.01;
    const half = roundVolume(position.volume / 2, step, min, position.volume);
    if (half >= position.volume - 1e-9) {
      notify('error', '仓位已经是最小手数，无法分批');
      return;
    }
    if (confirmHalf !== position.ticket) {
      setConfirmHalf(position.ticket);
      window.setTimeout(
        () => setConfirmHalf((current) => (current === position.ticket ? null : current)),
        4000,
      );
      return;
    }
    setConfirmHalf(null);
    setBusy(position.ticket);
    try {
      const res = await gateway.call<{ volume?: number; breakeven?: BreakevenResult }>(
        'position.close',
        {
          ticket: position.ticket,
          volume: half,
          moveToBe: true,
          beOffsetPoints: breakevenOffset,
        },
      );
      const done = res?.volume ?? half;
      notify(
        'success',
        `已平 ${done} 手${res?.breakeven?.changed ? '，剩余仓位止损移到开仓价' : ''}`,
      );
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const closeAll = async () => {
    if (!confirmAll) {
      setConfirmAll(true);
      window.setTimeout(() => setConfirmAll(false), 4000);
      return;
    }
    setConfirmAll(false);
    try {
      const res = await gateway.call<{ results?: { error?: string }[] }>('position.closeAll', {});
      const results = res?.results ?? [];
      const failed = results.filter((item) => item.error).length;
      notify(
        failed ? 'error' : 'success',
        failed
          ? `已平 ${results.length - failed} 个，${failed} 个失败`
          : `已平掉 ${results.length} 个仓位`,
      );
    } catch (error) {
      notify('error', (error as Error).message);
    }
  };

  const flatten = async () => {
    if (!symbol) return;
    if (!confirmFlatten) {
      setConfirmFlatten(true);
      window.setTimeout(() => setConfirmFlatten(false), 4000);
      return;
    }
    setConfirmFlatten(false);
    try {
      const res = await gateway.call<FlattenResult>('trade.flatten', { symbol });
      const cancelled = res?.cancelled ?? [];
      const done = res?.closed ?? [];
      const failed = [...cancelled, ...done].filter((item) => item.error).length;
      notify(
        failed ? 'error' : 'success',
        `已清 ${symbol}：平 ${done.filter((i) => !i.error).length} 个、撤 ${
          cancelled.filter((i) => !i.error).length
        } 个${failed ? `，${failed} 个失败` : ''}`,
      );
    } catch (error) {
      notify('error', (error as Error).message);
    }
  };

  const openDetail = (position: Position) => {
    if (detailFor === position.ticket) {
      setDetailFor(null);
      return;
    }
    setDetailFor(position.ticket);
    setSlInput(position.sl != null ? position.sl.toFixed(digitsOf(position.symbol)) : '');
    setTpInput(position.tp != null ? position.tp.toFixed(digitsOf(position.symbol)) : '');
    setTrailDist(position.trailing ? String(position.trailing.distancePoints) : '20');
  };

  const saveStops = async (position: Position) => {
    const info = infoOf(position.symbol);
    const parse = (value: string) => (value.trim() === '' ? 0 : Number(value));
    const sl = parse(slInput);
    const tp = parse(tpInput);
    if (!Number.isFinite(sl) || !Number.isFinite(tp) || sl < 0 || tp < 0) {
      notify('error', '止损/止盈价格格式不对');
      return;
    }
    const ref =
      quote?.symbol === position.symbol
        ? position.side === 'buy'
          ? quote.bid
          : quote.ask
        : position.openPrice;
    const problem = validateStops(position.side, ref, sl, tp, {
      stopsLevel: info?.stopsLevelPoints ?? 0,
      point: info?.point ?? 0,
    });
    if (problem) {
      notify('error', problem);
      return;
    }
    setBusy(position.ticket);
    try {
      await gateway.call('position.modify', { ticket: position.ticket, sl, tp });
      notify('success', sl || tp ? '止损/止盈已更新' : '已清除止损和止盈');
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const applyTrailing = async (position: Position) => {
    const distance = Number(trailDist);
    if (!Number.isFinite(distance) || distance <= 0) {
      notify('error', '请输入大于 0 的点数');
      return;
    }
    setBusy(position.ticket);
    try {
      await gateway.call('position.trailing.set', {
        ticket: position.ticket,
        distancePoints: distance,
        stepPoints: 1,
      });
      notify('success', `移动止损已启动：止损跟随价格 ${distance} 点`);
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const clearTrailing = async (position: Position) => {
    setBusy(position.ticket);
    try {
      await gateway.call('position.trailing.clear', { ticket: position.ticket });
      notify('info', '已取消移动止损');
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  /** 把未完成的档位改成等分：有最终止盈时它也算一份 */
  const equalizePlan = async (position: Position) => {
    const active = activeSteps(position.plan);
    if (active.length === 0) {
      notify('info', '还没有分批档位');
      return;
    }
    const shares = active.length + (position.tp != null ? 1 : 0);
    const percent = equalSharePercent(shares);
    setBusy(position.ticket);
    try {
      for (const step of active) {
        if (
          step.closePercent == null ||
          Math.abs(step.closePercent - percent) < 0.005
        ) {
          continue;
        }
        await gateway.call('position.plan.update', {
          ticket: position.ticket,
          stepId: step.id,
          closePercent: percent,
        });
      }
      notify(
        'success',
        `已均分：每档 ${percent}%${position.tp != null ? '，最终止盈拿剩余' : ''}`,
      );
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const addPlanStep = async (position: Position) => {
    const info = infoOf(position.symbol);
    const plan = position.plan ?? null;
    const active = activeSteps(plan);
    if (active.length >= MAX_PLAN_STEPS) {
      notify('info', `最多添加 ${MAX_PLAN_STEPS} 档分批止盈`);
      return;
    }
    const price = nextStepPrice(position, plan, info);
    // 新增后按「档位 + 最终止盈」均分：两档 + 止盈就是每档 1/3
    const shares = active.length + 1 + (position.tp != null ? 1 : 0);
    const percent = equalSharePercent(shares);
    // 校验时把现有档位虚拟成目标比例，否则合计会误判超过 100%
    const draftPlan = plan
      ? {
          ...plan,
          steps: plan.steps.map((step) =>
            step.done || step.skipped ? step : { ...step, closePercent: percent },
          ),
        }
      : null;
    const problem = validatePlanStep({ price, closePercent: percent }, position, draftPlan, info);
    if (problem) {
      notify('error', problem);
      return;
    }
    setBusy(position.ticket);
    try {
      await gateway.call('position.plan.add', {
        ticket: position.ticket,
        price,
        closePercent: percent,
        breakevenOffsetPoints: breakevenOffset,
      });
      // 新增一档后把已有档位一起均分，避免新档按 1/3、旧档还停在 50%
      for (const step of active) {
        if (
          step.closePercent == null ||
          Math.abs(step.closePercent - percent) < 0.005
        ) {
          continue;
        }
        await gateway.call('position.plan.update', {
          ticket: position.ticket,
          stepId: step.id,
          closePercent: percent,
        });
      }
      notify(
        'success',
        `已添加分批：${fmtPrice(price, info?.digits ?? 5)}，每档 ${percent}%`,
      );
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const clearPlan = async (position: Position) => {
    setBusy(position.ticket);
    try {
      await gateway.call('position.plan.clear', { ticket: position.ticket });
      notify('info', '已清空分批止盈');
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const removePlanStep = async (position: Position, planStep: PositionPlanStep) => {
    setBusy(position.ticket);
    try {
      await gateway.call('position.plan.remove', { ticket: position.ticket, stepId: planStep.id });
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = { startY: event.clientY, startHeight: useApp.getState().dockHeight };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setDockHeight(drag.startHeight - (event.clientY - drag.startY));
  };
  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
  };

  const counts: Record<DockTab, number> = {
    positions: positions.length,
    orders: orders.length,
    deals: deals.length,
    closed: closed.length,
  };

  return (
    <section
      className="relative flex shrink-0 flex-col border-t border-border bg-card"
      style={{ height: dockCollapsed ? 32 : dockHeight }}
      data-dock
    >
      {!dockCollapsed && (
        <div
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          className="absolute -top-[3px] left-0 right-0 z-10 h-[6px] cursor-ns-resize hover:bg-brand/30"
          title="拖动调整高度"
          aria-hidden="true"
        />
      )}

      {!dockCollapsed && (
      <div className="flex h-8 shrink-0 items-stretch border-b border-border bg-muted/50 pl-1">
        <Tabs
          value={dockTab}
          onValueChange={(next) => {
            if (
              next === 'positions' ||
              next === 'orders' ||
              next === 'deals' ||
              next === 'closed'
            ) {
              setDockTab(next);
            }
          }}
          className="min-w-0 flex-1 gap-0"
        >
          <TabsList
            variant="underline"
            className="h-full w-full justify-start gap-0.5 rounded-none px-0"
          >
            {TABS.map((tab) => (
              <TabsTab key={tab.key} value={tab.key} className="h-6 gap-1.5 px-3 text-[12px]">
                {tab.label}
                <span className="num font-mono text-[10px] text-muted-foreground/60">
                  {counts[tab.key]}
                </span>
              </TabsTab>
            ))}
          </TabsList>
        </Tabs>

        <div className="ml-auto flex items-center gap-1 px-1">
          {dockTab === 'positions' && (
            <>
              <Button
                variant={confirmFlatten ? 'destructive' : 'ghost'}
                size="xs"
                onClick={() => void flatten()}
                disabled={!symbol}
                title={
                  symbol
                    ? `平掉 ${symbol} 的全部持仓，并撤销该品种挂单`
                    : '平掉当前品种的全部持仓，并撤销挂单'
                }
                className={clsx(
                  'whitespace-nowrap px-2 text-[11px]',
                  !confirmFlatten && 'text-destructive-foreground hover:bg-destructive/10',
                )}
              >
                {confirmFlatten
                  ? symbol
                    ? `确认平掉 ${symbol} 全部？`
                    : '确认平掉当前品种全部？'
                  : symbol
                    ? `平掉 ${symbol} 全部`
                    : '平掉当前品种全部'}
              </Button>
              <Button
                variant={confirmAll ? 'destructive' : 'ghost'}
                size="xs"
                onClick={() => void closeAll()}
                title="平掉账户里所有品种的持仓"
                className={clsx(
                  'whitespace-nowrap px-2 text-[11px]',
                  !confirmAll && 'text-muted-foreground',
                )}
              >
                {confirmAll ? '确认平掉所有品种？' : '平掉账户全部'}
              </Button>
            </>
          )}
          {(dockTab === 'deals' || dockTab === 'closed') && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setTick((value) => value + 1)}
              disabled={loading}
              title="刷新"
              aria-label="刷新历史"
              className="text-muted-foreground"
            >
              <RefreshCw
                size={13}
                strokeWidth={1.5}
                className={loading ? 'animate-spin' : undefined}
              />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setDockCollapsed(!dockCollapsed)}
            title={dockCollapsed ? '展开托盘' : '收起托盘'}
            aria-label={dockCollapsed ? '展开托盘' : '收起托盘'}
            className="text-muted-foreground"
          >
            {dockCollapsed ? (
              <ChevronUp size={14} strokeWidth={1.5} />
            ) : (
              <ChevronDown size={14} strokeWidth={1.5} />
            )}
          </Button>
        </div>
      </div>
      )}

      {dockCollapsed ? (
        <button
          onClick={() => setDockCollapsed(false)}
          aria-label="展开托盘"
          title="展开托盘"
          className="flex h-full flex-1 items-center gap-2 px-3 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <span className="truncate">
            持仓 {positions.length} · 挂单 {orders.length} · 盈亏{' '}
            <span className={clsx('num font-mono', signedClass(totalProfit(positions)))}>
              {fmtSigned(totalProfit(positions))}
            </span>
          </span>
          <ChevronUp size={14} strokeWidth={1.5} className="ml-auto shrink-0" />
        </button>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {dockTab === 'positions' && (
            <>
              <div
                className={clsx(
                  'sticky top-0 z-[1] grid items-center gap-2 border-b border-border bg-card px-2 py-1 text-[10px] text-muted-foreground/60',
                  GRID_POSITION,
                )}
              >
                <span>品种 / 方向</span>
                <span className="text-right">手数</span>
                <span className="text-right">开仓价</span>
                <span className="text-right">现价</span>
                <span className="text-right">止损</span>
                <span className="text-right">止盈</span>
                <span className="text-right">盈亏</span>
                <span className="text-right">操作</span>
              </div>
              {positions.length === 0 && (
                <div className="px-3 py-4 text-[12px] text-muted-foreground">当前没有持仓</div>
              )}
              {positions.map((position) => {
                const info = infoOf(position.symbol);
                const digits = info?.digits ?? 5;
                const current = priceOf(position);
                const expanded = detailFor === position.ticket;
                return (
                  <div key={position.ticket} className="border-b border-border/60">
                    <div
                      className={clsx(
                        'grid h-9 items-center gap-2 px-2 text-[11px] hover:bg-accent/40',
                        GRID_POSITION,
                      )}
                    >
                      <button
                        onClick={() => openDetail(position)}
                        className="flex min-w-0 items-center gap-1.5 text-left"
                        title="点击展开止损/止盈、移动止损与分批计划"
                      >
                        <span
                          className={clsx(
                            'rounded px-1 py-0.5 text-[10px] font-medium',
                            position.side === 'buy'
                              ? 'bg-success/10 text-success-foreground'
                              : 'bg-destructive/10 text-destructive-foreground',
                          )}
                        >
                          {position.side === 'buy' ? '多' : '空'}
                        </span>
                        <span className="truncate font-medium text-foreground">{position.symbol}</span>
                      </button>
                      <span className="num text-right font-mono text-foreground">
                        {fmtVolume(position.volume, info?.volumeStep ?? 0.01)}
                      </span>
                      <span className="num text-right font-mono text-muted-foreground">
                        {fmtPrice(position.openPrice, digits)}
                      </span>
                      <span className="num text-right font-mono text-foreground">
                        {fmtPrice(current, digits)}
                      </span>
                      <span className="num text-right font-mono text-warning-foreground">
                        {position.sl != null ? fmtPrice(position.sl, digits) : '—'}
                      </span>
                      <span className="num text-right font-mono text-brand">
                        {position.tp != null ? fmtPrice(position.tp, digits) : '—'}
                      </span>
                      <span
                        className={clsx('num text-right font-mono', signedClass(position.profit))}
                      >
                        {fmtSigned(position.profit)}
                      </span>
                      <span className="flex min-w-0 items-center justify-end gap-0.5">
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => void breakeven(position)}
                          disabled={busy === position.ticket}
                          className="shrink-0 px-1 text-[10px] sm:text-[10px] text-muted-foreground"
                        >
                          保本
                        </Button>
                        <Button
                          variant={confirmHalf === position.ticket ? 'destructive' : 'ghost'}
                          size="xs"
                          onClick={() => void closeHalf(position)}
                          disabled={busy === position.ticket}
                          className={clsx(
                            'shrink-0 px-1 text-[10px] sm:text-[10px]',
                            confirmHalf !== position.ticket && 'text-muted-foreground',
                          )}
                        >
                          {confirmHalf === position.ticket ? '确认？' : '平掉一半'}
                        </Button>
                        <Button
                          variant={confirmClose === position.ticket ? 'destructive' : 'ghost'}
                          size="xs"
                          onClick={() => void close(position.ticket)}
                          disabled={busy === position.ticket}
                          className={clsx(
                            'shrink-0 px-1 text-[10px] sm:text-[10px]',
                            confirmClose !== position.ticket &&
                              'text-destructive-foreground hover:bg-destructive/10',
                          )}
                        >
                          {confirmClose === position.ticket ? '确认？' : '平仓'}
                        </Button>
                      </span>
                    </div>

                    {expanded && (
                      <div className="grid grid-cols-[1fr_1fr_1fr] gap-3 border-t border-border/60 bg-muted/40 px-3 py-2">
                        <div>
                          <div className="mb-1 text-[10px] text-muted-foreground/60">止损 / 止盈</div>
                          <div className="flex items-center gap-1">
                            <input
                              value={slInput}
                              onChange={(event) => setSlInput(event.target.value)}
                              placeholder="止损"
                              aria-label={`${position.symbol} 止损价`}
                              className="h-6 w-[78px] rounded border border-border bg-card px-1.5 font-mono text-[11px] text-warning-foreground outline-none focus:border-brand"
                            />
                            <input
                              value={tpInput}
                              onChange={(event) => setTpInput(event.target.value)}
                              placeholder="止盈"
                              aria-label={`${position.symbol} 止盈价`}
                              className="h-6 w-[78px] rounded border border-border bg-card px-1.5 font-mono text-[11px] text-brand outline-none focus:border-brand"
                            />
                            <Button
                              size="xs"
                              onClick={() => void saveStops(position)}
                              disabled={busy === position.ticket}
                              className="px-2 text-[10px]"
                            >
                              保存
                            </Button>
                          </div>
                        </div>

                        <div>
                          <div className="mb-1 text-[10px] text-muted-foreground/60">
                            移动止损
                            {position.trailing ? `（${position.trailing.distancePoints} 点）` : ''}
                          </div>
                          <div className="flex items-center gap-1">
                            <input
                              value={trailDist}
                              onChange={(event) => setTrailDist(event.target.value)}
                              inputMode="decimal"
                              aria-label={`${position.symbol} 移动止损距离`}
                              className="h-6 w-[64px] rounded border border-border bg-card px-1.5 font-mono text-[11px] text-foreground outline-none focus:border-brand"
                            />
                            <span className="text-[10px] text-muted-foreground/60">点</span>
                            <Button
                              variant="secondary"
                              size="xs"
                              onClick={() => void applyTrailing(position)}
                              disabled={busy === position.ticket}
                              className="px-2 text-[10px]"
                            >
                              {position.trailing ? '更新' : '启动'}
                            </Button>
                            {position.trailing && (
                              <Button
                                variant="ghost"
                                size="xs"
                                onClick={() => void clearTrailing(position)}
                                disabled={busy === position.ticket}
                                className="px-1.5 text-[10px] text-muted-foreground hover:text-destructive-foreground"
                              >
                                取消
                              </Button>
                            )}
                          </div>
                        </div>

                        <div>
                          <div
                            className="mb-1 flex items-center gap-1.5 text-[10px] text-muted-foreground/60"
                            title="比例按开仓手数计；有最终止盈时它也算一份"
                          >
                            分批止盈
                            {position.plan && position.plan.steps.length > 0 && (
                              <span className="text-muted-foreground">
                                {
                                  position.plan.steps.filter((s) => !s.done && !s.skipped)
                                    .length
                                }{' '}
                                档
                              </span>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-1">
                            <Button
                              variant="secondary"
                              size="xs"
                              onClick={() => void addPlanStep(position)}
                              disabled={busy === position.ticket}
                              className="px-2 text-[10px]"
                            >
                              ＋ 加一档
                            </Button>
                            <Button
                              variant="ghost"
                              size="xs"
                              onClick={() => void equalizePlan(position)}
                              disabled={
                                busy === position.ticket ||
                                !position.plan?.steps.some((step) => !step.done && !step.skipped)
                              }
                              title="按开仓手数均分；有最终止盈时它也占一份"
                              className="px-1.5 text-[10px] text-muted-foreground"
                            >
                              均分
                            </Button>
                            {position.plan && position.plan.steps.length > 0 && (
                              <Button
                                variant="ghost"
                                size="xs"
                                onClick={() => void clearPlan(position)}
                                disabled={busy === position.ticket}
                                className="px-1.5 text-[10px] text-muted-foreground hover:text-destructive-foreground"
                              >
                                清空
                              </Button>
                            )}
                            {position.plan?.steps.map((step) => (
                              <span
                                key={step.id}
                                className={clsx(
                                  'flex items-center gap-1 rounded bg-card px-1.5 py-0.5 font-mono text-[10px]',
                                  step.done || step.skipped
                                    ? 'text-muted-foreground/60 line-through'
                                    : 'text-foreground',
                                )}
                                title={
                                  step.done ? '已执行' : step.skipped ? '已跳过' : '等待触发'
                                }
                              >
                                {fmtPrice(step.price, digits)} ·{' '}
                                {Number((step.closePercent ?? 50).toFixed(2))}%
                                {!step.done && !step.skipped && (
                                  <button
                                    onClick={() => void removePlanStep(position, step)}
                                    aria-label={`删除 ${step.price} 分批`}
                                    className="text-muted-foreground/60 hover:text-destructive-foreground"
                                  >
                                    <X size={10} strokeWidth={2} />
                                  </button>
                                )}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}

          {dockTab === 'orders' && (
            <>
              <div
                className={clsx(
                  'sticky top-0 z-[1] grid items-center gap-2 border-b border-border bg-card px-2 py-1 text-[10px] text-muted-foreground/60',
                  GRID_ORDER,
                )}
              >
                <span>品种 / 方向</span>
                <span>类型</span>
                <span className="text-right">手数</span>
                <span className="text-right">委托价</span>
                <span className="text-right">止损</span>
                <span className="text-right">止盈</span>
                <span className="text-right">状态</span>
                <span className="text-right">操作</span>
              </div>
              {orders.length === 0 && (
                <div className="px-3 py-4 text-[12px] text-muted-foreground">当前没有挂单</div>
              )}
              {orders.map((order) => {
                const info = infoOf(order.symbol);
                const digits = info?.digits ?? 5;
                return (
                  <div
                    key={order.ticket}
                    className={clsx(
                      'grid h-9 items-center gap-2 border-b border-border/60 px-2 text-[11px] hover:bg-accent/40',
                      GRID_ORDER,
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                        {order.side === 'buy' ? '买' : '卖'}
                      </span>
                      <span className="truncate font-medium text-foreground">{order.symbol}</span>
                    </span>
                    <span className="text-muted-foreground">{orderTypeLabel(order.type)}</span>
                    <span className="num text-right font-mono text-foreground">
                      {fmtVolume(order.volume, info?.volumeStep ?? 0.01)}
                    </span>
                    <span className="num text-right font-mono text-foreground">
                      {fmtPrice(order.price, digits)}
                    </span>
                    <span className="num text-right font-mono text-warning-foreground">
                      {order.sl != null ? fmtPrice(order.sl, digits) : '—'}
                    </span>
                    <span className="num text-right font-mono text-brand">
                      {order.tp != null ? fmtPrice(order.tp, digits) : '—'}
                    </span>
                    <span className="text-right text-muted-foreground">{order.state || '—'}</span>
                    <span className="text-right">
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => void cancelOrderWithUndo(order, notify)}
                        className="shrink-0 px-1 text-[10px] sm:text-[10px] text-destructive-foreground hover:bg-destructive/10"
                      >
                        撤单
                      </Button>
                    </span>
                  </div>
                );
              })}
            </>
          )}

          {dockTab === 'deals' && (
            <>
              <div
                className={clsx(
                  'sticky top-0 z-[1] grid items-center gap-2 border-b border-border bg-card px-2 py-1 text-[10px] text-muted-foreground/60',
                  GRID_DEAL,
                )}
              >
                <span>时间</span>
                <span>品种</span>
                <span>方向</span>
                <span className="text-right">手数</span>
                <span className="text-right">价格</span>
                <span className="text-right">盈亏</span>
                <span className="text-right">手续费/库存</span>
                <span className="text-right">类型</span>
              </div>
              {deals.length === 0 && (
                <div className="px-3 py-4 text-[12px] text-muted-foreground">
                  {loading ? '加载成交记录…' : '最近 7 天没有成交'}
                </div>
              )}
              {deals.map((deal) => (
                <div
                  key={`${deal.ticket}`}
                  className={clsx(
                    'grid h-8 items-center gap-2 border-b border-border/60 px-2 text-[11px] hover:bg-accent/40',
                    GRID_DEAL,
                  )}
                >
                  <span className="num font-mono text-muted-foreground">{fmtTime(deal.time)}</span>
                  <span className="truncate font-medium text-foreground">{deal.symbol}</span>
                  <span className={deal.side === 'buy' ? 'text-success-foreground' : 'text-destructive-foreground'}>
                    {deal.side === 'buy' ? '买' : '卖'}
                  </span>
                  <span className="num text-right font-mono text-foreground">
                    {deal.volume.toFixed(2)}
                  </span>
                  <span className="num text-right font-mono text-foreground">{deal.price}</span>
                  <span className={clsx('num text-right font-mono', signedClass(deal.profit))}>
                    {fmtSigned(deal.profit)}
                  </span>
                  <span className="num text-right font-mono text-muted-foreground">
                    {fmtMoney(deal.commission + deal.swap)}
                  </span>
                  <span className="text-right text-[10px] text-muted-foreground">
                    {deal.entry === 0 ? '开仓' : deal.entry === 1 ? '平仓' : '—'}
                  </span>
                </div>
              ))}
            </>
          )}

          {dockTab === 'closed' && (
            <>
              <div
                className={clsx(
                  'sticky top-0 z-[1] grid items-center gap-2 border-b border-border bg-card px-2 py-1 text-[10px] text-muted-foreground/60',
                  GRID_CLOSED,
                )}
              >
                <span>平仓时间</span>
                <span>品种</span>
                <span>方向</span>
                <span className="text-right">手数</span>
                <span className="text-right">开仓 → 平仓</span>
                <span className="text-right">净盈亏</span>
                <span className="text-right">原因</span>
                <span className="text-right">持续</span>
              </div>
              {closed.length === 0 && (
                <div className="px-3 py-4 text-[12px] text-muted-foreground">
                  {loading ? '加载已平仓记录…' : '最近 30 天没有已平仓交易'}
                </div>
              )}
              {closed.map((row) => {
                const digits = digitsOf(row.symbol);
                const net = row.profit + row.swap + row.commission;
                return (
                  <div
                    key={row.position_id}
                    className={clsx(
                      'grid h-8 items-center gap-2 border-b border-border/60 px-2 text-[11px] hover:bg-accent/40',
                      GRID_CLOSED,
                    )}
                  >
                    <span className="num font-mono text-muted-foreground">{fmtTime(row.close_time)}</span>
                    <span className="truncate font-medium text-foreground">{row.symbol}</span>
                    <span className={row.side === 'buy' ? 'text-success-foreground' : 'text-destructive-foreground'}>
                      {row.side === 'buy' ? '多' : '空'}
                    </span>
                    <span className="num text-right font-mono text-foreground">
                      {fmtVolume(row.volume, 0.01)}
                    </span>
                    <span className="num text-right font-mono text-muted-foreground">
                      {fmtPrice(row.entry_price, digits)} → {fmtPrice(row.exit_price, digits)}
                    </span>
                    <span className={clsx('num text-right font-mono', signedClass(net))}>
                      {fmtSigned(net)}
                    </span>
                    <span className="text-right text-[10px] text-muted-foreground">
                      {closedByLabel(row.closed_by)}
                    </span>
                    <span className="num text-right font-mono text-muted-foreground/60">
                      {row.duration_sec >= 3600
                        ? `${(row.duration_sec / 3600).toFixed(1)}h`
                        : `${Math.max(1, Math.round(row.duration_sec / 60))}m`}
                    </span>
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function totalProfit(positions: Position[]): number {
  return positions.reduce((sum, item) => sum + item.profit, 0);
}

function orderTypeLabel(type: Order['type']): string {
  switch (type) {
    case 'market':
      return '市价';
    case 'limit':
      return '限价';
    case 'stop':
      return '停止';
    default:
      return String(type);
  }
}

function closedByLabel(reason: JournalRecord['closed_by']): string {
  switch (reason) {
    case 'sl':
      return '止损';
    case 'tp':
      return '止盈';
    case 'stop_out':
      return '强平';
    case 'manual':
      return '手动';
    default:
      return reason ? String(reason) : '—';
  }
}
