import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { Camera, ChartCandlestick, X } from 'lucide-react';
import { TradeChart } from './TradeChart';
import { isShotMeta, shotY, type ShotMeta } from '../chart/tv/shotMeta';
import { fmtPrice, fmtSigned, fmtVolume, signedClass } from '../lib/format';
import type { JournalRecord } from '../gateway/types';

const SHOT_BASE = 'http://127.0.0.1:8765/shots';

const CLOSED_BY: Record<string, string> = {
  sl: '止损',
  tp: '止盈',
  so: '强平',
  stop_out: '强平',
  manual: '手动',
};

/** 截图按账户分目录；旧版平铺文件由网关路由自动回退 */
function shotUrl(record: JournalRecord, ext = 'jpg'): string {
  return `${SHOT_BASE}/${record.login || 0}/${record.position_id}.${ext}`;
}

type Tab = 'chart' | 'shot';

/** 单笔交易详情：默认看按行情重绘的 K 线，成交时的截图作为第二页签 */
export function TradeDetailModal({
  record,
  initialTab = 'chart',
  onClose,
}: {
  record: JournalRecord;
  initialTab?: Tab;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [meta, setMeta] = useState<ShotMeta | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 截图旁边的价格锚点；老截图没有旁车文件，按无坐标处理
  useEffect(() => {
    setMeta(null);
    if (!record.has_shot) return;
    let alive = true;
    fetch(shotUrl(record, 'json'))
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (alive && isShotMeta(data)) setMeta(data);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [record]);

  const digits = meta?.digits ?? (Math.abs(record.entry_price) >= 100 ? 2 : 5);
  const closedBy = record.closed_by ? CLOSED_BY[record.closed_by] ?? record.closed_by : null;

  return (
    <div
      className="console-scope fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="flex h-[min(640px,92vh)] w-[min(1180px,96vw)] flex-col overflow-hidden rounded-xl border border-console-line bg-console-canvas shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-console-line px-4 py-2.5">
          <span
            className={clsx(
              'h-1.5 w-1.5 rounded-full',
              record.side === 'buy' ? 'bg-console-gain' : 'bg-console-loss',
            )}
          />
          <span className="text-[13px] font-medium">{record.symbol}</span>
          <span
            className={clsx(
              'text-[11px]',
              record.side === 'buy' ? 'text-console-gain' : 'text-console-loss',
            )}
          >
            {record.side === 'buy' ? '多' : '空'}
          </span>
          <span className="num font-mono text-[11px] text-console-muted">
            {fmtVolume(record.volume)} 手
          </span>
          <span className={clsx('num font-mono text-[12px] font-medium', signedClass(record.profit))}>
            {fmtSigned(record.profit)}
          </span>
          {record.tag && (
            <span className="rounded bg-console-hover px-1.5 py-0.5 text-[10px] text-console-ink-2">
              {record.tag}
            </span>
          )}
          {closedBy && <span className="text-[11px] text-console-faint">平仓：{closedBy}</span>}
          <span className="flex-1" />

          <div className="flex items-center gap-1">
            <button
              onClick={() => setTab('chart')}
              className={clsx('console-chip flex items-center gap-1.5', tab === 'chart' && 'console-chip-active')}
            >
              <ChartCandlestick size={13} strokeWidth={1.6} />
              图表
            </button>
            <button
              onClick={() => setTab('shot')}
              disabled={!record.has_shot}
              title={record.has_shot ? '成交时保存的图表截图' : '这笔交易没有保存截图'}
              className={clsx(
                'console-chip flex items-center gap-1.5',
                tab === 'shot' && 'console-chip-active',
                !record.has_shot && 'cursor-not-allowed opacity-40',
              )}
            >
              <Camera size={13} strokeWidth={1.6} />
              截图
            </button>
          </div>

          <button
            onClick={onClose}
            aria-label="关闭"
            className="ml-1 flex h-7 w-7 items-center justify-center rounded-md text-console-muted transition-colors hover:bg-console-hover hover:text-console-ink"
          >
            <X size={15} strokeWidth={1.6} />
          </button>
        </header>

        <div className="min-h-0 flex-1 p-4">
          {tab === 'chart' ? (
            <TradeChart record={record} />
          ) : (
            <div className="relative flex h-full items-center justify-center">
              <img
                src={shotUrl(record)}
                alt={`交易 ${record.position_id} 的图表截图`}
                className="block max-h-full max-w-full rounded-lg border border-console-line object-contain"
              />
              {meta && <ShotAnnotations meta={meta} record={record} />}
              {!meta && (
                <div className="absolute bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-lg bg-black/75 px-3 py-1.5 text-[11px] text-white/90">
                  入场 <span className="num">{fmtPrice(record.entry_price, digits)}</span>
                  <span className="mx-1.5 text-white/40">·</span>
                  出场 <span className="num">{fmtPrice(record.exit_price, digits)}</span>
                  <span className="ml-2 text-white/60">旧截图没有坐标信息，无法在图上定位</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 在截图上按价格锚点画入场 / 出场水平线；价格在画面外时贴边并加箭头 */
function ShotAnnotations({ meta, record }: { meta: ShotMeta; record: JournalRecord }) {
  const entry = shotY(record.entry_price, meta);
  const exit = shotY(record.exit_price, meta);
  if (!entry || !exit) return null;

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-lg">
      <PriceMarker
        y={entry.y}
        edge={entry.edge}
        color="#1f5fd6"
        side="left"
        label={`入场 ${fmtPrice(record.entry_price, meta.digits)}`}
      />
      <PriceMarker
        y={exit.y}
        edge={exit.edge}
        color={record.profit >= 0 ? '#0f7a55' : '#c2413a'}
        side="right"
        label={`出场 ${fmtPrice(record.exit_price, meta.digits)}`}
      />
    </div>
  );
}

function PriceMarker({
  y,
  edge,
  color,
  side,
  label,
}: {
  y: number;
  edge: 'above' | 'below' | null;
  color: string;
  side: 'left' | 'right';
  label: string;
}) {
  const arrow = edge === 'above' ? ' ↑' : edge === 'below' ? ' ↓' : '';
  const tag = (
    <span
      className={clsx(
        'shrink-0 px-2 py-0.5 text-[11px] font-medium text-white shadow-sm',
        side === 'left' ? 'rounded-r-md' : 'rounded-l-md',
      )}
      style={{ backgroundColor: color }}
      title={edge ? '该价格在截图可视区间之外' : undefined}
    >
      {label}
      {arrow}
    </span>
  );
  const line = <span className="h-px flex-1" style={{ backgroundColor: color, opacity: 0.85 }} />;

  return (
    <div
      className="absolute inset-x-0 flex -translate-y-1/2 items-center gap-1"
      style={{ top: `${y * 100}%` }}
    >
      {side === 'left' ? (
        <>
          {tag}
          {line}
        </>
      ) : (
        <>
          {line}
          {tag}
        </>
      )}
    </div>
  );
}
