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
      <div className="flex h-10 items-center justify-between px-4">
        <span className="text-[12px] font-semibold text-tv-text">
          挂单
          <span className="num ml-1.5 font-mono text-[11px] font-normal text-tv-muted">
            {orders.length}
          </span>
        </span>
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
                onClick={() =>
                  confirmTicket === order.ticket ? cancel(order.ticket) : setConfirmTicket(order.ticket)
                }
                disabled={busy === order.ticket}
                className={clsx(
                  'h-6 shrink-0 rounded-md px-2 text-[11px] transition-colors',
                  confirmTicket === order.ticket
                    ? 'bg-tv-down text-white'
                    : 'bg-tv-raised text-tv-text hover:bg-tv-hover',
                )}
              >
                {busy === order.ticket ? '…' : confirmTicket === order.ticket ? '确认' : '撤单'}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
