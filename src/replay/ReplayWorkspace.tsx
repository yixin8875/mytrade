import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ChevronLeft,
  Lock,
  MoreHorizontal,
  Pause,
  PenLine,
  Play,
  RotateCcw,
  StepForward,
  Trash2,
  X,
} from 'lucide-react';
import { clsx } from 'clsx';
import { fmtMoney, fmtPrice, fmtSigned, fmtVolume } from '../lib/format';
import { stepSummary, templateSummary, templateTpTarget } from '../lib/template';
import { activeTemplate, useApp } from '../store/useApp';
import { calcProfit, marginFor, positionProfit, roundPrice, roundVolume } from './engine';
import {
  currentBar,
  lastPrice,
  sessionAccount,
  sessionProgress,
  sessionStats,
  useReplay,
} from './store';
import { goReplayList, goReplayReport } from './route';
import { hasReplayBars } from './source';
import { ReplayChart, type ReplayDraft } from './ReplayChart';
import { Tape } from './Tape';
import { fmtDate, fmtShort } from './time';
import type { ReplaySession } from './types';
import type { OrderType, Side } from '../gateway/types';

/** 与交易台周期收藏一致：1/5/15 分钟、1/4 小时、日线 */
function tfLabel(resolution: string): string {
  if (resolution === '60') return '1h';
  if (resolution === '240') return '4h';
  if (resolution === '1D' || resolution === '1W' || resolution === '1M') return resolution;
  return `${resolution}m`;
}

const SIDES: { value: Side; label: string }[] = [
  { value: 'buy', label: '买入' },
  { value: 'sell', label: '卖出' },
];

const TYPES: { value: OrderType; label: string }[] = [
  { value: 'market', label: '市价' },
  { value: 'limit', label: '限价' },
  { value: 'stop', label: '停损' },
];

const SPEEDS = [1, 2, 5, 10, 30] as const;

function defaultStopDistance(info: ReplaySession['symbolInfo']): number {
  const point = info.point || info.tickSize || 0.0001;
  return point * (info.digits >= 4 ? 200 : 500);
}

function sideText(side: Side): string {
  return side === 'buy' ? '买入' : '卖出';
}

function pnlClass(value: number): string {
  return value > 0 ? 'text-console-gain' : value < 0 ? 'text-console-loss' : 'text-console-muted';
}

