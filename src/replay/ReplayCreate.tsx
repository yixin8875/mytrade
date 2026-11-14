import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { clsx } from 'clsx';
import { gateway } from '../gateway/client';
import type { Bar } from '../gateway/types';
import { activeTemplate, useApp } from '../store/useApp';
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
    <div
      data-modal
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(33,28,22,.32)] px-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="新建复盘"
        className="flex max-h-[calc(100vh-48px)] w-[640px] flex-col overflow-hidden rounded-[16px] border border-console-line bg-console-card shadow-[0_24px_64px_rgba(33,28,22,.22)]"
      >
        <div className="flex items-start justify-between gap-4 border-b border-console-line px-6 py-5">
          <div>
            <div className="text-[15px] font-medium">新建复盘</div>
            <div className="mt-1 text-[11px] text-console-muted">
              创建后先检查本地缓存，缺的行情再从网关补齐
            </div>
          </div>
          <button
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-[6px] text-console-muted hover:bg-console-hover hover:text-console-ink"
            title="关闭"
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-6">
          <section className="border-b border-console-line py-4">
            <h3 className="mb-3 text-[12px] font-medium">品种与区间</h3>
            <div className="grid grid-cols-2 gap-3">
              <label className="col-span-2 block">
                <span className="mb-1 block text-[10px] text-console-muted">品种</span>
                <div className="relative">
                  <select
                    value={symbol}
                    onChange={(event) => setSymbol(event.target.value)}
                    className="console-input w-full appearance-none pr-8"
                  >
                    {symbols.map((item) => (
                      <option key={item.name} value={item.name}>
                        {item.name} · {item.description}
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    size={14}
                    strokeWidth={1.5}
                    className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-console-faint"
                  />
                </div>
              </label>

              <div className="col-span-2">
                <span className="mb-1 block text-[10px] text-console-muted">区间</span>
                <div className="flex gap-0.5 rounded-[8px] bg-console-hover p-0.5">
                  {RANGES.map((item) => (
                    <button
                      key={item.key}
                      onClick={() => setRange(item.key)}
                      className={clsx(
                        'h-7 flex-1 rounded-[6px] text-[11px]',
                        range === item.key
                          ? 'bg-console-card text-console-ink shadow-[0_1px_1px_rgba(33,28,22,.06)]'
                          : 'text-console-muted hover:text-console-ink',
                      )}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>

              <label className="block">
                <span className="mb-1 block text-[10px] text-console-muted">开始时间</span>
                <input
                  type="datetime-local"
                  value={start}
                  onChange={(event) => {
                    setStart(event.target.value);
                    setRange('custom');
                  }}
                  className="console-input w-full font-mono text-[11px]"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] text-console-muted">结束时间</span>
                <input
                  type="datetime-local"
                  value={end}
                  onChange={(event) => {
                    setEnd(event.target.value);
                    setRange('custom');
                  }}
                  className="console-input w-full font-mono text-[11px]"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-[10px] text-console-muted">默认显示周期</span>
                <div className="relative">
                  <select
                    value={timeframe}
                    onChange={(event) => setTimeframe(event.target.value)}
                    className="console-input w-full appearance-none pr-8"
                  >
                    {TIMEFRAMES.map((item) => (
                      <option key={item} value={item}>
                        {item}m
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    size={14}
                    strokeWidth={1.5}
                    className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-console-faint"
                  />
                </div>
              </label>
              <div>
                <span className="mb-1 block text-[10px] text-console-muted">预热根数</span>
                <div className="console-input flex w-full items-center font-mono text-[11px] text-console-muted">
                  1,000 根 M1
                </div>
              </div>
            </div>
          </section>

          <section className="border-b border-console-line py-4">
            <div className="flex items-baseline justify-between gap-4">
              <h3 className="text-[12px] font-medium">数据覆盖</h3>
              <span className="text-[10px] text-console-muted">
                可用至 {latest ? fmtDateTime(latest) : '读取中…'}
              </span>
            </div>
            <div className="mt-2.5 flex gap-0.5" aria-hidden="true">
              {Array.from({ length: 24 }, (_, index) => (
                <span
                  key={index}
                  className={clsx(
                    'h-2 flex-1 rounded-[2px]',
                    index < 21 ? 'bg-console-gain' : index === 21 ? 'bg-console-warn' : 'bg-console-line',
                  )}
                />
              ))}
            </div>
            <div className="mt-1.5 flex justify-between font-mono text-[10px] text-console-muted">
              <span>{start ? start.slice(0, 10) : '—'}</span>
              <span>{end ? end.slice(0, 10) : '—'}</span>
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-3.5 text-[10px] text-console-muted">
              <span>{estimate ? `预计 ${estimate.bars.toLocaleString()} 根 M1` : '等待区间'}</span>
              <span>{estimate ? `约 ${estimate.size}` : '—'}</span>
              <span>
                {estimate
                  ? `${estimate.days} 天 · 10x 下约 ${Math.max(1, Math.round(estimate.days * 0.06))} 小时`
                  : '—'}
              </span>
            </div>
          </section>

          <section className="border-b border-console-line py-4">
            <h3 className="mb-3 text-[12px] font-medium">初始账户</h3>
            <div className="grid grid-cols-3 gap-3">
              <label className="block">
                <span className="mb-1 block text-[10px] text-console-muted">初始资金</span>
                <input
                  value={balance}
                  onChange={(event) => setBalance(event.target.value)}
                  inputMode="decimal"
                  className="console-input w-full font-mono text-[11px]"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] text-console-muted">杠杆</span>
                <input
                  value={leverage}
                  onChange={(event) => setLeverage(event.target.value)}
                  inputMode="numeric"
                  className="console-input w-full font-mono text-[11px]"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] text-console-muted">账户货币</span>
                <input
                  value={currency}
                  onChange={(event) => setCurrency(event.target.value.toUpperCase())}
                  className="console-input w-full font-mono text-[11px]"
                />
              </label>
            </div>
          </section>

          <section className="py-4">
            <button
              onClick={() => setAdvanced((value) => !value)}
              className="flex w-full items-center justify-between gap-4 text-left"
            >
              <div>
                <h3 className="text-[12px] font-medium">成本与撮合</h3>
                <p className="mt-1 text-[10px] text-console-muted">
                  点差 {spread || '—'} points · 佣金 {commission || '0'} / 手 / 单边 · 固定点差
                </p>
              </div>
              <ChevronRight
                size={14}
                strokeWidth={1.5}
                className={clsx('text-console-muted transition-transform', advanced && 'rotate-90')}
              />
            </button>
            {advanced && (
              <div className="mt-3 grid grid-cols-3 gap-3">
                <label className="block">
                  <span className="mb-1 block text-[10px] text-console-muted">点差（points）</span>
                  <input
                    value={spread}
                    onChange={(event) => setSpread(event.target.value)}
                    inputMode="numeric"
                    className="console-input w-full font-mono text-[11px]"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[10px] text-console-muted">佣金 / 手</span>
                  <input
                    value={commission}
                    onChange={(event) => setCommission(event.target.value)}
                    inputMode="decimal"
                    className="console-input w-full font-mono text-[11px]"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[10px] text-console-muted">单笔风险 %</span>
                  <input
                    value={riskPercent}
                    onChange={(event) => setRiskPercent(event.target.value)}
                    inputMode="decimal"
                    className="console-input w-full font-mono text-[11px]"
                  />
                </label>
              </div>
            )}
          </section>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-console-line px-6 py-4">
          <span
            className={clsx('mr-auto text-[10px]', error ? 'text-console-loss' : 'text-console-muted')}
          >
            {error ?? '不会调用任何实盘下单接口'}
          </span>
          <button onClick={onClose} className="console-btn console-btn-secondary">
            取消
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="console-btn console-btn-primary disabled:opacity-50"
          >
            创建并准备数据
          </button>
        </div>
      </div>
    </div>
  );
}
