import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { Camera, ChartCandlestick, Play, X } from 'lucide-react';
import { TradeChart } from './TradeChart';
import { isShotMeta, shotY, type ShotMeta } from '../chart/tv/shotMeta';
import { fmtPrice, fmtSigned, fmtVolume, signedClass } from '../lib/format';
import { shotUrl } from '../lib/shots';
import { useTradeReplay } from '../replay/useTradeReplay';
import type { JournalRecord } from '../gateway/types';
import { Button } from './ui/button';
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from './ui/dialog';
import { Tabs, TabsList, TabsTab } from './ui/tabs';

const CLOSED_BY: Record<string, string> = {
  sl: '止损',
  tp: '止盈',
  so: '强平',
  stop_out: '强平',
  manual: '手动',
};

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
  const replay = useTradeReplay();

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
  const entryLabel = fillCount(record, 'in') > 1 ? '入场均价' : '入场';
  const exitLabel = fillCount(record, 'out') > 1 ? '出场均价' : '出场';

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup className="console-scope h-[min(640px,92vh)] w-[min(1180px,96vw)] max-w-none gap-0 p-0">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2.5">
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              record.side === 'buy' ? 'bg-success' : 'bg-destructive',
            )}
          />
          <DialogTitle className="text-[13px] font-medium">{record.symbol}</DialogTitle>
          <DialogDescription className="sr-only">交易详情</DialogDescription>
          <span
            className={cn(
              'text-[11px]',
              record.side === 'buy' ? 'text-success-foreground' : 'text-destructive-foreground',
            )}
          >
            {record.side === 'buy' ? '多' : '空'}
          </span>
          <span className="num font-mono text-[11px] text-muted-foreground">
            {fmtVolume(record.volume)} 手
          </span>
          <span className={cn('num font-mono text-[12px] font-medium', signedClass(record.profit))}>
            {fmtSigned(record.profit)}
          </span>
          {record.tag && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground/80">
              {record.tag}
            </span>
          )}
          {closedBy && <span className="text-[11px] text-muted-foreground/60">平仓：{closedBy}</span>}
          <span className="flex-1" />

          <Button
            size="sm"
            onClick={() => {
              if (replay.start(record) === 'opened') onClose();
            }}
            title="创建或打开这笔交易的回放会话"
            className="gap-1.5 px-2.5"
          >
            <Play size={13} strokeWidth={1.6} />
            在回放中重演
          </Button>

          <Tabs
            value={tab}
            onValueChange={(next) => {
              if (next === 'chart' || next === 'shot') setTab(next);
            }}
            className="w-auto gap-0"
          >
            <TabsList variant="underline" className="h-8 gap-1">
              <TabsTab value="chart" className="h-7 gap-1.5 px-2 text-[11px]">
                <ChartCandlestick size={13} strokeWidth={1.6} />
                图表
              </TabsTab>
              <TabsTab
                value="shot"
                disabled={!record.has_shot}
                title={record.has_shot ? '成交时保存的图表截图' : '这笔交易没有保存截图'}
                className="h-7 gap-1.5 px-2 text-[11px]"
              >
                <Camera size={13} strokeWidth={1.6} />
                截图
              </TabsTab>
            </TabsList>
          </Tabs>

          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="关闭"
            className="ml-1"
          >
            <X size={15} strokeWidth={1.6} />
          </Button>
        </header>

        <div className="min-h-0 flex-1 p-4">
          {tab === 'chart' ? (
            <TradeChart record={record} />
          ) : (
            <div className="relative flex h-full items-center justify-center">
              <img
                src={shotUrl(record)}
                alt={`交易 ${record.position_id} 的图表截图`}
                className="block max-h-full max-w-full rounded-lg border border-border object-contain"
              />
              {meta && <ShotAnnotations meta={meta} record={record} />}
              {!meta && (
                <div className="absolute bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-lg bg-black/75 px-3 py-1.5 text-[11px] text-white/90">
                  {entryLabel} <span className="num">{fmtPrice(record.entry_price, digits)}</span>
                  <span className="mx-1.5 text-white/40">·</span>
                  {exitLabel} <span className="num">{fmtPrice(record.exit_price, digits)}</span>
                  <span className="ml-2 text-white/60">旧截图没有坐标信息，无法在图上定位</span>
                </div>
              )}
            </div>
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}

/** 在截图上按价格锚点画入场 / 出场水平线；价格在画面外时贴边并加箭头 */
function ShotAnnotations({ meta, record }: { meta: ShotMeta; record: JournalRecord }) {
  const entry = shotY(record.entry_price, meta);
  const exit = shotY(record.exit_price, meta);
  if (!entry || !exit) return null;
  const entryLabel = fillCount(record, 'in') > 1 ? '入场均价' : '入场';
  const exitLabel = fillCount(record, 'out') > 1 ? '出场均价' : '出场';

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-lg">
      <PriceMarker
        y={entry.y}
        edge={entry.edge}
        color="#1f5fd6"
        side="left"
        label={`${entryLabel} ${fmtPrice(record.entry_price, meta.digits)}`}
      />
      <PriceMarker
        y={exit.y}
        edge={exit.edge}
        color={record.profit >= 0 ? '#059669' : '#dc2626'}
        side="right"
        label={`${exitLabel} ${fmtPrice(record.exit_price, meta.digits)}`}
      />
    </div>
  );
}

/** 多笔成交时文案改标“均价”，避免把加权价当成某一次成交价 */
function fillCount(record: JournalRecord, side: 'in' | 'out'): number {
  return record.fills?.filter((fill) => fill.side === side).length ?? 0;
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
      className={cn(
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
