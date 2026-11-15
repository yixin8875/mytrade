import { useState } from 'react';
import { clsx } from 'clsx';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import { fmtPrice, fmtSigned, fmtVolume, roundVolume, signedClass } from '../lib/format';
import { validateStops } from '../lib/stops';
import type { BreakevenResult, Position } from '../gateway/types';

export function PositionsPanel() {
  const positions = useApp((s) => s.positions);
  const symbols = useApp((s) => s.symbols);
  const quote = useApp((s) => s.quote);
  const notify = useApp((s) => s.notify);
  const [confirmTicket, setConfirmTicket] = useState<number | null>(null);
  const [confirmHalf, setConfirmHalf] = useState<number | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [trailFor, setTrailFor] = useState<number | null>(null);
  const [trailDist, setTrailDist] = useState('20');
  const [busy, setBusy] = useState<number | null>(null);
  const [closingAll, setClosingAll] = useState(false);
  const [stopsFor, setStopsFor] = useState<number | null>(null);
  const [slInput, setSlInput] = useState('');
  const [tpInput, setTpInput] = useState('');

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
        offsetPoints: 0,
      });
      notify(
        res.changed ? 'success' : 'info',
        res.changed
          ? `止损已移到开仓价 ${fmtPrice(res.sl, digits)}`
          : '止损已经在开仓价或更好，无需移动',
      );
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
        { ticket: position.ticket, volume: half, moveToBe: true },
      );
      const moved = res?.breakeven?.changed ? '，止损已移到开仓价' : '';
      notify('success', `已平 ${res?.volume ?? half} 手${moved}`);
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

  return (
    <section className="border-b border-tv-border">
      <div className="flex h-10 items-center justify-between px-4">
        <span className="text-[12px] font-semibold text-tv-text">
          持仓
          <span className="num ml-1.5 font-mono text-[11px] font-normal text-tv-muted">
            {positions.length}
          </span>
        </span>
        {positions.length > 0 && (
          <button
            onClick={() => void closeAll()}
            disabled={closingAll}
            className={clsx(
              'rounded-md px-1.5 py-0.5 text-[11px] transition-colors',
              confirmAll ? 'bg-tv-down text-white' : 'text-tv-muted hover:text-tv-text',
              closingAll && 'cursor-not-allowed opacity-50',
            )}
          >
            {closingAll ? '平仓中…' : confirmAll ? '确认全平？' : '全部平仓'}
          </button>
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
                    title="把止损移到开仓价（保本）"
                    className="h-6 rounded-md border border-tv-border px-2 text-[11px] text-tv-text transition-colors hover:bg-tv-hover"
                  >
                    保本
                  </button>
                  <button
                    onClick={() => closeHalf(position)}
                    disabled={
                      busy === position.ticket || position.volume <= (info?.minVolume ?? 0.01)
                    }
                    title="平掉一半仓位，止损同时移到保本"
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
            </div>
          );
        })}
      </div>
    </section>
  );
}