export function ReplayWorkspace({ sessionId }: { sessionId: string }) {
  const session = useReplay((s) => s.sessions.find((item) => item.id === sessionId));
  const loading = useReplay((s) => s.loading);
  const playing = useReplay((s) => s.playing);
  const speed = useReplay((s) => s.speed);
  const follow = useReplay((s) => s.follow);
  const revision = useReplay((s) => s.revision);
  const restart = useReplay((s) => s.restart);
  const toggle = useReplay((s) => s.toggle);
  const step = useReplay((s) => s.step);
  const setSpeed = useReplay((s) => s.setSpeed);
  const setFollow = useReplay((s) => s.setFollow);
  const finish = useReplay((s) => s.finish);
  const archive = useReplay((s) => s.archive);
  const remove = useReplay((s) => s.remove);
  const submitOrder = useReplay((s) => s.submitOrder);
  const closePosition = useReplay((s) => s.closePosition);
  const modifyStops = useReplay((s) => s.modifyStops);
  const cancelOrder = useReplay((s) => s.cancelOrder);
  const addNote = useReplay((s) => s.addNote);
  const removeNote = useReplay((s) => s.removeNote);
  const template = useApp(activeTemplate);
  const templates = useApp((s) => s.templates);
  const setActiveTemplate = useApp((s) => s.setActiveTemplate);

  const [timeframe, setTimeframe] = useState('15');
  const [draftActive, setDraftActive] = useState(false);
  /** 复盘默认按模板下单：选了模板就直接生效，不用再点一次「启用」 */
  const [templateArmed, setTemplateArmed] = useState(true);
  const [tab, setTab] = useState<'positions' | 'orders' | 'notes' | 'stats'>('positions');
  const [menu, setMenu] = useState(false);
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editSl, setEditSl] = useState('');
  const [editTp, setEditTp] = useState('');
  const [noteText, setNoteText] = useState('');
  const [noteTag, setNoteTag] = useState('');
  const ticketInited = useRef<string | null>(null);

  const [side, setSide] = useState<Side>('buy');
  const [type, setType] = useState<OrderType>('market');
  const [volume, setVolume] = useState('0.10');
  const [price, setPrice] = useState('');
  const [sl, setSl] = useState('');
  const [tp, setTp] = useState('');
  const [slTouched, setSlTouched] = useState(false);
  const [tpTouched, setTpTouched] = useState(false);
  const [ticketError, setTicketError] = useState<string | null>(null);

  const info = session?.symbolInfo;
  const digits = info?.digits ?? 2;
  const stepVolume = info?.volumeStep ?? 0.01;
  const bid = session ? lastPrice(session) : 0;
  const spread = session && info ? session.settings.spreadPoints * info.point : 0;
  const ask = bid + spread;
  const bar = session ? currentBar(session) : null;
  const progress = session ? sessionProgress(session) : 0;
  const account = session ? sessionAccount(session) : null;
  const stats = useMemo(() => (session ? sessionStats(session) : null), [session]);
  const initial = session?.settings.initialBalance ?? 0;
  /** 启用模板时用模板的风险比例和 R 倍数，否则用会话设置与默认 2R */
  const riskPercent = templateArmed ? template.riskPercent : (session?.settings.riskPercent ?? 0);
  const rewardR = templateArmed ? Math.max(1, template.rewardR) : 2;

  useEffect(() => {
    if (!session) return;
    setTimeframe(session.settings.timeframe);
    ticketInited.current = null;
  }, [session?.id]);

  // 行情就绪后按模板给出一张可用的模拟单
  useEffect(() => {
    if (!session || !bar || !info) return;
    if (ticketInited.current === session.id) return;
    ticketInited.current = session.id;
    const reference = side === 'buy' ? ask : bid;
    const distance = defaultStopDistance(info);
    const tickSize = info.tickSize || info.point || 1e-9;
    const riskPerLot = (distance / tickSize) * (info.tickValue || 0);
    const riskAmount = (session.settings.initialBalance * riskPercent) / 100;
    const suggested =
      riskPerLot > 0 ? roundVolume(riskAmount / riskPerLot, info) : info.minVolume;
    setVolume(String(suggested));
    setSl(
      String(roundPrice(side === 'buy' ? reference - distance : reference + distance, info)),
    );
    setTp(
      String(
        roundPrice(
          side === 'buy'
            ? reference + distance * rewardR
            : reference - distance * rewardR,
          info,
        ),
      ),
    );
    setPrice(String(roundPrice(reference, info)));
    setTicketError(null);
  }, [session, bar, info, side, ask, bid, rewardR, riskPercent]);

  // 市价单的止损止盈跟着回放价格走；用户手动改过就不再覆盖
  useEffect(() => {
    if (!info || type !== 'market' || !(ask > 0)) return;
    const distance = defaultStopDistance(info);
    const reference = side === 'buy' ? ask : bid;
    if (!slTouched) {
      setSl(
        String(roundPrice(side === 'buy' ? reference - distance : reference + distance, info)),
      );
    }
    if (!tpTouched) {
      setTp(
        String(
          roundPrice(
            side === 'buy'
              ? reference + distance * rewardR
              : reference - distance * rewardR,
            info,
          ),
        ),
      );
    }
  }, [ask, bid, info, side, type, slTouched, tpTouched, rewardR]);

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center bg-console-canvas">
        <div className="text-center">
          <div className="text-[13px] text-console-ink">复盘会话不存在</div>
          <button onClick={goReplayList} className="console-btn console-btn-secondary mt-3">
            返回复盘列表
          </button>
        </div>
      </div>
    );
  }

  const preparing = session.status === 'preparing';
  const finished = session.status === 'finished' || session.status === 'archived';
  const barsReady = hasReplayBars(session.id);
  const played = Math.max(0, session.cursorIndex - session.startIndex);
  const virtualTime = bar ? bar.time + 60 : session.startTs;

  const startEdit = (positionId: string, entrySl: number | null, entryTp: number | null) => {
    setEditing(positionId);
    setEditSl(entrySl != null ? String(entrySl) : '');
    setEditTp(entryTp != null ? String(entryTp) : '');
  };

  const saveEdit = (positionId: string) => {
    modifyStops(positionId, {
      sl: editSl.trim() ? Number(editSl) : null,
      tp: editTp.trim() ? Number(editTp) : null,
    });
    setEditing(null);
  };

  const submit = () => {
    const error = submitOrder({
      side,
      type,
      volume: Number(volume),
      price: Number(price),
      sl: sl.trim() ? Number(sl) : null,
      tp: tp.trim() ? Number(tp) : null,
      tag: useApp.getState().orderTag,
      steps: templateArmed ? template.steps : undefined,
      templateName: templateArmed ? template.name : undefined,
    });
    setTicketError(error);
    if (!error) {
      setDraftActive(false);
      // 模板保持启用：复盘常连续下单，每笔都按同一模板执行
    }
  };

  const entry = type === 'market' ? (side === 'buy' ? ask : bid) : Number(price) || 0;
  /** 市价单没有入场点，始终用当前对手价；挂单用票面委托价 */
  const entryForDisplay =
    type === 'market' ? entry : draftActive && Number(price) > 0 ? Number(price) : entry;
  const slNumber = sl.trim() ? Number(sl) : null;
  const tpNumber = tp.trim() ? Number(tp) : null;
  const riskAmount =
    info && slNumber != null
      ? Math.abs(calcProfit(side, Number(volume) || 0, entryForDisplay, slNumber, info))
      : null;
  const rewardAmount =
    info && tpNumber != null
      ? Math.abs(calcProfit(side, Number(volume) || 0, entryForDisplay, tpNumber, info))
      : null;
  const rr =
    slNumber != null && tpNumber != null && Math.abs(entryForDisplay - slNumber) > 0
      ? Math.abs(tpNumber - entryForDisplay) / Math.abs(entryForDisplay - slNumber)
      : null;
  const margin =
    info && entryForDisplay > 0
      ? marginFor(Number(volume) || 0, entryForDisplay, info, session.settings.leverage)
      : 0;
  const riskPct = initial > 0 && riskAmount != null ? (riskAmount / initial) * 100 : null;

  /** 模板启用时按 R 倍数推止盈；模板停用或参数不全时不干预 */
  const tpTargetFor = (priceValue: number, stop: number | null): number | null => {
    if (!templateArmed || !info || stop == null || !(stop > 0) || !(priceValue > 0)) return null;
    return templateTpTarget({
      side,
      price: priceValue,
      sl: stop,
      rewardR: Math.max(1, template.rewardR),
      tick: info.tickSize || info.point || 0,
      digits: info.digits,
    });
  };

  const toggleDraft = () => {
    if (draftActive) {
      setDraftActive(false);
      return;
    }
    if (!info) return;
    // 挂单才需要图上入场点；市价单成交价由行情决定，画线只用来放止损止盈
    if (type !== 'market') setPrice(String(roundPrice(entry, info)));
    // 画线期间冻结自动止损止盈，免得线每根 K 线都跟着跑
    setSlTouched(true);
    setTpTouched(true);
    setDraftActive(true);
  };

  const handleDraftChange = (patch: { price?: number; sl?: number | null; tp?: number | null }) => {
    // 市价草稿的入场基准是当前对手价；挂单才用手放的委托价
    const nextEntry = patch.price ?? entryForDisplay;
    const nextStop = patch.sl !== undefined ? patch.sl : slNumber;
    if (patch.price != null) setPrice(String(patch.price));
    if (patch.sl !== undefined) {
      setSl(patch.sl == null ? '' : String(patch.sl));
      setSlTouched(true);
    }
    if (patch.tp !== undefined) {
      setTp(patch.tp == null ? '' : String(patch.tp));
      setTpTouched(true);
      return;
    }
    // 拖动止损或入场线后，模板的止盈按 R 倍数重新跟随（与交易台一致）
    if (patch.price != null || patch.sl !== undefined) {
      const target = tpTargetFor(nextEntry, nextStop);
      if (target != null) {
        setTp(String(target));
        // 手动定过止损后，止盈交给模板 R；别再被行情自动跟随覆盖
        setTpTouched(true);
      }
    }
  };

  const toggleTemplate = () => {
    const next = !templateArmed;
    setTemplateArmed(next);
    setSlTouched(false);
    setTpTouched(false);
    // 模板风险比例变了，手数和默认止损按新风险重算
    ticketInited.current = null;
    useApp
      .getState()
      .notify(
        'info',
        next
          ? `模板「${template.name}」已启用：${templateSummary(template)}`
          : `模板「${template.name}」已停用，按手工手数与止盈止损下单`,
      );
  };

  const draft: ReplayDraft = {
    active: draftActive,
    side,
    type,
    price: Number(price) || 0,
    // 市价草稿的计价基准：当前对手价；R 刻度也按它算
    reference: type === 'market' ? entry : undefined,
    sl: slNumber,
    tp: tpNumber,
    volume: Number(volume) || 0,
    // 模板阶段可能在止盈之外，图上把阶段 R 也标出来
    stepsR: templateArmed ? Math.max(0, ...template.steps.map((step) => step.atR)) : 0,
  };

  const latestNote = session.notes[session.notes.length - 1];
  const equity = account?.equity ?? session.equity;

  return (
    <div className="flex h-full min-h-0 flex-col bg-console-canvas">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-console-line px-6">
        <button
          onClick={goReplayList}
          className="grid h-8 w-8 place-items-center rounded-[8px] text-console-muted hover:bg-console-hover hover:text-console-ink"
          title="返回复盘列表"
        >
          <ChevronLeft size={16} strokeWidth={1.5} />
        </button>
        <div className="min-w-0">
          <div className="truncate text-[15px] font-medium leading-tight">{session.name}</div>
          <div className="mt-1 whitespace-nowrap text-[11px] text-console-muted">
            {session.symbol} · {tfLabel(timeframe)} · 行情时间{' '}
            <b className="font-mono font-normal text-console-ink-2">{fmtShort(virtualTime)}</b>
          </div>
        </div>
        <span className="ml-2 inline-flex items-center gap-1.5 text-[11px] text-console-muted">
          <span
            className={clsx(
              'h-1.5 w-1.5 rounded-full',
              playing
                ? 'bg-console-accent'
                : finished
                  ? 'bg-console-gain'
                  : preparing
                    ? 'bg-console-warn'
                    : 'bg-console-line-2',
            )}
          />
          {playing ? '回放中' : finished ? '已完成' : preparing ? '准备行情' : '暂停'}
        </span>
        <span className="num font-mono text-[11px] text-console-muted">
          {Math.round(progress * 100)}%
        </span>
        <div className="flex-1" />
        <span className="inline-flex h-[18px] items-center rounded-[4px] border border-console-line-2 px-1.5 text-[10px] text-console-muted">
          模拟撮合
        </span>
        {finished ? (
          <button
            onClick={() => goReplayReport(session.id)}
            className="console-btn console-btn-primary"
          >
            查看报告
          </button>
        ) : confirmFinish ? (
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-console-muted">结束并平掉持仓？</span>
            <button
              onClick={() => {
                finish();
                setConfirmFinish(false);
                goReplayReport(session.id);
              }}
              className="console-btn console-btn-primary"
            >
              结束
            </button>
            <button
              onClick={() => setConfirmFinish(false)}
              className="console-btn console-btn-secondary"
            >
              取消
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmFinish(true)}
            className="console-btn console-btn-secondary"
          >
            结束复盘
          </button>
        )}
        <div className="relative">
          <button
            onClick={() => setMenu((value) => !value)}
            className="grid h-8 w-8 place-items-center rounded-[8px] text-console-muted hover:bg-console-hover hover:text-console-ink"
            title="更多"
          >
            <MoreHorizontal size={16} strokeWidth={1.5} />
          </button>
          {menu && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setMenu(false)} />
              <div className="absolute right-0 top-9 z-30 w-36 overflow-hidden rounded-[8px] border border-console-line bg-console-card py-1 shadow-[0_12px_28px_-12px_rgba(33,28,22,.35)]">
                <button
                  onClick={() => {
                    restart();
                    setMenu(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-console-ink-2 hover:bg-console-hover"
                >
                  <RotateCcw size={13} strokeWidth={1.5} />
                  重新开始
                </button>
                <button
                  onClick={() => {
                    archive(session.id);
                    setMenu(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-console-ink-2 hover:bg-console-hover"
                >
                  <Archive size={13} strokeWidth={1.5} />
                  归档
                </button>
                <button
                  onClick={() => {
                    remove(session.id);
                    setMenu(false);
                    goReplayList();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-console-loss hover:bg-console-hover"
                >
                  <Trash2 size={13} strokeWidth={1.5} />
                  删除
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col border-r border-console-line">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-console-line px-4">
            <span className="font-mono text-[11px] text-console-ink-2">{tfLabel(timeframe)}</span>
            <span className="mx-1 h-4 w-px bg-console-line" />
            <span className="inline-flex items-center gap-1 text-[10px] text-console-muted">
              <Lock size={13} strokeWidth={1.5} />
              品种与区间已锁定 · 周期在图表上方切换
            </span>
            <div className="flex-1" />
            {session.dataSource === 'demo' && (
              <span className="inline-flex h-[20px] items-center rounded-[4px] bg-console-warn-soft px-1.5 text-[10px] text-console-warn">
                演示数据
              </span>
            )}
            <span className="text-[10px] text-console-muted">
              {session.settings.spreadPoints} points 点差
            </span>
          </div>

          <div className="relative min-h-0 flex-1 bg-console-card">
            {barsReady && (
              <ReplayChart
                sessionId={session.id}
                revision={revision}
                timeframe={timeframe}
                follow={follow}
                draft={draft}
                onDraftChange={handleDraftChange}
                onTimeframeChange={setTimeframe}
              />
            )}

            {(!barsReady || preparing || loading?.id === session.id) && (
              <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-console-card/90">
                <div className="text-[13px] text-console-ink">
                  {loading?.message ?? '准备回放行情'}
                </div>
                <div className="h-1 w-56 overflow-hidden rounded-full bg-console-line">
                  <div
                    className="h-full rounded-full bg-console-accent transition-[width] duration-300"
                    style={{ width: `${Math.round((loading?.progress ?? 0.02) * 100)}%` }}
                  />
                </div>
                <div className="text-[10px] text-console-muted">
                  先读本地缓存，缺的部分按 5,000 根一段向网关取 M1
                </div>
              </div>
            )}

            {session.status === 'error' && (
              <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-console-card/90">
                <div className="text-[13px] text-console-loss">
                  {session.error ?? '这段区间没有可用行情'}
                </div>
                <button onClick={goReplayList} className="console-btn console-btn-secondary mt-1">
                  返回复盘列表
                </button>
              </div>
            )}

            {finished && (
              <div className="absolute inset-x-0 bottom-4 z-20 flex justify-center">
                <div className="flex items-center gap-3 rounded-[12px] border border-console-line bg-console-card/95 px-4 py-2.5 shadow-[0_12px_28px_-16px_rgba(33,28,22,.4)]">
                  <span className="text-[11px] text-console-muted">
                    复盘已结束，模拟持仓已按最后一根 M1 收盘平仓
                  </span>
                  <button
                    onClick={() => goReplayReport(session.id)}
                    className="console-btn console-btn-primary"
                  >
                    查看复盘报告
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>

        <aside className="flex w-[336px] shrink-0 flex-col bg-console-card">
          <div className="shrink-0 border-b border-console-line px-5 py-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-medium">模拟账户</span>
              <span className="text-[10px] text-console-muted">
                {session.settings.currency} · 1:{session.settings.leverage}
              </span>
            </div>
            <div className="mt-2.5 flex items-baseline gap-2">
              <span className="text-[11px] text-console-muted">净值</span>
              <span className="num font-mono text-[24px] font-medium leading-none tracking-[-0.01em]">
                {fmtMoney(equity)}
              </span>
              <span className={clsx('num font-mono text-[11px]', pnlClass(equity - initial))}>
                {fmtSigned(equity - initial)}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[10px] text-console-muted">
              <span>
                余额{' '}
                <b className="font-mono font-normal text-console-ink-2">
                  {fmtMoney(session.balance)}
                </b>
              </span>
              <span>
                保证金{' '}
                <b className="font-mono font-normal text-console-ink-2">
                  {fmtMoney(account?.margin ?? 0)}
                </b>
              </span>
              <span>
                可用{' '}
                <b className="font-mono font-normal text-console-ink-2">
                  {fmtMoney(account?.freeMargin ?? 0)}
                </b>
              </span>
            </div>
          </div>

          <div className="flex h-10 shrink-0 items-stretch gap-0.5 border-b border-console-line px-3">
            {(
              [
                ['positions', '持仓', session.positions.length],
                ['orders', '挂单', session.orders.length],
                ['notes', '笔记', session.notes.length],
                ['stats', '统计', null],
              ] as const
            ).map(([value, label, count]) => (
              <button
                key={value}
                onClick={() => setTab(value)}
                className={clsx(
                  'relative inline-flex items-center gap-1.5 px-2.5 text-[12px] transition-colors',
                  tab === value
                    ? 'font-medium text-console-ink'
                    : 'text-console-muted hover:text-console-ink',
                )}
              >
                {label}
                {count != null && (
                  <span className="num font-mono text-[10px] text-console-muted">{count}</span>
                )}
                {tab === value && (
                  <span className="absolute inset-x-2.5 -bottom-px h-0.5 bg-console-ink" />
                )}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {tab === 'positions' && (
              <>
                {session.positions.length === 0 && (
                  <div className="px-5 py-6 text-[11px] leading-5 text-console-muted">
                    还没有模拟持仓。市价单会在下一根 M1 开盘成交，限价/停损单等待价格触发。
                  </div>
                )}
                {session.positions.map((position) => {
                  const profit = info
                    ? positionProfit(position, bid, info, session.settings.spreadPoints)
                    : 0;
                  const r =
                    position.initialRisk && position.initialRisk > 0
                      ? profit / position.initialRisk
                      : null;
                  const exit = position.side === 'buy' ? bid : ask;
                  return (
                    <div key={position.id} className="border-b border-console-line px-5 py-3">
                      <div className="flex items-center gap-2">
                        <span
                          className={clsx(
                            'text-[11px] font-medium',
                            position.side === 'buy' ? 'text-console-gain' : 'text-console-loss',
                          )}
                        >
                          {sideText(position.side)}
                        </span>
                        <span className="text-[13px] font-medium">{session.symbol}</span>
                        <span className="font-mono text-[10px] text-console-muted">
                          {fmtVolume(position.volume, stepVolume)} 手
                        </span>
                        <span
                          className={clsx(
                            'num ml-auto font-mono text-[13px] font-medium',
                            pnlClass(profit),
                          )}
                        >
                          {fmtSigned(profit)}
                        </span>
                      </div>
                      {position.templateName && (
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-console-muted">
                          <span className="rounded-[4px] bg-console-hover px-1.5">模板</span>
                          <span className="text-console-ink-2">{position.templateName}</span>
                          {position.steps?.length ? (
                            <span className="num font-mono">
                              {Math.min(position.templateStep, position.steps.length)}/
                              {position.steps.length} 阶段
                            </span>
                          ) : null}
                          {position.steps?.length ? (
                            position.templateStep < position.steps.length ? (
                              <span>下档 {stepSummary(position.steps[position.templateStep])}</span>
                            ) : (
                              <span>阶段已执行完</span>
                            )
                          ) : null}
                        </div>
                      )}
                      <div className="mt-1.5 flex items-center gap-4 text-[10px] text-console-muted">
                        <span>
                          入场{' '}
                          <b className="font-mono font-normal text-console-ink-2">
                            {fmtPrice(position.entry, digits)}
                          </b>
                        </span>
                        <span>
                          现价{' '}
                          <b className="font-mono font-normal text-console-ink-2">
                            {fmtPrice(exit, digits)}
                          </b>
                        </span>
                        {r != null && <span className={pnlClass(r)}>{fmtSigned(r)}R</span>}
                      </div>
                      <div className="mt-2 flex items-center gap-3 text-[10px] text-console-muted">
                        <span>
                          SL{' '}
                          <b className="font-mono font-normal text-console-ink-2">
                            {fmtPrice(position.sl, digits)}
                          </b>
                        </span>
                        <span>
                          TP{' '}
                          <b className="font-mono font-normal text-console-ink-2">
                            {fmtPrice(position.tp, digits)}
                          </b>
                        </span>
                        <div className="flex-1" />
                        <button
                          onClick={() => closePosition(position.id)}
                          className="text-console-muted hover:text-console-ink"
                        >
                          平仓
                        </button>
                        <button
                          onClick={() => startEdit(position.id, position.sl, position.tp)}
                          className="text-console-muted hover:text-console-ink"
                        >
                          改止损
                        </button>
                      </div>
                      {editing === position.id && (
                        <div className="mt-2 rounded-[8px] border border-console-line bg-console-canvas p-2">
                          <div className="grid grid-cols-2 gap-2">
                            <label className="block">
                              <span className="mb-1 block text-[10px] text-console-muted">
                                止损
                              </span>
                              <input
                                value={editSl}
                                onChange={(event) => setEditSl(event.target.value)}
                                className="console-input w-full font-mono text-[11px]"
                              />
                            </label>
                            <label className="block">
                              <span className="mb-1 block text-[10px] text-console-muted">
                                止盈
                              </span>
                              <input
                                value={editTp}
                                onChange={(event) => setEditTp(event.target.value)}
                                className="console-input w-full font-mono text-[11px]"
                              />
                            </label>
                          </div>
                          <div className="mt-2 flex justify-end gap-1.5">
                            <button
                              onClick={() => setEditing(null)}
                              className="text-[10px] text-console-muted hover:text-console-ink"
                            >
                              取消
                            </button>
                            <button
                              onClick={() => saveEdit(position.id)}
                              className="text-[10px] font-medium text-console-accent"
                            >
                              保存
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                {latestNote && (
                  <div className="border-b border-console-line px-5 py-3">
                    <div className="flex items-center justify-between text-[10px] text-console-muted">
                      <span>最新笔记</span>
                      <span className="num font-mono">{fmtShort(latestNote.time)}</span>
                    </div>
                    <p className="mt-1.5 text-[11px] leading-5 text-console-ink-2">
                      {latestNote.text}
                    </p>
                  </div>
                )}
              </>
            )}

            {tab === 'orders' && (
              <>
                {session.orders.length === 0 && (
                  <div className="px-5 py-6 text-[11px] leading-5 text-console-muted">
                    没有等待触发的模拟挂单。
                  </div>
                )}
                {session.orders.map((order) => (
                  <div key={order.id} className="border-b border-console-line px-5 py-3">
                    <div className="flex items-center gap-2">
                      <span
                        className={clsx(
                          'text-[11px] font-medium',
                          order.side === 'buy' ? 'text-console-gain' : 'text-console-loss',
                        )}
                      >
                        {order.type === 'limit' ? '限价' : order.type === 'stop' ? '停损' : '市价'}
                        {sideText(order.side)}
                      </span>
                      <span className="font-mono text-[10px] text-console-muted">
                        {fmtVolume(order.volume, stepVolume)} 手
                      </span>
                      <div className="flex-1" />
                      <button
                        onClick={() => cancelOrder(order.id)}
                        className="text-[10px] text-console-muted hover:text-console-loss"
                      >
                        撤单
                      </button>
                    </div>
                    <div className="mt-1.5 flex items-center gap-4 text-[10px] text-console-muted">
                      <span>
                        委托{' '}
                        <b className="font-mono font-normal text-console-ink-2">
                          {fmtPrice(order.price, digits)}
                        </b>
                      </span>
                      <span>SL {fmtPrice(order.sl, digits)}</span>
                      <span>TP {fmtPrice(order.tp, digits)}</span>
                    </div>
                    {order.templateName && (
                      <div className="mt-1 text-[10px] text-console-muted">
                        模板 {order.templateName}
                        {order.steps?.length
                          ? ` · ${order.steps.map(stepSummary).join(' · ')}`
                          : ''}
                      </div>
                    )}
                    <div className="mt-1 text-[10px] text-console-faint">
                      {order.type === 'market'
                        ? '下一根 M1 开盘按对手价成交'
                        : '价格触发后按委托价成交，跳空时按开盘价'}
                    </div>
                  </div>
                ))}
              </>
            )}

            {tab === 'notes' && (
              <div className="flex h-full flex-col">
                <div className="min-h-0 flex-1">
                  {session.notes.length === 0 && (
                    <div className="px-5 py-6 text-[11px] leading-5 text-console-muted">
                      在回放过程中记下判断和情绪，结束后会出现在复盘报告里。
                    </div>
                  )}
                  {[...session.notes].reverse().map((note) => (
                    <div key={note.id} className="border-b border-console-line px-5 py-3">
                      <div className="flex items-center gap-2 text-[10px] text-console-muted">
                        <span className="num font-mono">{fmtShort(note.time)}</span>
                        {note.tag && (
                          <span className="rounded-[4px] bg-console-hover px-1.5 text-[10px]">
                            {note.tag}
                          </span>
                        )}
                        <div className="flex-1" />
                        <button
                          onClick={() => removeNote(note.id)}
                          className="text-console-faint hover:text-console-loss"
                          title="删除笔记"
                        >
                          <X size={12} strokeWidth={1.5} />
                        </button>
                      </div>
                      <p className="mt-1.5 text-[11px] leading-5 text-console-ink-2">{note.text}</p>
                    </div>
                  ))}
                </div>
                <div className="border-t border-console-line p-3">
                  <textarea
                    value={noteText}
                    onChange={(event) => setNoteText(event.target.value)}
                    placeholder="记录这一段的判断…"
                    rows={2}
                    className="console-input h-auto w-full resize-none py-2 text-[11px] leading-5"
                  />
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      value={noteTag}
                      onChange={(event) => setNoteTag(event.target.value)}
                      placeholder="标签"
                      className="console-input h-7 w-24 text-[11px]"
                    />
                    <div className="flex-1" />
                    <button
                      onClick={() => {
                        addNote(noteText, noteTag);
                        setNoteText('');
                      }}
                      disabled={!noteText.trim()}
                      className="console-btn console-btn-primary h-7 px-3 text-[11px] disabled:opacity-40"
                    >
                      添加笔记
                    </button>
                  </div>
                </div>
              </div>
            )}

            {tab === 'stats' && stats && (
              <div className="grid grid-cols-2 gap-px bg-console-line">
                {[
                  ['已平仓净盈亏', fmtSigned(stats.netPnl), pnlClass(stats.netPnl)],
                  ['含浮盈净值变化', fmtSigned(stats.equityPnl), pnlClass(stats.equityPnl)],
                  [
                    '交易 / 胜率',
                    `${stats.trades} / ${
                      stats.winRate == null ? '—' : `${(stats.winRate * 100).toFixed(0)}%`
                    }`,
                    '',
                  ],
                  [
                    '平均 R',
                    stats.avgR == null ? '—' : fmtSigned(stats.avgR),
                    stats.avgR == null ? '' : pnlClass(stats.avgR),
                  ],
                  ['总 R', fmtSigned(stats.totalR), pnlClass(stats.totalR)],
                  ['盈亏比', stats.profitFactor == null ? '—' : stats.profitFactor.toFixed(2), ''],
                  ['最大回撤', `-${session.maxDrawdownPct.toFixed(1)}%`, 'text-console-loss'],
                  ['保证金', fmtMoney(account?.margin ?? 0), ''],
                ].map(([label, value, tone]) => (
                  <div key={label} className="bg-console-card px-4 py-3">
                    <div className="text-[10px] text-console-muted">{label}</div>
                    <div className={clsx('num mt-1 font-mono text-[13px] font-medium', tone)}>
                      {value}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="shrink-0 border-t border-console-line px-5 py-4">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[12px] font-medium">模拟下单</span>
              <span className="text-[10px] text-console-muted">按 {riskPercent}% 风险</span>
            </div>

            <div className="mt-2.5 flex items-center gap-2">
              <select
                value={template.id}
                onChange={(event) => {
                  setActiveTemplate(event.target.value);
                  // 选中模板即视为启用，避免选了模板却仍按手工参数下单
                  if (!templateArmed) setTemplateArmed(true);
                  setSlTouched(false);
                  setTpTouched(false);
                  ticketInited.current = null;
                }}
                className="console-input h-7 min-w-0 flex-1 text-[11px]"
                title="下单模板"
              >
                {templates.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <button
                onClick={toggleTemplate}
                className={clsx(
                  'h-7 shrink-0 rounded-[6px] border px-2 text-[11px] transition-colors',
                  templateArmed
                    ? 'border-console-accent bg-console-accent-soft text-console-accent'
                    : 'border-console-line text-console-muted hover:text-console-ink',
                )}
              >
                {templateArmed ? '已启用' : '启用'}
              </button>
            </div>
            <div className="mt-1 truncate text-[10px] text-console-muted">
              {templateSummary(template)}
            </div>

            <div className="mt-2.5 grid grid-cols-2 gap-0.5 rounded-[8px] bg-console-hover p-0.5">
              {SIDES.map((item) => (
                <button
                  key={item.value}
                  onClick={() => {
                    setSide(item.value);
                    setSlTouched(false);
                    setTpTouched(false);
                    ticketInited.current = null;
                  }}
                  className={clsx(
                    'h-[30px] rounded-[6px] text-[12px] transition-colors',
                    side === item.value
                      ? item.value === 'buy'
                        ? 'bg-console-gain-soft font-medium text-console-gain'
                        : 'bg-console-loss-soft font-medium text-console-loss'
                      : 'text-console-muted hover:text-console-ink',
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="mt-2.5 grid grid-cols-3 gap-0.5 rounded-[8px] bg-console-hover p-0.5">
              {TYPES.map((item) => (
                <button
                  key={item.value}
                  onClick={() => {
                    setType(item.value);
                    setSlTouched(false);
                    setTpTouched(false);
                    if (item.value !== 'market' && info) {
                      setPrice(String(roundPrice(entry, info)));
                    }
                  }}
                  className={clsx(
                    'h-6 rounded-[6px] text-[11px]',
                    type === item.value
                      ? 'bg-console-card text-console-ink shadow-[0_1px_1px_rgba(33,28,22,.06)]'
                      : 'text-console-muted hover:text-console-ink',
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="mt-2 flex items-center justify-between gap-2 text-[10px]">
              <button
                onClick={toggleDraft}
                className={clsx(
                  'inline-flex items-center gap-1 rounded-[6px] px-1.5 py-1 transition-colors',
                  draftActive
                    ? 'bg-console-accent-soft text-console-accent'
                    : 'text-console-muted hover:bg-console-hover hover:text-console-ink',
                )}
              >
                <PenLine size={12} strokeWidth={1.5} />
                {draftActive
                  ? type === 'market'
                    ? '划线中 · 拖动设置止损/止盈'
                    : '划线中 · 点击图表设价'
                  : '画线下单'}
              </button>
              {draftActive && (
                <button
                  onClick={() => setDraftActive(false)}
                  className="text-console-faint hover:text-console-ink"
                >
                  清除划线
                </button>
              )}
            </div>

            <div className="mt-2.5 grid grid-cols-2 gap-2">
              <label className="block">
                <span className="mb-1 block text-[10px] text-console-muted">手数</span>
                <input
                  value={volume}
                  onChange={(event) => setVolume(event.target.value)}
                  inputMode="decimal"
                  className="console-input w-full font-mono text-[11px]"
                />
              </label>
              <div>
                <span className="mb-1 block text-[10px] text-console-muted">风险</span>
                <div className="console-input flex w-full items-center font-mono text-[11px] text-console-ink-2">
                  {riskAmount == null ? '—' : fmtMoney(riskAmount)}
                </div>
              </div>
              <label className="block">
                <span className="mb-1 block text-[10px] text-console-muted">
                  {type === 'market' ? '参考价' : '委托价'}
                </span>
                <input
                  value={type === 'market' ? fmtPrice(entry, digits) : price}
                  onChange={(event) => {
                    const next = event.target.value;
                    setPrice(next);
                    if (slNumber != null) {
                      const target = tpTargetFor(Number(next), slNumber);
                      if (target != null) {
                        setTp(String(target));
                        setTpTouched(true);
                      }
                    }
                  }}
                  disabled={type === 'market'}
                  className="console-input w-full font-mono text-[11px] disabled:text-console-muted"
                />
              </label>
              <div>
                <span className="mb-1 block text-[10px] text-console-muted">保证金</span>
                <div className="console-input flex w-full items-center font-mono text-[11px] text-console-ink-2">
                  ≈ {fmtMoney(margin)}
                </div>
              </div>
              <label className="block">
                <span className="mb-1 block text-[10px] text-console-muted">止损</span>
                <input
                  value={sl}
                  onChange={(event) => {
                    const next = event.target.value;
                    setSl(next);
                    setSlTouched(true);
                    const stop = Number(next);
                    const target = tpTargetFor(entryForDisplay, stop > 0 ? stop : null);
                    if (target != null) {
                      setTp(String(target));
                      setTpTouched(true);
                    }
                  }}
                  className="console-input w-full font-mono text-[11px]"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] text-console-muted">止盈</span>
                <input
                  value={tp}
                  onChange={(event) => {
                    setTp(event.target.value);
                    setTpTouched(true);
                  }}
                  className="console-input w-full font-mono text-[11px]"
                />
              </label>
            </div>
            <div className="mt-2.5 flex items-center justify-between gap-3 text-[10px] text-console-muted">
              <span>
                风险 {riskPct == null ? '—' : `${riskPct.toFixed(2)}%`}
                {rr != null ? ` · R ${rr.toFixed(1)}` : ''}
              </span>
              <span>
                潜在盈利 {rewardAmount == null ? '—' : fmtMoney(rewardAmount)}
              </span>
            </div>
            <button
              onClick={submit}
              disabled={finished || preparing || !bar}
              className="mt-2.5 h-9 w-full rounded-[8px] bg-console-ink text-[12px] font-medium text-console-card transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              模拟{sideText(side)} {fmtVolume(Number(volume) || 0, stepVolume)} 手
            </button>
            <div
              className={clsx(
                'mt-1.5 min-h-[14px] text-[10px]',
                ticketError ? 'text-console-loss' : 'text-console-muted',
              )}
            >
              {ticketError ?? '提交后由下一根 M1 撮合，不会发送到券商'}
            </div>
          </div>
        </aside>
      </div>

      <footer className="flex h-[72px] shrink-0 items-center gap-4 border-t border-console-line bg-console-card px-5">
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={restart}
            className="grid h-8 w-8 place-items-center rounded-[8px] text-console-muted hover:bg-console-hover hover:text-console-ink"
            title="重新开始"
          >
            <RotateCcw size={15} strokeWidth={1.5} />
          </button>
          <button
            onClick={() => step(1)}
            disabled={finished || preparing}
            className="grid h-8 w-8 place-items-center rounded-[8px] text-console-muted hover:bg-console-hover hover:text-console-ink disabled:opacity-40"
            title="单步一根 M1"
          >
            <StepForward size={15} strokeWidth={1.5} />
          </button>
          <button
            onClick={toggle}
            disabled={finished || preparing}
            className="grid h-9 w-9 place-items-center rounded-[10px] bg-console-ink text-console-card transition-opacity hover:opacity-90 disabled:opacity-40"
            title={playing ? '暂停' : '播放'}
          >
            {playing ? (
              <Pause size={16} strokeWidth={1.5} />
            ) : (
              <Play size={16} strokeWidth={1.5} />
            )}
          </button>
          <div className="ml-2 flex items-center gap-0.5 rounded-[8px] bg-console-hover p-0.5">
            {SPEEDS.map((value) => (
              <button
                key={value}
                onClick={() => setSpeed(value)}
                className={clsx(
                  'h-[26px] rounded-[6px] px-2 font-mono text-[10px]',
                  speed === value
                    ? 'bg-console-card text-console-ink shadow-[0_1px_1px_rgba(33,28,22,.06)]'
                    : 'text-console-muted hover:text-console-ink',
                )}
              >
                {value}x
              </button>
            ))}
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="relative h-3 font-mono text-[10px] text-console-muted">
            <span className="absolute left-0 top-0">{fmtDate(session.startTs)}</span>
            <span className="absolute left-1/2 top-0 -translate-x-1/2 whitespace-nowrap">
              {fmtDate((session.startTs + session.endTs) / 2)}
            </span>
            <span className="absolute right-0 top-0">{fmtDate(session.endTs)}</span>
          </div>
          <Tape session={session} height={22} count={96} className="h-[22px] w-full" />
        </div>

        <div className="flex min-w-[104px] shrink-0 flex-col items-end gap-0.5">
          <span className="num font-mono text-[12px] text-console-ink">
            {fmtShort(virtualTime)}
          </span>
          <span className="text-[10px] text-console-muted">
            {Math.round(progress * 100)}% · {played.toLocaleString()} /{' '}
            {session.totalBars.toLocaleString()} 根
          </span>
        </div>

        <label className="flex shrink-0 cursor-pointer items-center gap-2 text-[10px] text-console-muted">
          <button
            onClick={() => setFollow(!follow)}
            className={clsx(
              'relative h-4 w-7 rounded-full transition-colors',
              follow ? 'bg-console-ink' : 'bg-console-line-2',
            )}
            role="switch"
            aria-checked={follow}
            title="跟随游标"
          >
            <span
              className={clsx(
                'absolute top-0.5 h-3 w-3 rounded-full bg-console-card transition-transform',
                follow ? 'translate-x-3.5' : 'translate-x-0.5',
              )}
            />
          </button>
          跟随游标
        </label>
      </footer>
    </div>
  );
}
