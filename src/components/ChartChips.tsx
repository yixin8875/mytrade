import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { subscribeCrosshair, type CrosshairState } from '../chart/tv/sync';
import type { IChartWidgetApi } from '../../public/charting_library/charting_library';

export interface ChartChip {
  key: string;
  price: number;
  text: string;
  color: string;
  /** 有值时显示 ✕，点击执行（撤单 / 去掉止损等） */
  onRemove?: () => void;
  /** 拖动标签时回调；价格未取整，由调用方按 tick 对齐 */
  onMove?: (price: number) => void;
}

/** 图上从 from 到 to 的半透明区间（风险/盈利带），可带 R 倍数刻度 */
export interface ChartBand {
  key: string;
  from: number;
  to: number;
  color: string;
  label?: string;
  labelColor?: string;
  /** 区间内的刻度线，例如 1R/2R/3R；priceText 是该价位在价格轴旁的精确价格 */
  marks?: { price: number; text: string; priceText?: string }[];
}

interface Position {
  y: number;
  right: number;
}

interface BandPosition {
  top: number;
  left: number;
  width: number;
  height: number;
  marks: { key: string; y: number; text: string; priceText?: string }[];
}

interface GhostPosition {
  y: number;
  top: number;
  left: number;
  width: number;
  height: number;
  /** 垂直线在容器内的 x，时间映射不出来时为 null */
  vx: number | null;
  price: number;
}

interface Layout {
  chips: Record<string, Position | null>;
  bands: Record<string, BandPosition | null>;
  ghost: GhostPosition | null;
}

type ChartInternals = {
  getPanes?: () => {
    getMainSourcePriceScale?: () => {
      _priceScale?: { priceToCoordinate?: (price: number) => number };
    } | null;
  }[];
  getVisiblePriceRange?: () => { from: number; to: number } | null;
  getTimeScale?: () => { coordinateToTime?: (x: number) => number | null } | null;
};

type TvGlobal = {
  __tv?: { activeChart?: () => ChartInternals };
};

interface PaneBox {
  top: number;
  left: number;
  width: number;
  right: number;
  height: number;
  coord: (price: number) => number | null;
  /** 画布 y 坐标 → 价格；用于拖动右侧小块 */
  priceAt: (y: number) => number | null;
  /** 当前可见的价格区间，区间外的线不显示小块（否则会压住图表顶部的图例） */
  range: { from: number; to: number } | null;
}

/**
 * TradingView 把图表画在 same-origin 的 blob iframe 里，画线自带的文字标签只能居中，
 * 做不出「右边缘的小块 + 金额 + ×」。这里读 iframe 里主图 canvas 的位置和内部
 * priceToCoordinate，把 React 小块定位到价格线上——线条仍由图表绘制。
 */
export function measurePane(
  host: HTMLElement,
  chartApi?: IChartWidgetApi | null,
): PaneBox | null {
  const tv = (window as unknown as TvGlobal).__tv;
  const chart = (chartApi as unknown as ChartInternals | null | undefined) ?? tv?.activeChart?.();
  const scale = chart?.getPanes?.()[0]?.getMainSourcePriceScale?.()?._priceScale;
  if (!scale?.priceToCoordinate) return null;

  // 图表刚创建时 iframe/画布还没就绪，取不到就等下一帧
  const frame = host.querySelector('iframe') ?? document.querySelector('iframe');
  const doc = frame?.contentDocument;
  if (!frame || !doc) return null;

  let canvas: HTMLCanvasElement | null = null;
  for (const item of doc.querySelectorAll('canvas')) {
    const rect = item.getBoundingClientRect();
    if (rect.width > 200 && rect.height > 200) {
      canvas = item;
      break;
    }
  }
  if (!canvas) return null;

  let range: { from: number; to: number } | null = null;
  try {
    const visible = chart?.getVisiblePriceRange?.();
    if (visible && Number.isFinite(visible.from) && Number.isFinite(visible.to)) {
      range = { from: visible.from, to: visible.to };
    }
  } catch {
    range = null;
  }

  const frameRect = frame.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  return {
    top: frameRect.top + canvasRect.top,
    left: frameRect.left + canvasRect.left,
    width: canvasRect.width,
    right: frameRect.left + canvasRect.left + canvasRect.width,
    height: canvasRect.height,
    range,
    coord: (price: number) => {
      const value = scale.priceToCoordinate?.(price);
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    },
    priceAt: (y: number) => {
      if (!range) return null;
      const fromY = scale.priceToCoordinate?.(range.from);
      const toY = scale.priceToCoordinate?.(range.to);
      if (
        typeof fromY !== 'number' ||
        typeof toY !== 'number' ||
        !Number.isFinite(fromY) ||
        !Number.isFinite(toY) ||
        fromY === toY
      ) {
        return null;
      }
      return range.from + ((y - fromY) * (range.to - range.from)) / (toY - fromY);
    },
  };
}

