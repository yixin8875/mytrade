import { useEffect, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { Settings2 } from 'lucide-react';
import { gateway } from '../gateway/client';
import { activeTemplate, useApp } from '../store/useApp';
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
  'h-8 w-full rounded-lg border border-tv-border bg-tv-raised px-2 font-mono text-[12px] text-tv-text outline-none transition-colors focus:border-tv-accent focus:bg-tv-panel';

/** 模板里的数字显示：2 → "2"，0.50 → "0.5" */
function num(value: number): string {
  return `${Number(value.toFixed(2))}`;
}

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
  const template = useApp(activeTemplate);
  const templates = useApp((s) => s.templates);
  const setActiveTemplate = useApp((s) => s.setActiveTemplate);
  const templateArmed = useApp((s) => s.templateArmed);
  const setTemplateArmed = useApp((s) => s.setTemplateArmed);
  const setPage = useApp((s) => s.setPage);
  const setSettingsSection = useApp((s) => s.setSettingsSection);
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

  const stepSummary = template.steps.length
    ? template.steps
        .map(
          (step) =>
            `${num(step.atR)}R${
              step.closePercent != null ? ` 平${num(step.closePercent)}%` : ''
            }${step.moveBreakeven ? '→保本' : ''}`,
        )
        .join(' · ')
    : '成交后不管理';
  const templateParams = `${num(template.riskPercent)}% 风险 + ${
    template.rewardR > 0 ? `止盈 ${num(template.rewardR)}R` : '不自动设止盈'
  }`;

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

  // 模板启用期间在设置里改了风险比例，这里跟着套用；手动改风险不会被覆盖
  useEffect(() => {
    if (!templateArmed) return;
    if (risk.mode === 'percent' && risk.value === template.riskPercent && risk.auto) return;
    patchRisk({ mode: 'percent', value: template.riskPercent, auto: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateArmed, template.riskPercent, patchRisk]);

  // 模板：止损设定后按设置的 R 倍数自动放止盈；改入场价/止损会重新算
  useEffect(() => {
    if (!templateArmed || !info || !draft.active || !(draft.price > 0) || !draft.sl) return;
    if (!(template.rewardR > 0)) return;
    const risk = Math.abs(draft.price - draft.sl);
    if (!(risk > 0)) return;
    const tick = info.tickSize || info.point || 0;
    const reward = risk * template.rewardR;
    const raw = draft.side === 'buy' ? draft.price + reward : draft.price - reward;
    const target = tick ? Number((Math.round(raw / tick) * tick).toFixed(digits)) : raw;
    if (draft.tp == null || Math.abs(draft.tp - target) > (tick || 1e-9) / 2) {
      patchDraft({ tp: target });
    }
    // 只跟随入场价与止损，用户手动改止盈时不抢回
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    templateArmed,
    template.rewardR,
    draft.active,
    draft.side,
    draft.price,
    draft.sl,
    info,
    digits,
    patchDraft,
  ]);

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
    patchRisk({ mode: 'percent', value: template.riskPercent, auto: true });
    patchDraft({
      type: 'market',
      active: true,
      price: defaultPrice(draft.side, 'market', quote, info),
    });
    setTemplateArmed(true);
    notify('info', `模板「${template.name}」已启用：${templateParams}；${stepSummary}`);
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
        plan:
          templateArmed && template.steps.length
            ? {
                steps: template.steps.map((step) => ({
                  atR: step.atR,
                  closePercent: step.closePercent,
                  moveBreakeven: step.moveBreakeven,
                })),
              }
            : undefined,
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

  // R 标尺的入场价：市价单跟随当前报价，挂单用草稿价
  const rulerEntry =
    draft.type === 'market'
      ? ((draft.side === 'buy' ? quote?.ask : quote?.bid) ?? 0)
      : draft.price;

  const templateLabel = `${template.name} · ${num(template.riskPercent)}%${
    template.rewardR > 0 ? ` / ${num(template.rewardR)}R` : ''
  }`;
  const templateArmedLabel = `已启用 · ${template.name}`;
  const templateTitle = `${template.name}：${templateParams}；${stepSummary}。先设置止损后会自动算止盈；右侧箭头切换模板，齿轮编辑`;

  return (
    <section className="shrink-0 border-b border-tv-border">
      <div className="flex h-12 items-center justify-between px-4">
        <span className="text-[13px] font-semibold text-tv-text">下单</span>
        <button
          onClick={activate}
          disabled={!ready || !info}
          className={clsx(
            'h-7 rounded-lg border px-2.5 text-[12px] transition-colors',
            draft.active
              ? 'border-tv-accent/40 bg-tv-accent-soft text-tv-accent'
              : 'border-tv-border bg-tv-panel text-tv-muted hover:bg-tv-hover hover:text-tv-text',
            (!ready || !info) && 'cursor-not-allowed opacity-40',
          )}
        >
          {draft.active ? '划线中' : '画线下单'}
        </button>
      </div>

      <div className="space-y-4 px-4 pb-4">
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => setSide('buy')}
            className={clsx(
              'h-9 rounded-lg text-[13px] font-medium transition-colors',
              draft.side === 'buy'
                ? 'bg-tv-up text-white'
                : 'bg-tv-raised text-tv-muted hover:text-tv-text',
            )}
          >
            买入
          </button>
          <button
            onClick={() => setSide('sell')}
            className={clsx(
              'h-9 rounded-lg text-[13px] font-medium transition-colors',
              draft.side === 'sell'
                ? 'bg-tv-down text-white'
                : 'bg-tv-raised text-tv-muted hover:text-tv-text',
            )}
          >
            卖出
          </button>
        </div>

        <div className="flex rounded-lg border border-tv-border bg-tv-raised p-0.5">
          {ORDER_TYPES.map((item) => (
            <button
              key={item.value}
              onClick={() => setType(item.value)}
              className={clsx(
                'h-7 flex-1 rounded-md text-[12px] transition-colors',
                draft.type === item.value
                  ? 'bg-tv-panel text-tv-text shadow-[0_1px_2px_rgba(20,30,45,0.06)]'
                  : 'text-tv-muted hover:text-tv-text',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        {templates.length > 1 && (
          <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-0.5">
            {templates.map((item) => (
              <button
                key={item.id}
                onClick={() => setActiveTemplate(item.id)}
                title={`${item.name}：${num(item.riskPercent)}% 风险${
                  item.rewardR > 0 ? `、止盈 ${num(item.rewardR)}R` : ''
                }、${item.steps.length} 个阶段`}
                className={clsx(
                  'h-6 shrink-0 rounded-md border px-2 text-[11px] transition-colors',
                  item.id === template.id
                    ? 'border-tv-accent/40 bg-tv-accent-soft text-tv-accent'
                    : 'border-tv-border bg-tv-panel text-tv-muted hover:text-tv-text',
                )}
              >
                {item.name}
              </button>
            ))}
          </div>
        )}

        <div className="flex gap-1.5">
          <button
            onClick={applyTemplate}
            title={templateTitle}
            className={clsx(
              'h-8 flex-1 truncate rounded-lg border text-[12px] transition-colors',
              templateArmed
                ? 'border-tv-accent/40 bg-tv-accent-soft text-tv-accent'
                : 'border-tv-border bg-tv-panel text-tv-muted hover:text-tv-text',
            )}
          >
            {templateArmed ? templateArmedLabel : templateLabel}
          </button>
          <button
            onClick={() => {
              setSettingsSection('template');
              setPage('settings');
            }}
            title="新建或编辑模板：风险 %、止盈 R、分批止盈"
            aria-label="自定义下单模板"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-tv-border bg-tv-panel text-tv-muted transition-colors hover:bg-tv-hover hover:text-tv-text"
          >
            <Settings2 size={14} strokeWidth={1.6} />
          </button>
        </div>

        <Field label="风险开仓">
          <div className="space-y-2">
            <div className="flex rounded-lg border border-tv-border bg-tv-raised p-0.5">
              {(
                [
                  ['amount', '固定金额'],
                  ['percent', '余额 %'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => patchRisk({ mode: value })}
                  className={clsx(
                    'h-7 flex-1 rounded-md text-[12px] transition-colors',
                    risk.mode === value
                      ? 'bg-tv-panel text-tv-text shadow-[0_1px_2px_rgba(20,30,45,0.06)]'
                      : 'text-tv-muted hover:text-tv-text',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
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
                  'h-8 w-[92px] shrink-0 rounded-lg border text-[12px] transition-colors',
                  risk.auto
                    ? 'border-tv-accent/40 bg-tv-accent-soft text-tv-accent'
                    : 'border-tv-border bg-tv-panel text-tv-muted hover:text-tv-text',
                )}
              >
                {risk.auto ? '自动手数' : '手动手数'}
              </button>
            </div>
            <div className="text-[11px] leading-relaxed text-tv-muted">
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
              <div className="text-[11px] text-tv-down">{sizing.warnings.join('；')}</div>
            ) : null}
          </div>
        </Field>

        <Field label="手数">
          <div className="flex items-center gap-2">
            <button
              onClick={() => changeVolume(-1)}
              className="h-8 w-8 shrink-0 rounded-lg bg-tv-raised text-[14px] text-tv-muted transition-colors hover:text-tv-text"
              aria-label="减少手数"
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
              className="h-8 w-8 shrink-0 rounded-lg bg-tv-raised text-[14px] text-tv-muted transition-colors hover:text-tv-text"
              aria-label="增加手数"
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
            placeholder="例如：突破 / 回踩"
            onChange={(event) => setOrderTag(event.target.value)}
            className={inputClass}
          />
        </Field>

        {draft.type !== 'market' && (
          <Field label="委托价格">
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

        <p className="text-[11px] leading-relaxed text-tv-muted">
          图表上的止损 / 止盈参考线可直接拖动；拖动后才写入，并自动计算手数。
        </p>

        <div className="space-y-1.5 rounded-lg bg-tv-raised px-3 py-2.5 text-[12px]">
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
          <PreviewRow label="盈亏比" value={preview?.rr != null ? preview.rr.toFixed(2) : '—'} />
          <PreviewRow label="点差" value={preview ? `${preview.spreadPoints.toFixed(0)} 点` : '—'} />
          {previewError && <div className="text-tv-warn">{previewError}</div>}
          {preview?.warnings.map((warning) => (
            <div key={warning} className="text-tv-warn">
              {warning}
            </div>
          ))}
        </div>

        <RiskRuler
          entry={rulerEntry}
          sl={draft.sl}
          tp={draft.tp}
          digits={digits}
          active={draft.active}
        />

        <button
          onClick={handlePlace}
          disabled={!ready || !info}
          className={clsx(
            'h-9 w-full rounded-lg text-[13px] font-medium text-white transition-colors',
            draft.side === 'buy' ? 'bg-tv-up hover:bg-[#0c6a49]' : 'bg-tv-down hover:bg-[#a93831]',
            (!ready || !info) && 'cursor-not-allowed opacity-40',
          )}
        >
          {buttonText}
        </button>

        <div className="text-center text-[11px] leading-relaxed text-tv-muted">
          {mode === 'readonly' ? '只读模式不会发送任何订单' : '订单发送到本机 MT5，确认后成交'}
          <div className="mt-1.5 flex flex-wrap items-center justify-center gap-1 text-tv-faint">
            <Kbd>B</Kbd>
            <span>/</span>
            <Kbd>S</Kbd>
            <span>市价</span>
            <span className="px-1">·</span>
            <Kbd>Esc</Kbd>
            <span>取消草稿</span>
            <span className="px-1">·</span>
            <Kbd>Shift</Kbd>
            <span>吸附整数位</span>
          </div>
        </div>
      </div>

      {confirm && (
        <div
          data-confirm="order"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6"
        >
          <div className="w-[340px] rounded-xl border border-tv-border bg-tv-panel p-5 shadow-[0_16px_48px_rgba(20,30,45,0.18)]">
            <div className="flex items-baseline justify-between">
              <span className="text-[14px] font-semibold text-tv-text">确认下单</span>
              <span className="num font-mono text-[11px] text-tv-muted">{symbol}</span>
            </div>
            <dl className="mt-4 space-y-2 text-[12px]">
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
              <ConfirmRow label="策略标签" value={orderTag.trim() || '—'} />
              <ConfirmRow label="模板步骤" value={templateArmed ? stepSummary : '—'} />
            </dl>
            <div className="mt-5 flex gap-2">
              <button
                onClick={() => setConfirm(false)}
                className="h-9 flex-1 rounded-lg border border-tv-border text-[12px] text-tv-text transition-colors hover:bg-tv-hover"
              >
                取消
              </button>
              <button
                onClick={send}
                disabled={busy}
                className={clsx(
                  'h-9 flex-1 rounded-lg text-[12px] font-medium text-white transition-colors',
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
      <span className="mb-1.5 block text-[11px] text-tv-muted">{label}</span>
      {children}
    </label>
  );
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-tv-muted">{label}</span>
      <span className="num font-mono text-tv-text">{value}</span>
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
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-tv-muted">{label}</dt>
      <dd className={clsx('num font-mono', accent ?? 'text-tv-text')}>{value}</dd>
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-tv-border bg-tv-panel px-1 font-mono text-[11px] text-tv-muted">
      {children}
    </kbd>
  );
}

/**
 * 风险尺：把入场、止损、止盈按 R 排成一条细尺。
 * 止损永远是 −1R，止盈按实际距离换算；只读展示，不改任何下单字段。
 */
function RiskRuler({
  entry,
  sl,
  tp,
  digits,
  active,
}: {
  entry: number;
  sl: number | null;
  tp: number | null;
  digits: number;
  active: boolean;
}) {
  if (!active || !(entry > 0) || sl == null) {
    return (
      <div className="rounded-lg border border-dashed border-tv-border px-3 py-2.5 text-[11px] leading-relaxed text-tv-muted">
        风险尺：设置止损后，这里显示 −1R / 入场 / 止盈 的位置
      </div>
    );
  }
  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return null;

  const low = Math.min(entry, sl, tp ?? entry);
  const high = Math.max(entry, sl, tp ?? entry);
  const span = high - low || 1;
  const pct = (price: number) => ((price - low) / span) * 100;
  const entryPct = pct(entry);
  const slPct = pct(sl);
  const tpPct = tp != null ? pct(tp) : null;
  const tpR = tp != null ? Math.abs(tp - entry) / risk : null;

  return (
    <div aria-label="风险尺">
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="text-tv-muted">风险尺 · 止损为 1R</span>
        <span className="num font-mono text-tv-faint">入场 {fmtPrice(entry, digits)}</span>
      </div>
      <div className="relative mt-2 h-1.5 rounded-full bg-tv-raised">
        <span
          className="absolute inset-y-0 rounded-full bg-tv-down/70"
          style={{
            left: `${Math.min(entryPct, slPct)}%`,
            width: `${Math.abs(entryPct - slPct)}%`,
          }}
        />
        {tpPct != null && (
          <span
            className="absolute inset-y-0 rounded-full bg-tv-up/70"
            style={{
              left: `${Math.min(entryPct, tpPct)}%`,
              width: `${Math.abs(entryPct - tpPct)}%`,
            }}
          />
        )}
        <span
          className="absolute -top-1 h-3.5 w-px bg-tv-text"
          style={{ left: `${entryPct}%` }}
        />
      </div>
      <div className="mt-1.5 flex items-baseline justify-between gap-3 text-[11px]">
        <span className="num font-mono text-tv-down">
          止损 {fmtPrice(sl, digits)} · -1.0R
        </span>
        <span className="num font-mono text-tv-up">
          {tp != null ? `止盈 ${fmtPrice(tp, digits)} · +${tpR?.toFixed(1)}R` : '未设止盈'}
        </span>
      </div>
    </div>
  );
}
