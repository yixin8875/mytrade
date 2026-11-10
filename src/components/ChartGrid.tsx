import { useState } from 'react';
import { ChartPanel } from './ChartPanel';
import { useApp } from '../store/useApp';

const FRAMES_KEY = 'mytrade.quadFrames';
const DEFAULT_FRAMES = ['5', '15', '60', '240'];

/** 四图周期存本地，刷新后保持上次的搭配 */
function loadFrames(): string[] {
  try {
    const raw = window.localStorage.getItem(FRAMES_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (
      Array.isArray(parsed) &&
      parsed.length === 4 &&
      parsed.every((item) => typeof item === 'string' && item.length > 0)
    ) {
      return parsed as string[];
    }
  } catch {
    /* 坏数据就回默认 */
  }
  return DEFAULT_FRAMES;
}

export function ChartGrid() {
  const layout = useApp((s) => s.layout);
  const symbol = useApp((s) => s.symbol);
  const [frames, setFrames] = useState<string[]>(loadFrames);

  const setFrame = (index: number, frame: string) => {
    setFrames((prev) => {
      if (prev[index] === frame) return prev;
      const next = [...prev];
      next[index] = frame;
      try {
        window.localStorage.setItem(FRAMES_KEY, JSON.stringify(next));
      } catch {
        /* 写不进去也继续用 */
      }
      return next;
    });
  };

  if (layout === 'single') return <ChartPanel slot="main" />;

  return (
    <div className="grid h-full w-full grid-cols-2 grid-rows-2 gap-px bg-tv-border">
      {frames.map((frame, index) => (
        <div key={index} className="relative min-h-0 min-w-0 overflow-hidden bg-tv-bg">
          {/* 四格同品种、不同周期；十字线在图表之间联动 */}
          <ChartPanel
            slot={`q${index}`}
            symbol={symbol}
            resolution={frame}
            chrome
            onFrame={(value) => setFrame(index, value)}
          />
        </div>
      ))}
    </div>
  );
}