/**
 * 时间 → 画布 x。公开 API 只有 coordinateToTime（坐标 → 时间），
 * 所以采样一条单调曲线再按时间插值；周期不同的图也能对上同一时刻。
 */
export function timeToX(
  chart: IChartWidgetApi | null | undefined,
  time: number,
  width: number,
): number | null {
  if (!chart || !(width > 0) || !Number.isFinite(time)) return null;
  const scale = (chart as unknown as ChartInternals).getTimeScale?.();
  const toTime = scale?.coordinateToTime;
  if (!toTime) return null;

  const samples: { x: number; t: number }[] = [];
  const steps = 48;
  for (let index = 0; index <= steps; index++) {
    const x = (index / steps) * width;
    let t: number | null = null;
    try {
      t = toTime.call(scale, x);
    } catch {
      t = null;
    }
    if (typeof t === 'number' && Number.isFinite(t)) samples.push({ x, t });
  }
  if (samples.length < 2) return null;

  for (let index = 1; index < samples.length; index++) {
    const a = samples[index - 1];
    const b = samples[index];
    const low = Math.min(a.t, b.t);
    const high = Math.max(a.t, b.t);
    if (time < low || time > high) continue;
    if (b.t === a.t) return a.x;
    const ratio = (time - a.t) / (b.t - a.t);
    return a.x + (b.x - a.x) * ratio;
  }
  return null;
}

