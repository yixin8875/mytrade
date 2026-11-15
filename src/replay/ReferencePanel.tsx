import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { Camera, Eye, EyeOff, RotateCcw, X } from 'lucide-react';
import { gateway } from '../gateway/client';
import type { RuleCheck, TradeNoteDetail } from '../gateway/types';
import { isShotMeta, shotY, type ShotMeta } from '../chart/tv/shotMeta';
import { fmtMoney, fmtPrice, fmtSigned, fmtVolume, signedClass } from '../lib/format';
import { usePrivacyMask } from '../lib/privacy';
import { shotUrl } from '../lib/shots';
import { useApp } from '../store/useApp';
import { referenceVisible } from './reference';
import { fmtDateTime } from './time';
import type { ReplayReference, ReplaySession } from './types';

const CLOSED_BY: Record<string, string> = {
  sl: '止损',
  tp: '止盈',
  so: '强平',
  stop_out: '强平',
  manual: '手动',
};

function fmtDuration(sec: number): string {
  const minutes = Math.max(0, Math.round(sec / 60));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

function ruleMark(followed: boolean | null): { text: string; tone: string } {
  if (followed === true) return { text: '遵守', tone: 'text-console-gain' };
  if (followed === false) return { text: '违反', tone: 'text-console-loss' };
  return { text: '未评估', tone: 'text-console-faint' };
}

/** 实盘交易的只读摘要；参照面板与报告共用同一份字段与文案 */
export function ReferenceSummary({
  reference,
  digits,
  className,
}: {
  reference: ReplayReference;
  digits: number;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        'grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px] text-console-muted',
        className,
      )}
    >
      <span>
        方向{' '}
        <b
          className={clsx(
            'font-normal',
            reference.side === 'buy' ? 'text-console-gain' : 'text-console-loss',
          )}
        >
          {reference.side === 'buy' ? '多' : '空'} {fmtVolume(reference.volume)}
        </b>
      </span>
      <span className="text-right">
        盈亏{' '}
        <b className={clsx('font-mono font-normal', signedClass(reference.profit))}>
          {fmtSigned(reference.profit)}
        </b>
        {reference.r != null && (
          <span className={clsx('ml-1 font-mono', signedClass(reference.r))}>
            {fmtSigned(reference.r)}R
          </span>
        )}
      </span>
      <span>
        入场{' '}
        <b className="font-mono font-normal text-console-ink-2">
          {fmtPrice(reference.entry, digits)}
        </b>
      </span>
      <span className="text-right">
        出场{' '}
        <b className="font-mono font-normal text-console-ink-2">
          {fmtPrice(reference.exit, digits)}
        </b>
      </span>
      <span className="col-span-2 font-mono text-console-faint">
        {fmtDateTime(reference.openTs)} → {fmtDateTime(reference.closeTs)}
      </span>
      <span>
        持仓{' '}
        <b className="font-normal text-console-ink-2">
          {fmtDuration(reference.closeTs - reference.openTs)}
        </b>
      </span>
      <span className="text-right">
        平仓{' '}
        <b className="font-normal text-console-ink-2">
          {reference.closedBy ? CLOSED_BY[reference.closedBy] ?? reference.closedBy : '—'}
        </b>
      </span>
      <span>
        MFE{' '}
        <b className="font-mono font-normal text-console-ink-2">{fmtMoney(reference.mfe)}</b>
      </span>
      <span className="text-right">
        MAE{' '}
        <b className="font-mono font-normal text-console-ink-2">{fmtMoney(reference.mae)}</b>
      </span>
      <span>
        止损{' '}
        <b className="font-mono font-normal text-console-ink-2">
          {fmtPrice(reference.sl, digits)}
        </b>
      </span>
      <span className="text-right">
        止盈{' '}
        <b className="font-mono font-normal text-console-ink-2">
          {fmtPrice(reference.tp, digits)}
        </b>
      </span>
      {reference.tag && (
        <span className="col-span-2">
          标签 <b className="font-normal text-console-ink-2">{reference.tag}</b>
        </span>
      )}
    </div>
  );
}

