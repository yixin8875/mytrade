import { useEffect, useRef, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { Check, ChevronDown, Pencil, Plus, Settings2, X } from 'lucide-react';
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
import { TemplateEditor } from './TemplateEditor';
import type {
  DisciplineGate,
  DraftOrder,
  OrderType,
  Playbook,
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

const inputClass =
  'h-8 w-full rounded-lg border border-tv-border bg-tv-raised px-2 font-mono text-[12px] text-tv-text outline-none transition-colors focus:border-tv-accent focus:bg-tv-panel';

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
  const [liveAsk, setLiveAsk] = useState<Side | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const modeWrapRef = useRef<HTMLDivElement>(null);
  const oneClickLiveRef = useRef(false);
  const lastClickRef = useRef(0);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [sizing, setSizing] = useState<TradeSizing | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 开仓纪律门禁：清单状态与二次确认 */
  const [gate, setGate] = useState<DisciplineGate | null>(null);
  const [gatePlaybooks, setGatePlaybooks] = useState<Playbook[]>([]);
  const [gateLoading, setGateLoading] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);
  const [gateConfirmed, setGateConfirmed] = useState(false);
  const [gateReason, setGateReason] = useState('');
  const [gateClientId, setGateClientId] = useState<string | null>(null);
  /** 连续切换清单时只接受最后一次请求的结果 */
  const gateRequestRef = useRef(0);
  /** 下拉与票内编辑弹层互斥；点外部或 Esc 关闭 */
  const [templateMenu, setTemplateMenu] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  /** 用户手动改过止盈后，模板不再抢回；改入场价/止损时重新跟随 */
  const [tpTouched, setTpTouched] = useState(false);
  const templateWrapRef = useRef<HTMLDivElement>(null);

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

  // 风险计算表格里手数只能由风险反算：启动时恢复成该模式也强制打开自动手数
  useEffect(() => {
    if (entryMode === 'risk' && !risk.auto) patchRisk({ auto: true });
  }, [entryMode, risk.auto, patchRisk]);

  // 模板启用期间在设置或票内改了风险比例，这里跟着套用；手动改风险不会被覆盖
  useEffect(() => {
    if (!templateArmed) return;
    if (risk.mode === 'percent' && risk.value === template.riskPercent && risk.auto) return;
    patchRisk({ mode: 'percent', value: template.riskPercent, auto: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateArmed, template.id, template.riskPercent, patchRisk]);

  // 改入场价 / 止损 / 方向 / 类型后，止盈重新跟随模板（手动改过的 TP 此时让位）
  useEffect(() => {
    setTpTouched(false);
  }, [draft.side, draft.type, draft.price, draft.sl]);

  // 挂单项：价格或市价变化后重新推导限价 / 停损，并回写草稿类型
  useEffect(() => {
    if (!draft.active || draft.type === 'market' || !pendingInfo.type) return;
    if (pendingInfo.type !== draft.type) patchDraft({ type: pendingInfo.type });
  }, [draft.active, draft.type, pendingInfo.type, patchDraft]);

  // 切换模板时同样重新跟随
  useEffect(() => {
    setTpTouched(false);
  }, [template.id]);

  // 模板：止损设定后按设置的 R 倍数自动放止盈；用户手动改过就不抢回
  useEffect(() => {
    if (!templateArmed || tpTouched || !info || !draft.active) return;
    const target = templateTpTarget({
      side: draft.side,
      price: rulerEntry,
      sl: draft.sl,
      rewardR: template.rewardR,
      tick,
      digits,
    });
    if (target == null) return;
    if (draft.tp == null || Math.abs(draft.tp - target) > (tick || 1e-9) / 2) {
      patchDraft({ tp: target });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    templateArmed,
    tpTouched,
    template.rewardR,
    draft.active,
    draft.side,
    draft.price,
    draft.sl,
    info,
    tick,
    digits,
    patchDraft,
  ]);

  // 点模板栏外面关闭下拉/编辑器；点栏内的输入框不关闭
  useEffect(() => {
    if (!templateMenu && !editorOpen) return;
    const onDown = (event: MouseEvent) => {
      if (templateWrapRef.current?.contains(event.target as Node)) return;
      setTemplateMenu(false);
      setEditorOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [templateMenu, editorOpen]);

  // Esc 只关闭模板下拉/编辑器，不取消草稿。
  // 全局快捷键监听在 window 上，这里挂 document 捕获阶段，先截住事件。
  useEffect(() => {
    if (!templateMenu && !editorOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setTemplateMenu(false);
      setEditorOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [templateMenu, editorOpen]);

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

  /** 打开/切换开仓清单；每次生成新的 clientOrderId，避免沿用旧快照 */
  const openDisciplineGate = async (playbookId?: string) => {
    if (!disciplineEnabled) return;
    const request = gateRequestRef.current + 1;
    gateRequestRef.current = request;
    setGateLoading(true);
    setGateError(null);
    setGateConfirmed(false);
    setGateReason('');
    setGate(null);
    const clientOrderId = crypto.randomUUID();
    setGateClientId(clientOrderId);
    try {
      let books = gatePlaybooks;
      if (!books.length) {
        const res = await gateway.call<{ playbooks: Playbook[] }>('strategy.list', {});
        books = res.playbooks ?? [];
        if (gateRequestRef.current !== request) return;
        setGatePlaybooks(books);
      }
      const fallback = health?.config.discipline_playbook || books[0]?.id || '';
      const chosen = playbookId === undefined ? fallback : playbookId;
      const res = await gateway.call<{ gate: DisciplineGate }>('discipline.start', {
        clientOrderId,
        playbookId: chosen || undefined,
      });
      if (gateRequestRef.current !== request) return;
      setGate(res.gate);
    } catch (error) {
      if (gateRequestRef.current !== request) return;
      setGateError((error as Error).message);
    } finally {
      if (gateRequestRef.current === request) setGateLoading(false);
    }
  };

  useEffect(() => {
    if (!confirm) {
      // 关闭弹窗：丢弃在途请求，下次打开重新生成 clientOrderId
      gateRequestRef.current += 1;
      setGate(null);
      setGateError(null);
      setGateLoading(false);
      setGateConfirmed(false);
      setGateReason('');
      setGateClientId(null);
      return;
    }
    if (!disciplineEnabled) return;
    void openDisciplineGate();
    // 只在弹窗打开时初始化；切换清单由用户操作显式触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirm]);

  const checkRule = async (rule: string, followed: boolean | null) => {
    if (!gate || gateLoading) return;
    setGateLoading(true);
    try {
      const res = await gateway.call<{ gate: DisciplineGate }>('discipline.check', {
        clientOrderId: gate.clientId,
        playbookId: gate.playbookId ?? undefined,
        rule,
        followed,
      });
      setGate(res.gate);
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setGateLoading(false);
    }
  };

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
    setTemplateMenu(false);
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
    setTemplateMenu(false);
    setEditorOpen(false);
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

  /** 单击模式：跳过确认窗，但仍要求先设止损、遵守 800ms 防抖和实盘首次确认 */
  const instantOrder = (side: Side, liveAcked = false) => {
    if (!ready || !info) return;
    if (mode === 'readonly') {
      notify('info', '只读模式：请先在顶部切换到「模拟可交易」');
      return;
    }
    const next: DraftOrder = {
      ...draft,
      active: true,
      side,
      type: 'market',
      price: defaultPrice(side, 'market', quote, info),
    };
    if (!next.sl) {
      notify('error', '单击模式必须先设置止损，模板不会代填止损');
      return;
    }
    if (disciplineEnabled) {
      // 有开仓清单时退回常规确认窗，避免绕过纪律检查
      patchDraft(next);
      setConfirm(true);
      return;
    }
    if (mode === 'live' && !oneClickLiveRef.current && !liveAcked) {
      setLiveAsk(side);
      return;
    }
    const now = Date.now();
    if (now - lastClickRef.current < 800) return;
    lastClickRef.current = now;
    patchDraft(next);
    void send(next);
  };

  const chooseMode = (next: OrderEntryMode) => {
    setModeMenu(false);
    setEntryMode(next);
    if (next === 'risk') patchRisk({ auto: true });
    if (next === 'oneclick' && !draft.sl) {
      notify('info', '单击模式需要先设置止损，否则不会发单');
    }
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
      gateRequestRef.current += 1;
      setGate(null);
      setGateClientId(null);
      setGateConfirmed(false);
      setGateReason('');
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

  const entryModeLabel =
    entryMode === 'oneclick' ? '单击模式' : entryMode === 'risk' ? '风险计算表格' : '常规模式';
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

  // 门禁状态：全部规则都有评估结果才算完成；「不适用」视为已评估
  const gateRules = gate?.rules ?? [];
  const gateMissing = gate?.missing ?? [];
  const gateViolated = gate?.violated ?? [];
  const gateHasRules = !!gate?.playbookId && gateRules.length > 0;
  const gateShowConfirm =
    disciplineEnabled &&
    gateHasRules &&
    (disciplineMode === 'confirm'
      ? gateMissing.length > 0 || gateViolated.length > 0
      : gateMissing.length === 0 && gateViolated.length > 0);
  const gateShowReason =
    gateShowConfirm && (disciplineMode === 'block' || disciplineRequireReason);
  let gateProblem: string | null = null;
  if (disciplineEnabled) {
    if (gateLoading) {
      gateProblem = '正在读取开仓清单…';
    } else if (gateError) {
      gateProblem = gateError;
    } else if (!gate) {
      gateProblem = '开仓清单不可用，请稍后重试';
    } else if (!gateHasRules) {
      // confirm 允许跳过并写审计；block 必须先在设置里配置清单
      if (disciplineMode === 'block') gateProblem = '先在设置里配置开仓清单';
    } else if (disciplineMode === 'block') {
      if (gateMissing.length) {
        gateProblem = `还有 ${gateMissing.length} 条规则未评估`;
      } else if (gateViolated.length) {
        if (!gateConfirmed) gateProblem = '存在违反的规则，请先勾选复核';
        else if (!gateReason.trim()) gateProblem = '请填写强行下单的理由';
      }
    } else if (gateMissing.length || gateViolated.length) {
      if (!gateConfirmed) {
        gateProblem =
          gateMissing.length > 0
            ? `还有 ${gateMissing.length} 条规则未评估，请先勾选「我已复核」`
            : '存在违反的规则，请先勾选「我已复核」';
      } else if (disciplineRequireReason && !gateReason.trim()) {
        gateProblem = '请填写强行下单的理由';
      }
    }
  }

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
            className={clsx(
              'flex h-8 w-full items-center justify-between rounded-lg border px-2.5 text-[12px] transition-colors',
              entryMode === 'oneclick'
                ? 'border-tv-down/40 bg-tv-down-soft text-tv-down'
                : 'border-tv-border bg-tv-panel text-tv-text hover:bg-tv-hover',
            )}
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
                  ['oneclick', '单击模式', '点买/卖立即发单；必须先设止损'],
                  ['risk', '风险计算表格', '按风险金额与止损自动算手数'],
                ] as const
              ).map(([value, label, hint]) => (
                <button
                  key={value}
                  role="menuitemradio"
                  aria-checked={entryMode === value}
                  onClick={() => chooseMode(value)}
                  disabled={value === 'oneclick' && mode === 'readonly'}
                  title={
                    value === 'oneclick' && mode === 'readonly'
                      ? '只读模式下不能开启单击下单'
                      : undefined
                  }
                  className="flex w-full items-start gap-2 px-2.5 py-1.5 text-left hover:bg-tv-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
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

        {entryMode === 'oneclick' && (
          <div className="rounded-lg border border-tv-down/30 bg-tv-down-soft px-2.5 py-1.5 text-[10px] leading-relaxed text-tv-down">
            单击直发已开启：买/卖按钮会立即下单，不再弹确认窗。
            {mode === 'live' ? ' 实盘首次下单仍需确认一次。' : ''}
            {disciplineEnabled ? ' 有开仓清单时自动退回确认窗。' : ''}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => (entryMode === 'oneclick' ? instantOrder('sell') : startMarket('sell'))}
            className={clsx(
              'flex h-14 flex-col items-center justify-center rounded-lg text-white transition-colors',
              'bg-tv-down hover:bg-[#a93831]',
              draft.side === 'sell' && entryMode !== 'oneclick' && 'ring-2 ring-tv-down/40 ring-offset-1',
              mode === 'readonly' && 'opacity-60',
            )}
            title={entryMode === 'oneclick' ? '单击立即卖出' : '以市价卖出'}
          >
            <span className="text-[13px] font-medium">卖出</span>
            <span className="num font-mono text-[12px] opacity-90">{fmtPrice(bid, digits)}</span>
          </button>
          <button
            onClick={() => (entryMode === 'oneclick' ? instantOrder('buy') : startMarket('buy'))}
            className={clsx(
              'flex h-14 flex-col items-center justify-center rounded-lg text-white transition-colors',
              'bg-tv-up hover:bg-[#0c6a49]',
              draft.side === 'buy' && entryMode !== 'oneclick' && 'ring-2 ring-tv-up/40 ring-offset-1',
              mode === 'readonly' && 'opacity-60',
            )}
            title={entryMode === 'oneclick' ? '单击立即买入' : '以市价买入'}
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

        {draft.type !== 'market' && (
          <div className="rounded-lg border border-tv-border bg-tv-panel p-2">
            <div className="flex items-center gap-1.5">
              <span className="w-10 shrink-0 text-[11px] text-tv-muted">委托价</span>
              <input
                type="number"
                step={info?.tickSize ?? 0.00001}
                value={draft.price || ''}
                aria-label="委托价格"
                onChange={(event) => {
                  const value = event.target.value === '' ? 0 : Number(event.target.value);
                  patchDraft({ price: Number.isFinite(value) ? value : 0 });
                }}
                className="h-7 min-w-0 flex-1 rounded border border-tv-border bg-tv-raised px-1.5 font-mono text-[11px] text-tv-text outline-none focus:border-tv-accent"
              />
              <span
                className={clsx(
                  'shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium',
                  pendingInfo.type
                    ? 'border-tv-accent/40 bg-tv-accent-soft text-tv-accent'
                    : 'border-tv-warn/40 bg-tv-warn-soft text-tv-warn',
                )}
              >
                {pendingInfo.label}
              </span>
            </div>
            <div
              className={clsx(
                'mt-1 text-[10px] leading-4',
                pendingInfo.warning ? 'text-tv-warn' : 'text-tv-muted',
              )}
            >
              {pendingInfo.warning ??
                (draft.side === 'buy'
                  ? '高于买价 = 停损买入，低于买价 = 限价买入'
                  : '低于卖价 = 停损卖出，高于卖价 = 限价卖出')}
            </div>
          </div>
        )}

        {riskMode ? (
          <div data-risk-table className="space-y-2 rounded-lg border border-tv-border bg-tv-panel p-2">
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
                  aria-pressed={risk.mode === value}
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

            <div>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="text-[11px] text-tv-muted">
                  {risk.mode === 'percent' ? '风险比例' : '风险金额'}
                </span>
                <span className="text-[10px] text-tv-faint">
                  余额 {fmtMoney(balance)} {currency}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => bumpRisk(-riskStep)}
                  aria-label="减少风险"
                  className="h-8 w-8 shrink-0 rounded-lg bg-tv-raised text-[14px] text-tv-muted transition-colors hover:text-tv-text"
                >
                  −
                </button>
                <div className="relative min-w-0 flex-1">
                  <input
                    type="number"
                    min={0}
                    step={riskStep}
                    value={risk.value}
                    aria-label={risk.mode === 'percent' ? '风险比例' : '风险金额'}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (Number.isFinite(value)) patchRisk({ value });
                    }}
                    className={clsx(inputClass, 'pr-7 text-center')}
                  />
                  <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-tv-faint">
                    {risk.mode === 'percent' ? '%' : currency}
                  </span>
                </div>
                <button
                  onClick={() => bumpRisk(riskStep)}
                  aria-label="增加风险"
                  className="h-8 w-8 shrink-0 rounded-lg bg-tv-raised text-[14px] text-tv-muted transition-colors hover:text-tv-text"
                >
                  +
                </button>
              </div>
            </div>

            <div>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="text-[11px] text-tv-warn">止损价</span>
                <span
                  className={clsx(
                    'text-[10px]',
                    slSet ? 'text-tv-faint' : 'text-tv-warn',
                  )}
                >
                  {slDistancePoints != null
                    ? `距现价 ${slDistancePoints.toFixed(0)} 点`
                    : '必填 · 决定手数'}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  step={info?.tickSize ?? 0.00001}
                  value={draft.sl ?? ''}
                  placeholder="未设置"
                  aria-label="止损价格"
                  onChange={(event) => {
                    const value = event.target.value === '' ? null : Number(event.target.value);
                    patchOrder({ sl: Number.isFinite(value as number) ? value : null });
                  }}
                  className="h-7 min-w-0 flex-1 rounded border border-tv-border bg-tv-raised px-1.5 font-mono text-[11px] text-tv-warn outline-none focus:border-tv-accent"
                />
                {[100, 300, 500].map((points) => (
                  <button
                    key={points}
                    onClick={() => applySlPoints(points)}
                    title={`按现价偏移 ${points} 点`}
                    className="h-7 shrink-0 rounded border border-tv-border bg-tv-panel px-1 text-[10px] text-tv-muted hover:bg-tv-hover hover:text-tv-text"
                  >
                    {points}点
                  </button>
                ))}
                {draft.sl != null && (
                  <button
                    onClick={() => patchOrder({ sl: null })}
                    aria-label="清除止损"
                    title="清除止损"
                    className="flex h-7 w-5 shrink-0 items-center justify-center rounded text-tv-faint hover:text-tv-down"
                  >
                    <X size={11} strokeWidth={2} />
                  </button>
                )}
              </div>
            </div>

            <div>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="text-[11px] text-tv-accent">止盈价</span>
                <span className="text-[10px] text-tv-faint">
                  {rrShown != null ? `1 : ${rrShown.toFixed(2)}` : '可选'}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  step={info?.tickSize ?? 0.00001}
                  value={draft.tp ?? ''}
                  placeholder="未设置"
                  aria-label="止盈价格"
                  onChange={(event) => {
                    setTpTouched(true);
                    const value = event.target.value === '' ? null : Number(event.target.value);
                    patchOrder({ tp: Number.isFinite(value as number) ? value : null });
                  }}
                  className="h-7 min-w-0 flex-1 rounded border border-tv-border bg-tv-raised px-1.5 font-mono text-[11px] text-tv-accent outline-none focus:border-tv-accent"
                />
                {[1, 2, 3].map((multiple) => (
                  <button
                    key={multiple}
                    onClick={() => applyTpR(multiple)}
                    title={`按止损距离设置 ${multiple}R 止盈`}
                    className="h-7 shrink-0 rounded border border-tv-border bg-tv-panel px-1.5 text-[10px] text-tv-muted hover:bg-tv-hover hover:text-tv-text"
                  >
                    {multiple}R
                  </button>
                ))}
                {draft.tp != null && (
                  <button
                    onClick={() => {
                      setTpTouched(true);
                      patchOrder({ tp: null });
                    }}
                    aria-label="清除止盈"
                    title="清除止盈"
                    className="flex h-7 w-5 shrink-0 items-center justify-center rounded text-tv-faint hover:text-tv-down"
                  >
                    <X size={11} strokeWidth={2} />
                  </button>
                )}
              </div>
            </div>

            <div className="space-y-1 border-t border-tv-border pt-1.5">
              <PreviewRow
                label="自动手数"
                value={slSet ? `${fmtVolume(sizing?.volume ?? draft.volume, step)} 手` : '—'}
              />
              <PreviewRow
                label="风险占比"
                value={riskPctShown != null ? `${riskPctShown.toFixed(2)}%` : '—'}
              />
              <PreviewRow label="保证金" value={fmtMoney(preview?.margin)} />
              <PreviewRow
                label="R:R"
                value={rrShown != null ? `1 : ${rrShown.toFixed(2)}` : '—'}
              />
            </div>
            {!slSet && (
              <div className="text-[10px] leading-4 text-tv-faint">
                填写止损价后按风险金额自动算手数
              </div>
            )}
            {sizing?.warnings?.length ? (
              <div className="text-[11px] text-tv-warn">{sizing.warnings.join('；')}</div>
            ) : null}
            {sizing?.capped?.length ? (
              <div className="text-[11px] text-tv-warn">
                手数已按 {sizing.capped.join(' / ')} 限制
              </div>
            ) : null}
          </div>
        ) : (
        <>
        <div className="rounded-lg border border-tv-border bg-tv-panel p-2">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[11px] text-tv-muted">手数</span>
            <span
              className={clsx(
                'rounded px-1 py-px text-[9px] font-medium',
                autoLots
                  ? 'bg-tv-accent-soft text-tv-accent'
                  : risk.auto
                    ? 'bg-tv-raised text-tv-muted'
                    : 'text-tv-faint',
              )}
            >
              {autoLots ? '模板自动' : risk.auto ? '风险自动' : '手动'}
            </span>
          </div>
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
          {risk.auto && !draft.sl && (
            <div className="mt-1 text-[10px] leading-4 text-tv-faint">
              设置止损后按模板风险自动算手数
            </div>
          )}
        </div>

        <div className="space-y-1.5 rounded-lg border border-tv-border bg-tv-panel p-2">
          <div className="flex items-center gap-1">
            <span className="w-7 shrink-0 text-[11px] text-tv-warn">止损</span>
            <input
              type="number"
              step={info?.tickSize ?? 0.00001}
              value={draft.sl ?? ''}
              placeholder="未设置"
              aria-label="止损价格"
              onChange={(event) => {
                const value = event.target.value === '' ? null : Number(event.target.value);
                patchOrder({ sl: Number.isFinite(value as number) ? value : null });
              }}
              className="h-7 min-w-0 flex-1 rounded border border-tv-border bg-tv-raised px-1.5 font-mono text-[11px] text-tv-warn outline-none focus:border-tv-accent"
            />
            {[100, 300, 500].map((points) => (
              <button
                key={points}
                onClick={() => applySlPoints(points)}
                title={`按现价偏移 ${points} 点`}
                className="h-7 shrink-0 rounded border border-tv-border bg-tv-panel px-1 text-[10px] text-tv-muted hover:bg-tv-hover hover:text-tv-text"
              >
                {points}点
              </button>
            ))}
            {draft.sl != null && (
              <button
                onClick={() => patchOrder({ sl: null })}
                aria-label="清除止损"
                title="清除止损"
                className="flex h-7 w-5 shrink-0 items-center justify-center rounded text-tv-faint hover:text-tv-down"
              >
                <X size={11} strokeWidth={2} />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1">
            <span className="w-7 shrink-0 text-[11px] text-tv-accent">止盈</span>
            <input
              type="number"
              step={info?.tickSize ?? 0.00001}
              value={draft.tp ?? ''}
              placeholder="未设置"
              aria-label="止盈价格"
              onChange={(event) => {
                setTpTouched(true);
                const value = event.target.value === '' ? null : Number(event.target.value);
                patchOrder({ tp: Number.isFinite(value as number) ? value : null });
              }}
              className="h-7 min-w-0 flex-1 rounded border border-tv-border bg-tv-raised px-1.5 font-mono text-[11px] text-tv-accent outline-none focus:border-tv-accent"
            />
            {[1, 2, 3].map((multiple) => (
              <button
                key={multiple}
                onClick={() => applyTpR(multiple)}
                title={`按止损距离设置 ${multiple}R 止盈`}
                className="h-7 shrink-0 rounded border border-tv-border bg-tv-panel px-1.5 text-[10px] text-tv-muted hover:bg-tv-hover hover:text-tv-text"
              >
                {multiple}R
              </button>
            ))}
            {draft.tp != null && (
              <button
                onClick={() => {
                  setTpTouched(true);
                  patchOrder({ tp: null });
                }}
                aria-label="清除止盈"
                title="清除止盈"
                className="flex h-7 w-5 shrink-0 items-center justify-center rounded text-tv-faint hover:text-tv-down"
              >
                <X size={11} strokeWidth={2} />
              </button>
            )}
          </div>
        </div>
        </>
        )}

        <div ref={templateWrapRef} className="relative">
          <div className="flex gap-1.5">
            <button
              onClick={() => {
                setTemplateMenu((open) => !open);
                setEditorOpen(false);
              }}
              title={planTitle}
              aria-haspopup="listbox"
              aria-expanded={templateMenu}
              className={clsx(
                'flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-lg border px-2.5 text-left transition-colors',
                templateArmed
                  ? 'border-tv-accent/40 bg-tv-accent-soft'
                  : 'border-tv-border bg-tv-panel hover:bg-tv-hover',
              )}
            >
              <span className="min-w-0 flex-1">
                <span
                  className={clsx(
                    'block truncate text-[12px] font-medium',
                    templateArmed ? 'text-tv-accent' : 'text-tv-text',
                  )}
                >
                  {template.name}
                </span>
                <span className="block truncate text-[10px] text-tv-muted">{summaryText}</span>
              </span>
              <ChevronDown
                size={13}
                strokeWidth={1.8}
                className={clsx(
                  'shrink-0',
                  templateArmed ? 'text-tv-accent/70' : 'text-tv-muted',
                )}
              />
            </button>
            <button
              onClick={applyTemplate}
              disabled={!info}
              title={
                templateArmed
                  ? '停用模板：已填入的风险、手数与止损止盈保持不变'
                  : '启用模板：带入风险比例、止盈与阶段计划'
              }
              className={clsx(
                'h-9 w-[62px] shrink-0 rounded-lg border text-[12px] transition-colors',
                templateArmed
                  ? 'border-tv-accent bg-tv-accent text-white hover:bg-tv-accent/90'
                  : 'border-tv-border bg-tv-panel text-tv-text hover:bg-tv-hover',
                !info && 'cursor-not-allowed opacity-40',
              )}
            >
              {templateArmed ? '已启用' : '启用'}
            </button>
            <button
              onClick={() => {
                setEditorOpen((open) => !open);
                setTemplateMenu(false);
              }}
              title="编辑当前模板：风险 %、止盈 R、分批止盈"
              aria-label="编辑当前模板"
              className={clsx(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors',
                editorOpen
                  ? 'border-tv-accent/40 bg-tv-accent-soft text-tv-accent'
                  : 'border-tv-border bg-tv-panel text-tv-muted hover:bg-tv-hover hover:text-tv-text',
              )}
            >
              <Pencil size={13} strokeWidth={1.7} />
            </button>
          </div>

          {templateMenu && (
            <div
              data-modal
              className="absolute left-0 right-0 top-full z-30 mt-1 rounded-lg border border-tv-border bg-tv-panel p-1 shadow-[0_12px_32px_rgba(20,30,45,0.16)]"
            >
              <div className="max-h-56 overflow-y-auto">
                {templates.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => selectTemplate(item.id)}
                    className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-tv-hover"
                  >
                    <Check
                      size={13}
                      strokeWidth={2}
                      className={clsx(
                        'mt-0.5 shrink-0',
                        item.id === template.id ? 'text-tv-accent' : 'text-transparent',
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] text-tv-text">{item.name}</span>
                      <span className="block truncate text-[10px] text-tv-muted">
                        {templateSummary(item)}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
              <div className="my-1 border-t border-tv-border" />
              <button
                onClick={() => {
                  createTemplate();
                  setTemplateMenu(false);
                  notify('info', '已新建空白模板，可点铅笔编辑');
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-tv-muted transition-colors hover:bg-tv-hover hover:text-tv-text"
              >
                <Plus size={13} strokeWidth={1.8} />
                新建模板
              </button>
              <button
                onClick={openTemplateSettings}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-tv-muted transition-colors hover:bg-tv-hover hover:text-tv-text"
              >
                <Settings2 size={13} strokeWidth={1.6} />
                管理模板（设置页）
              </button>
            </div>
          )}

          {editorOpen && (
            <div
              data-modal
              className="absolute left-0 right-0 top-full z-30 mt-1 max-h-[70vh] overflow-y-auto rounded-xl border border-tv-border bg-tv-panel p-3 shadow-[0_16px_48px_rgba(20,30,45,0.18)]"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="truncate text-[12px] font-medium text-tv-text">
                  编辑「{template.name}」
                </span>
                <button
                  onClick={() => setEditorOpen(false)}
                  className="h-6 shrink-0 rounded-md border border-tv-border px-2 text-[11px] text-tv-muted transition-colors hover:bg-tv-hover hover:text-tv-text"
                >
                  完成
                </button>
              </div>
              <TemplateEditor templateId={template.id} tone="tv" compact />
            </div>
          )}
        </div>

        {templateArmed && (
          <div className="rounded-lg border border-tv-accent/25 bg-tv-accent-soft/50 px-2.5 py-2 text-[11px] leading-relaxed">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[12px] font-medium text-tv-accent">
                {template.name}
              </span>
              <span className="shrink-0 text-tv-muted">{summaryText}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-tv-muted">
              <span>
                风险 {fmtNum(risk.value)}%
                {sizing ? ` ≈ ${fmtMoney(sizing.targetRisk)}${currency}` : ''}
              </span>
              {tpTarget != null ? (
                <span>
                  止盈 {fmtNum(template.rewardR)}R @ {fmtPrice(tpTarget, digits)}
                </span>
              ) : (
                <span>不自动设止盈</span>
              )}
            </div>
            <div className="mt-0.5 text-tv-muted">{stepsText}</div>
            {draft.type !== 'market' && (
              <div className="mt-0.5 text-tv-muted">挂单成交后自动登记阶段计划</div>
            )}
            {paused && (
              <div className="mt-0.5 text-tv-warn">
                阶段已暂停：{mode === 'readonly' ? '只读模式' : '风控急停'}，恢复可交易后继续
              </div>
            )}
            {riskDeviated && (
              <div className="mt-1 flex items-center justify-between gap-2 text-tv-warn">
                <span>
                  已偏离模板：风险{' '}
                  {risk.mode === 'percent'
                    ? `${fmtNum(risk.value)}%`
                    : `固定 ${fmtMoney(risk.value)}`}
                  {risk.auto ? '' : ' · 手动手数'}
                </span>
                <button
                  onClick={restoreTemplateRisk}
                  className="shrink-0 rounded border border-tv-warn/40 px-1.5 py-0.5 text-[10px] text-tv-warn transition-colors hover:bg-tv-warn-soft"
                >
                  恢复
                </button>
              </div>
            )}
            {tpManual && tpTarget != null && (
              <div className="mt-1 flex items-center justify-between gap-2 text-tv-warn">
                <span>止盈已手动调整（模板 {fmtPrice(tpTarget, digits)}）</span>
                <button
                  onClick={() => {
                    setTpTouched(false);
                    patchDraft({ tp: tpTarget });
                  }}
                  className="shrink-0 rounded border border-tv-warn/40 px-1.5 py-0.5 text-[10px] text-tv-warn transition-colors hover:bg-tv-warn-soft"
                >
                  用模板止盈
                </button>
              </div>
            )}
          </div>
        )}

        {moreOpen && !riskMode && (
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

        {entryMode !== 'oneclick' ? (
          <button
            onClick={handlePlace}
            disabled={!ready || !info || pendingBlocked || riskNeedsSl}
            title={riskNeedsSl ? '先填写止损价，手数会按风险金额自动算' : undefined}
            className={clsx(
              'mt-auto h-10 w-full rounded-lg text-[13px] font-medium text-white transition-colors',
              draft.side === 'buy'
                ? 'bg-tv-up hover:bg-[#0c6a49]'
                : 'bg-tv-down hover:bg-[#a93831]',
              (!ready || !info || pendingBlocked || riskNeedsSl) &&
                'cursor-not-allowed opacity-40',
            )}
          >
            {buttonText}
          </button>
        ) : (
          <div className="mt-auto rounded-lg border border-tv-border bg-tv-raised px-3 py-2 text-center text-[11px] text-tv-muted">
            单击模式：点上方买 / 卖按钮立即发单
            {!draft.sl && <span className="mt-0.5 block text-tv-warn">发送前必须先设置止损</span>}
          </div>
        )}

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

      {liveAsk && (
        <div
          data-confirm="oneclick-live"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6"
        >
          <div className="w-[380px] max-w-[92vw] rounded-xl border border-tv-border bg-tv-panel p-5 shadow-[0_16px_48px_rgba(20,30,45,0.18)]">
            <div className="text-[14px] font-semibold text-tv-text">实盘单击下单确认</div>
            <p className="mt-2 text-[12px] leading-relaxed text-tv-muted">
              当前是实盘账户。单击模式会跳过每笔确认窗，点击买 / 卖即按市价真实成交。
              本次启动只需确认一次，止损仍必须手动设置。
            </p>
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => setLiveAsk(null)}
                className="h-9 flex-1 rounded-lg border border-tv-border text-[12px] text-tv-text hover:bg-tv-hover"
              >
                取消
              </button>
              <button
                onClick={() => {
                  const side = liveAsk;
                  oneClickLiveRef.current = true;
                  setLiveAsk(null);
                  if (side) instantOrder(side, true);
                }}
                className={clsx(
                  'h-9 flex-1 rounded-lg text-[12px] font-medium text-white',
                  liveAsk === 'buy' ? 'bg-tv-up' : 'bg-tv-down',
                )}
              >
                我知道，继续{liveAsk === 'buy' ? '买入' : '卖出'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirm && (
        <div
          data-confirm="order"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6"
        >
          <div className="max-h-[88vh] w-[400px] max-w-[92vw] overflow-y-auto rounded-xl border border-tv-border bg-tv-panel p-5 shadow-[0_16px_48px_rgba(20,30,45,0.18)]">
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
                value={draft.type === 'market' ? '市价' : pendingInfo.label}
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
              <ConfirmRow label="模板" value={templateArmed ? template.name : '—'} />
              <ConfirmRow
                label="模板参数"
                value={
                  templateArmed
                    ? `${fmtNum(template.riskPercent)}% 风险 · ${
                        template.rewardR > 0 ? `止盈 ${fmtNum(template.rewardR)}R` : '不自动设止盈'
                      }`
                    : '—'
                }
              />
              <ConfirmRow label="模板阶段" value={templateArmed ? stepsText : '—'} />
              {templateArmed && (riskDeviated || tpManual) && (
                <ConfirmRow
                  label="模板偏离"
                  value={[riskDeviated ? '风险已改' : '', tpManual ? '止盈已改' : '']
                    .filter(Boolean)
                    .join(' · ')}
                  accent="text-tv-warn"
                />
              )}
            </dl>

            {disciplineEnabled && (
              <div className="mt-4 rounded-lg border border-tv-border bg-tv-raised px-2.5 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium text-tv-text">开仓清单</span>
                  <select
                    value={gate?.playbookId ?? ''}
                    onChange={(event) => void openDisciplineGate(event.target.value)}
                    disabled={gateLoading}
                    aria-label="切换开仓清单"
                    className="h-6 max-w-[180px] rounded border border-tv-border bg-tv-panel px-1 text-[11px] text-tv-text outline-none disabled:opacity-50"
                  >
                    <option value="">不关联清单</option>
                    {gatePlaybooks.map((book) => (
                      <option key={book.id} value={book.id}>
                        {book.name}
                      </option>
                    ))}
                  </select>
                </div>

                {gateLoading && !gate ? (
                  <div className="mt-2 text-[10px] text-tv-muted">读取清单…</div>
                ) : gateError ? (
                  <div className="mt-2 text-[10px] leading-4 text-tv-warn">{gateError}</div>
                ) : gateRules.length === 0 ? (
                  <div className="mt-2 space-y-1.5 text-[10px] text-tv-muted">
                    <div>{gate?.playbookId ? '当前清单没有规则' : '未关联清单'}</div>
                    <button
                      onClick={() => openSettings('discipline')}
                      className="rounded border border-tv-border px-1.5 py-0.5 text-[10px] text-tv-text transition-colors hover:bg-tv-hover"
                    >
                      去设置开仓纪律
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="mt-2 space-y-1">
                      {gateRules.map((item) => (
                        <div key={item.rule} className="flex items-center gap-1.5">
                          <span
                            className="min-w-0 flex-1 truncate text-[11px] text-tv-text"
                            title={item.rule}
                          >
                            {item.rule}
                          </span>
                          <div className="flex shrink-0 gap-0.5">
                            <RuleButton
                              active={item.evaluated && item.followed === true}
                              tone="up"
                              onClick={() => void checkRule(item.rule, true)}
                            >
                              遵守
                            </RuleButton>
                            <RuleButton
                              active={item.evaluated && item.followed === false}
                              tone="down"
                              onClick={() => void checkRule(item.rule, false)}
                            >
                              违反
                            </RuleButton>
                            <RuleButton
                              active={item.evaluated && item.followed === null}
                              tone="na"
                              onClick={() => void checkRule(item.rule, null)}
                            >
                              不适用
                            </RuleButton>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-1.5 text-[10px] text-tv-muted">
                      已评估 {gateRules.length - gateMissing.length}/{gateRules.length} · 违反{' '}
                      {gateViolated.length}
                    </div>
                  </>
                )}

                {gateShowConfirm && (
                  <label className="mt-2 flex items-start gap-1.5 text-[11px] leading-4 text-tv-text">
                    <input
                      type="checkbox"
                      checked={gateConfirmed}
                      onChange={(event) => setGateConfirmed(event.target.checked)}
                      className="mt-0.5 accent-current"
                    />
                    我已复核清单，仍然下单
                  </label>
                )}
                {gateShowReason && (
                  <input
                    type="text"
                    value={gateReason}
                    maxLength={500}
                    placeholder="强行下单理由（写入审计）"
                    onChange={(event) => setGateReason(event.target.value)}
                    className={clsx(inputClass, 'mt-2 h-7 text-[11px]')}
                  />
                )}
                {gateProblem && (
                  <div className="mt-1.5 text-[10px] leading-4 text-tv-warn">{gateProblem}</div>
                )}
              </div>
            )}

            <div className="mt-5 flex gap-2">
              <button
                onClick={() => setConfirm(false)}
                className="h-9 flex-1 rounded-lg border border-tv-border text-[12px] text-tv-text transition-colors hover:bg-tv-hover"
              >
                取消
              </button>
              <button
                onClick={() => void send()}
                disabled={busy || !!gateProblem}
                className={clsx(
                  'h-9 flex-1 rounded-lg text-[12px] font-medium text-white transition-colors',
                  draft.side === 'buy' ? 'bg-tv-up' : 'bg-tv-down',
                  (busy || !!gateProblem) && 'cursor-not-allowed opacity-50',
                )}
              >
                {busy ? '发送中…' : gateProblem ? '清单未完成' : '确认发送'}
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

/** 清单规则的三态按钮：选中色与交易方向色一致，未评估时不亮 */
function RuleButton({
  active,
  tone,
  onClick,
  children,
}: {
  active: boolean;
  tone: 'up' | 'down' | 'na';
  onClick: () => void;
  children: ReactNode;
}) {
  const activeClass =
    tone === 'up'
      ? 'border-tv-up/50 bg-tv-up/10 text-tv-up'
      : tone === 'down'
        ? 'border-tv-down/50 bg-tv-down/10 text-tv-down'
        : 'border-tv-border bg-tv-panel text-tv-muted';
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'h-5 rounded border px-1 text-[10px] leading-none transition-colors',
        active ? activeClass : 'border-transparent text-tv-faint hover:bg-tv-hover',
      )}
    >
      {children}
    </button>
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
