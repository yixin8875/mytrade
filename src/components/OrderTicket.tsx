import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { Check, ChevronDown, X } from 'lucide-react';
import { gateway } from '../gateway/client';
import { activeTemplate, useApp, type OrderEntryMode } from '../store/useApp';
import { fmtMoney, fmtPrice, fmtVolume, roundVolume } from '../lib/format';
import { classifyPending } from '../lib/pendingOrder';
import {
  fmtNum,
  isRiskDeviated,
  isTpManual,
  templateStepsSummary,
  templateSummary,
  templateTpTarget,
} from '../lib/template';
import { ConfirmDialog } from './order/ConfirmDialog';
import { OrderFields } from './order/OrderFields';
import { RiskRuler } from './order/RiskRuler';
import { RiskSection } from './order/RiskSection';
import { useDisciplineGate } from './order/useDisciplineGate';
import { useOrderPreview } from './order/useOrderPreview';
import { useTemplateSync } from './order/useTemplateSync';
import { TemplateBar } from './order/TemplateBar';
import { Field, Kbd, PreviewRow, inputClass } from './order/primitives';
import type {
  DraftOrder,
  OrderType,
  Quote,
  Side,
  SymbolInfo,
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
  const breakevenOffset = useApp((s) => s.breakevenOffset);
  const setOrderTag = useApp((s) => s.setOrderTag);
  const template = useApp(activeTemplate);
  const templates = useApp((s) => s.templates);
  const setActiveTemplate = useApp((s) => s.setActiveTemplate);
  const createTemplate = useApp((s) => s.createTemplate);
  const templateArmed = useApp((s) => s.templateArmed);
  const setTemplateArmed = useApp((s) => s.setTemplateArmed);
  const riskStatus = useApp((s) => s.riskStatus);
  const setPage = useApp((s) => s.setPage);
  const setSettingsSection = useApp((s) => s.setSettingsSection);
  const openSettings = useApp((s) => s.openSettings);
  const resetDraft = useApp((s) => s.resetDraft);
  const notify = useApp((s) => s.notify);
  const entryMode = useApp((s) => s.orderEntryMode);
  const setEntryMode = useApp((s) => s.setOrderEntryMode);
  const setTicketOpen = useApp((s) => s.setTicketOpen);

  const [modeMenu, setModeMenu] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const modeWrapRef = useRef<HTMLDivElement>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const info = symbols.find((item) => item.name === symbol);
  const digits = info?.digits ?? 5;
  const tick = info?.tickSize || info?.point || 0;
  const step = info?.volumeStep ?? 0.01;
  const ready = conn === 'open' && !!health?.connected;
  const mode = health?.tradeMode ?? 'readonly';
  const disciplineMode = health?.config.discipline_mode ?? 'off';
  const disciplineEnabled = disciplineMode !== 'off';
  const disciplineRequireReason = health?.config.discipline_require_reason ?? false;
  const currency = health?.account?.currency ?? '';
  const paused = mode === 'readonly' || !!riskStatus?.halted;
  const stepsText = templateStepsSummary(template);
  const summaryText = templateSummary(template);
  const riskDeviated = templateArmed && isRiskDeviated(template, risk);
  // R 标尺的入场价：市价单跟随当前报价，挂单用草稿价。
  // 市价草稿在图上没有入场线，止损止盈和 R 都以这个价为准。
  const rulerEntry =
    draft.type === 'market'
      ? ((draft.side === 'buy' ? quote?.ask : quote?.bid) ?? 0) || draft.price
      : draft.price;
  // 挂单类型：方向 + 价格相对市价的高低，决定限价还是停损
  const pendingInfo = classifyPending({
    side: draft.side,
    price: draft.price,
    bid: quote?.bid,
    ask: quote?.ask,
    stopsLevelPoints: info?.stopsLevelPoints,
    point: info?.point,
  });
  const autoLots = templateArmed && risk.auto;

  const { previewError, sizing } = useOrderPreview({
    ready,
    info,
    symbol,
    draft,
    risk,
    patchDraft,
    setPreview,
  });

  const { tpTouched, setTpTouched } = useTemplateSync({
    info,
    tick,
    digits,
    template,
    armed: templateArmed,
    draft,
    risk,
    rulerEntry,
    entryMode,
    patchDraft,
    patchRisk,
  });

  const {
    gate,
    gatePlaybooks,
    gateLoading,
    gateError,
    gateConfirmed,
    setGateConfirmed,
    gateReason,
    setGateReason,
    gateClientId,
    gateRules,
    gateMissing,
    gateViolated,
    gateShowConfirm,
    gateShowReason,
    gateProblem,
    openDisciplineGate,
    checkRule,
    resetGate,
  } = useDisciplineGate({
    confirm,
    enabled: disciplineEnabled,
    mode: disciplineMode,
    requireReason: disciplineRequireReason,
    defaultPlaybook: health?.config.discipline_playbook ?? '',
    notify,
  });

  // 挂单项：价格或市价变化后重新推导限价 / 停损，并回写草稿类型
  useEffect(() => {
    if (!draft.active || draft.type === 'market' || !pendingInfo.type) return;
    if (pendingInfo.type !== draft.type) patchDraft({ type: pendingInfo.type });
  }, [draft.active, draft.type, pendingInfo.type, patchDraft]);

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

  // 下单模式菜单：点外部或 Esc 关闭
  useEffect(() => {
    if (!modeMenu) return;
    const onDown = (event: MouseEvent) => {
      if (modeWrapRef.current?.contains(event.target as Node)) return;
      setModeMenu(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setModeMenu(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [modeMenu]);

  const activate = () => {
    if (!info) return;
    const volume = Math.max(info.minVolume, Math.min(info.maxVolume, draft.volume));
    if (draft.type === 'market') {
      patchDraft({
        active: true,
        price: defaultPrice(draft.side, 'market', quote, info),
        volume,
      });
      return;
    }
    // 挂单要落在点差之外才有意义，默认给一个停损价，类型由价格推导
    const price = defaultPrice(draft.side, 'stop', quote, info);
    const next = classifyPending({
      side: draft.side,
      price,
      bid: quote?.bid,
      ask: quote?.ask,
      stopsLevelPoints: info.stopsLevelPoints,
      point: info.point,
    });
    patchDraft({ active: true, type: next.type ?? 'stop', price, volume });
  };

  const applyTemplate = () => {
    if (templateArmed) {
      setTemplateArmed(false);
      notify('info', `已停用模板「${template.name}」，风险、手数与止损止盈保持不变`);
      return;
    }
    if (!info) return;
    patchRisk({ mode: 'percent', value: template.riskPercent, auto: true });
    setTpTouched(false);
    // 已经有委托价的草稿（限价/停损）保留类型；否则准备一张市价草稿
    const keepPending = draft.active && draft.type !== 'market' && draft.price > 0;
    patchDraft(
      keepPending
        ? { active: true }
        : {
            type: 'market',
            active: true,
            price: defaultPrice(draft.side, 'market', quote, info),
          },
    );
    setTemplateArmed(true);
    notify('info', `模板「${template.name}」已启用：${summaryText}`);
  };

  const selectTemplate = (id: string) => {
    setActiveTemplate(id);
    const next = templates.find((item) => item.id === id);
    if (!next) return;
    if (templateArmed) {
      patchRisk({ mode: 'percent', value: next.riskPercent, auto: true });
      setTpTouched(false);
      notify('info', `已切换到「${next.name}」：${templateSummary(next)}`);
    }
  };

  const restoreTemplateRisk = () => {
    patchRisk({ mode: 'percent', value: template.riskPercent, auto: true });
    notify('info', `已恢复模板风险 ${fmtNum(template.riskPercent)}%`);
  };

  const openTemplateSettings = () => {
    setSettingsSection('template');
    setPage('settings');
  };

  /** 常规模式点买/卖：直接开一张市价草稿，图上出现跟随现价的委托线 */
  const startMarket = (side: Side) => {
    if (!info) return;
    setTpTouched(false);
    patchDraft({
      active: true,
      side,
      type: 'market',
      price: defaultPrice(side, 'market', quote, info),
    });
  };

  /** 市价 / 挂单切换：挂单时给一个市价外的默认价，类型交给 classifyPending */
  const setOrderMode = (pending: boolean) => {
    if (!info) return;
    // 已经是当前页签时不重置用户填好的价格
    if (draft.active && pending === (draft.type !== 'market')) return;
    if (!pending) {
      patchDraft({
        active: true,
        type: 'market',
        price: defaultPrice(draft.side, 'market', quote, info),
      });
      return;
    }
    const price =
      draft.type === 'market' || !(draft.price > 0)
        ? defaultPrice(draft.side, 'stop', quote, info)
        : draft.price;
    const next = classifyPending({
      side: draft.side,
      price,
      bid: quote?.bid,
      ask: quote?.ask,
      stopsLevelPoints: info.stopsLevelPoints,
      point: info.point,
    });
    patchDraft({ active: true, type: next.type ?? 'stop', price });
  };

  const changeVolume = (delta: number) => {
    if (!info) return;
    patchDraft({
      volume: roundVolume(draft.volume + delta * step, step, info.minVolume, info.maxVolume),
    });
    patchRisk({ auto: false });
  };

  /** 快捷价按钮只在草稿未激活时补一个入场价，不覆盖用户已经输入的价格 */
  const patchOrder = (patch: Partial<DraftOrder>) => {
    const needPrice = !draft.active && !(draft.price > 0);
    patchDraft({
      active: true,
      ...(needPrice ? { price: defaultPrice(draft.side, draft.type, quote, info) } : {}),
      ...patch,
    });
  };

  const applySlPoints = (points: number) => {
    if (!info) return;
    const entry = rulerEntry > 0 ? rulerEntry : defaultPrice(draft.side, draft.type, quote, info);
    if (!(entry > 0)) {
      notify('info', '等待报价后再设置止损');
      return;
    }
    const distance = points * (info.point || info.tickSize || 0);
    const sl = draft.side === 'buy' ? entry - distance : entry + distance;
    patchOrder({ sl: Number(sl.toFixed(digits)) });
  };

  const applyTpR = (multiple: number) => {
    const entry = rulerEntry > 0 ? rulerEntry : defaultPrice(draft.side, draft.type, quote, info);
    if (!draft.sl || !(entry > 0)) {
      notify('info', '先设置止损，再按 R 设置止盈');
      return;
    }
    const risk = Math.abs(entry - draft.sl);
    if (!(risk > 0)) return;
    const tp = draft.side === 'buy' ? entry + risk * multiple : entry - risk * multiple;
    setTpTouched(true);
    patchOrder({ tp: Number(tp.toFixed(digits)) });
  };

  const chooseMode = (next: OrderEntryMode) => {
    setModeMenu(false);
    setEntryMode(next);
    if (next === 'risk') patchRisk({ auto: true });
  };

  const handlePlace = () => {
    if (!ready || !info) return;
    if (mode === 'readonly') {
      notify('info', '只读模式：请先在顶部切换到「模拟可交易」');
      return;
    }
    if (draft.type !== 'market' && !pendingInfo.type) {
      notify('error', pendingInfo.warning ?? '请设置有效的委托价格');
      return;
    }
    setConfirm(true);
  };

  const send = async (override?: Partial<DraftOrder>) => {
    if (!info) return;
    const order = { ...draft, ...override };
    const clientOrderId = gateClientId ?? crypto.randomUUID();
    setBusy(true);
    try {
      await gateway.call('order.place', {
        clientOrderId,
        symbol,
        side: order.side,
        type: order.type,
        volume: order.volume,
        price: order.type === 'market' ? undefined : order.price,
        sl: order.sl ?? undefined,
        tp: order.tp ?? undefined,
        tag: orderTag.trim() || undefined,
        discipline: disciplineEnabled
          ? {
              clientOrderId: gate?.clientId ?? clientOrderId,
              playbookId: gate?.playbookId ?? undefined,
              confirmed: gateConfirmed,
              reason: gateReason.trim() || undefined,
            }
          : undefined,
        plan:
          templateArmed && template.steps.length
            ? {
                steps: template.steps.map((step) => ({
                  atR: step.atR,
                  closePercent: step.closePercent,
                  moveBreakeven: step.moveBreakeven,
                })),
                templateId: template.id,
                templateName: template.name,
                breakevenOffsetPoints: breakevenOffset,
              }
            : undefined,
      });
      setConfirm(false);
      setTemplateArmed(false);
      patchDraft({ active: false });
      resetGate();
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pendingBlocked = draft.type !== 'market' && !pendingInfo.type;
  // 风险计算表格：手数由「风险金额 + 止损」反算，没填止损就没有可下的单
  const riskMode = entryMode === 'risk';
  const slSet = draft.sl != null && draft.sl > 0;
  const riskNeedsSl = riskMode && !slSet;
  const riskStep = risk.mode === 'percent' ? 0.1 : 10;
  const riskPctShown = sizing?.riskPct ?? preview?.riskPct ?? null;
  const rrShown = sizing?.rr ?? preview?.rr ?? null;
  const balance = health?.account?.balance ?? null;
  const slDistancePoints =
    slSet && rulerEntry > 0 && info?.point
      ? Math.abs(rulerEntry - (draft.sl as number)) / info.point
      : null;
  const bumpRisk = (delta: number) => {
    if (!Number.isFinite(risk.value)) return;
    patchRisk({ value: Math.max(0, Math.round((risk.value + delta) * 100) / 100) });
  };
  const buttonText = !ready
    ? '等待 MT5 连接'
    : !info
      ? '无可用品种'
      : mode === 'readonly'
        ? '只读模式 · 不会下单'
        : pendingBlocked
          ? '委托价无效'
          : riskNeedsSl
            ? '设定止损与风险值'
            : `${draft.side === 'buy' ? '买入' : '卖出'} ${fmtVolume(draft.volume, step)}`;

  const entryModeLabel = entryMode === 'risk' ? '风险计算表格' : '常规模式';
  const ask = quote?.ask ?? null;
  const bid = quote?.bid ?? null;

  const tpTarget = templateTpTarget({
    side: draft.side,
    price: rulerEntry,
    sl: draft.sl,
    rewardR: template.rewardR,
    tick,
    digits,
  });
  const tpManual = templateArmed && isTpManual(tpTarget, draft.tp, tick);
  const planTitle = `${template.name}：${summaryText}。启用后带走风险比例、止盈与阶段计划`;

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-tv-border px-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-tv-text">
            {symbol || '下单'}
          </div>
          <div className="truncate text-[10px] leading-tight text-tv-faint">
            {info?.description ?? (ready ? '选择品种' : '等待 MT5 连接')}
          </div>
        </div>
        <button
          onClick={() => (draft.active ? resetDraft() : activate())}
          disabled={!draft.active && (!ready || !info)}
          className={clsx(
            'h-7 shrink-0 rounded-lg border px-2 text-[11px] transition-colors',
            draft.active
              ? 'border-tv-accent/40 bg-tv-accent-soft text-tv-accent hover:bg-tv-accent/15'
              : 'border-tv-border bg-tv-panel text-tv-muted hover:bg-tv-hover hover:text-tv-text',
            !draft.active && (!ready || !info) && 'cursor-not-allowed opacity-40',
          )}
        >
          {draft.active ? '取消划线' : '画线'}
        </button>
        <button
          onClick={() => setTicketOpen(false)}
          title="收起下单面板"
          aria-label="收起下单面板"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-tv-muted hover:bg-tv-hover hover:text-tv-text"
        >
          <X size={15} strokeWidth={1.5} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-4 pt-2">
        <div className="flex items-end justify-between gap-2">
          <div>
            <div className="text-[10px] text-tv-faint">卖出 · Bid</div>
            <div className="num font-mono text-[19px] font-medium leading-none text-tv-down">
              {fmtPrice(bid, digits)}
            </div>
          </div>
          <div className="pb-0.5 text-center text-[10px] leading-tight text-tv-faint">
            <div>点差</div>
            <div className="num font-mono text-[11px] text-tv-muted">
              {preview ? `${preview.spreadPoints.toFixed(0)}` : '—'}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] text-tv-faint">买入 · Ask</div>
            <div className="num font-mono text-[19px] font-medium leading-none text-tv-up">
              {fmtPrice(ask, digits)}
            </div>
          </div>
        </div>

        <div ref={modeWrapRef} className="relative">
          <button
            onClick={() => setModeMenu(!modeMenu)}
            aria-haspopup="menu"
            aria-expanded={modeMenu}
            className="flex h-8 w-full items-center justify-between rounded-lg border border-tv-border bg-tv-panel px-2.5 text-[12px] text-tv-text transition-colors hover:bg-tv-hover"
          >
            <span className="flex items-center gap-1.5">
              <span className="text-tv-muted">下单模式</span>
              <span className="font-medium">{entryModeLabel}</span>
            </span>
            <ChevronDown size={13} strokeWidth={1.8} className="text-tv-muted" />
          </button>
          {modeMenu && (
            <div
              role="menu"
              className="absolute left-0 right-0 top-full z-40 mt-1 overflow-hidden rounded-lg border border-tv-border bg-tv-panel py-1 shadow-[0_12px_32px_rgba(20,30,45,0.16)]"
            >
              {(
                [
                  ['regular', '常规模式', '每次下单都弹出确认窗，最稳妥'],
                  ['risk', '风险计算表格', '按风险金额与止损自动算手数'],
                ] as const
              ).map(([value, label, hint]) => (
                <button
                  key={value}
                  role="menuitemradio"
                  aria-checked={entryMode === value}
                  onClick={() => chooseMode(value)}
                  className="flex w-full items-start gap-2 px-2.5 py-1.5 text-left hover:bg-tv-hover"
                >
                  <Check
                    size={13}
                    strokeWidth={2}
                    className={clsx(
                      'mt-0.5 shrink-0',
                      entryMode === value ? 'text-tv-accent' : 'text-transparent',
                    )}
                  />
                  <span className="min-w-0">
                    <span className="block text-[12px] text-tv-text">{label}</span>
                    <span className="block text-[10px] leading-tight text-tv-muted">{hint}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => startMarket('sell')}
            className={clsx(
              'flex h-14 flex-col items-center justify-center rounded-lg text-white transition-colors',
              'bg-tv-down hover:bg-[#a93831]',
              draft.side === 'sell' && 'ring-2 ring-tv-down/40 ring-offset-1',
              mode === 'readonly' && 'opacity-60',
            )}
            title="以市价卖出"
          >
            <span className="text-[13px] font-medium">卖出</span>
            <span className="num font-mono text-[12px] opacity-90">{fmtPrice(bid, digits)}</span>
          </button>
          <button
            onClick={() => startMarket('buy')}
            className={clsx(
              'flex h-14 flex-col items-center justify-center rounded-lg text-white transition-colors',
              'bg-tv-up hover:bg-[#0c6a49]',
              draft.side === 'buy' && 'ring-2 ring-tv-up/40 ring-offset-1',
              mode === 'readonly' && 'opacity-60',
            )}
            title="以市价买入"
          >
            <span className="text-[13px] font-medium">买入</span>
            <span className="num font-mono text-[12px] opacity-90">{fmtPrice(ask, digits)}</span>
          </button>
        </div>

        <div className="flex rounded-lg border border-tv-border bg-tv-raised p-0.5">
          {(
            [
              [false, '市价订单'],
              [true, '挂单'],
            ] as const
          ).map(([pending, label]) => {
            const selected = pending === (draft.type !== 'market');
            return (
              <button
                key={label}
                onClick={() => setOrderMode(pending)}
                aria-pressed={selected}
                className={clsx(
                  'h-7 flex-1 rounded-md text-[12px] transition-colors',
                  selected
                    ? 'bg-tv-panel text-tv-text shadow-[0_1px_2px_rgba(20,30,45,0.06)]'
                    : 'text-tv-muted hover:text-tv-text',
                )}
              >
                {label}
              </button>
            );
          })}
        </div>

        <OrderFields
          draft={draft}
          info={info}
          pendingInfo={pendingInfo}
          risk={risk}
          riskMode={riskMode}
          riskStep={riskStep}
          balance={balance}
          currency={currency}
          slSet={slSet}
          slDistancePoints={slDistancePoints}
          rrShown={rrShown}
          riskPctShown={riskPctShown}
          sizing={sizing}
          preview={preview}
          autoLots={autoLots}
          step={step}
          patchDraft={patchDraft}
          patchRisk={patchRisk}
          patchOrder={patchOrder}
          changeVolume={changeVolume}
          applySlPoints={applySlPoints}
          applyTpR={applyTpR}
          bumpRisk={bumpRisk}
          onTouchTp={() => setTpTouched(true)}
        />

        <TemplateBar
          template={template}
          templates={templates}
          armed={templateArmed}
          summary={summaryText}
          steps={stepsText}
          planTitle={planTitle}
          tpTarget={tpTarget}
          tpManual={tpManual}
          risk={risk}
          riskDeviated={riskDeviated}
          paused={paused}
          readonly={mode === 'readonly'}
          pending={draft.type !== 'market'}
          sizing={sizing}
          currency={currency}
          digits={digits}
          disabled={!info}
          onApply={applyTemplate}
          onSelect={selectTemplate}
          onCreate={() => {
            createTemplate();
            notify('info', '已新建空白模板，可点铅笔编辑');
          }}
          onOpenSettings={openTemplateSettings}
          onRestoreRisk={restoreTemplateRisk}
          onUseTemplateTp={() => {
            setTpTouched(false);
            if (tpTarget != null) patchDraft({ tp: tpTarget });
          }}
        />

        {moreOpen && !riskMode && (
          <RiskSection
            risk={risk}
            currency={currency}
            step={step}
            sizing={sizing}
            sl={draft.sl}
            patchRisk={patchRisk}
          />
        )}

        <button
          onClick={() => setMoreOpen(!moreOpen)}
          className="flex w-full items-center justify-between rounded-lg border border-dashed border-tv-border px-2.5 py-1.5 text-[11px] text-tv-muted transition-colors hover:border-tv-border hover:bg-tv-hover hover:text-tv-text"
        >
          <span>{moreOpen ? '收起附加设置' : '附加设置 · 策略标签 / 风险 / 计划'}</span>
          <ChevronDown
            size={12}
            strokeWidth={1.8}
            className={clsx('transition-transform', moreOpen && 'rotate-180')}
          />
        </button>

        {moreOpen && (
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
        )}

        <p className="text-[11px] leading-relaxed text-tv-muted">
          {draft.type === 'market'
            ? '市价单按当前报价成交，图上的虚线跟着现价走；按住线上 TP / SL 徽标向上或向下拉动即可设置保护，手数按模板自动计算。'
            : '挂单价格高于 / 低于市价时自动切换停损或限价；按住线上 TP / SL 徽标上下拖动即可设置保护。'}
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
          disabled={!ready || !info || pendingBlocked || riskNeedsSl}
          title={riskNeedsSl ? '先填写止损价，手数会按风险金额自动算' : undefined}
          className={clsx(
            'mt-auto h-10 w-full rounded-lg text-[13px] font-medium text-white transition-colors',
            draft.side === 'buy' ? 'bg-tv-up hover:bg-[#0c6a49]' : 'bg-tv-down hover:bg-[#a93831]',
            (!ready || !info || pendingBlocked || riskNeedsSl) &&
              'cursor-not-allowed opacity-40',
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
            <span>在图上拖动时吸附整数位</span>
          </div>
        </div>
      </div>

      {confirm && (
        <ConfirmDialog
          symbol={symbol}
          draft={draft}
          pendingLabel={pendingInfo.label ?? ''}
          digits={digits}
          step={step}
          preview={preview}
          orderTag={orderTag}
          templateArmed={templateArmed}
          template={template}
          steps={stepsText}
          riskDeviated={riskDeviated}
          tpManual={tpManual}
          disciplineEnabled={disciplineEnabled}
          gate={gate}
          gatePlaybooks={gatePlaybooks}
          gateLoading={gateLoading}
          gateError={gateError}
          gateRules={gateRules}
          gateMissing={gateMissing}
          gateViolated={gateViolated}
          gateShowConfirm={gateShowConfirm}
          gateShowReason={gateShowReason}
          gateProblem={gateProblem}
          gateConfirmed={gateConfirmed}
          gateReason={gateReason}
          setGateConfirmed={setGateConfirmed}
          setGateReason={setGateReason}
          busy={busy}
          onSwitchPlaybook={(id) => void openDisciplineGate(id)}
          onCheckRule={(rule, followed) => void checkRule(rule, followed)}
          onOpenSettings={() => openSettings('discipline')}
          onCancel={() => setConfirm(false)}
          onSend={() => void send()}
        />
      )}
    </section>
  );
}
