import { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { FilterX, SlidersHorizontal } from 'lucide-react';
import { fmtPct, fmtR, sampleHint } from '../lib/review';
import { fmtSigned, signedClass } from '../lib/format';
import {
  CROSS_METRICS,
  DURATION_BUCKETS,
  EMPTY_FILTERS,
  HOUR_BUCKETS,
  WEEKDAY_KEYS,
  WEEKDAY_LABELS,
  applyFilters,
  crossKey,
  crossTab,
  groupTrades,
  isFiltered,
  summarize,
  type CrossCell,
  type CrossMetric,
  type FilterCtx,
  type Filters,
  type GroupRow,
} from '../lib/analysis';
import { useApp } from '../store/useApp';
import type { Side, TrendSeries } from '../gateway/types';

const DIMENSIONS: { key: string; label: string }[] = [
  { key: 'symbol', label: '品种' },
  { key: 'side', label: '方向' },
  { key: 'tag', label: '标签' },
  { key: 'weekday', label: '星期' },
  { key: 'hour', label: '时段' },
  { key: 'duration', label: '持仓时长' },
];

/** 深度筛选与交叉分析：先筛交易，再按维度看汇总和二维矩阵 */
export function AnalysisSection({
  series,
  loading,
  days,
}: {
  series: TrendSeries | null;
  loading: boolean;
  days: number;
}) {
  const activeLogin = useApp((s) => s.account?.login ?? 0);
  const serverOffset = useApp((s) => s.health?.serverOffset ?? 0);

  const [filters, setFilters] = useState<Filters>({ ...EMPTY_FILTERS });
  const [dimension, setDimension] = useState('symbol');
  const [rowDim, setRowDim] = useState('symbol');
  const [colDim, setColDim] = useState('hour');
  const [metric, setMetric] = useState<CrossMetric>('net');

  const ctx: FilterCtx = useMemo(
    () => ({
      serverOffset,
      timezoneOffsetMin: series?.timezoneOffsetMin ?? 480,
    }),
    [serverOffset, series],
  );

  const trades = useMemo(() => series?.trades ?? [], [series]);
  const options = useMemo(() => {
    const symbols = new Set<string>();
    const tags = new Set<string>();
    for (const trade of trades) {
      symbols.add(trade.symbol);
      tags.add(trade.tag?.trim() || '');
    }
    return { symbols: [...symbols].sort(), tags: [...tags].sort() };
  }, [trades]);

  const filtered = useMemo(() => applyFilters(trades, filters, ctx), [trades, filters, ctx]);
  const stats = useMemo(() => summarize(filtered), [filtered]);
  const groups = useMemo(
    () => groupTrades(filtered, dimension, ctx),
    [filtered, dimension, ctx],
  );
  const cross = useMemo(
    () => crossTab(filtered, rowDim, colDim, ctx, metric),
    [filtered, rowDim, colDim, ctx, metric],
  );
  const hint = sampleHint(stats.count);

  const toggle = (key: 'symbols' | 'sides' | 'tags' | 'weekdays' | 'hours' | 'durations', value: string | number) => {
    setFilters((prev) => {
      const list = prev[key] as (string | number)[];
      const next = list.includes(value)
        ? list.filter((item) => item !== value)
        : [...list, value];
      return { ...prev, [key]: next } as Filters;
    });
  };

  return (
    <section className="mt-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-[16px] font-medium tracking-[-0.01em]">深度分析</h2>
          <p className="mt-1.5 text-[13px] text-console-muted">
            最近 {days} 天 · 先筛出想看的交易，再按品种、时段、星期等维度拆开对比
            {activeLogin ? ` · 账户 ${activeLogin}` : ''}
          </p>
        </div>
      </header>

      <section className="console-card mt-6 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-[13px] font-medium">
              <SlidersHorizontal size={14} strokeWidth={1.6} />
              筛选
            </div>
            <button
              onClick={() => setFilters({ ...EMPTY_FILTERS })}
              disabled={!isFiltered(filters)}
              className="console-chip disabled:opacity-40"
            >
              <FilterX size={12} strokeWidth={1.6} className="mr-1" />
              清空
            </button>
          </div>

          <FilterRow label="品种">
            {options.symbols.map((symbol) => (
              <Chip
                key={symbol}
                on={filters.symbols.includes(symbol)}
                onClick={() => toggle('symbols', symbol)}
              >
                {symbol}
              </Chip>
            ))}
          </FilterRow>
          <FilterRow label="方向">
            {(['buy', 'sell'] as Side[]).map((side) => (
              <Chip
                key={side}
                on={filters.sides.includes(side)}
                onClick={() => toggle('sides', side)}
              >
                {side === 'buy' ? '做多' : '做空'}
              </Chip>
            ))}
            <span className="mx-1 h-4 w-px bg-console-line" />
            {[
              { key: 'all', label: '全部' },
              { key: 'win', label: '只看盈利' },
              { key: 'loss', label: '只看亏损' },
            ].map((item) => (
              <Chip
                key={item.key}
                on={filters.result === item.key}
                onClick={() =>
                  setFilters((prev) => ({ ...prev, result: item.key as Filters['result'] }))
                }
              >
                {item.label}
              </Chip>
            ))}
          </FilterRow>
          <FilterRow label="标签">
            {options.tags.map((tag) => (
              <Chip
                key={tag || 'none'}
                on={filters.tags.includes(tag)}
                onClick={() => toggle('tags', tag)}
              >
                {tag || '未标记'}
              </Chip>
            ))}
          </FilterRow>
          <FilterRow label="星期">
            {WEEKDAY_KEYS.map((day) => (
              <Chip
                key={day}
                on={filters.weekdays.includes(day)}
                onClick={() => toggle('weekdays', day)}
              >
                {WEEKDAY_LABELS[day - 1]}
              </Chip>
            ))}
          </FilterRow>
          <FilterRow label="时段">
            {HOUR_BUCKETS.map((bucket) => (
              <Chip
                key={bucket.key}
                on={filters.hours.includes(bucket.key)}
                onClick={() => toggle('hours', bucket.key)}
              >
                {bucket.label}
              </Chip>
            ))}
          </FilterRow>
          <FilterRow label="持仓">
            {DURATION_BUCKETS.map((bucket) => (
              <Chip
                key={bucket.key}
                on={filters.durations.includes(bucket.key)}
                onClick={() => toggle('durations', bucket.key)}
              >
                {bucket.label}
              </Chip>
            ))}
          </FilterRow>
        </section>

        <section className="console-card mt-4 grid grid-cols-2 gap-4 px-4 py-3 md:grid-cols-5">
          <Metric label="笔数" value={String(stats.count)} />
          <Metric label="净盈亏" value={fmtSigned(stats.net)} tone={stats.net} />
          <Metric label="胜率" value={fmtPct(stats.winRate)} />
          <Metric label="平均 R" value={fmtR(stats.avgR)} tone={stats.avgR ?? 0} />
          <Metric
            label="期望"
            value={fmtSigned(stats.expectancy ?? 0)}
            tone={stats.expectancy ?? 0}
          />
        </section>
        {hint && <p className="mt-2 px-1 text-[11px] text-console-faint">{hint}</p>}

        <section className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <div className="console-card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-console-line px-4 py-2.5">
              <h2 className="text-[13px] font-medium">分组汇总</h2>
              <div className="flex flex-wrap items-center gap-1">
                {DIMENSIONS.map((item) => (
                  <button
                    key={item.key}
                    onClick={() => setDimension(item.key)}
                    className={clsx('console-chip', dimension === item.key && 'console-chip-active')}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            <GroupTable rows={groups} />
          </div>

          <div className="console-card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-console-line px-4 py-2.5">
              <h2 className="text-[13px] font-medium">交叉矩阵</h2>
              <div className="flex flex-wrap items-center gap-1">
                {CROSS_METRICS.map((item) => (
                  <button
                    key={item.key}
                    onClick={() => setMetric(item.key)}
                    className={clsx('console-chip', metric === item.key && 'console-chip-active')}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-[11px] text-console-muted">
              <span>行</span>
              <select
                value={rowDim}
                onChange={(event) => setRowDim(event.target.value)}
                className="console-input h-7 py-0 text-[11px]"
              >
                {DIMENSIONS.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label}
                  </option>
                ))}
              </select>
              <span>列</span>
              <select
                value={colDim}
                onChange={(event) => setColDim(event.target.value)}
                className="console-input h-7 py-0 text-[11px]"
              >
                {DIMENSIONS.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>
            <CrossMatrix rows={cross.rows} cols={cross.cols} cells={cross.cells} metric={metric} />
          </div>
        </section>

      <p className="mt-4 text-[11px] leading-relaxed text-console-faint">
        所有筛选与分组都只作用于当前区间的平仓记录；格子里的数字是所选指标，括号内是笔数。
        少于 3 笔的格子会淡显，避免把噪声当结论。
      </p>
    </section>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1">
      <span className="w-[40px] shrink-0 text-[11px] text-console-faint">{label}</span>
      {children}
    </div>
  );
}

function Chip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} className={clsx('console-chip', on && 'console-chip-active')}>
      {children}
    </button>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: number }) {
  return (
    <div>
      <div className="text-[11px] text-console-faint">{label}</div>
      <div
        className={clsx(
          'num mt-0.5 font-mono text-[15px]',
          tone == null ? 'text-console-ink' : signedClass(tone),
        )}
      >
        {value}
      </div>
    </div>
  );
}

function GroupTable({ rows }: { rows: GroupRow[] }) {
  if (rows.length === 0) {
    return <p className="px-4 py-8 text-center text-[12px] text-console-faint">当前筛选没有交易</p>;
  }
  return (
    <div className="overflow-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-console-line text-left text-[10px] text-console-faint">
            <th className="px-4 py-2 font-normal">分组</th>
            <th className="px-2 py-2 text-right font-normal">笔数</th>
            <th className="px-2 py-2 text-right font-normal">净盈亏</th>
            <th className="px-2 py-2 text-right font-normal">胜率</th>
            <th className="px-4 py-2 text-right font-normal">平均 R</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-console-line/50 last:border-0">
              <td className="max-w-[160px] truncate px-4 py-2">{row.key}</td>
              <td className="num px-2 py-2 text-right font-mono">{row.stats.count}</td>
              <td
                className={clsx(
                  'num px-2 py-2 text-right font-mono',
                  signedClass(row.stats.net),
                )}
              >
                {fmtSigned(row.stats.net)}
              </td>
              <td className="num px-2 py-2 text-right font-mono">{fmtPct(row.stats.winRate)}</td>
              <td
                className={clsx(
                  'num px-4 py-2 text-right font-mono',
                  signedClass(row.stats.avgR ?? 0),
                )}
              >
                {fmtR(row.stats.avgR)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CrossMatrix({
  rows,
  cols,
  cells,
  metric,
}: {
  rows: string[];
  cols: string[];
  cells: Record<string, CrossCell>;
  metric: CrossMetric;
}) {
  if (rows.length === 0 || cols.length === 0) {
    return <p className="px-4 py-8 text-center text-[12px] text-console-faint">当前筛选没有交易</p>;
  }
  const format = (value: number | null) => {
    if (value == null) return '—';
    if (metric === 'count') return String(Math.round(value));
    if (metric === 'winRate') return fmtPct(value);
    if (metric === 'avgR') return fmtR(value);
    return fmtSigned(value);
  };
  return (
    <div className="overflow-auto px-4 pb-4">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr>
            <th className="sticky left-0 bg-console-card px-2 py-1.5 text-left font-normal text-console-faint" />
            {cols.map((col) => (
              <th key={col} className="px-1.5 py-1.5 text-center font-normal text-console-faint">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row}>
              <td className="sticky left-0 max-w-[120px] truncate bg-console-card px-2 py-1.5 text-console-muted">
                {row}
              </td>
              {cols.map((col) => {
                const cell = cells[crossKey(row, col)];
                if (!cell) {
                  return (
                    <td key={col} className="px-1.5 py-1.5 text-center text-console-line">
                      ·
                    </td>
                  );
                }
                const weak = cell.count < 3;
                return (
                  <td
                    key={col}
                    className={clsx(
                      'px-1.5 py-1.5 text-center font-mono',
                      weak && 'opacity-45',
                      metric !== 'count' && metric !== 'winRate' && cell.value != null
                        ? signedClass(cell.value)
                        : 'text-console-ink',
                    )}
                    title={`${row} × ${col} · ${cell.count} 笔`}
                  >
                    {format(cell.value)}
                    <span className="ml-0.5 text-[9px] text-console-faint">({cell.count})</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
