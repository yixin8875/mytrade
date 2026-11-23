import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { gateway } from '../gateway/client';
import type { Bar } from '../gateway/types';
import { activeTemplate, useApp } from '../store/useApp';
import { readCachedBars } from './cache';
import { goReplaySession } from './route';
import { useReplay } from './store';
import { addDays, fmtDateTime, parseServerInput, toInputValue } from './time';

const RANGES = [
  { key: '1w', label: '1 周', days: 7 },
  { key: '1m', label: '1 个月', days: 30 },
  { key: '3m', label: '3 个月', days: 90 },
  { key: 'custom', label: '自定义', days: 0 },
] as const;

const TIMEFRAMES = ['1', '5', '15', '30', '60', '240'];

export function ReplayCreate({ open, onClose }: { open: boolean; onClose: () => void }) {
  const symbols = useApp((s) => s.symbols);
  const template = useApp((s) => activeTemplate(s));
  const createSession = useReplay((s) => s.createSession);

  const [symbol, setSymbol] = useState('');
  const [range, setRange] = useState<(typeof RANGES)[number]['key']>('1m');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [timeframe, setTimeframe] = useState('15');
  const [balance, setBalance] = useState('10000');
  const [leverage, setLeverage] = useState('100');
  const [currency, setCurrency] = useState('USD');
  const [spread, setSpread] = useState('20');
  const [commission, setCommission] = useState('0');
  const [riskPercent, setRiskPercent] = useState('0.5');
  const [advanced, setAdvanced] = useState(false);
  const [latest, setLatest] = useState<number | null>(null);
  const [cached, setCached] = useState<{ from: number; to: number; bars: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const info = symbols.find((item) => item.name === symbol);

  useEffect(() => {
    if (!open) return;
    const preferred =
      symbols.find((item) => item.name === useApp.getState().symbol)?.name ??
      symbols.find((item) => /XAU/i.test(item.name))?.name ??
      symbols[0]?.name ??
      '';
    if (!symbol || !symbols.some((item) => item.name === symbol)) setSymbol(preferred);
    setRiskPercent(String(template.riskPercent));
    setError(null);
  }, [open, symbols, symbol, template.riskPercent]);

  // 最新一根 M1 决定默认区间的右端，避免创建到没有行情的未来
  useEffect(() => {
    if (!open || !symbol) return;
    let alive = true;
    setLatest(null);
    gateway
      .call<{ bars: Bar[] }>('history.get', { symbol, resolution: '1', count: 2 })
      .then((result) => {
        if (!alive) return;
        const last = result.bars[result.bars.length - 1];
        if (last) setLatest(last.time + 60);
      })
      .catch(() => {
        if (alive) setLatest(Math.floor(Date.now() / 1000));
      });
    return () => {
      alive = false;
    };
  }, [open, symbol]);

  useEffect(() => {
    if (!open || !latest) return;
    const days = RANGES.find((item) => item.key === range)?.days ?? 0;
    if (!days) return;
    const endTs = Math.floor(latest / 60) * 60;
    setEnd(toInputValue(endTs));
    setStart(toInputValue(addDays(endTs, -days)));
    if (!info) return;
    setSpread(String(info.spreadPoints || 20));
    setCurrency(info.currency || 'USD');
  }, [open, latest, range, info]);

  useEffect(() => {
    if (!open || !symbol) return;
    let alive = true;
    setCached(null);
    void readCachedBars(symbol)
      .then((bars) => {
        if (!alive) return;
        const first = bars[0];
        const last = bars[bars.length - 1];
        setCached(first && last ? { from: first.time, to: last.time + 60, bars: bars.length } : null);
      })
      .catch(() => {
        if (alive) setCached(null);
      });
    return () => {
      alive = false;
    };
  }, [open, symbol]);

  const estimate = useMemo(() => {
    const startTs = parseServerInput(start);
    const endTs = parseServerInput(end);
    if (!startTs || !endTs || endTs <= startTs) return null;
    const minutes = (endTs - startTs) / 60;
    const bars = Math.round(minutes * 0.7);
    return {
      bars,
      size: `${((bars * 48) / 1024 / 1024).toFixed(1)} MB`,
      days: Math.max(1, Math.round(minutes / 1440)),
    };
  }, [start, end]);

  // 色条按本机已有缓存与所选区间的重叠比例来画，不再是装饰
  const coverage = useMemo(() => {
    const startTs = parseServerInput(start);
    const endTs = parseServerInput(end);
    if (!startTs || !endTs || endTs <= startTs) return null;
    if (!cached) return { filled: 0, partial: true };
    const from = Math.max(startTs, cached.from);
    const to = Math.min(endTs, cached.to);
    if (to <= from) return { filled: 0, partial: true };
    const ratio = (to - from) / (endTs - startTs);
    const filled = Math.min(24, Math.round(ratio * 24));
    return { filled, partial: ratio < 0.995 };
  }, [start, end, cached]);

  if (!open) return null;

  const submit = () => {
    setError(null);
    if (!symbol || !info) {
      setError('请选择品种');
      return;
    }
    const startTs = parseServerInput(start);
    const endTs = parseServerInput(end);
    if (!startTs || !endTs) {
      setError('请填写完整的开始与结束时间');
      return;
    }
    if (endTs <= startTs) {
      setError('结束时间需要晚于开始时间');
      return;
    }
    if (latest && endTs > latest + 86400) {
      setError(`这段区间还没有行情，最新数据到 ${fmtDateTime(latest)}`);
      return;
    }
    const initialBalance = Number(balance);
    const lev = Number(leverage);
    const spreadPoints = Number(spread);
    const commissionPerLot = Number(commission);
    const risk = Number(riskPercent);
    if (!(initialBalance > 0)) {
      setError('初始资金需要大于 0');
      return;
    }
    if (!(lev > 0)) {
      setError('杠杆需要大于 0');
      return;
    }
    if (!(spreadPoints >= 0) || !(commissionPerLot >= 0)) {
      setError('点差与佣金不能为负数');
      return;
    }
    setBusy(true);
    const id = createSession({
      name: `${symbol} · ${fmtDateTime(startTs).slice(5, 7)} 月复盘`,
      symbol,
      symbolInfo: info,
      startTs,
      endTs,
      settings: {
        initialBalance,
        currency: currency.trim() || 'USD',
        leverage: lev,
        spreadPoints,
        commissionPerLot,
        timeframe,
        riskPercent: Number.isFinite(risk) && risk > 0 ? risk : 0.5,
      },
    });
    setBusy(false);
    onClose();
    goReplaySession(id);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup
        data-modal=""
        showCloseButton={false}
        bottomStickOnMobile={false}
        className="max-h-[calc(100vh-48px)] w-[640px] max-w-[640px]"
        aria-label="新建复盘"
      >
        <DialogHeader className="relative flex-row items-start justify-between gap-4 border-b border-border px-6 py-5">
          <div>
            <DialogTitle className="text-[15px] font-medium leading-none">新建复盘</DialogTitle>
            <DialogDescription className="mt-1 text-[11px]">
              创建后先检查本地缓存，缺的行情再从网关补齐
            </DialogDescription>
          </div>
          <DialogClose
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="absolute end-4 top-4"
                title="关闭"
                aria-label="关闭"
              />
            }
          >
            <X strokeWidth={1.5} />
          </DialogClose>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-auto px-6">
          <section className="border-b border-border py-4">
            <h3 className="mb-3 text-[12px] font-medium">品种与区间</h3>
            <div className="grid grid-cols-2 gap-3">
              <label className="col-span-2 block">
                <span className="mb-1 block text-[10px] text-muted-foreground">品种</span>
                <Select
                  value={symbol}
                  onValueChange={(value) => {
                    if (typeof value === 'string') setSymbol(value);
                  }}
                >
                  <SelectTrigger className="w-full" aria-label="品种">
                    <SelectValue>
                      {(value: string | null) => {
                        const item = symbols.find((entry) => entry.name === value);
                        return value ? `${value} · ${item?.description ?? ''}` : '选择品种';
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {symbols.map((item) => (
                      <SelectItem key={item.name} value={item.name}>
                        {item.name} · {item.description}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>

              <div className="col-span-2">
                <span className="mb-1 block text-[10px] text-muted-foreground">区间</span>
                <div className="flex gap-0.5 rounded-lg bg-muted p-0.5">
                  {RANGES.map((item) => (
                    <Button
                      key={item.key}
                      variant={range === item.key ? 'secondary' : 'ghost'}
                      size="xs"
                      onClick={() => setRange(item.key)}
                      className={cn(
                        'h-7 flex-1 rounded-md text-[11px]',
                        range === item.key ? 'text-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {item.label}
                    </Button>
                  ))}
                </div>
              </div>

              <label className="block">
                <span className="mb-1 block text-[10px] text-muted-foreground">开始时间</span>
                <Input
                  type="datetime-local"
                  value={start}
                  onChange={(event) => {
                    setStart(event.target.value);
                    setRange('custom');
                  }}
                  className="w-full font-mono text-[11px]"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] text-muted-foreground">结束时间</span>
                <Input
                  type="datetime-local"
                  value={end}
                  onChange={(event) => {
                    setEnd(event.target.value);
                    setRange('custom');
                  }}
                  className="w-full font-mono text-[11px]"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-[10px] text-muted-foreground">默认显示周期</span>
                <Select
                  value={timeframe}
                  onValueChange={(value) => {
                    if (typeof value === 'string') setTimeframe(value);
                  }}
                >
                  <SelectTrigger className="w-full" aria-label="默认显示周期">
                    <SelectValue>
                      {(value: string | null) => (value ? `${value}m` : '选择周期')}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {TIMEFRAMES.map((item) => (
                      <SelectItem key={item} value={item}>
                        {item}m
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
              <div>
                <span className="mb-1 block text-[10px] text-muted-foreground">预热根数</span>
                <div className="flex h-8.5 w-full items-center rounded-lg border border-input bg-background px-[calc(--spacing(3)-1px)] font-mono text-[11px] text-muted-foreground sm:h-7.5">
                  1,000 根 M1
                </div>
              </div>
            </div>
          </section>

          <section className="border-b border-border py-4">
            <div className="flex items-baseline justify-between gap-4">
              <h3 className="text-[12px] font-medium">数据覆盖</h3>
              <span className="text-[10px] text-muted-foreground">
                可用至 {latest ? fmtDateTime(latest) : '读取中…'}
              </span>
            </div>
            <div className="mt-2.5 flex gap-0.5" aria-hidden="true">
              {Array.from({ length: 24 }, (_, index) => (
                <span
                  key={index}
                  className={cn(
                    'h-2 flex-1 rounded-[2px]',
                    index < (coverage?.filled ?? 0)
                      ? 'bg-console-gain'
                      : index === (coverage?.filled ?? 0) && coverage?.partial
                        ? 'bg-console-warn'
                        : 'bg-console-line',
                  )}
                />
              ))}
            </div>
            <div className="mt-1.5 flex justify-between font-mono text-[10px] text-muted-foreground">
              <span>{start ? start.slice(0, 10) : '—'}</span>
              <span>{end ? end.slice(0, 10) : '—'}</span>
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-3.5 text-[10px] text-muted-foreground">
              <span>{estimate ? `预计 ${estimate.bars.toLocaleString()} 根 M1` : '等待区间'}</span>
              <span>{estimate ? `约 ${estimate.size}` : '—'}</span>
              <span>
                {estimate
                  ? `${estimate.days} 天 · 10x 下约 ${Math.max(1, Math.round(estimate.days * 0.06))} 小时`
                  : '—'}
              </span>
              <span>
                {cached
                  ? `本机缓存 ${cached.bars.toLocaleString()} 根 · ${fmtDateTime(cached.from)} 起`
                  : '本机暂无缓存，将联网读取'}
              </span>
            </div>
          </section>

          <section className="border-b border-border py-4">
            <h3 className="mb-3 text-[12px] font-medium">初始账户</h3>
            <div className="grid grid-cols-3 gap-3">
              <label className="block">
                <span className="mb-1 block text-[10px] text-muted-foreground">初始资金</span>
                <Input
                  value={balance}
                  onChange={(event) => setBalance(event.target.value)}
                  inputMode="decimal"
                  className="w-full font-mono text-[11px]"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] text-muted-foreground">杠杆</span>
                <Input
                  value={leverage}
                  onChange={(event) => setLeverage(event.target.value)}
                  inputMode="numeric"
                  className="w-full font-mono text-[11px]"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] text-muted-foreground">账户货币</span>
                <Input
                  value={currency}
                  onChange={(event) => setCurrency(event.target.value.toUpperCase())}
                  className="w-full font-mono text-[11px]"
                />
              </label>
            </div>
          </section>

          <section className="py-4">
            <Button
              variant="ghost"
              onClick={() => setAdvanced((value) => !value)}
              className="h-auto w-full justify-between gap-4 p-0 text-left hover:bg-transparent"
            >
              <div>
                <h3 className="text-[12px] font-medium">成本与撮合</h3>
                <p className="mt-1 text-[10px] font-normal text-muted-foreground">
                  点差 {spread || '—'} points · 佣金 {commission || '0'} / 手 / 单边 · 固定点差
                </p>
              </div>
              <ChevronRight
                strokeWidth={1.5}
                className={cn(
                  'size-3.5 shrink-0 text-muted-foreground transition-transform',
                  advanced && 'rotate-90',
                )}
              />
            </Button>
            {advanced && (
              <div className="mt-3 grid grid-cols-3 gap-3">
                <label className="block">
                  <span className="mb-1 block text-[10px] text-muted-foreground">
                    点差（points）
                  </span>
                  <Input
                    value={spread}
                    onChange={(event) => setSpread(event.target.value)}
                    inputMode="numeric"
                    className="w-full font-mono text-[11px]"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[10px] text-muted-foreground">佣金 / 手</span>
                  <Input
                    value={commission}
                    onChange={(event) => setCommission(event.target.value)}
                    inputMode="decimal"
                    className="w-full font-mono text-[11px]"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[10px] text-muted-foreground">单笔风险 %</span>
                  <Input
                    value={riskPercent}
                    onChange={(event) => setRiskPercent(event.target.value)}
                    inputMode="decimal"
                    className="w-full font-mono text-[11px]"
                  />
                </label>
              </div>
            )}
          </section>
        </div>

        <DialogFooter className="flex-row items-center justify-end gap-2 border-t border-border bg-card px-6 py-4">
          <span
            className={cn(
              'mr-auto text-[10px]',
              error ? 'text-destructive-foreground' : 'text-muted-foreground',
            )}
          >
            {error ?? '不会调用任何实盘下单接口'}
          </span>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button onClick={submit} disabled={busy}>
            创建并准备数据
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
