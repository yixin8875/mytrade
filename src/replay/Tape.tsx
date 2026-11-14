import { useMemo } from 'react';
import { replayBars } from './source';
import type { ReplaySession } from './types';

/**
 * 回放纸带：已回放的部分按真实收盘价画高低，未回放的部分只画等高占位，
 * 这样界面有进度感，但不会把未来的价格提前泄露出去。
 */
export function Tape({
  session,
  height = 22,
  count = 96,
  className,
}: {
  session: ReplaySession;
  height?: number;
  count?: number;
  className?: string;
}) {
  const bars = replayBars(session.id);
  const progress =
    session.totalBars > 0
      ? Math.max(0, Math.min(1, (session.cursorIndex - session.startIndex) / session.totalBars))
      : 0;

  const shape = useMemo(() => {
    const played = Math.floor(progress * count);
    const end = Math.min(session.cursorIndex, bars.length);
    const step = end > 0 ? Math.max(1, Math.floor(end / count)) : 1;
    const closes: number[] = [];
    for (let index = 0; index < played; index += 1) {
      const barIndex = Math.min(end - 1, index * step);
      const bar = bars[barIndex];
      if (bar) closes.push(bar.close);
    }
    const min = closes.length ? Math.min(...closes) : 0;
    const max = closes.length ? Math.max(...closes) : 0;
    const span = max - min || 1;
    const heights = Array.from({ length: count }, (_, index) => {
      if (index >= played || !closes.length) return 0;
      const value = closes[Math.min(closes.length - 1, index)];
      return 4 + ((value - min) / span) * (height - 6);
    });
    return { played, heights };
  }, [bars, progress, count, height, session.cursorIndex, session.startIndex]);

  const width = 240;
  const step = width / count;
  const barWidth = Math.max(0.7, step * 0.52);
  const cursorX = progress * width;

  return (
    <svg
      className={className}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {shape.heights.map((barHeight, index) => {
        const played = index < shape.played;
        const h = played ? barHeight : Math.max(3, height * 0.22);
        return (
          <rect
            key={index}
            x={index * step + (step - barWidth) / 2}
            y={height - h}
            width={barWidth}
            height={h}
            fill={played ? 'var(--color-console-ink)' : 'var(--color-console-line-2)'}
            opacity={played ? 0.88 : 0.7}
          />
        );
      })}
      {progress > 0 && (
        <>
          <line
            x1={cursorX}
            y1={0}
            x2={cursorX}
            y2={height}
            stroke="var(--color-console-accent)"
            strokeWidth={1.4}
          />
          <path d={`M${cursorX - 3} 0 h6 l-3 4 z`} fill="var(--color-console-accent)" />
        </>
      )}
    </svg>
  );
}
