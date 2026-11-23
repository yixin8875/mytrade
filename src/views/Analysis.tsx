import { useMemo, useState } from 'react';
import { FilterX, SlidersHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
          <p className="mt-1.5 text-[13px] text-muted-foreground">
            最近 {days} 天 · 先筛出想看的交易，再按品种、时段、星期等维度拆开对比
            {activeLogin ? ` · 账户 ${activeLogin}` : ''}
          </p>
        </div>
      </header>

      <Card className="mt-6 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-[13px] font-medium">
              <SlidersHorizontal size={14} strokeWidth={1.6} />
              筛选
            </div>
            <Button
              onClick={() => setFilters({ ...EMPTY_FILTERS })}
              disabled={!isFiltered(filters)}
              size="xs"
              variant="outline"
            >
              <FilterX size={12} strokeWidth={1.6} />
              清空
            </Button>
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
            <span className="mx-1 h-4 w-px bg-border" />
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
        </Card>

        <Card className="mt-4 grid grid-cols-2 gap-4 px-4 py-3 md:grid-cols-5">
          <Metric label="笔数" value={String(stats.count)} />
          <Metric label="净盈亏" value={fmtSigned(stats.net)} tone={stats.net} />
          <Metric label="胜率" value={fmtPct(stats.winRate)} />
          <Metric label="平均 R" value={fmtR(stats.avgR)} tone={stats.avgR ?? 0} />
          <Metric
            label="期望"
            value={fmtSigned(stats.expectancy ?? 0)}
            tone={stats.expectancy ?? 0}
          />
        </Card>
        {hint && <p className="mt-2 px-1 text-[11px] text-muted-foreground/60">{hint}</p>}

        <section className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
              <h2 className="text-[13px] font-medium">分组汇总</h2>
              <div className="flex flex-wrap items-center gap-1">
                {DIMENSIONS.map((item) => (
                  <Button
                    key={item.key}
                    onClick={() => setDimension(item.key)}
                    size="xs"
                    variant={dimension === item.key ? 'default' : 'outline'}
                  >
                    {item.label}
                  </Button>
                ))}
              </div>
            </div>
            <GroupTable rows={groups} />
          </Card>

          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
              <h2 className="text-[13px] font-medium">交叉矩阵</h2>
              <div className="flex flex-wrap items-center gap-1">
                {CROSS_METRICS.map((item) => (
                  <Button
                    key={item.key}
                    onClick={() => setMetric(item.key)}
                    size="xs"
                    variant={metric === item.key ? 'default' : 'outline'}
                  >
                    {item.label}
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-[11px] text-muted-foreground">
              <span>行</span>
              <Select
                value={rowDim}
                onValueChange={(value) => setRowDim(String(value))}
              >
                <SelectTrigger size="sm" className="w-auto min-w-0 text-[11px]" aria-label="行维度">
                  <SelectValue>
                    {DIMENSIONS.find((item) => item.key === rowDim)?.label}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {DIMENSIONS.map((item) => (
                    <SelectItem key={item.key} value={item.key}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <span>列</span>
              <Select
                value={colDim}
                onValueChange={(value) => setColDim(String(value))}
              >
                <SelectTrigger size="sm" className="w-auto min-w-0 text-[11px]" aria-label="列维度">
                  <SelectValue>
                    {DIMENSIONS.find((item) => item.key === colDim)?.label}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {DIMENSIONS.map((item) => (
                    <SelectItem key={item.key} value={item.key}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <CrossMatrix rows={cross.rows} cols={cross.cols} cells={cross.cells} metric={metric} />
          </Card>
        </section>

      <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground/60">
        所有筛选与分组都只作用于当前区间的平仓记录；格子里的数字是所选指标，括号内是笔数。
        少于 3 笔的格子会淡显，避免把噪声当结论。
      </p>
    </section>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1">
      <span className="w-[40px] shrink-0 text-[11px] text-muted-foreground/60">{label}</span>
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
    <Button onClick={onClick} size="xs" variant={on ? 'default' : 'outline'}>
      {children}
    </Button>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: number }) {
  return (
    <div>
      <div className="text-[11px] text-muted-foreground/60">{label}</div>
      <div
        className={cn(
          'num mt-0.5 font-mono text-[15px]',
          tone == null ? 'text-foreground' : signedClass(tone),
        )}
      >
        {value}
      </div>
    </div>
  );
}

function GroupTable({ rows }: { rows: GroupRow[] }) {
  if (rows.length === 0) {
    return <p className="px-4 py-8 text-center text-[12px] text-muted-foreground/60">当前筛选没有交易</p>;
  }
  return (
    <Table className="w-full text-[12px]">
      <TableHeader>
        <TableRow className="border-b border-border text-left text-[10px] text-muted-foreground/60 hover:bg-transparent">
          <TableHead className="h-auto px-4 py-2 font-normal">分组</TableHead>
          <TableHead className="h-auto px-2 py-2 text-right font-normal">笔数</TableHead>
          <TableHead className="h-auto px-2 py-2 text-right font-normal">净盈亏</TableHead>
          <TableHead className="h-auto px-2 py-2 text-right font-normal">胜率</TableHead>
          <TableHead className="h-auto px-4 py-2 text-right font-normal">平均 R</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.key} className="border-b border-border/50 last:border-0">
            <TableCell className="max-w-[160px] truncate px-4 py-2">{row.key}</TableCell>
            <TableCell className="num px-2 py-2 text-right font-mono">{row.stats.count}</TableCell>
            <TableCell
              className={cn('num px-2 py-2 text-right font-mono', signedClass(row.stats.net))}
            >
              {fmtSigned(row.stats.net)}
            </TableCell>
            <TableCell className="num px-2 py-2 text-right font-mono">
              {fmtPct(row.stats.winRate)}
            </TableCell>
            <TableCell
              className={cn('num px-4 py-2 text-right font-mono', signedClass(row.stats.avgR ?? 0))}
            >
              {fmtR(row.stats.avgR)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
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
    return <p className="px-4 py-8 text-center text-[12px] text-muted-foreground/60">当前筛选没有交易</p>;
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
      <Table className="w-full border-collapse text-[11px]">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="sticky left-0 h-auto bg-card px-2 py-1.5 text-left font-normal text-muted-foreground/60" />
            {cols.map((col) => (
              <TableHead
                key={col}
                className="h-auto px-1.5 py-1.5 text-center font-normal text-muted-foreground/60"
              >
                {col}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row}>
              <TableCell className="sticky left-0 max-w-[120px] truncate bg-card px-2 py-1.5 text-muted-foreground">
                {row}
              </TableCell>
              {cols.map((col) => {
                const cell = cells[crossKey(row, col)];
                if (!cell) {
                  return (
                    <TableCell key={col} className="px-1.5 py-1.5 text-center text-border">
                      ·
                    </TableCell>
                  );
                }
                const weak = cell.count < 3;
                return (
                  <TableCell
                    key={col}
                    className={cn(
                      'px-1.5 py-1.5 text-center font-mono',
                      weak && 'opacity-45',
                      metric !== 'count' && metric !== 'winRate' && cell.value != null
                        ? signedClass(cell.value)
                        : 'text-foreground',
                    )}
                    title={`${row} × ${col} · ${cell.count} 笔`}
                  >
                    {format(cell.value)}
                    <span className="ml-0.5 text-[9px] text-muted-foreground/60">({cell.count})</span>
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
