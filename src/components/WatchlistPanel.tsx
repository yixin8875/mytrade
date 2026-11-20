import { useEffect, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { PanelLeftClose, Search, X } from 'lucide-react';
import { requestSymbol } from '../chart/tv/registry';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import { fmtPrice, signedClass } from '../lib/format';
import type { WatchlistRow } from '../gateway/types';

type Filter = 'all' | 'position' | 'order';

/** 交易台左侧行情列：和 Exness 一样紧凑成表格，点一行即切换图表品种 */
export function WatchlistPanel() {
  const conn = useApp((s) => s.conn);
  const symbols = useApp((s) => s.symbols);
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const watchlist = useApp((s) => s.watchlist);
  const setWatchlist = useApp((s) => s.setWatchlist);
  const rows = useApp((s) => s.watchRows);
  const setWatchRows = useApp((s) => s.setWatchRows);
  const orders = useApp((s) => s.orders);
  const setWatchColumnOpen = useApp((s) => s.setWatchColumnOpen);
  const [pick, setPick] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const save = (names: string[]) => {
    setWatchlist(names);
    gateway.call('watchlist.set', { symbols: names }).catch(() => {
      /* 网关没连上时先存本地，连上后自动补齐 */
    });
  };

  // 第一次打开：用券商的可见品种补一个默认自选（最多 10 个）
  useEffect(() => {
    if (conn !== 'open' || watchlist.length > 0 || symbols.length === 0) return;
    const names = symbols.filter((item) => item.visible).slice(0, 10).map((item) => item.name);
    if (names.length > 0) save(names);
    // save 每次渲染都是新函数，这里只关心登录后第一次补齐
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, watchlist.length, symbols]);

  // 每 3 秒拉一次报价；组件卸载（切走标签页）就停
  useEffect(() => {
    if (conn !== 'open') {
      setWatchRows([]);
      return;
    }
    let alive = true;
    const load = () => {
      const names = useApp.getState().watchlist;
      if (names.length === 0) {
        setWatchRows([]);
        return;
      }
      gateway
        .call<WatchlistRow[]>('watchlist.get', { symbols: names })
        .then((next) => {
          if (alive) setWatchRows(next);
        })
        .catch(() => {
          /* 单个 tick 取不到不打断轮询 */
        });
    };
    load();
    const timer = window.setInterval(load, 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [conn, watchlist, setWatchRows]);

  const candidates = symbols.filter((item) => !watchlist.includes(item.name)).slice(0, 300);

  const orderSymbols = useMemo(() => new Set(orders.map((item) => item.symbol)), [orders]);
  const rowOf = (name: string) => rows.find((item) => item.symbol === name);

  const visible = watchlist.filter((name) => {
    const row = rowOf(name);
    if (filter === 'position' && !row?.hasPosition) return false;
    if (filter === 'order' && !orderSymbols.has(name)) return false;
    const needle = query.trim().toUpperCase();
    if (!needle) return true;
    const info = symbols.find((item) => item.name === name);
    return (
      name.toUpperCase().includes(needle) ||
      (info?.description.toUpperCase().includes(needle) ?? false)
    );
  });

  return (
    <section className="flex h-full min-h-0 flex-col bg-tv-panel" data-panel="watchlist">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-tv-border px-3">
        <span className="text-[12px] font-semibold text-tv-text">
          行情
          <span className="num ml-1.5 font-mono text-[11px] font-normal text-tv-muted">
            {watchlist.length}
          </span>
        </span>
        <div className="ml-auto flex items-center gap-1">
          <select
            value={pick}
            onChange={(event) => {
              const name = event.target.value;
              setPick('');
              if (name) save([...watchlist, name]);
            }}
            title="添加自选品种"
            aria-label="添加自选品种"
            className="h-6 w-[76px] rounded border border-tv-border bg-tv-raised px-1 text-[11px] text-tv-muted outline-none hover:text-tv-text focus:border-tv-accent"
          >
            <option value="">＋ 添加</option>
            {candidates.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}
              </option>
            ))}
          </select>
          <button
            onClick={() => setWatchColumnOpen(false)}
            title="收起行情列"
            aria-label="收起行情列"
            className="flex h-6 w-6 items-center justify-center rounded text-tv-muted hover:bg-tv-hover hover:text-tv-text"
          >
            <PanelLeftClose size={14} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      <div className="shrink-0 px-2 pt-2">
        <div className="flex h-7 items-center gap-1.5 rounded-md border border-tv-border bg-tv-raised px-2">
          <Search size={13} strokeWidth={1.5} className="shrink-0 text-tv-faint" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索自选"
            aria-label="搜索自选品种"
            className="h-full min-w-0 flex-1 bg-transparent text-[11px] text-tv-text outline-none placeholder:text-tv-faint"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              aria-label="清空搜索"
              className="text-tv-faint hover:text-tv-text"
            >
              <X size={12} strokeWidth={1.5} />
            </button>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
        {(
          [
            ['all', '全部'],
            ['position', '持仓中'],
            ['order', '有挂单'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            aria-pressed={filter === key}
            className={clsx(
              'h-6 rounded px-2 text-[11px] transition-colors',
              filter === key
                ? 'bg-tv-accent-soft text-tv-accent'
                : 'text-tv-muted hover:bg-tv-hover hover:text-tv-text',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_52px_52px_48px] items-center gap-1 border-y border-tv-border bg-tv-raised/60 px-2 py-1 text-[10px] text-tv-faint">
        <span>品种</span>
        <span className="text-right">卖价</span>
        <span className="text-right">买价</span>
        <span className="text-right">涨跌</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {watchlist.length === 0 && (
          <div className="px-3 py-3 text-[11px] text-tv-muted">
            {conn === 'open' ? '还没有自选品种，从上方添加' : '等待网关连接…'}
          </div>
        )}
        {watchlist.length > 0 && visible.length === 0 && (
          <div className="px-3 py-3 text-[11px] text-tv-muted">没有符合条件的品种</div>
        )}
        {visible.map((name) => {
          const row = rowOf(name);
          const active = name === symbol;
          const info = symbols.find((item) => item.name === name);
          return (
            <div
              key={name}
              onClick={() => {
                // 优先切到最近操作的图表；交易台没挂载时退回全局品种
                if (!requestSymbol(name)) setSymbol(name);
              }}
              className={clsx(
                'group relative grid h-9 cursor-pointer grid-cols-[minmax(0,1fr)_52px_52px_48px] items-center gap-1 border-b border-tv-border/50 px-2 text-[11px] transition-colors',
                active ? 'bg-tv-accent-soft' : 'hover:bg-tv-hover',
              )}
            >
              <div className="flex min-w-0 items-center gap-1.5">
                {row?.hasPosition && (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-tv-accent"
                    title="有持仓"
                  />
                )}
                {orderSymbols.has(name) && !row?.hasPosition && (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-tv-warn"
                    title="有挂单"
                  />
                )}
                <div className="min-w-0">
                  <div
                    className={clsx(
                      'truncate font-medium',
                      active ? 'text-tv-text' : 'text-tv-text/90',
                    )}
                  >
                    {name}
                  </div>
                  <div className="truncate text-[10px] leading-tight text-tv-faint">
                    {info?.description ?? row?.description ?? ''}
                  </div>
                </div>
              </div>
              <span className="num text-right font-mono text-tv-down">
                {row ? fmtPrice(row.bid, row.digits) : '—'}
              </span>
              <span className="num text-right font-mono text-tv-up">
                {row ? fmtPrice(row.ask, row.digits) : '—'}
              </span>
              <span
                className={clsx(
                  'num text-right font-mono group-hover:invisible',
                  signedClass(row?.changePct),
                )}
              >
                {row?.changePct != null
                  ? `${row.changePct >= 0 ? '+' : ''}${row.changePct.toFixed(2)}%`
                  : '—'}
              </span>
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  save(watchlist.filter((item) => item !== name));
                }}
                title="从自选里移除"
                aria-label={`从自选移除 ${name}`}
                className="absolute right-1 top-1/2 hidden h-5 w-5 -translate-y-1/2 items-center justify-center rounded bg-tv-panel text-tv-muted hover:text-tv-text group-hover:flex"
              >
                <X size={12} strokeWidth={1.5} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="shrink-0 border-t border-tv-border px-2 py-1.5 text-[10px] leading-tight text-tv-faint">
        点差按「点」计，涨跌幅按 D1 开盘价；蓝点=持仓，琥珀点=挂单。
      </div>
    </section>
  );
}
