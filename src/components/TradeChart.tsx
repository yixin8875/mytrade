import { useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import { fmtMoney, fmtPrice, fmtSigned, signedClass } from '../lib/format';
import { fmtLocalTime, rowOffset } from '../lib/time';
import {
  buildTradeChart,
  chartWindow,
  chooseResolution,
  CHART_RESOLUTIONS,
  priceDigits,
  spreadLabelY,
} from '../lib/tradeChart';
import type { Bar, JournalRecord } from '../gateway/types';

const MIN_CHART_HEIGHT = 240;

const RESOLUTION_LABELS: Record<string, string> = {
  '1': '1 分钟',
  '5': '5 分钟',
  '15': '15 分钟',
  '30': '30 分钟',
  '60': '1 小时',
  '240': '4 小时',
};

function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  if (sec < 60) return `${Math.round(sec)} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时 ${Math.floor((sec % 3600) / 60)} 分`;
  return `${Math.floor(sec / 86400)} 天 ${Math.floor((sec % 86400) / 3600)} 时`;
}

/** 按持仓时段从 MT5 取 K 线，画出入场、出场、持仓区间和止损止盈 */
export function TradeChart({ record }: { record: JournalRecord }) {
  const serverOffset = useApp((s) => s.health?.serverOffset ?? 0);
  const offset = rowOffset(record, serverOffset);
  const [resolution, setResolution] = useState<string>('auto');
  const effective = resolution === 'auto' ? chooseResolution(record.duration_sec) : resolution;
  const [bars, setBars] = useState<Bar[]>([]);
  const [digits, setDigits] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 760, height: 380 });

  const request = useMemo(
    () => chartWindow(record.open_time, record.close_time, effective),
    [record.open_time, record.close_time, effective],
  );

  useEffect(() => {
    const element = boxRef.current;
    if (!element) return;
    const update = () =>
      setSize({
        width: Math.max(320, element.clientWidth || 760),
        height: Math.max(MIN_CHART_HEIGHT, element.clientHeight || 380),
      });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    gateway
      .call<{ bars: Bar[]; digits: number }>('history.get', {
        symbol: record.symbol,
        resolution: effective,
        from: request.from,
        to: request.to,
        count: Math.min(4000, Math.max(200, request.count)),
      })
      .then((result) => {
        if (!alive) return;
        setBars(result.bars ?? []);
        setDigits(Number.isFinite(result.digits) ? result.digits : null);
      })
      .catch((err) => {
        if (!alive) return;
        setBars([]);
        setError((err as Error).message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [record.symbol, effective, request.from, request.to, request.count]);

  const precision = digits ?? priceDigits(record.entry_price);
  const price = (value: number | null | undefined) => fmtPrice(value, precision);

  const layout = useMemo(
    () =>
      buildTradeChart(
        {
          bars,
          entry: record.entry_price,
          exit: record.exit_price,
          sl: record.sl ?? null,
          tp: record.tp ?? null,
          openTime: record.open_time,
          closeTime: record.close_time,
          width: size.width,
          height: size.height,
        },
        digits ?? undefined,
      ),
    [bars, record, size, digits],
  );

  const profitTone = record.profit >= 0 ? 'var(--color-console-gain)' : 'var(--color-console-loss)';
  const rMultiple = record.risk && record.risk > 0 ? record.profit / record.risk : null;

  const levels = [
    { key: 'entry', y: layout.entryY, color: '#1f5fd6', label: `入 ${price(record.entry_price)}` },
    { key: 'exit', y: layout.exitY, color: profitTone, label: `出 ${price(record.exit_price)}` },
    ...(layout.slY != null
      ? [{ key: 'sl', y: layout.slY, color: '#9a4a44', label: `损 ${price(record.sl)}` }]
      : []),
    ...(layout.tpY != null
      ? [{ key: 'tp', y: layout.tpY, color: '#2f6b52', label: `盈 ${price(record.tp)}` }]
      : []),
  ];
  const tagYs = spreadLabelY(
    levels.map((level) => level.y),
    layout.plot.top + 10,
    layout.plot.bottom - 10,
  );

  const { plot } = layout;
  const emptyHint = loading
    ? '读取行情…'
    : error
      ? `行情读取失败：${error}`
      : 'MT5 没有这段行情（可能超出券商保留范围），入场与出场价仍按记录标出';

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-[11px] text-console-muted">
          MT5 行情 · {RESOLUTION_LABELS[effective] ?? effective} · 阴影为持仓时段
        </span>
        <span className="flex-1" />
        <div className="flex items-center gap-1">
          {CHART_RESOLUTIONS.map((item) => (
            <button
              key={item.value}
              onClick={() => setResolution(item.value)}
              className={clsx('console-chip', resolution === item.value && 'console-chip-active')}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div
        ref={boxRef}
        className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-console-line bg-console-card"
      >
        <svg
          width={size.width}
          height={size.height}
          className="block max-w-full"
          role="img"
          aria-label={`${record.symbol} 交易 K 线图`}
        >
          <rect
            x={plot.left}
            y={plot.top}
            width={plot.width}
            height={plot.height}
            rx={6}
            fill="var(--color-console-hover)"
            opacity={0.35}
          />
          <rect
            x={layout.holdX0}
            y={plot.top}
            width={Math.max(1, layout.holdX1 - layout.holdX0)}
            height={plot.height}
            fill="var(--color-console-accent)"
            opacity={0.08}
          />

          {layout.priceTicks.map((tick) => (
            <g key={`p${tick.price}`}>
              <line
                x1={plot.left}
                x2={plot.right}
                y1={tick.y}
                y2={tick.y}
                stroke="var(--color-console-line)"
                strokeDasharray="2 4"
                opacity={0.55}
              />
              <text
                x={plot.right + 6}
                y={tick.y + 3}
                fontSize={10}
                fill="var(--color-console-faint)"
                className="num font-mono"
              >
                {tick.label}
              </text>
            </g>
          ))}

          {layout.candles.map((candle) => {
            const color = candle.up ? 'var(--color-console-gain)' : 'var(--color-console-loss)';
            return (
              <g key={candle.time}>
                <line
                  x1={candle.x}
                  x2={candle.x}
                  y1={candle.highY}
                  y2={candle.lowY}
                  stroke={color}
                  strokeWidth={1}
                />
                <rect
                  x={candle.x - candle.width / 2}
                  y={Math.min(candle.openY, candle.closeY)}
                  width={candle.width}
                  height={Math.max(1, Math.abs(candle.closeY - candle.openY))}
                  fill={color}
                />
              </g>
            );
          })}

          <line
            x1={layout.holdX0}
            x2={layout.holdX0}
            y1={plot.top}
            y2={plot.bottom}
            stroke="#1f5fd6"
            strokeDasharray="3 4"
            opacity={0.45}
          />
          <line
            x1={layout.holdX1}
            x2={layout.holdX1}
            y1={plot.top}
            y2={plot.bottom}
            stroke={profitTone}
            strokeDasharray="3 4"
            opacity={0.45}
          />

          {levels.map((level) => (
            <line
              key={`line-${level.key}`}
              x1={plot.left}
              x2={plot.right}
              y1={level.y}
              y2={level.y}
              stroke={level.color}
              strokeWidth={1}
              strokeDasharray={level.key === 'exit' ? undefined : '5 4'}
              opacity={0.9}
            />
          ))}

          <circle
            cx={layout.entryX}
            cy={layout.entryY}
            r={3}
            fill="#1f5fd6"
            stroke="#fff"
            strokeWidth={1}
          />
          <circle
            cx={layout.exitX}
            cy={layout.exitY}
            r={3}
            fill={profitTone}
            stroke="#fff"
            strokeWidth={1}
          />

          {levels.map((level, index) => {
            const pillWidth = 84;
            const x = plot.right - pillWidth - 4;
            return (
              <g key={`tag-${level.key}`} transform={`translate(0, ${tagYs[index]})`}>
                <rect x={x} y={-8} width={pillWidth} height={16} rx={3} fill={level.color} opacity={0.95} />
                <text
                  x={x + pillWidth / 2}
                  y={0.5}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={9.5}
                  fill="#fff"
                  className="num font-mono"
                >
                  {level.label}
                </text>
              </g>
            );
          })}

          {layout.timeTicks.map((tick, index) => (
            <text
              key={`t${tick.time}`}
              x={tick.x}
              y={plot.bottom + 15}
              fontSize={10}
              fill="var(--color-console-faint)"
              className="num font-mono"
              textAnchor={index === 0 ? 'start' : index === layout.timeTicks.length - 1 ? 'end' : 'middle'}
            >
              {tick.label}
            </text>
          ))}
        </svg>

        {(loading || error || layout.empty) && (
          <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
            <span
              className={clsx(
                'rounded-md px-2.5 py-1 text-[11px]',
                error
                  ? 'bg-console-loss-soft text-console-loss'
                  : 'bg-console-canvas/90 text-console-muted',
              )}
            >
              {emptyHint}
            </span>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px]">
        <Metric label="入场" value={price(record.entry_price)} hint={fmtLocalTime(record.open_time, offset)} />
        <Metric label="出场" value={price(record.exit_price)} hint={fmtLocalTime(record.close_time, offset)} />
        <Metric label="持仓" value={fmtDuration(record.duration_sec)} />
        <Metric
          label="盈亏"
          value={fmtSigned(record.profit)}
          hint={rMultiple != null ? `${rMultiple >= 0 ? '+' : ''}${rMultiple.toFixed(2)} R` : undefined}
          tone={signedClass(record.profit)}
        />
        {record.mfe != null && <Metric label="最大浮盈" value={fmtMoney(record.mfe)} />}
        {record.mae != null && <Metric label="最大浮亏" value={fmtMoney(record.mae)} />}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: string;
}) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-console-faint">{label}</span>
      <span className={clsx('num font-mono text-[12px] text-console-ink-2', tone)}>{value}</span>
      {hint && <span className="num font-mono text-[10px] text-console-faint">{hint}</span>}
    </span>
  );
}
