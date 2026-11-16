import { useState } from 'react';
import { clsx } from 'clsx';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import { fmtMoney, fmtPrice, fmtSigned, fmtVolume, roundVolume, signedClass } from '../lib/format';
import { maxLoss, validateStops } from '../lib/stops';
import {
  MAX_PLAN_STEPS,
  estimateStepLots,
  nextStepPrice,
  validatePlanStep,
} from '../lib/plan';
import type {
  BreakevenResult,
  FlattenResult,
  Position,
  PositionPlanStep,
} from '../gateway/types';

export function PositionsPanel() {
  const positions = useApp((s) => s.positions);
  const orders = useApp((s) => s.orders);
  const symbol = useApp((s) => s.symbol);
  const symbols = useApp((s) => s.symbols);
  const quote = useApp((s) => s.quote);
  const notify = useApp((s) => s.notify);
  const breakevenOffset = useApp((s) => s.breakevenOffset);
  const [confirmTicket, setConfirmTicket] = useState<number | null>(null);
  const [confirmHalf, setConfirmHalf] = useState<number | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [trailFor, setTrailFor] = useState<number | null>(null);
  const [trailDist, setTrailDist] = useState('20');
  const [busy, setBusy] = useState<number | null>(null);
  const [closingAll, setClosingAll] = useState(false);
  const [confirmFlatten, setConfirmFlatten] = useState(false);
  const [flattening, setFlattening] = useState(false);
  const [stopsFor, setStopsFor] = useState<number | null>(null);
  const [slInput, setSlInput] = useState('');
  const [tpInput, setTpInput] = useState('');
  const [planFor, setPlanFor] = useState<number | null>(null);
  const [planBusy, setPlanBusy] = useState(false);

  // 全清只作用于当前品种：别的品种持仓不动，避免一键误伤
  const scopedPositions = symbol ? positions.filter((item) => item.symbol === symbol) : [];
  const scopedOrders = symbol ? orders.filter((item) => item.symbol === symbol) : [];
  const canFlatten = scopedPositions.length > 0 || scopedOrders.length > 0;

  const close = async (ticket: number) => {
    setBusy(ticket);
    try {
      await gateway.call('position.close', { ticket });
      setConfirmTicket(null);
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const breakeven = async (ticket: number, digits: number) => {
    setBusy(ticket);
    try {
      const res = await gateway.call<BreakevenResult>('position.breakeven', {
        ticket,
        offsetPoints: breakevenOffset,
      });
      if (res.changed) {
        notify('success', `止损已移到开仓价 ${fmtPrice(res.sl, digits)}`);
      } else if (res.reason === 'not_in_profit') {
        notify('info', '当前未回本，止损保持原值');
      } else if (res.reason === 'too_close') {
        notify('info', '离保本还差一点，止损保持原值');
      } else {
        notify('info', '止损已经在开仓价或更好，无需移动');
      }
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const closeHalf = async (position: Position) => {
    const info = symbols.find((item) => item.name === position.symbol);
    const step = info?.volumeStep ?? 0.01;
    const min = info?.minVolume ?? 0.01;
    const half = roundVolume(position.volume / 2, step, min, position.volume);
    if (half >= position.volume - 1e-9) {
      notify('error', '仓位已经是最小手数，无法分批');
      return;
    }
    if (confirmHalf !== position.ticket) {
      setConfirmHalf(position.ticket);
      window.setTimeout(() => setConfirmHalf(null), 4000);
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
      const closed = res?.volume ?? half;
      const remaining = Math.max(0, position.volume - closed);
      const rest = remaining > 1e-9 ? `，剩余 ${fmtVolume(remaining, step)} 手` : '';
      const stop = position.sl ?? 0;
      const stopText = stop > 0 ? `止损保持 ${fmtPrice(stop, info?.digits ?? 2)}` : '该仓位没有止损';
      const be = res?.breakeven;
      if (be?.changed) {
        notify(
          'success',
          `已平 ${closed} 手，止损移到开仓价 ${fmtPrice(be.sl, info?.digits ?? 2)}${rest}`,
        );
      } else if (be?.reason === 'not_in_profit') {
        const risk = maxLoss(position.side, remaining, position.openPrice, stop, info);
        notify(
          'success',
          `已平 ${closed} 手，当前未回本，${stopText}${rest}${
            risk != null ? `，剩余最大亏损约 ${fmtMoney(risk)}` : ''
          }`,
        );
      } else if (be?.reason === 'too_close') {
        notify('success', `已平 ${closed} 手，离保本还差一点，${stopText}${rest}`);
      } else {
        notify('success', `已平 ${closed} 手${rest}`);
      }
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const applyTrailing = async (ticket: number) => {
    const distance = Number(trailDist);
    if (!Number.isFinite(distance) || distance <= 0) {
      notify('error', '请输入大于 0 的点数');
      return;
    }
    setBusy(ticket);
    try {
      await gateway.call('position.trailing.set', {
        ticket,
        distancePoints: distance,
        stepPoints: 1,
      });
      setTrailFor(null);
      notify('success', `移动止损已启动：止损跟随价格 ${distance} 点`);
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const clearTrailing = async (ticket: number) => {
    setBusy(ticket);
    try {
      await gateway.call('position.trailing.clear', { ticket });
      notify('info', '已取消移动止损');
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const openStops = (position: Position) => {
    const digits = symbols.find((item) => item.name === position.symbol)?.digits ?? 5;
    setStopsFor(position.ticket);
    setSlInput(position.sl != null ? position.sl.toFixed(digits) : '');
    setTpInput(position.tp != null ? position.tp.toFixed(digits) : '');
  };

  const saveStops = async (position: Position) => {
    const info = symbols.find((item) => item.name === position.symbol);
    const parse = (value: string) => (value.trim() === '' ? 0 : Number(value));
    const sl = parse(slInput);
    const tp = parse(tpInput);
    if (!Number.isFinite(sl) || !Number.isFinite(tp) || sl < 0 || tp < 0) {
      notify('error', '止损/止盈价格格式不对');
      return;
    }
    // 有当前品种报价时按可平仓价校验，其它品种退回开仓价
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
      setStopsFor(null);
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
    setClosingAll(true);
    try {
      const res = await gateway.call<{ results?: { error?: string }[] }>('position.closeAll', {});
      const results = res?.results ?? [];
      const failed = results.filter((item) => item.error).length;
      notify(
        failed ? 'error' : 'success',
        failed ? `已平 ${results.length - failed} 个，${failed} 个失败` : `已平掉 ${results.length} 个仓位`,
      );
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setClosingAll(false);
    }
  };

  /** 全清：先撤当前品种的挂单，再平当前品种的持仓，由网关保证顺序。 */
  const flatten = async () => {
    if (!symbol) return;
    if (!confirmFlatten) {
      setConfirmFlatten(true);
      window.setTimeout(() => setConfirmFlatten(false), 4000);
      return;
    }
    setConfirmFlatten(false);
    setFlattening(true);
    try {
      const res = await gateway.call<FlattenResult>('trade.flatten', { symbol });
      const cancelled = res?.cancelled ?? [];
      const closed = res?.closed ?? [];
      const failed = [...cancelled, ...closed].filter((item) => item.error).length;
      const cancelledOk = cancelled.filter((item) => !item.error).length;
      const closedOk = closed.filter((item) => !item.error).length;
      const remaining = res?.remaining;
      const rest =
        remaining && (remaining.positions > 0 || remaining.orders > 0)
          ? `，剩余 ${remaining.positions} 仓 / ${remaining.orders} 单`
          : '';
      const text = failed
        ? `${symbol}：已平 ${closedOk}/${closed.length}，撤单 ${cancelledOk}/${cancelled.length}，${failed} 个失败${rest}`
        : `已清 ${symbol}：平 ${closed.length} 个仓位、撤销 ${cancelled.length} 个挂单${rest}`;
      notify(failed || rest ? 'error' : 'success', text);
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setFlattening(false);
    }
  };

  /** 新增一档：默认放在下一个未被占用的 R 上，比例 50%，可在图上再拖。 */
  const addPlanStep = async (position: Position) => {
    const info = symbols.find((item) => item.name === position.symbol);
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
    setPlanBusy(true);
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
      setPlanBusy(false);
    }
  };

  /** 价格/比例改完即提交（失焦或回车），不设总保存按钮。 */
  const updatePlanStep = async (
    position: Position,
    planStep: PositionPlanStep,
    patch: { price?: number; closePercent?: number; moveBreakeven?: boolean },
  ) => {
    if (patch.price != null || patch.closePercent != null) {
      const info = symbols.find((item) => item.name === position.symbol);
      const problem = validatePlanStep(
        {
          price: patch.price ?? planStep.price,
          closePercent: patch.closePercent ?? planStep.closePercent,
        },
        position,
        position.plan,
        info,
        planStep.id,
      );
      if (problem) {
        notify('error', problem);
        return;
      }
    }
    setPlanBusy(true);
    try {
      await gateway.call('position.plan.update', {
        ticket: position.ticket,
        stepId: planStep.id,
        ...patch,
      });
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setPlanBusy(false);
    }
  };

  const removePlanStep = async (position: Position, stepId: string) => {
    setPlanBusy(true);
    try {
      await gateway.call('position.plan.remove', { ticket: position.ticket, stepId });
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setPlanBusy(false);
    }
  };

  const clearPlan = async (position: Position) => {
    setPlanBusy(true);
    try {
      await gateway.call('position.plan.clear', { ticket: position.ticket });
      notify('info', '已清空分批止盈');
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setPlanBusy(false);
    }
  };

  return (
    <section className="border-b border-tv-border">
      <div className="flex h-10 items-center justify-between px-4">
        <span className="text-[12px] font-semibold text-tv-text">
          持仓
          <span className="num ml-1.5 font-mono text-[11px] font-normal text-tv-muted">
            {positions.length}
          </span>
        </span>
        {(positions.length > 0 || canFlatten) && (
          <div className="flex items-center gap-1.5">
            {positions.length > 0 && (
              <button
                onClick={() => void closeAll()}
                disabled={closingAll}
                title="平掉账户里全部品种的持仓"
                className={clsx(
                  'rounded-md px-1.5 py-0.5 text-[11px] transition-colors',
                  confirmAll ? 'bg-tv-down text-white' : 'text-tv-muted hover:text-tv-text',
                  closingAll && 'cursor-not-allowed opacity-50',
                )}
              >
                {closingAll ? '平仓中…' : confirmAll ? '确认全平？' : '全部平仓'}
              </button>
            )}
            {canFlatten && (
              <button
                onClick={() => void flatten()}
                disabled={flattening}
                title={`清空 ${symbol}：平 ${scopedPositions.length} 个持仓、撤销 ${scopedOrders.length} 个挂单`}
                className={clsx(
                  'rounded-md px-1.5 py-0.5 text-[11px] transition-colors',
                  confirmFlatten ? 'bg-tv-down text-white' : 'text-tv-down hover:bg-tv-down-soft',
                  flattening && 'cursor-not-allowed opacity-50',
                )}
              >
                {flattening ? '全清中…' : confirmFlatten ? '确认全清？' : '全清'}
              </button>
            )}
          </div>
        )}
      </div>
      <div className="max-h-[240px] overflow-auto">
        {positions.length === 0 && (
          <div className="px-4 pb-4 text-[12px] text-tv-muted">暂无持仓</div>
        )}
        {positions.map((position) => {
          const info = symbols.find((item) => item.name === position.symbol);
          const digits = info?.digits ?? 5;
          return (
            <div key={position.ticket} className="border-t border-tv-border/60">
              <div className="px-4 py-2.5 text-[12px]">
                <div className="flex items-center gap-2">
                  <span
                    className={clsx(
                      'flex w-8 shrink-0 items-center gap-1 text-[11px]',
                      position.side === 'buy' ? 'text-tv-up' : 'text-tv-down',
                    )}
                  >
                    <span
                      className={clsx(
                        'h-1.5 w-1.5 rounded-full',
                        position.side === 'buy' ? 'bg-tv-up' : 'bg-tv-down',
                      )}
                    />
                    {position.side === 'buy' ? '多' : '空'}
                  </span>
                  <span className="truncate font-medium text-tv-text">
                    {position.symbol}
                    <span className="num ml-1.5 font-mono text-[11px] font-normal text-tv-muted">
                      {fmtVolume(position.volume, info?.volumeStep)}
                    </span>
                    {position.trailing && (
                      <span className="ml-1.5 rounded bg-tv-accent-soft px-1 text-[11px] text-tv-accent">
                        移损 {position.trailing.distancePoints} 点
                      </span>
                    )}
                    {position.plan && position.plan.steps.length > 0 && (
                      <span className="ml-1.5 rounded bg-tv-raised px-1 text-[11px] text-tv-muted">
                        分批{' '}
                        {
                          position.plan.steps.filter((item) => !item.done && !item.skipped)
                            .length
                        }{' '}
                        档
                      </span>
                    )}
                  </span>
                  <span className="flex-1" />
                  <span className={clsx('num font-mono', signedClass(position.profit))}>
                    {fmtSigned(position.profit)}
                  </span>
                </div>
                <div className="mt-1 truncate font-mono text-[11px] text-tv-muted">
                  开 {fmtPrice(position.openPrice, digits)}
                  {position.sl != null ? ` · SL ${fmtPrice(position.sl, digits)}` : ''}
                  {position.tp != null ? ` · TP ${fmtPrice(position.tp, digits)}` : ''}
                  {position.stopOutPrice != null
                    ? ` · 强平 ${fmtPrice(position.stopOutPrice, digits)}`
                    : ''}
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-end gap-1">
                  <button
                    onClick={() => (stopsFor === position.ticket ? setStopsFor(null) : openStops(position))}
                    disabled={busy === position.ticket}
                    title="设置或清除止损/止盈"
                    className={clsx(
                      'h-6 rounded-md border px-2 text-[11px] transition-colors',
                      stopsFor === position.ticket
                        ? 'border-tv-accent/40 bg-tv-accent-soft text-tv-accent'
                        : 'border-tv-border text-tv-text hover:bg-tv-hover',
                    )}
                  >
                    止损止盈
                  </button>
                  <button
                    onClick={() => breakeven(position.ticket, digits)}
                    disabled={busy === position.ticket}
                    title="把止损移到开仓价（已回本且放得下时才生效）"
                    className="h-6 rounded-md border border-tv-border px-2 text-[11px] text-tv-text transition-colors hover:bg-tv-hover"
                  >
                    保本
                  </button>
                  <button
                    onClick={() =>
                      setPlanFor(planFor === position.ticket ? null : position.ticket)
                    }
                    disabled={busy === position.ticket}
                    title="按价格分档平仓；添加后可直接在图上拖动"
                    className={clsx(
                      'h-6 rounded-md border px-2 text-[11px] transition-colors',
                      planFor === position.ticket
                        ? 'border-tv-accent/40 bg-tv-accent-soft text-tv-accent'
                        : 'border-tv-border text-tv-text hover:bg-tv-hover',
                    )}
                  >
                    分批
                  </button>
                  <button
                    onClick={() => closeHalf(position)}
                    disabled={
                      busy === position.ticket || position.volume <= (info?.minVolume ?? 0.01)
                    }
                    title="平掉一半仓位；已回本时把止损移到开仓价，未回本时止损不动"
                    className={clsx(
                      'h-6 rounded-md border px-2 text-[11px] transition-colors',
                      confirmHalf === position.ticket
                        ? 'border-tv-warn bg-tv-warn text-white'
                        : 'border-tv-border text-tv-text hover:bg-tv-hover',
                      position.volume <= (info?.minVolume ?? 0.01) &&
                        'cursor-not-allowed opacity-40',
                    )}
                  >
                    {confirmHalf === position.ticket ? '确认平一半' : '平一半'}
                  </button>
                  <button
                    onClick={() =>
                      position.trailing
                        ? clearTrailing(position.ticket)
                        : setTrailFor(trailFor === position.ticket ? null : position.ticket)
                    }
                    disabled={busy === position.ticket}
                    title={
                      position.trailing ? '点击取消移动止损' : '启动移动止损（止损跟随价格）'
                    }
                    className={clsx(
                      'h-6 rounded-md border px-2 text-[11px] transition-colors',
                      position.trailing
                        ? 'border-tv-accent/40 bg-tv-accent-soft text-tv-accent'
                        : 'border-tv-border text-tv-text hover:bg-tv-hover',
                    )}
                  >
                    {position.trailing ? '取消移损' : '移动止损'}
                  </button>
                  <button
                    onClick={() =>
                      confirmTicket === position.ticket
                        ? close(position.ticket)
                        : setConfirmTicket(position.ticket)
                    }
                    disabled={busy === position.ticket}
                    className={clsx(
                      'h-6 rounded-md px-2 text-[11px] transition-colors',
                      confirmTicket === position.ticket
                        ? 'bg-tv-down text-white'
                        : 'bg-tv-raised text-tv-text hover:bg-tv-hover',
                    )}
                  >
                    {busy === position.ticket
                      ? '…'
                      : confirmTicket === position.ticket
                        ? '确认平仓'
                        : '平仓'}
                  </button>
                </div>
              </div>
              {stopsFor === position.ticket && (
                <div className="flex flex-wrap items-center gap-1.5 border-t border-tv-border/60 bg-tv-raised px-4 py-2 text-[11px] text-tv-muted">
                  <label className="flex items-center gap-1">
                    止损
                    <input
                      type="number"
                      step={info?.point ?? 0.00001}
                      value={slInput}
                      placeholder="不设"
                      onChange={(event) => setSlInput(event.target.value)}
                      className="h-6 w-[88px] rounded-md border border-tv-border bg-tv-panel px-1.5 text-right font-mono text-[11px] text-tv-text outline-none focus:border-tv-accent"
                    />
                  </label>
                  <label className="flex items-center gap-1">
                    止盈
                    <input
                      type="number"
                      step={info?.point ?? 0.00001}
                      value={tpInput}
                      placeholder="不设"
                      onChange={(event) => setTpInput(event.target.value)}
                      className="h-6 w-[88px] rounded-md border border-tv-border bg-tv-panel px-1.5 text-right font-mono text-[11px] text-tv-text outline-none focus:border-tv-accent"
                    />
                  </label>
                  <span className="flex-1" />
                  <button
                    onClick={() => void saveStops(position)}
                    disabled={busy === position.ticket}
                    className="h-6 rounded-md bg-tv-text px-2 text-[11px] font-medium text-tv-panel transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {busy === position.ticket ? '保存中…' : '保存'}
                  </button>
                  <button
                    onClick={() => setStopsFor(null)}
                    className="h-6 rounded-md px-1.5 text-[11px] text-tv-muted transition-colors hover:text-tv-text"
                  >
                    取消
                  </button>
                  <p className="w-full text-[10px] leading-4 text-tv-faint">
                    清空输入 = 删除该价位；留空不填不影响另一端
                  </p>
                </div>
              )}
              {trailFor === position.ticket && (
                <div className="flex items-center gap-1.5 border-t border-tv-border/60 bg-tv-raised px-4 py-2 text-[11px] text-tv-muted">
                  距离
                  <input
                    type="number"
                    min={1}
                    value={trailDist}
                    onChange={(event) => setTrailDist(event.target.value)}
                    className="h-6 w-16 rounded-md border border-tv-border bg-tv-panel px-1.5 text-right font-mono text-[11px] text-tv-text outline-none focus:border-tv-accent"
                  />
                  点
                  <span className="ml-1 truncate">
                    （价格{position.side === 'buy' ? '下方' : '上方'}，只朝有利方向移动）
                  </span>
                  <span className="flex-1" />
                  <button
                    onClick={() => applyTrailing(position.ticket)}
                    disabled={busy === position.ticket}
                    className="h-6 rounded-md bg-tv-text px-2 text-[11px] font-medium text-tv-panel transition-opacity hover:opacity-90"
                  >
                    启动
                  </button>
                  <button
                    onClick={() => setTrailFor(null)}
                    className="h-6 rounded-md px-1.5 text-[11px] text-tv-muted transition-colors hover:text-tv-text"
                  >
                    取消
                  </button>
                </div>
              )}
              {planFor === position.ticket &&
                (() => {
                  const plan = position.plan ?? null;
                  const steps = plan?.steps ?? [];
                  const active = steps.filter((item) => !item.done && !item.skipped);
                  const lots = estimateStepLots(position.volume, active, info, position.side);
                  const lotsById = new Map(lots.rows.map((row) => [row.id, row]));
                  const minVolume = info?.minVolume ?? 0.01;
                  const canSplit = position.volume > minVolume + 1e-9;
                  const full = active.length >= MAX_PLAN_STEPS;
                  return (
                    <div className="border-t border-tv-border/60 bg-tv-raised px-4 py-2 text-[11px] text-tv-muted">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-tv-text">分批止盈</span>
                        <span className="text-[10px]">（比例占当时剩余仓位）</span>
                        <span className="flex-1" />
                        {steps.length > 0 && (
                          <button
                            onClick={() => void clearPlan(position)}
                            disabled={planBusy}
                            className="rounded px-1 text-[10px] text-tv-muted transition-colors hover:text-tv-down"
                          >
                            清空
                          </button>
                        )}
                        <button
                          onClick={() => setPlanFor(null)}
                          className="rounded px-1 text-[10px] text-tv-muted transition-colors hover:text-tv-text"
                        >
                          收起
                        </button>
                      </div>

                      {steps.length === 0 && (
                        <p className="mt-1 text-[10px] leading-4 text-tv-faint">
                          还没有分批止盈。添加一档后可以直接在图上拖动。
                        </p>
                      )}

                      {steps.map((planStep) => {
                        const row = lotsById.get(planStep.id);
                        const finished = planStep.done || planStep.skipped;
                        return (
                          <div
                            key={planStep.id}
                            className={clsx(
                              'mt-1 flex flex-wrap items-center gap-1.5',
                              finished && 'opacity-60',
                            )}
                          >
                            <input
                              key={`price-${planStep.price}`}
                              aria-label="触发价"
                              type="number"
                              step={info?.tickSize ?? info?.point ?? 0.00001}
                              defaultValue={planStep.price.toFixed(digits)}
                              disabled={planBusy || finished}
                              onBlur={(event) => {
                                const value = Number(event.target.value);
                                if (
                                  !Number.isFinite(value) ||
                                  Math.abs(value - planStep.price) < 1e-12
                                ) {
                                  event.target.value = planStep.price.toFixed(digits);
                                  return;
                                }
                                void updatePlanStep(position, planStep, { price: value });
                              }}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') event.currentTarget.blur();
                              }}
                              className="h-6 w-[88px] rounded-md border border-tv-border bg-tv-panel px-1.5 text-right font-mono text-[11px] text-tv-text outline-none focus:border-tv-accent disabled:opacity-60"
                            />
                            <label className="flex items-center gap-0.5">
                              <input
                                key={`pct-${planStep.closePercent}`}
                                aria-label="平仓比例"
                                type="number"
                                min={1}
                                max={99}
                                defaultValue={planStep.closePercent ?? 50}
                                disabled={planBusy || finished}
                                onBlur={(event) => {
                                  const value = Number(event.target.value);
                                  if (
                                    !Number.isFinite(value) ||
                                    Math.abs(value - (planStep.closePercent ?? 50)) < 1e-9
                                  ) {
                                    event.target.value = String(planStep.closePercent ?? 50);
                                    return;
                                  }
                                  void updatePlanStep(position, planStep, { closePercent: value });
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') event.currentTarget.blur();
                                }}
                                className="h-6 w-12 rounded-md border border-tv-border bg-tv-panel px-1.5 text-right font-mono text-[11px] text-tv-text outline-none focus:border-tv-accent disabled:opacity-60"
                              />
                              %
                            </label>
                            <label className="flex items-center gap-1">
                              <input
                                type="checkbox"
                                checked={planStep.moveBreakeven}
                                disabled={planBusy || finished}
                                onChange={(event) =>
                                  void updatePlanStep(position, planStep, {
                                    moveBreakeven: event.target.checked,
                                  })
                                }
                                className="h-3 w-3 accent-[color:var(--tv-accent)]"
                              />
                              平后移保本
                            </label>
                            <span
                              className={clsx(
                                'font-mono text-[10px]',
                                row?.skipped && !finished ? 'text-tv-down' : 'text-tv-faint',
                              )}
                            >
                              {planStep.done
                                ? '已完成'
                                : planStep.skipped
                                  ? '已跳过'
                                  : row && row.lots > 0
                                    ? `≈ ${fmtVolume(row.lots, info?.volumeStep)} 手`
                                    : '仓位过小'}
                            </span>
                            <span className="flex-1" />
                            <button
                              onClick={() => void removePlanStep(position, planStep.id)}
                              disabled={planBusy}
                              className="rounded px-1 text-[10px] text-tv-muted transition-colors hover:text-tv-down"
                            >
                              删除
                            </button>
                          </div>
                        );
                      })}

                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <button
                          onClick={() => void addPlanStep(position)}
                          disabled={planBusy || full || !canSplit}
                          title={
                            !canSplit
                              ? '仓位已是最小手数，无法分批'
                              : full
                                ? `最多 ${MAX_PLAN_STEPS} 档`
                                : '添加一档，之后可在图上拖动'
                          }
                          className="h-6 rounded-md border border-tv-border px-2 text-[10px] text-tv-text transition-colors hover:bg-tv-hover disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          + 添加一档
                        </button>
                        {active.length > 0 && (
                          <span className="font-mono text-[10px] text-tv-faint">
                            剩余约 {fmtVolume(lots.remaining, info?.volumeStep)} 手
                          </span>
                        )}
                        <span className="flex-1" />
                        <span className="text-[10px] text-tv-faint">
                          {position.tp != null
                            ? `最终止盈 ${fmtPrice(position.tp, digits)}`
                            : '没有最终止盈：分批后的剩余仓位需手动处理'}
                        </span>
                      </div>
                      <p className="mt-1 text-[10px] leading-4 text-tv-faint">
                        网关关闭或应用退出时不会执行，只有券商的止损/止盈继续生效。
                      </p>
                    </div>
                  );
                })()}
            </div>
          );
        })}
      </div>
    </section>
  );
}
