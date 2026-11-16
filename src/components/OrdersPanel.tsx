import { useState } from 'react';
import { clsx } from 'clsx';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import { fmtPrice, fmtVolume } from '../lib/format';
import { cancelOrderWithUndo } from '../lib/orderActions';
import type { CancelAllResult, Order } from '../gateway/types';

export function OrdersPanel() {
  const orders = useApp((s) => s.orders);
  const symbols = useApp((s) => s.symbols);
  const notify = useApp((s) => s.notify);
  const [busy, setBusy] = useState<number | null>(null);
  const [confirmCancelAll, setConfirmCancelAll] = useState(false);
  const [cancellingAll, setCancellingAll] = useState(false);

  const cancel = async (order: Order) => {
    setBusy(order.ticket);
    try {
      await cancelOrderWithUndo(order, notify);
    } finally {
      setBusy(null);
    }
  };

  /** 批量撤销不提供撤销：原价可能已经穿过，重挂是另一笔委托。 */
  const cancelAll = async () => {
    if (!confirmCancelAll) {
      setConfirmCancelAll(true);
      window.setTimeout(() => setConfirmCancelAll(false), 4000);
      return;
    }
    setConfirmCancelAll(false);
    setCancellingAll(true);
    try {
      const res = await gateway.call<CancelAllResult>('order.cancelAll', {});
      const results = res?.results ?? [];
      const failed = results.filter((item) => item.error).length;
      const ok = results.length - failed;
      const rest = res?.remaining ? `，剩余 ${res.remaining} 个` : '';
      notify(
        failed || rest ? 'error' : 'success',
        failed
          ? `已撤销 ${ok}/${results.length} 个，${failed} 个失败${rest}`
          : `已撤销 ${results.length} 个挂单${rest}`,
      );
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setCancellingAll(false);
    }
  };

  return (
    <section>
      <div className="flex h-10 items-center justify-between px-4">
        <span className="text-[12px] font-semibold text-tv-text">
          挂单
          <span className="num ml-1.5 font-mono text-[11px] font-normal text-tv-muted">
            {orders.length}
          </span>
        </span>
        {orders.length > 0 && (
          <button
            onClick={() => void cancelAll()}
            disabled={cancellingAll}
            title="批量撤销全部挂单（不支持撤销）"
            className={clsx(
              'rounded-md px-1.5 py-0.5 text-[11px] transition-colors',
              confirmCancelAll ? 'bg-tv-down text-white' : 'text-tv-muted hover:text-tv-text',
              cancellingAll && 'cursor-not-allowed opacity-50',
            )}
          >
            {cancellingAll ? '撤销中…' : confirmCancelAll ? '确认全部撤销？' : '全部撤销'}
          </button>
        )}
      </div>
      <div className="max-h-[200px] overflow-auto">
        {orders.length === 0 && (
          <div className="px-4 pb-4 text-[12px] text-tv-muted">暂无挂单</div>
        )}
        {orders.map((order) => {
          const info = symbols.find((item) => item.name === order.symbol);
          const digits = info?.digits ?? 5;
          return (
            <div
              key={order.ticket}
              className="flex items-center gap-2 border-t border-tv-border/60 px-4 py-2.5 text-[12px]"
            >
              <span
                className={clsx(
                  'flex w-8 shrink-0 items-center gap-1 text-[11px]',
                  order.side === 'buy' ? 'text-tv-up' : 'text-tv-down',
                )}
              >
                <span
                  className={clsx(
                    'h-1.5 w-1.5 rounded-full',
                    order.side === 'buy' ? 'bg-tv-up' : 'bg-tv-down',
                  )}
                />
                {order.side === 'buy' ? '买' : '卖'}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-tv-text">
                  <span className="font-medium">{order.symbol}</span>
                  <span className="num ml-1.5 font-mono text-[11px] text-tv-muted">
                    {fmtVolume(order.volume, info?.volumeStep)}
                  </span>
                  <span className="ml-1.5 text-[11px] text-tv-muted">
                    {order.type === 'limit' ? '限价' : '停损'}
                  </span>
                </div>
                <div className="truncate font-mono text-[11px] text-tv-muted">
                  @ {fmtPrice(order.price, digits)}
                  {order.sl != null ? ` · SL ${fmtPrice(order.sl, digits)}` : ''}
                  {order.tp != null ? ` · TP ${fmtPrice(order.tp, digits)}` : ''}
                </div>
              </div>
              <button
                onClick={() => void cancel(order)}
                disabled={busy === order.ticket}
                title="撤销后可立即恢复"
                className={clsx(
                  'h-6 shrink-0 rounded-md px-2 text-[11px] transition-colors',
                  'bg-tv-raised text-tv-text hover:bg-tv-hover',
                  busy === order.ticket && 'opacity-50',
                )}
              >
                {busy === order.ticket ? '…' : '撤单'}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
