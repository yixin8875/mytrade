import { useEffect, useRef, useState } from 'react';
import { ChartPanel } from './ChartPanel';
import { DEFAULT_FRAMES, layoutById } from '../chart/layouts';
import { currentSlot, setActiveSlot, subscribeSymbolRequest } from '../chart/tv/registry';
import { useApp } from '../store/useApp';

/** 最多 16 格；不足的布局只使用前面的格子 */
const CELLS = DEFAULT_FRAMES.length;
const FRAMES_KEY = 'mytrade.cellFrames';
const LEGACY_FRAMES_KEY = 'mytrade.quadFrames';
const SYMBOLS_KEY = 'mytrade.cellSymbols';

function readJson(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function persist(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 写不进去也继续用 */
  }
}

/** 每格周期存本地，刷新后保持上次的搭配；旧的四图周期自动迁移 */
function loadFrames(): string[] {
  const next = [...DEFAULT_FRAMES];
  let raw = readJson(FRAMES_KEY);
  if (!Array.isArray(raw)) raw = readJson(LEGACY_FRAMES_KEY);
  if (Array.isArray(raw)) {
    raw.forEach((value, index) => {
      if (index < CELLS && typeof value === 'string' && value) next[index] = value;
    });
  }
  return next;
}

/** 每格品种；空串表示跟随全局品种 */
function loadSymbols(): string[] {
  const next = Array.from({ length: CELLS }, () => '');
  const raw = readJson(SYMBOLS_KEY);
  if (Array.isArray(raw)) {
    raw.forEach((value, index) => {
      if (index < CELLS && typeof value === 'string') next[index] = value;
    });
  }
  return next;
}

/** ChartPanel 的 slot 与格子下标：main 是 0，cN 是 N */
function slotFor(index: number): string {
  return index === 0 ? 'main' : `c${index}`;
}

function indexForSlot(slot: string, count: number): number {
  if (slot === 'main') return 0;
  const index = Number(slot.replace(/^c/, ''));
  return Number.isInteger(index) && index >= 0 && index < count ? index : 0;
}

export function ChartGrid() {
  const layoutId = useApp((s) => s.layout);
  const symbol = useApp((s) => s.symbol);
  const resolution = useApp((s) => s.resolution);
  const available = useApp((s) => s.symbols);
  const sync = useApp((s) => s.layoutSync);
  const setSymbol = useApp((s) => s.setSymbol);
  const setResolution = useApp((s) => s.setResolution);
  const preset = layoutById(layoutId);

  const [frames, setFrames] = useState<string[]>(loadFrames);
  const [symbols, setSymbols] = useState<string[]>(loadSymbols);

  // 全局品种确定后，把还没单独设置过的格子填成当前品种，
  // 之后某个格子换品种就不会顺带把其他格子一起拖走。
  // 开着「商品代码同步」时全部对齐全局，关掉同步的瞬间画面保持不变。
  useEffect(() => {
    if (!symbol) return;
    setSymbols((prev) => {
      const next = prev.map((value) => (sync.symbol ? symbol : value || symbol));
      if (next.every((value, index) => value === prev[index])) return prev;
      persist(SYMBOLS_KEY, next);
      return next;
    });
  }, [symbol, sync.symbol]);

  // 启动时格子会恢复上次的品种，全局品种却会被重置成默认值（通常按字母序第一个）。
  // 两者不一致时，下单区按 A 品种算价、图表画的却是 B 品种，画线下单的线会落在
  // 可视区间外，看起来像“点了没反应”。这里让下单品种跟随当前操作的格子。
  useEffect(() => {
    if (sync.symbol || !symbol || available.length === 0) return;
    const index = indexForSlot(currentSlot(), preset.count);
    const cell = symbols[index];
    if (!cell || cell === symbol) return;
    if (!available.some((item) => item.name === cell)) return;
    setSymbol(cell);
  }, [symbol, symbols, available, sync.symbol, preset.count, setSymbol]);

  // 周期同步同理：同步期间把全局周期记到每一格，关掉同步时不跳回旧周期。
  useEffect(() => {
    if (!sync.interval || !resolution) return;
    setFrames((prev) => {
      if (prev.every((value) => value === resolution)) return prev;
      const next = prev.map(() => resolution);
      persist(FRAMES_KEY, next);
      return next;
    });
  }, [resolution, sync.interval]);

  const changeSymbol = (index: number, next: string) => {
    setActiveSlot(slotFor(index));
    if (sync.symbol) {
      if (useApp.getState().symbol !== next) setSymbol(next);
      return;
    }
    setSymbols((prev) => {
      if (prev[index] === next) return prev;
      const values = [...prev];
      values[index] = next;
      persist(SYMBOLS_KEY, values);
      return values;
    });
    // 下单 / 持仓列表跟随当前操作的图表
    if (useApp.getState().symbol !== next) setSymbol(next);
  };

  const changeInterval = (index: number, next: string) => {
    setActiveSlot(slotFor(index));
    if (sync.interval) {
      if (useApp.getState().resolution !== next) setResolution(next);
      return;
    }
    setFrames((prev) => {
      if (prev[index] === next) return prev;
      const values = [...prev];
      values[index] = next;
      persist(FRAMES_KEY, values);
      return values;
    });
  };

  // 自选列表等图表外部入口：把品种送到最近操作的那一格。
  // 直接改全局品种是不够的——每格都有自己的品种，全局值变化不会自动落到格子里。
  const changeSymbolRef = useRef(changeSymbol);
  changeSymbolRef.current = changeSymbol;
  const cellCountRef = useRef(preset.count);
  cellCountRef.current = preset.count;

  useEffect(
    () =>
      subscribeSymbolRequest((next) => {
        changeSymbolRef.current(indexForSlot(currentSlot(), cellCountRef.current), next);
      }),
    [],
  );

  return (
    <div
      className="grid h-full w-full gap-px bg-tv-border"
      style={{
        gridTemplateAreas: preset.areas,
        gridTemplateColumns: `repeat(${preset.cols}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${preset.rows}, minmax(0, 1fr))`,
      }}
    >
      {Array.from({ length: preset.count }, (_, index) => (
        <div
          key={index}
          style={{ gridArea: `c${index}` }}
          className="relative min-h-0 min-w-0 overflow-hidden bg-tv-bg"
        >
          <ChartPanel
            slot={index === 0 ? 'main' : `c${index}`}
            symbol={sync.symbol ? symbol : symbols[index] || symbol}
            resolution={sync.interval ? resolution : frames[index]}
            syncCrosshair={sync.crosshair}
            syncRange={sync.time || sync.dateRange}
            onSymbolChange={(next) => changeSymbol(index, next)}
            onIntervalChange={(next) => changeInterval(index, next)}
          />
        </div>
      ))}
    </div>
  );
}
