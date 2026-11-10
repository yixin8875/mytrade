import { useEffect, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import { fmtMoney, fmtPrice, fmtVolume, roundVolume } from '../lib/format';
import type {
  OrderType,
  Quote,
  Side,
  SymbolInfo,
  TradePreview,
  TradeSizing,
} from '../gateway/types';

function defaultPrice(
  side: Side,
  type: OrderType,
  quote: Quote | null,
  info?: SymbolInfo,
): number {
  if (!quote || !info) return 0;
  const tick = info.tickSize || info.point || 0;
  if (type === 'limit') return side === 'buy' ? quote.bid : quote.ask;
  if (type === 'stop') return side === 'buy' ? quote.ask + tick * 10 : quote.bid - tick * 10;
  return side === 'buy' ? quote.ask : quote.bid;
}

const ORDER_TYPES: { value: OrderType; label: string }[] = [
  { value: 'market', label: '市价' },
  { value: 'limit', label: '限价' },
  { value: 'stop', label: '停损' },
];

const inputClass =
  'h-7 w-full rounded border border-tv-border bg-tv-bg px-2 font-mono text-[11px] text-tv-text outline-none focus:border-tv-accent';

export function OrderTicket() {
  const conn = useApp((s) => s.conn);
  const health = useApp((s) => s.health);
  const symbols = useApp((s) => s.symbols);
  const symbol = useApp((s) => s.symbol);
  const quote = useApp((s) => s.quote);
  const draft = useApp((s) => s.draft);
  const patchDraft = useApp((s) => s.patchDraft);
  const preview = useApp((s) => s.preview);
  const setPreview = useApp((s) => s.setPreview);
  const risk = useApp((s) => s.risk);
  const patchRisk = useApp((s) => s.patchRisk);
  const orderTag = useApp((s) => s.orderTag);
  const setOrderTag = useApp((s) => s.setOrderTag);
  const templateArmed = useApp((s) => s.templateArmed);
  const setTemplateArmed = useApp((s) => s.setTemplateArmed);
  const notify = useApp((s) => s.notify);

  const [previewError, setPreviewError] = useState<string | null>(null);
  const [sizing, setSizing] = useState<TradeSizing | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const info = symbols.find((item) => item.name === symbol);
  const digits = info?.digits ?? 5;
  const step = info?.volumeStep ?? 0.01;
  const ready = conn === 'open' && !!health?.connected;
  const mode = health?.tradeMode ?? 'readonly';
  const currency = health?.account?.currency ?? '';

  useEffect(() => {
    if (!ready || !info || !draft.active) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    if (draft.type !== 'market' && !(draft.price > 0)) {
      setPreview(null);
      setPreviewError('请先设置委托价格');
      return;
    }
    const timer = window.setTimeout(() => {
      gateway
        .call<TradePreview>('trade.preview', {
          symbol,
          side: draft.side,
          type: draft.type,
          volume: draft.volume,
          price: draft.type === 'market' ? undefined : draft.price,
          sl: draft.sl ?? undefined,
          tp: draft.tp ?? undefined,
        })
        .then((result) => {
          setPreview(result);
          setPreviewError(null);
        })
        .catch((error: Error) => {
          setPreview(null);
          setPreviewError(error.message);
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    ready,
    info,
    symbol,
    draft.active,
    draft.side,
    draft.type,
    draft.price,
    draft.volume,
    draft.sl,
    draft.tp,
  ]);

  // 按目标风险反推手数：止损一变就算一次，自动模式下直接套用
  useEffect(() => {
    if (!ready || !info || !draft.active || !draft.sl || !(draft.price > 0)) {
      setSizing(null);
      return;
    }
    const timer = window.setTimeout(() => {
      gateway
        .call<TradeSizing>('trade.size', {
          symbol,
          side: draft.side,
          type: draft.type,
          volume: Math.max(info.minVolume, draft.volume),
          price: draft.type === 'market' ? undefined : draft.price,
          sl: draft.sl ?? undefined,
          tp: draft.tp ?? undefined,
          riskMode: risk.mode,
          riskValue: risk.value,
        })
        .then((result) => {
          setSizing(result);
          if (risk.auto && Math.abs(result.volume - draft.volume) > 1e-9) {
            patchDraft({ volume: result.volume });
          }
        })
        .catch(() => setSizing(null));
    }, 250);
    return () => window.clearTimeout(timer);
    // draft.volume 只是输入值，不放进依赖，避免自己改手数又触发一轮
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    ready,
    info,
    symbol,
    draft.active,
    draft.side,
    draft.type,
    draft.price,
    draft.sl,
    draft.tp,
    risk.mode,
    risk.value,
    risk.auto,
    patchDraft,
  ]);

  // 模板：止损设定后自动把止盈放到 2R；改入场价/止损会重新算
  useEffect(() => {
    if (!templateArmed || !info || !draft.active || !(draft.price > 0) || !draft.sl) return;
    const risk = Math.abs(draft.price - draft.sl);
    if (!(risk > 0)) return;
    const tick = info.tickSize || info.point || 0;
    const raw = draft.side === 'buy' ? draft.price + risk * 2 : draft.price - risk * 2;
    const target = tick ? Number((Math.round(raw / tick) * tick).toFixed(digits)) : raw;
    if (draft.tp == null || Math.abs(draft.tp - target) > (tick || 1e-9) / 2) {
      patchDraft({ tp: target });
    }
    // 只跟随入场价与止损，用户手动改止盈时不抢回
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateArmed, draft.active, draft.side, draft.price, draft.sl, info, digits, patchDraft]);

  useEffect(() => {
    if (!confirm) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setConfirm(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [confirm]);

  const activate = () => {
    if (!info) return;
    patchDraft({
      active: true,
      price: defaultPrice(draft.side, draft.type, quote, info),
      volume: Math.max(info.minVolume, Math.min(info.maxVolume, draft.volume)),
    });
  };

  const applyTemplate = () => {
    if (templateArmed) {
      setTemplateArmed(false);
      notify('info', '已取消下单模板');
      return;
    }
    if (!info) return;
    patchRisk({ mode: 'percent', value: 0.5, auto: true });
    patchDraft({
      type: 'market',
      active: true,
      price: defaultPrice(draft.side, 'market', quote, info),
    });
    setTemplateArmed(true);
    notify('info', '模板已启用：0.5% 风险、止盈 2R、浮盈 1R 自动保本');
  };

  const setSide = (side: Side) => {
    patchDraft({ side, price: defaultPrice(side, draft.type, quote, info) });
  };

  const setType = (type: OrderType) => {
    patchDraft({
      type,
      price: draft.active ? defaultPrice(draft.side, type, quote, info) : draft.price,
    });
  };

  const changeVolume = (delta: number) => {
    if (!info) return;
    patchDraft({
      volume: roundVolume(draft.volume + delta * step, step, info.minVolume, info.maxVolume),
    });
    patchRisk({ auto: false });
  };

  const handlePlace = () => {
    if (!ready || !info) return;
    if (mode === 'readonly') {
      notify('info', '只读模式：请先在顶部切换到「模拟可交易」');
      return;
    }
    if (draft.type !== 'market' && !(draft.price > 0)) {
      notify('error', '请先设置委托价格');
      return;
    }
    setConfirm(true);
  };

  const send = async () => {
    if (!info) return;
    setBusy(true);
    try {
      await gateway.call('order.place', {
        clientOrderId: crypto.randomUUID(),
        symbol,
        side: draft.side,
        type: draft.type,
        volume: draft.volume,
        price: draft.type === 'market' ? undefined : draft.price,
        sl: draft.sl ?? undefined,
        tp: draft.tp ?? undefined,
        tag: orderTag.trim() || undefined,
        autoBreakeven: templateArmed || undefined,
      });
      setConfirm(false);
      setTemplateArmed(false);
      patchDraft({ active: false });
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const buttonText = !ready
    ? '等待 MT5 连接'
    : !info
      ? '无可用品种'
      : mode === 'readonly'
        ? '只读模式 · 不会下单'
        : `${draft.side === 'buy' ? '买入' : '卖出'} ${fmtVolume(draft.volume, step)}`;

  return (
    <section className="shrink-0 border-b border-tv-border">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[11px] font-semibold tracking-wide text-tv-muted">下单</span>
        <button
          onClick={activate}
          disabled={!ready || !info}
          className={clsx(
            'h-6 rounded px-2 text-[10px] transition-colors',
            draft.active ? 'bg-tv-accent text-white' : 'bg-tv-border text-tv-text hover:bg-tv-hover',
            (!ready || !info) && 'cursor-not-allowed opacity-40',
          )}
        >
          {draft.active ? '划线中' : '画线下单'}
        </button>
      </div>

      <div className="space-y-2 px-3 pb-3">
        <div className="grid grid-cols-2 gap-1">
          <button
            onClick={() => setSide('buy')}
            className={clsx(
              'h-8 rounded text-xs font-semibold transition-colors',
              draft.side === 'buy'
                ? 'bg-tv-up text-white'
                : 'bg-tv-bg text-tv-muted hover:text-tv-text',
            )}
          >
            买入
          </button>
          <button
            onClick={() => setSide('sell')}
            className={clsx(
              'h-8 rounded text-xs font-semibold transition-colors',
              draft.side === 'sell'
                ? 'bg-tv-down text-white'
                : 'bg-tv-bg text-tv-muted hover:text-tv-text',
            )}
          >
            卖出
          </button>
        </div>

        <div className="grid grid-cols-3 gap-1">
          {ORDER_TYPES.map((item) => (
            <button
              key={item.value}
              onClick={() => setType(item.value)}
              className={clsx(
                'h-6 rounded text-[10px] transition-colors',
                draft.type === item.value
                  ? 'bg-tv-border text-tv-text'
                  : 'bg-tv-bg text-tv-muted hover:text-tv-text',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        <button
          onClick={applyTemplate}
          title="0.5% 风险 + 止盈 2R + 浮盈 1R 自动保本；先设置止损后会自动算止盈"
          className={clsx(
            'h-6 w-full rounded border text-[10px] transition-colors',
            templateArmed
              ? 'border-tv-accent bg-tv-accent/20 text-tv-accent'
              : 'border-tv-border bg-tv-bg text-tv-muted hover:text-tv-text',
          )}
        >
          {templateArmed ? '模板已启用 · 0.5% / 2R / 保本' : '模板 · 0.5% 风险 + 2R + 保本'}
        </button>

        <Field label="风险开仓">
          <div className="space-y-1">
            <div className="grid grid-cols-2 gap-1">
              <button
                onClick={() => patchRisk({ mode: 'amount' })}
                className={clsx(
                  'h-6 rounded text-[10px] transition-colors',
                  risk.mode === 'amount'
                    ? 'bg-tv-border text-tv-text'
                    : 'bg-tv-bg text-tv-muted hover:text-tv-text',
                )}
              >
                固定金额
              </button>
              <button
                onClick={() => patchRisk({ mode: 'percent' })}
                className={clsx(
                  'h-6 rounded text-[10px] transition-colors',
                  risk.mode === 'percent'
                    ? 'bg-tv-border text-tv-text'
                    : 'bg-tv-bg text-tv-muted hover:text-tv-text',
                )}
              >
                余额 %
              </button>
            </div>
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={0}
                step={risk.mode === 'percent' ? 0.1 : 10}
                value={risk.value}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value)) patchRisk({ value });
                }}
                className={clsx(inputClass, 'text-center')}
              />
              <button
                onClick={() => patchRisk({ auto: !risk.auto })}
                className={clsx(
                  'h-7 shrink-0 rounded px-2 text-[10px] transition-colors',
                  risk.auto
                    ? 'bg-tv-accent text-white'
                    : 'bg-tv-bg text-tv-muted hover:text-tv-text',
                )}
              >
                {risk.auto ? '自动手数' : '手动手数'}
              </button>
            </div>
            <div className="text-[10px] text-tv-muted">
              {!draft.sl
                ? '设置止损后自动算手数'
                : sizing
                  ? `目标 ${fmtMoney(sizing.targetRisk)}${currency} → ${fmtVolume(
                      sizing.volume,
                      step,
                    )} 手（实际 ${fmtMoney(sizing.riskAmount)}${currency}）`
                  : '计算中…'}
            </div>
            {sizing?.warnings?.length ? (
              <div className="text-[10px] text-tv-down">{sizing.warnings.join('；')}</div>
            ) : null}
          </div>
        </Field>

        <Field label="手数">
          <div className="flex items-center gap-1">
            <button
              onClick={() => changeVolume(-1)}
              className="h-7 w-7 rounded bg-tv-bg text-tv-muted hover:text-tv-text"
            >
              −
            </button>
            <input
              type="number"
              step={step}
              min={info?.minVolume}
              max={info?.maxVolume}
              value={draft.volume}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value)) patchDraft({ volume: value });
                patchRisk({ auto: false });
              }}
              className={clsx(inputClass, 'text-center')}
            />
            <button
              onClick={() => changeVolume(1)}
              className="h-7 w-7 rounded bg-tv-bg text-tv-muted hover:text-tv-text"
            >
              +
            </button>
          </div>
        </Field>

        <Field label="策略标签">
          <input
            type="text"
            maxLength={40}
            value={orderTag}
            placeholder="可选，例如：突破 / 回踩"
            onChange={(event) => setOrderTag(event.target.value)}
            className={inputClass}
          />
        </Field>

        {draft.type !== 'market' && (
          <Field label="价格">
            <input
              type="number"
              step={info?.tickSize ?? 0.00001}
              value={draft.price || ''}
              onChange={(event) => {
                const value = Number(event.target.value);
                patchDraft({ price: Number.isFinite(value) ? value : 0 });
              }}
              className={inputClass}
            />
          </Field>
        )}

        <div className="grid grid-cols-2 gap-2">
          <Field label="止损">
            <input
              type="number"
              step={info?.tickSize ?? 0.00001}
              value={draft.sl ?? ''}
              placeholder="无"
              onChange={(event) =>
                patchDraft({ sl: event.target.value === '' ? null : Number(event.target.value) })
              }
              className={inputClass}
            />
          </Field>
          <Field label="止盈">
            <input
              type="number"
              step={info?.tickSize ?? 0.00001}
              value={draft.tp ?? ''}
              placeholder="无"
              onChange={(event) =>
                patchDraft({ tp: event.target.value === '' ? null : Number(event.target.value) })
              }
              className={inputClass}
            />
          </Field>
        </div>
        <p className="text-[10px] text-tv-muted">
          图表上的红色/绿色参考线可直接上下拖动，拖过之后才会写入止损/止盈，并自动计算手数。
        </p>

        <div className="space-y-1 rounded bg-tv-bg p-2 text-[10px] text-tv-muted">
          <PreviewRow label="保证金" value={fmtMoney(preview?.margin)} />
          <PreviewRow
            label="风险"
            value={
              preview?.riskAmount != null
                ? `${fmtMoney(preview.riskAmount)} ${
                    preview.riskPct != null ? `(${preview.riskPct.toFixed(2)}%)` : ''
                  }`
                : '—'
            }
          />
          <PreviewRow label="R:R" value={preview?.rr != null ? preview.rr.toFixed(2) : '—'} />
          <PreviewRow label="点差" value={preview ? `${preview.spreadPoints.toFixed(0)} 点` : '—'} />
          {previewError && <div className="text-amber-400">{previewError}</div>}
          {preview?.warnings.map((warning) => (
            <div key={warning} className="text-amber-400">
              {warning}
            </div>
          ))}
        </div>

        <button
          onClick={handlePlace}
          disabled={!ready || !info}
          className={clsx(
            'h-9 w-full rounded text-xs font-semibold text-white transition-all',
            draft.side === 'buy' ? 'bg-tv-up hover:brightness-110' : 'bg-tv-down hover:brightness-110',
            (!ready || !info) && 'cursor-not-allowed opacity-40',
          )}
        >
          {buttonText}
        </button>
        <div className="text-center text-[9px] leading-relaxed text-tv-muted">
          {mode === 'readonly'
            ? '只读模式不会发送任何订单'
            : '订单将发送到本机 MT5，请核对后在确认窗确认'}
          <br />
          B / S 市价 · Esc 取消草稿 · 拖动时按住 Shift 吸附整数位
        </div>
      </div>

      {confirm && (
        <div data-confirm="order" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-[320px] rounded border border-tv-border bg-tv-panel p-4 shadow-2xl">
            <div className="mb-3 text-sm font-medium text-tv-text">确认下单</div>
            <dl className="space-y-1.5 text-[11px]">
              <ConfirmRow label="品种" value={symbol} />
              <ConfirmRow
                label="方向"
                value={draft.side === 'buy' ? '买入' : '卖出'}
                accent={draft.side === 'buy' ? 'text-tv-up' : 'text-tv-down'}
              />
              <ConfirmRow
                label="类型"
                value={draft.type === 'market' ? '市价' : draft.type === 'limit' ? '限价' : '停损'}
              />
              <ConfirmRow label="手数" value={fmtVolume(draft.volume, step)} />
              <ConfirmRow
                label="价格"
                value={draft.type === 'market' ? '市价成交' : fmtPrice(draft.price, digits)}
              />
              <ConfirmRow label="止损" value={fmtPrice(draft.sl, digits)} />
              <ConfirmRow label="止盈" value={fmtPrice(draft.tp, digits)} />
              <ConfirmRow label="预估风险" value={fmtMoney(preview?.riskAmount)} />
              <ConfirmRow label="标签" value={orderTag.trim() || '—'} />
              <ConfirmRow
                label="自动保本"
                value={templateArmed && draft.sl ? '浮盈 1R 移到开仓价' : '—'}
              />
            </dl>
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => setConfirm(false)}
                className="h-8 flex-1 rounded border border-tv-border text-[11px] text-tv-text hover:bg-tv-hover"
              >
                取消
              </button>
              <button
                onClick={send}
                disabled={busy}
                className={clsx(
                  'h-8 flex-1 rounded text-[11px] font-semibold text-white',
                  draft.side === 'buy' ? 'bg-tv-up' : 'bg-tv-down',
                  busy && 'opacity-50',
                )}
              >
                {busy ? '发送中…' : '确认发送'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] text-tv-muted">{label}</span>
      {children}
    </label>
  );
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span>{label}</span>
      <span className="font-mono text-tv-text">{value}</span>
    </div>
  );
}

function ConfirmRow({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-tv-muted">{label}</dt>
      <dd className={clsx('font-mono', accent ?? 'text-tv-text')}>{value}</dd>
    </div>
  );
}