/** 回放右侧的「参照」页签：实盘成交、当时的复盘与截图，全部只读 */
export function ReferencePanel({
  session,
  onRetry,
  onToggleVisible,
}: {
  session: ReplaySession;
  onRetry: () => void;
  onToggleVisible: () => void;
}) {
  const reference = session.reference;
  usePrivacyMask();
  const currentLogin = useApp((s) => s.account?.login ?? null);
  const setPage = useApp((s) => s.setPage);
  const setJournalFocus = useApp((s) => s.setJournalFocus);
  const [note, setNote] = useState<TradeNoteDetail | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [noteLoading, setNoteLoading] = useState(true);
  const positionId = reference?.positionId;

  useEffect(() => {
    if (positionId == null) return;
    let alive = true;
    setNoteLoading(true);
    setNoteError(null);
    gateway
      .call<TradeNoteDetail>('strategy.tradeNote', { positionId })
      .then((detail) => {
        if (alive) setNote(detail);
      })
      .catch((err) => {
        if (alive) setNoteError((err as Error).message);
      })
      .finally(() => {
        if (alive) setNoteLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [positionId]);

  if (!reference) {
    return (
      <div className="px-5 py-6 text-[11px] leading-5 text-console-muted">
        这个会话没有关联实盘交易。
      </div>
    );
  }

  const digits = session.symbolInfo.digits;
  const rules: RuleCheck[] = note?.rules ?? [];
  const reviewed =
    !!note &&
    (note.reviewedAt != null ||
      (note.note ?? '').trim() !== '' ||
      rules.some((item) => item.followed != null));
  const visible = referenceVisible(session);
  const accountMismatch = currentLogin != null && currentLogin !== reference.login;

  return (
    <div className="pb-4">
      {session.dataSource === 'demo' && (
        <div className="mx-5 mt-3 rounded-[8px] bg-console-warn-soft px-3 py-2 text-[10px] leading-4 text-console-warn">
          演示数据 · 不能作为真实行情对照。参照层默认隐藏，需要手动打开。
        </div>
      )}

      <div className="border-b border-console-line px-5 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium">参照交易 · 实盘</span>
          <span className="font-mono text-[10px] text-console-muted">#{reference.positionId}</span>
          <span className="flex-1" />
          <button
            onClick={onToggleVisible}
            className="inline-flex items-center gap-1 text-[10px] text-console-muted hover:text-console-ink"
          >
            {visible ? <EyeOff size={12} strokeWidth={1.5} /> : <Eye size={12} strokeWidth={1.5} />}
            {visible ? '隐藏参照层' : '显示参照层'}
          </button>
        </div>
        {accountMismatch && (
          <div className="mt-1 text-[10px] text-console-faint">
            账户 {reference.login} · 当前终端为 {currentLogin}
          </div>
        )}

        <ReferenceSummary reference={reference} digits={digits} className="mt-2.5" />
      </div>

      {(reference.fills?.length ?? 0) > 0 && (
        <div className="border-b border-console-line px-5 py-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium">逐笔成交</span>
            <span className="text-[10px] text-console-muted">{reference.fills!.length} 笔</span>
          </div>
          <table className="mt-2 w-full text-[10px]">
            <thead>
              <tr className="text-left text-console-faint">
                <th className="pb-1 font-normal">时间</th>
                <th className="pb-1 font-normal">方向</th>
                <th className="pb-1 text-right font-normal">手数</th>
                <th className="pb-1 text-right font-normal">价格</th>
                <th className="pb-1 text-right font-normal">盈亏</th>
              </tr>
            </thead>
            <tbody>
              {reference.fills!.map((fill) => (
                <tr key={fill.ticket} className="border-t border-console-line/60">
                  <td className="py-1 font-mono text-console-muted">{fmtDateTime(fill.time)}</td>
                  <td className="py-1 text-console-ink-2">
                    {fill.entry === 'in' ? '开仓' : '平仓'}
                  </td>
                  <td className="py-1 text-right font-mono text-console-ink-2">
                    {fmtVolume(fill.volume)}
                  </td>
                  <td className="py-1 text-right font-mono text-console-ink-2">
                    {fmtPrice(fill.price, digits)}
                  </td>
                  <td
                    className={clsx(
                      'py-1 text-right font-mono',
                      fill.entry === 'in' ? 'text-console-faint' : signedClass(fill.profit),
                    )}
                  >
                    {fill.entry === 'in' ? '—' : fmtSigned(fill.profit)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1.5 text-[10px] leading-4 text-console-faint">
            来自网关执行记录；图表上的灰色标记只在游标走过之后出现。
          </p>
        </div>
      )}

      <div className="border-b border-console-line px-5 py-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium">当时的判断</span>
          {note?.playbookName && (
            <span className="text-[10px] text-console-muted">{note.playbookName}</span>
          )}
        </div>
        {noteLoading ? (
          <div className="mt-2 text-[10px] text-console-muted">读取复盘…</div>
        ) : noteError ? (
          <div className="mt-2 text-[10px] leading-4 text-console-muted">
            复盘记录不可用：{noteError}
          </div>
        ) : !reviewed ? (
          <div className="mt-2 flex items-center gap-2 text-[10px] text-console-muted">
            这笔还没复盘。
            <button
              onClick={() => {
                if (reference) setJournalFocus(reference.positionId);
                setPage('journal');
              }}
              className="text-console-accent hover:underline"
            >
              去复盘
            </button>
          </div>
        ) : (
          <div className="mt-2 space-y-2">
            <div className="flex items-center gap-2 text-[10px] text-console-muted">
              {note?.rating != null && (
                <span>
                  评分{' '}
                  <b className="font-mono font-normal text-console-ink-2">{note.rating}/5</b>
                </span>
              )}
              {note && note.mistakes.length > 0 && (
                <span className="min-w-0 truncate" title={note.mistakes.join('、')}>
                  错误 <span className="text-console-loss">{note.mistakes.join('、')}</span>
                </span>
              )}
            </div>
            {note?.note && (
              <p className="text-[11px] leading-5 text-console-ink-2">{note.note}</p>
            )}
            {rules.length > 0 && (
              <div className="space-y-1">
                <div className="text-[10px] text-console-muted">当时勾选的规则</div>
                {rules.map((item) => {
                  const mark = ruleMark(item.followed);
                  return (
                    <div key={item.rule} className="flex items-start gap-2 text-[10px] leading-4">
                      <span className={clsx('w-9 shrink-0', mark.tone)}>{mark.text}</span>
                      <span className="min-w-0 text-console-ink-2">{item.rule}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="border-b border-console-line px-5 py-3">
        <div className="text-[11px] font-medium">成交截图</div>
        {reference.hasShot ? (
          <ShotPreview
            login={reference.login}
            positionId={reference.positionId}
            entry={reference.entry}
            exit={reference.exit}
            digits={digits}
            profit={reference.profit}
          />
        ) : (
          <div className="mt-2 text-[10px] text-console-muted">这笔交易没有保存截图。</div>
        )}
      </div>

      <div className="px-5 py-3">
        <button
          onClick={onRetry}
          className="console-btn console-btn-primary flex w-full items-center justify-center gap-1.5"
        >
          <RotateCcw size={13} strokeWidth={1.6} />
          重演这笔
        </button>
        <div className="mt-1.5 text-[10px] leading-4 text-console-muted">
          按实盘方向、手数、止损止盈预填下单票，不会自动发送。
        </div>
      </div>
    </div>
  );
}

function ShotPreview({
  login,
  positionId,
  entry,
  exit,
  digits,
  profit,
}: {
  login: number;
  positionId: number;
  entry: number;
  exit: number;
  digits: number;
  profit: number;
}) {
  const [open, setOpen] = useState(false);
  const [meta, setMeta] = useState<ShotMeta | null>(null);
  const key = { login, position_id: positionId };

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setMeta(null);
    fetch(shotUrl(key, 'json'))
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (alive && isShotMeta(data)) setMeta(data);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, login, positionId]);

  const entryY = meta ? shotY(entry, meta) : null;
  const exitY = meta ? shotY(exit, meta) : null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="mt-2 block w-full overflow-hidden rounded-[8px] border border-console-line"
        title="查看完整截图"
      >
        <img
          src={shotUrl(key)}
          alt={`交易 ${positionId} 的成交截图`}
          className="block h-32 w-full object-cover object-top"
        />
      </button>
      {open && (
        <div
          className="console-scope fixed inset-0 z-[80] flex items-center justify-center bg-black/75 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="relative max-h-[92vh] max-w-[96vw]"
            onClick={(event) => event.stopPropagation()}
          >
            <img
              src={shotUrl(key)}
              alt={`交易 ${positionId} 的成交截图`}
              className="block max-h-[92vh] max-w-[96vw] rounded-lg object-contain"
            />
            {entryY && (
              <ShotLine
                point={entryY}
                color="#1f5fd6"
                label={`入场 ${fmtPrice(entry, meta?.digits ?? digits)}`}
              />
            )}
            {exitY && (
              <ShotLine
                point={exitY}
                color={profit >= 0 ? '#0f7a55' : '#c2413a'}
                label={`出场 ${fmtPrice(exit, meta?.digits ?? digits)}`}
                align="right"
              />
            )}
            <button
              onClick={() => setOpen(false)}
              aria-label="关闭"
              className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-md bg-black/60 text-white/90 hover:bg-black/80"
            >
              <X size={15} strokeWidth={1.6} />
            </button>
            {!meta && (
              <div className="absolute bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-lg bg-black/75 px-3 py-1.5 text-[11px] text-white/90">
                旧截图没有坐标信息，无法在图上定位
              </div>
            )}
            <div className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-md bg-black/60 px-2 py-1 text-[10px] text-white/85">
              <Camera size={12} strokeWidth={1.5} />
              实盘成交截图
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ShotLine({
  point,
  color,
  label,
  align = 'left',
}: {
  point: { y: number; edge: 'above' | 'below' | null };
  color: string;
  label: string;
  align?: 'left' | 'right';
}) {
  const arrow = point.edge === 'above' ? ' ↑' : point.edge === 'below' ? ' ↓' : '';
  return (
    <div
      className="pointer-events-none absolute inset-x-0 flex -translate-y-1/2 items-center gap-1"
      style={{ top: `${point.y * 100}%` }}
    >
      {align === 'left' ? (
        <>
          <span
            className="shrink-0 rounded-r-md px-2 py-0.5 text-[11px] font-medium text-white shadow-sm"
            style={{ backgroundColor: color }}
          >
            {label}
            {arrow}
          </span>
          <span className="h-px flex-1" style={{ backgroundColor: color, opacity: 0.85 }} />
        </>
      ) : (
        <>
          <span className="h-px flex-1" style={{ backgroundColor: color, opacity: 0.85 }} />
          <span
            className="shrink-0 rounded-l-md px-2 py-0.5 text-[11px] font-medium text-white shadow-sm"
            style={{ backgroundColor: color }}
          >
            {label}
            {arrow}
          </span>
        </>
      )}
    </div>
  );
}
