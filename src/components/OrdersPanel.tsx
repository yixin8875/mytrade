import { useState } from 'react';
import { clsx } from 'clsx';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import { fmtPrice, fmtVolume } from '../lib/format';

export function OrdersPanel() {
  const orders = useApp((s) => s.orders);
  const symbols = useApp((s) => s.symbols);
  const notify = useApp((s) => s.notify);
  const [confirmTicket, setConfirmTicket] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const cancel = async (ticket: number) => {
    setBusy(ticket);
    try {
      await gateway.call('order.cancel', { ticket });
      setConfirmTicket(null);
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section>
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[11px] font-semibold tracking-wide text-tv-muted">
          挂单 <span className="ml-1 text-tv-text">{orders.length}</span>
        </span>
      </div>
      <div className="max-h-[200px] overflow-auto">
        {orders.length === 0 && (
          <div className="px-3 pb-3 text-[11px] text-tv-muted">暂无挂单</div>
        )}
        {orders.map((order) => {
          const info = symbols.find((item) => item.name === order.symbol);
          const digits = info?.digits ?? 5;
          return (
            <div
              key={order.ticket}
              className="flex items-center gap-2 border-t border-tv-border/60 px-3 py-1.5 text-[11px]"
            >
              <span
                className={clsx(
                  'w-7 shrink-0 rounded px-1 py-0.5 text-center text-[9px] font-semibold text-white',
                  order.side === 'buy' ? 'bg-tv-up' : 'bg-tv-down',
                )}
              >
                {order.side === 'buy' ? '买' : '卖'}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-tv-text">
                  {order.symbol}
                  <span className="ml-1 text-tv-muted">
                    {fmtVolume(order.volume, info?.volumeStep)}
                  </span>
                  <span className="ml-1 text-[9px] uppercase text-tv-muted">
                    {order.type === 'limit' ? 'limit' : 'stop'}
                  </span>
                </div>
                <div className="truncate text-[10px] text-tv-muted">
                  @ {fmtPrice(order.price, digits)}
                  {order.sl != null ? ` · SL ${fmtPrice(order.sl, digits)}` : ''}
                  {order.tp != null ? ` · TP ${fmtPrice(order.tp, digits)}` : ''}
                </div>
              </div>
              <button
                onClick={() =>
                  confirmTicket === order.ticket ? cancel(order.ticket) : setConfirmTicket(order.ticket)
                }
                disabled={busy === order.ticket}
                className={clsx(
                  'h-5 shrink-0 rounded px-1.5 text-[10px]',
                  confirmTicket === order.ticket
                    ? 'bg-tv-down text-white'
                    : 'bg-tv-border text-tv-text hover:bg-tv-hover',
                )}
              >
                {busy === order.ticket ? '…' : confirmTicket === order.ticket ? '确认' : '撤'}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
