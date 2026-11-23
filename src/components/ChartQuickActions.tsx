import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Plus } from 'lucide-react';
import { measurePriceAxis, type PriceAxisBox } from './ChartChips';
import { Kbd } from './ui/kbd';
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from './ui/menu';
import { useApp } from '../store/useApp';
import { buildQuickActionItems, type QuickActionItem } from '../lib/chartQuickActions';
import { roundToTick } from '../lib/orderPrice';
import type { IChartWidgetApi } from '../../public/charting_library/charting_library';

interface Spot {
  /** 已按 tick 对齐的点击价 */
  price: number;
  /** 容器内 top（已夹在绘图区内） */
  top: number;
  /** 容器内 right：贴在价格轴左侧 4px */
  right: number;
}

const BUTTON = 20;
const HIDE_DELAY = 180;

/**
 * 价格轴悬停的「+」：库自带的快速交易/警报按钮在这个构建里是空实现，
 * 这里用覆盖层补一个，菜单里的三个动作走 store 的同一入口
 * （只预填草稿 / 告警，不直接下单）。
 *
 * 覆盖层整体 pointer-events-none，只有按钮和菜单可点，
 * 不影响图表本身的十字线、拖拽与价格轴缩放。
 */
export function ChartQuickActions({
  host,
  chart,
  symbol,
}: {
  host: RefObject<HTMLDivElement | null>;
  chart: IChartWidgetApi | null;
  symbol: string;
}) {
  const alertsOpen = useApp((s) => s.alertsOpen);
  const calendarOpen = useApp((s) => s.calendarOpen);
  const quote = useApp((s) => s.quote);
  const symbols = useApp((s) => s.symbols);
  const draftVolume = useApp((s) => s.draft.volume);
  const runQuickAction = useApp((s) => s.chartQuickAction);

  const [spot, setSpot] = useState<Spot | null>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<{ at: number; box: PriceAxisBox | null }>({ at: 0, box: null });
  const hideTimer = useRef<number | null>(null);
  const openRef = useRef(false);
  openRef.current = open;

  const info = symbols.find((item) => item.name === symbol);
  const digits = info?.digits ?? 5;
  const items = spot
    ? buildQuickActionItems({
        price: spot.price,
        symbol,
        volume: draftVolume,
        digits,
        step: info?.volumeStep ?? 0.01,
        // 全局 quote 可能属于别的品种（多图/刚切换），不能拿来判断限价停损
        quote: quote?.symbol === symbol ? quote : null,
        info,
      })
    : [];

  const cancelHide = useCallback(() => {
    if (hideTimer.current != null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  // 从 iframe 移到按钮/菜单上时不会有新的十字线事件，延迟隐藏避免按钮先消失。
  // 菜单打开期间不隐藏，否则按钮一消失，菜单跟着卸载、open 状态还会卡住。
  const scheduleHide = useCallback(() => {
    if (openRef.current) return;
    cancelHide();
    hideTimer.current = window.setTimeout(() => setSpot(null), HIDE_DELAY);
  }, [cancelHide]);

  useEffect(() => () => cancelHide(), [cancelHide]);

  // 按钮位置没了就把菜单一并关掉，恢复下一次悬停
  useEffect(() => {
    if (!spot) setOpen(false);
  }, [spot]);

  // 价格轴上的移动不会触发 crossHairMoved（十字线不进价格标尺），
  // 所以直接听 iframe 文档的 mousemove，再用价格标尺把 y 反推成价格。
  useEffect(() => {
    if (!chart || !host.current) return;
    const hostEl = host.current;
    const doc = hostEl.querySelector('iframe')?.contentDocument;
    if (!doc) return;
    let last = 0;

    const handler = (event: MouseEvent) => {
      // 菜单打开后冻结位置，否则按钮和弹层会跟着鼠标漂走
      if (openRef.current) return;
      const now = performance.now();
      if (now - last < 50) return;
      last = now;
      let box = boxRef.current.box;
      if (!box || now - boxRef.current.at > 1500) {
        box = measurePriceAxis(hostEl, chart);
        boxRef.current = { at: now, box };
      }
      if (!box || !box.inAxis(event.clientX, event.clientY)) {
        cancelHide();
        setSpot(null);
        return;
      }
      const raw = box.priceAtLocal(event.clientY);
      if (raw == null) return;
      const current = useApp.getState();
      const infoNow = current.symbols.find((item) => item.name === symbol);
      const price = roundToTick(raw, infoNow);
      if (!Number.isFinite(price) || !(price > 0)) return;
      const y = box.yFor(price) ?? event.clientY;
      const top = Math.min(
        Math.max(y - BUTTON / 2, box.top + 2),
        box.top + box.height - BUTTON - 2,
      );
      cancelHide();
      setSpot((prev) =>
        prev && prev.price === price && prev.top === top && prev.right === box!.right
          ? prev
          : { price, top, right: box!.right },
      );
    };

    const leave = () => {
      if (!openRef.current) setSpot(null);
    };
    doc.addEventListener('mousemove', handler, true);
    doc.addEventListener('mouseleave', leave);
    return () => {
      doc.removeEventListener('mousemove', handler, true);
      doc.removeEventListener('mouseleave', leave);
      boxRef.current = { at: 0, box: null };
    };
  }, [chart, host, symbol, cancelHide]);

  // 鼠标离开整个图表容器时收起（iframe 外面的事件不会再经过十字线）
  useEffect(() => {
    const panel = rootRef.current?.parentElement;
    if (!panel) return;
    const leave = () => scheduleHide();
    const enter = () => cancelHide();
    panel.addEventListener('pointerleave', leave);
    panel.addEventListener('pointerenter', enter);
    return () => {
      panel.removeEventListener('pointerleave', leave);
      panel.removeEventListener('pointerenter', enter);
      cancelHide();
    };
  }, [scheduleHide, cancelHide]);

  // 菜单开着时点图表（iframe 内的点击不会冒泡到父文档）要能关掉
  useEffect(() => {
    if (!open) return;
    const doc = host.current?.querySelector('iframe')?.contentDocument;
    if (!doc) return;
    const close = () => setOpen(false);
    doc.addEventListener('pointerdown', close, true);
    return () => doc.removeEventListener('pointerdown', close, true);
  }, [open, host]);

  const execute = (item: QuickActionItem) => {
    runQuickAction(item.action, item.price, symbol);
    setOpen(false);
    setSpot(null);
  };

  const hidden = !spot || alertsOpen || calendarOpen;
  if (hidden) {
    return <div ref={rootRef} className="pointer-events-none absolute inset-0 z-30" />;
  }

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute inset-0 z-30"
      onPointerLeave={scheduleHide}
      onPointerEnter={cancelHide}
    >
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger
          aria-label="图表快捷操作"
          title="添加警报 / 买入 / 卖出"
          className="pointer-events-auto absolute flex size-5 items-center justify-center rounded-md border border-border bg-popover text-muted-foreground shadow-sm/5 outline-none transition-colors hover:border-ring hover:bg-accent hover:text-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 data-[popup-open]:border-ring data-[popup-open]:bg-accent data-[popup-open]:text-foreground"
          style={{ top: spot.top, right: spot.right }}
        >
          <Plus size={13} strokeWidth={2} />
        </MenuTrigger>
        <MenuPopup side="left" align="center" sideOffset={6} className="w-[360px]">
          <div className="px-2 py-1 font-mono text-[11px] text-muted-foreground">
            {symbol} · {spot.price.toFixed(digits)}
          </div>
          <MenuSeparator />
          {items.map((item) => (
            <MenuItem
              key={item.action}
              disabled={item.disabled}
              onClick={() => execute(item)}
              className="gap-3 text-[12px]"
            >
              <span className="min-w-0 flex-1 truncate">{item.text}</span>
              <Kbd className="shrink-0">{item.hint}</Kbd>
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </div>
  );
}
