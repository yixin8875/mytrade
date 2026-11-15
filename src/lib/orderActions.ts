import { gateway } from '../gateway/client';
import type { Order, Toast, ToastAction } from '../gateway/types';

type Notify = (kind: Toast['kind'], text: string, action?: ToastAction) => void;

/** 撤销重挂：沿用原单的品种、方向、类型、手数、委托价与止损止盈 */
async function replaceOrder(order: Order, notify: Notify): Promise<void> {
  try {
    await gateway.call('order.place', {
      clientOrderId: crypto.randomUUID(),
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      volume: order.volume,
      price: order.price,
      sl: order.sl ?? undefined,
      tp: order.tp ?? undefined,
    });
    notify('success', `已重新挂上 ${order.symbol} ${order.side === 'buy' ? '买入' : '卖出'}`);
  } catch (error) {
    notify('error', `重挂失败：${(error as Error).message}。价格可能已穿过，请重新下单`);
  }
}

/**
 * 撤单统一入口：成功后弹 6 秒「撤销」，用原参数重新挂单。
 * 原来的分批计划不会随撤销恢复，提示里不承诺这一点。
 */
export async function cancelOrderWithUndo(order: Order, notify: Notify): Promise<boolean> {
  try {
    await gateway.call('order.cancel', { ticket: order.ticket });
  } catch (error) {
    notify('error', (error as Error).message);
    return false;
  }
  notify('info', `已撤 ${order.symbol} #${order.ticket}`, {
    label: '撤销',
    run: () => {
      void replaceOrder(order, notify);
    },
  });
  return true;
}
