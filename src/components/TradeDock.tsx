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
import { MAX_PLAN_STEPS, nextStepPrice, validatePlanStep } from '../lib/plan';
import { cancelOrderWithUndo } from '../lib/orderActions';
import type {
  BreakevenResult,
  FlattenResult,
  JournalRecord,
  Order,
  Position,
  PositionPlanStep,
} from '../gateway/types';

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

const GRID_POSITION = 'grid-cols-[112px_1fr_74px_84px_84px_84px_90px_90px]';
const GRID_ORDER = 'grid-cols-[112px_1fr_62px_62px_88px_88px_88px_68px]';
const GRID_DEAL = 'grid-cols-[92px_1fr_54px_58px_88px_84px_76px_64px]';
const GRID_CLOSED = 'grid-cols-[92px_1fr_54px_88px_88px_80px_56px_70px]';

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

  const addPlanStep = async (position: Position) => {
    const info = infoOf(position.symbol);
    const plan = position.plan ?? null;
    const active = (plan?.steps ?? []).filter((item) => !item.done && !item.skipped).length;
    if (active >= MAX_PLAN_STEPS) {
      notify('info', `最多添加 ${MAX_PLAN_STEPS} 档分批止盈`);
      return;
    }
    const price = nextStepPrice(position, plan, info);
    const problem = validatePlanStep({ price, closePercent: 50 }, position, plan, info);
    if (problem) {
      notify('error', problem);
      return;
    }
    setBusy(position.ticket);
    try {
      await gateway.call('position.plan.add', {
        ticket: position.ticket,
        price,
        closePercent: 50,
        breakevenOffsetPoints: breakevenOffset,
      });
      notify('success', `已添加分批：${fmtPrice(price, info?.digits ?? 5)} 平 50%`);
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
      className="relative flex shrink-0 flex-col border-t border-tv-border bg-tv-panel"
      style={{ height: dockCollapsed ? 32 : dockHeight }}
      data-dock
    >
      {!dockCollapsed && (
        <div
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          className="absolute -top-[3px] left-0 right-0 z-10 h-[6px] cursor-ns-resize hover:bg-tv-accent/30"
          title="拖动调整高度"
          aria-hidden="true"
        />
      )}

      <div className="flex h-8 shrink-0 items-stretch border-b border-tv-border bg-tv-raised/70 px-1">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setDockTab(tab.key)}
            className={clsx(
              'relative flex items-center gap-1.5 px-3 text-[12px] transition-colors',
              dockTab === tab.key
                ? 'font-medium text-tv-text'
                : 'text-tv-muted hover:text-tv-text',
            )}
          >
            {tab.label}
            <span className="num font-mono text-[10px] text-tv-faint">{counts[tab.key]}</span>
            {dockTab === tab.key && (
              <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-tv-accent" />
            )}
          </button>
        ))}

        <div className="ml-auto flex items-center gap-1 pr-1">
          {dockTab === 'positions' && (
            <>
              <button
                onClick={() => void flatten()}
                disabled={!symbol}
                title={
                  symbol
                    ? `平掉 ${symbol} 的全部持仓，并撤销该品种挂单`
                    : '平掉当前品种的全部持仓，并撤销挂单'
                }
                className={clsx(
                  'h-6 whitespace-nowrap rounded px-2 text-[11px] transition-colors',
                  confirmFlatten
                    ? 'bg-tv-down text-white'
                    : 'text-tv-down hover:bg-tv-down-soft',
                )}
              >
                {confirmFlatten
                  ? symbol
                    ? `确认平掉 ${symbol} 全部？`
                    : '确认平掉当前品种全部？'
                  : symbol
                    ? `平掉 ${symbol} 全部`
                    : '平掉当前品种全部'}
              </button>
              <button
                onClick={() => void closeAll()}
                title="平掉账户里所有品种的持仓"
                className={clsx(
                  'h-6 whitespace-nowrap rounded px-2 text-[11px] transition-colors',
                  confirmAll
                    ? 'bg-tv-down text-white'
                    : 'text-tv-muted hover:bg-tv-hover hover:text-tv-text',
                )}
              >
                {confirmAll ? '确认平掉所有品种？' : '平掉账户全部'}
              </button>
            </>
          )}
          {(dockTab === 'deals' || dockTab === 'closed') && (
            <button
              onClick={() => setTick((value) => value + 1)}
              disabled={loading}
              title="刷新"
              aria-label="刷新历史"
              className="flex h-6 w-6 items-center justify-center rounded text-tv-muted hover:bg-tv-hover hover:text-tv-text disabled:opacity-40"
            >
              <RefreshCw
                size={13}
                strokeWidth={1.5}
                className={loading ? 'animate-spin' : undefined}
              />
            </button>
          )}
          <button
            onClick={() => setDockCollapsed(!dockCollapsed)}
            title={dockCollapsed ? '展开托盘' : '收起托盘'}
            aria-label={dockCollapsed ? '展开托盘' : '收起托盘'}
            className="flex h-6 w-6 items-center justify-center rounded text-tv-muted hover:bg-tv-hover hover:text-tv-text"
          >
            {dockCollapsed ? (
              <ChevronUp size={14} strokeWidth={1.5} />
            ) : (
              <ChevronDown size={14} strokeWidth={1.5} />
            )}
          </button>
        </div>
      </div>

      {dockCollapsed ? (
        <button
          onClick={() => setDockCollapsed(false)}
          className="flex flex-1 items-center px-3 text-[11px] text-tv-muted hover:text-tv-text"
        >
          持仓 {positions.length} · 挂单 {orders.length} · 盈亏{' '}
          <span className={clsx('num ml-1 font-mono', signedClass(totalProfit(positions)))}>
            {fmtSigned(totalProfit(positions))}
          </span>
        </button>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {dockTab === 'positions' && (
            <>
              <div
                className={clsx(
                  'sticky top-0 z-[1] grid items-center gap-2 border-b border-tv-border bg-tv-panel px-2 py-1 text-[10px] text-tv-faint',
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
                <div className="px-3 py-4 text-[12px] text-tv-muted">当前没有持仓</div>
              )}
              {positions.map((position) => {
                const info = infoOf(position.symbol);
                const digits = info?.digits ?? 5;
                const current = priceOf(position);
                const expanded = detailFor === position.ticket;
                return (
                  <div key={position.ticket} className="border-b border-tv-border/40">
                    <div
                      className={clsx(
                        'grid h-9 items-center gap-2 px-2 text-[11px] hover:bg-tv-hover/60',
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
                              ? 'bg-tv-up-soft text-tv-up'
                              : 'bg-tv-down-soft text-tv-down',
                          )}
                        >
                          {position.side === 'buy' ? '多' : '空'}
                        </span>
                        <span className="truncate font-medium text-tv-text">{position.symbol}</span>
                      </button>
                      <span className="num text-right font-mono text-tv-text">
                        {fmtVolume(position.volume, info?.volumeStep ?? 0.01)}
                      </span>
                      <span className="num text-right font-mono text-tv-muted">
                        {fmtPrice(position.openPrice, digits)}
                      </span>
                      <span className="num text-right font-mono text-tv-text">
                        {fmtPrice(current, digits)}
                      </span>
                      <span className="num text-right font-mono text-tv-warn">
                        {position.sl != null ? fmtPrice(position.sl, digits) : '—'}
                      </span>
                      <span className="num text-right font-mono text-tv-accent">
                        {position.tp != null ? fmtPrice(position.tp, digits) : '—'}
                      </span>
                      <span
                        className={clsx('num text-right font-mono', signedClass(position.profit))}
                      >
                        {fmtSigned(position.profit)}
                      </span>
                      <span className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => void breakeven(position)}
                          disabled={busy === position.ticket}
                          className="h-6 rounded px-1.5 text-[10px] text-tv-muted hover:bg-tv-hover hover:text-tv-text disabled:opacity-40"
                        >
                          保本
                        </button>
                        <button
                          onClick={() => void closeHalf(position)}
                          disabled={busy === position.ticket}
                          className={clsx(
                            'h-6 rounded px-1.5 text-[10px] disabled:opacity-40',
                            confirmHalf === position.ticket
                              ? 'bg-tv-down text-white'
                              : 'text-tv-muted hover:bg-tv-hover hover:text-tv-text',
                          )}
                        >
                          {confirmHalf === position.ticket ? '确认？' : '平掉一半'}
                        </button>
                        <button
                          onClick={() => void close(position.ticket)}
                          disabled={busy === position.ticket}
                          className={clsx(
                            'h-6 rounded px-1.5 text-[10px] disabled:opacity-40',
                            confirmClose === position.ticket
                              ? 'bg-tv-down text-white'
                              : 'text-tv-down hover:bg-tv-down-soft',
                          )}
                        >
                          {confirmClose === position.ticket ? '确认？' : '平仓'}
                        </button>
                      </span>
                    </div>

                    {expanded && (
                      <div className="grid grid-cols-[1fr_1fr_1fr] gap-3 border-t border-tv-border/40 bg-tv-raised/50 px-3 py-2">
                        <div>
                          <div className="mb-1 text-[10px] text-tv-faint">止损 / 止盈</div>
                          <div className="flex items-center gap-1">
                            <input
                              value={slInput}
                              onChange={(event) => setSlInput(event.target.value)}
                              placeholder="止损"
                              aria-label={`${position.symbol} 止损价`}
                              className="h-6 w-[78px] rounded border border-tv-border bg-tv-panel px-1.5 font-mono text-[11px] text-tv-warn outline-none focus:border-tv-accent"
                            />
                            <input
                              value={tpInput}
                              onChange={(event) => setTpInput(event.target.value)}
                              placeholder="止盈"
                              aria-label={`${position.symbol} 止盈价`}
                              className="h-6 w-[78px] rounded border border-tv-border bg-tv-panel px-1.5 font-mono text-[11px] text-tv-accent outline-none focus:border-tv-accent"
                            />
                            <button
                              onClick={() => void saveStops(position)}
                              disabled={busy === position.ticket}
                              className="h-6 rounded bg-tv-accent px-2 text-[10px] text-white disabled:opacity-40"
                            >
                              保存
                            </button>
                          </div>
                        </div>

                        <div>
                          <div className="mb-1 text-[10px] text-tv-faint">
                            移动止损
                            {position.trailing ? `（${position.trailing.distancePoints} 点）` : ''}
                          </div>
                          <div className="flex items-center gap-1">
                            <input
                              value={trailDist}
                              onChange={(event) => setTrailDist(event.target.value)}
                              inputMode="decimal"
                              aria-label={`${position.symbol} 移动止损距离`}
                              className="h-6 w-[64px] rounded border border-tv-border bg-tv-panel px-1.5 font-mono text-[11px] text-tv-text outline-none focus:border-tv-accent"
                            />
                            <span className="text-[10px] text-tv-faint">点</span>
                            <button
                              onClick={() => void applyTrailing(position)}
                              disabled={busy === position.ticket}
                              className="h-6 rounded bg-tv-raised px-2 text-[10px] text-tv-text hover:bg-tv-hover disabled:opacity-40"
                            >
                              {position.trailing ? '更新' : '启动'}
                            </button>
                            {position.trailing && (
                              <button
                                onClick={() => void clearTrailing(position)}
                                disabled={busy === position.ticket}
                                className="h-6 rounded px-1.5 text-[10px] text-tv-muted hover:text-tv-down disabled:opacity-40"
                              >
                                取消
                              </button>
                            )}
                          </div>
                        </div>

                        <div>
                          <div className="mb-1 flex items-center gap-1.5 text-[10px] text-tv-faint">
                            分批止盈
                            {position.plan && position.plan.steps.length > 0 && (
                              <span className="text-tv-muted">
                                {
                                  position.plan.steps.filter((s) => !s.done && !s.skipped)
                                    .length
                                }{' '}
                                档
                              </span>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-1">
                            <button
                              onClick={() => void addPlanStep(position)}
                              disabled={busy === position.ticket}
                              className="h-6 rounded bg-tv-raised px-2 text-[10px] text-tv-text hover:bg-tv-hover disabled:opacity-40"
                            >
                              ＋ 加一档
                            </button>
                            {position.plan && position.plan.steps.length > 0 && (
                              <button
                                onClick={() => void clearPlan(position)}
                                disabled={busy === position.ticket}
                                className="h-6 rounded px-1.5 text-[10px] text-tv-muted hover:text-tv-down disabled:opacity-40"
                              >
                                清空
                              </button>
                            )}
                            {position.plan?.steps.map((step) => (
                              <span
                                key={step.id}
                                className={clsx(
                                  'flex items-center gap-1 rounded bg-tv-panel px-1.5 py-0.5 font-mono text-[10px]',
                                  step.done || step.skipped
                                    ? 'text-tv-faint line-through'
                                    : 'text-tv-text',
                                )}
                                title={
                                  step.done ? '已执行' : step.skipped ? '已跳过' : '等待触发'
                                }
                              >
                                {fmtPrice(step.price, digits)} · {step.closePercent ?? 50}%
                                {!step.done && !step.skipped && (
                                  <button
                                    onClick={() => void removePlanStep(position, step)}
                                    aria-label={`删除 ${step.price} 分批`}
                                    className="text-tv-faint hover:text-tv-down"
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
                  'sticky top-0 z-[1] grid items-center gap-2 border-b border-tv-border bg-tv-panel px-2 py-1 text-[10px] text-tv-faint',
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
                <div className="px-3 py-4 text-[12px] text-tv-muted">当前没有挂单</div>
              )}
              {orders.map((order) => {
                const info = infoOf(order.symbol);
                const digits = info?.digits ?? 5;
                return (
                  <div
                    key={order.ticket}
                    className={clsx(
                      'grid h-9 items-center gap-2 border-b border-tv-border/40 px-2 text-[11px] hover:bg-tv-hover/60',
                      GRID_ORDER,
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="rounded bg-tv-raised px-1 py-0.5 text-[10px] text-tv-muted">
                        {order.side === 'buy' ? '买' : '卖'}
                      </span>
                      <span className="truncate font-medium text-tv-text">{order.symbol}</span>
                    </span>
                    <span className="text-tv-muted">{orderTypeLabel(order.type)}</span>
                    <span className="num text-right font-mono text-tv-text">
                      {fmtVolume(order.volume, info?.volumeStep ?? 0.01)}
                    </span>
                    <span className="num text-right font-mono text-tv-text">
                      {fmtPrice(order.price, digits)}
                    </span>
                    <span className="num text-right font-mono text-tv-warn">
                      {order.sl != null ? fmtPrice(order.sl, digits) : '—'}
                    </span>
                    <span className="num text-right font-mono text-tv-accent">
                      {order.tp != null ? fmtPrice(order.tp, digits) : '—'}
                    </span>
                    <span className="text-right text-tv-muted">{order.state || '—'}</span>
                    <span className="text-right">
                      <button
                        onClick={() => void cancelOrderWithUndo(order, notify)}
                        className="h-6 rounded px-1.5 text-[10px] text-tv-down hover:bg-tv-down-soft"
                      >
                        撤单
                      </button>
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
                  'sticky top-0 z-[1] grid items-center gap-2 border-b border-tv-border bg-tv-panel px-2 py-1 text-[10px] text-tv-faint',
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
                <div className="px-3 py-4 text-[12px] text-tv-muted">
                  {loading ? '加载成交记录…' : '最近 7 天没有成交'}
                </div>
              )}
              {deals.map((deal) => (
                <div
                  key={`${deal.ticket}`}
                  className={clsx(
                    'grid h-8 items-center gap-2 border-b border-tv-border/40 px-2 text-[11px] hover:bg-tv-hover/60',
                    GRID_DEAL,
                  )}
                >
                  <span className="num font-mono text-tv-muted">{fmtTime(deal.time)}</span>
                  <span className="truncate font-medium text-tv-text">{deal.symbol}</span>
                  <span className={deal.side === 'buy' ? 'text-tv-up' : 'text-tv-down'}>
                    {deal.side === 'buy' ? '买' : '卖'}
                  </span>
                  <span className="num text-right font-mono text-tv-text">
                    {deal.volume.toFixed(2)}
                  </span>
                  <span className="num text-right font-mono text-tv-text">{deal.price}</span>
                  <span className={clsx('num text-right font-mono', signedClass(deal.profit))}>
                    {fmtSigned(deal.profit)}
                  </span>
                  <span className="num text-right font-mono text-tv-muted">
                    {fmtMoney(deal.commission + deal.swap)}
                  </span>
                  <span className="text-right text-[10px] text-tv-muted">
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
                  'sticky top-0 z-[1] grid items-center gap-2 border-b border-tv-border bg-tv-panel px-2 py-1 text-[10px] text-tv-faint',
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
                <div className="px-3 py-4 text-[12px] text-tv-muted">
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
                      'grid h-8 items-center gap-2 border-b border-tv-border/40 px-2 text-[11px] hover:bg-tv-hover/60',
                      GRID_CLOSED,
                    )}
                  >
                    <span className="num font-mono text-tv-muted">{fmtTime(row.close_time)}</span>
                    <span className="truncate font-medium text-tv-text">{row.symbol}</span>
                    <span className={row.side === 'buy' ? 'text-tv-up' : 'text-tv-down'}>
                      {row.side === 'buy' ? '多' : '空'}
                    </span>
                    <span className="num text-right font-mono text-tv-text">
                      {fmtVolume(row.volume, 0.01)}
                    </span>
                    <span className="num text-right font-mono text-tv-muted">
                      {fmtPrice(row.entry_price, digits)} → {fmtPrice(row.exit_price, digits)}
                    </span>
                    <span className={clsx('num text-right font-mono', signedClass(net))}>
                      {fmtSigned(net)}
                    </span>
                    <span className="text-right text-[10px] text-tv-muted">
                      {closedByLabel(row.closed_by)}
                    </span>
                    <span className="num text-right font-mono text-tv-faint">
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