export function ChartChips({
  chips,
  bands = [],
  host,
  chart = null,
  slot = 'main',
  syncCrosshair = true,
}: {
  chips: ChartChip[];
  bands?: ChartBand[];
  host: RefObject<HTMLDivElement | null>;
  chart?: IChartWidgetApi | null;
  /** 用于过滤自己发出的十字线联动 */
  slot?: string;
  /** 关闭时不再显示其他图表的十字线 */
  syncCrosshair?: boolean;
}) {
  const [layout, setLayout] = useState<Layout>({ chips: {}, bands: {}, ghost: null });
  const chipsRef = useRef(chips);
  chipsRef.current = chips;
  const bandsRef = useRef(bands);
  bandsRef.current = bands;
  const chartRef = useRef(chart);
  chartRef.current = chart;
  const ghostRef = useRef<CrosshairState | null>(null);
  const lastRef = useRef('');
  const [drag, setDrag] = useState<{ key: string; y: number; right: number } | null>(null);
  const dragRef = useRef<{
    key: string;
    pointerId: number;
    box: PaneBox;
    paneTop: number;
    right: number;
    startY: number;
    startPriceY: number;
    lastMove: number;
    onMove: (price: number) => void;
  } | null>(null);

  const startChipDrag = (chip: ChartChip, event: ReactPointerEvent<HTMLDivElement>) => {
    if (!chip.onMove) return;
    if ((event.target as HTMLElement).closest('button')) return;
    const hostEl = host.current;
    const box = hostEl ? measurePane(hostEl, chartRef.current) : null;
    const hostRect = hostEl?.getBoundingClientRect();
    if (!box || !hostRect) return;
    const startPriceY = box.coord(chip.price);
    if (startPriceY == null) return;
    const paneTop = box.top - hostRect.top;
    const right = hostRect.right - box.right + 6;
    dragRef.current = {
      key: chip.key,
      pointerId: event.pointerId,
      box,
      paneTop,
      right,
      startY: event.clientY,
      startPriceY,
      lastMove: 0,
      onMove: chip.onMove,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
    setDrag({ key: chip.key, y: paneTop + startPriceY, right });
  };

  const moveChipDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;
    if (!current || event.pointerId !== current.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const targetY = current.startPriceY + (event.clientY - current.startY);
    const price = current.box.priceAt(targetY);
    if (price == null) return;
    setDrag({
      key: current.key,
      y: current.paneTop + Math.min(Math.max(targetY, 8), current.box.height - 8),
      right: current.right,
    });
    const now = performance.now();
    if (now - current.lastMove >= 90) {
      current.lastMove = now;
      current.onMove(price);
    }
  };

  const endChipDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;
    if (!current || event.pointerId !== current.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const targetY = current.startPriceY + (event.clientY - current.startY);
    const price = current.box.priceAt(targetY);
    if (price != null) current.onMove(price);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* 指针已释放 */
    }
    dragRef.current = null;
    setDrag(null);
  };

  const cancelChipDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;
    if (!current || event.pointerId !== current.pointerId) return;
    dragRef.current = null;
    setDrag(null);
  };

  // 其他图表的十字线：订阅后写进 ref，由下面的动画帧循环读取
  useEffect(() => {
    if (!syncCrosshair) {
      ghostRef.current = null;
      return;
    }
    return subscribeCrosshair((state) => {
      ghostRef.current = !state || state.from === slot ? null : state;
    });
  }, [slot, syncCrosshair]);

  useEffect(() => {
    let raf = 0;
    let last = 0;

    const tick = (time: number) => {
      if (time - last >= 50) {
        last = time;
        let next: Layout = { chips: {}, bands: {}, ghost: null };
        try {
          const hostEl = host.current;
          const box = hostEl ? measurePane(hostEl, chartRef.current) : null;
          const hostRect = hostEl?.getBoundingClientRect();

          if (box && hostRect) {
            const paneTop = box.top - hostRect.top;
            const right = hostRect.right - box.right + 6;
            const left = box.left - hostRect.left;
            const raw: { key: string; y: number }[] = [];
            for (const chip of chipsRef.current) {
              const value = box.coord(chip.price);
              const outsideRange = !!box.range &&
                (chip.price < box.range.from || chip.price > box.range.to);
              if (outsideRange || value == null || value < -2 || value > box.height + 2) {
                next.chips[chip.key] = null;
                continue;
              }
              // 贴边时把小块往里收一点，别被图表顶栏/底栏切掉
              raw.push({ key: chip.key, y: Math.min(Math.max(value, 10), box.height - 10) });
            }
            // 同一价格附近有多笔持仓/挂单时，小块竖直错行，避免叠在一起看不清
            const CHIP_GAP = 18;
            raw.sort((a, b) => a.y - b.y);
            let index = 0;
            while (index < raw.length) {
              let end = index + 1;
              while (end < raw.length && raw[end].y - raw[end - 1].y < CHIP_GAP) end += 1;
              const group = raw.slice(index, end);
              const center = group.reduce((sum, item) => sum + item.y, 0) / group.length;
              const top = center - ((group.length - 1) * CHIP_GAP) / 2;
              group.forEach((item, offset) => {
                const y = Math.min(Math.max(top + offset * CHIP_GAP, 10), box.height - 10);
                next.chips[item.key] = { y: paneTop + y, right };
              });
              index = end;
            }

            for (const band of bandsRef.current) {
              const a = box.coord(band.from);
              const b = box.coord(band.to);
              if (a == null || b == null) {
                next.bands[band.key] = null;
                continue;
              }
              const topRaw = Math.min(a, b);
              const bottomRaw = Math.max(a, b);
              const top = Math.max(0, topRaw);
              const bottom = Math.min(box.height, bottomRaw);
              if (bottom - top < 1) {
                next.bands[band.key] = null;
                continue;
              }
              next.bands[band.key] = {
                top: paneTop + top,
                left,
                width: box.width,
                height: bottom - top,
                marks: (band.marks ?? []).flatMap((mark) => {
                  const y = box.coord(mark.price);
                  if (y == null || y < top - 1 || y > bottom + 1) return [];
                  return [
                    {
                      key: `${band.key}:${mark.text}`,
                      y: paneTop + y,
                      text: mark.text,
                      priceText: mark.priceText,
                    },
                  ];
                }),
              };
            }

            // 其他图表的十字线：横向按价格画，纵向按时间换算到本图坐标
            const ghost = ghostRef.current;
            if (ghost) {
              const y = box.coord(ghost.price);
              const insideRange = !box.range ||
                (ghost.price >= box.range.from && ghost.price <= box.range.to);
              if (y != null && insideRange && y >= -2 && y <= box.height + 2) {
                const left = box.left - hostRect.left;
                const timeX = ghost.time != null ? timeToX(chartRef.current, ghost.time, box.width) : null;
                next.ghost = {
                  y: paneTop + Math.min(Math.max(y, 0), box.height),
                  top: paneTop,
                  left,
                  width: box.width,
                  height: box.height,
                  vx: timeX == null ? null : left + timeX,
                  price: ghost.price,
                };
              }
            }
          }
        } catch {
          // 图表切换/销毁瞬间内部对象可能暂时不可用，下一帧再试
          next = { chips: {}, bands: {}, ghost: null };
        }

        const fingerprint = JSON.stringify(next);
        if (fingerprint !== lastRef.current) {
          lastRef.current = fingerprint;
          setLayout(next);
        }
      }
      raf = window.requestAnimationFrame(tick);
    };

    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [host]);

  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      {layout.ghost && (
        <>
          <div
            data-ghost="price"
            className="pointer-events-none absolute border-t border-dashed border-tv-accent/50"
            style={{
              top: layout.ghost.y,
              left: layout.ghost.left,
              width: layout.ghost.width,
            }}
          />
          {layout.ghost.vx != null && (
            <div
              data-ghost="time"
              className="pointer-events-none absolute border-l border-dashed border-tv-accent/30"
              style={{
                left: layout.ghost.vx,
                top: layout.ghost.top,
                height: layout.ghost.height,
              }}
            />
          )}
        </>
      )}
      {bands.map((band) => {
        const pos = layout.bands[band.key];
        if (!pos) return null;
        return (
          <div
            key={band.key}
            data-band={band.key}
            className="pointer-events-none absolute"
            style={{
              top: pos.top,
              left: pos.left,
              width: pos.width,
              height: pos.height,
              backgroundColor: band.color,
            }}
          >
            {band.label && (
              <span
                className="absolute left-2 top-1 whitespace-nowrap font-mono text-[11px]"
                style={{ color: band.labelColor ?? 'rgba(209,212,220,0.75)' }}
              >
                {band.label}
              </span>
            )}
            {pos.marks.map((mark, index) => {
              // 刻度挨得太近时不标价格，免得两行数字叠在一起
              const prev = pos.marks[index - 1];
              const next = pos.marks[index + 1];
              const tight =
                (prev != null && Math.abs(mark.y - prev.y) < 13) ||
                (next != null && Math.abs(next.y - mark.y) < 13);
              return (
                <div
                  key={mark.key}
                  className="absolute inset-x-0 border-t border-white/15"
                  style={{ top: mark.y - pos.top }}
                >
                  <span className="absolute left-2 -top-[9px] font-mono text-[11px] text-tv-muted">
                    {mark.text}
                  </span>
                  {/* 贴住价格轴一侧的短横线：明确点出这个 R 对应的价位 */}
                  <span
                    className="absolute right-0 top-0 w-7 border-t"
                    style={{
                      borderColor: band.labelColor ?? 'rgba(255,255,255,0.55)',
                      opacity: 0.7,
                    }}
                  />
                  {mark.priceText && !tight && (
                    <span
                      data-r-price={mark.text}
                      className="absolute right-9 -top-[7px] whitespace-nowrap font-mono text-[10px] tabular-nums text-tv-muted"
                    >
                      {mark.priceText}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
      {chips.map((chip) => {
        const pos = layout.chips[chip.key];
        const dragging = drag?.key === chip.key;
        const top = dragging && drag ? drag.y : pos?.y;
        if (top == null) return null;
        const right = dragging && drag ? drag.right : pos?.right ?? 6;
        return (
          <div
            key={chip.key}
            data-chip={chip.key}
            className="pointer-events-auto absolute flex h-5 -translate-y-1/2 select-none items-center rounded pl-1.5 font-mono text-[11px] font-medium text-white shadow-sm"
            style={{
              top,
              right,
              backgroundColor: chip.color,
              touchAction: 'none',
              cursor: chip.onMove ? 'ns-resize' : undefined,
            }}
            onPointerDown={chip.onMove ? (event) => startChipDrag(chip, event) : undefined}
            onPointerMove={chip.onMove ? moveChipDrag : undefined}
            onPointerUp={chip.onMove ? endChipDrag : undefined}
            onPointerCancel={chip.onMove ? cancelChipDrag : undefined}
          >
            <span className="whitespace-nowrap pr-1">{chip.text}</span>
            {chip.onRemove && (
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  chip.onRemove?.();
                }}
                className="ml-0.5 flex h-full items-center rounded-r-sm border-l border-white/30 px-1 text-white/75 hover:bg-black/15 hover:text-white"
                title="移除"
              >
                ✕
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
