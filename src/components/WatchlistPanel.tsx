import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { X } from 'lucide-react';
import { requestSymbol } from '../chart/tv/registry';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import { fmtPrice, signedClass } from '../lib/format';
import type { WatchlistRow } from '../gateway/types';

export function WatchlistPanel() {
  const conn = useApp((s) => s.conn);
  const symbols = useApp((s) => s.symbols);
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const watchlist = useApp((s) => s.watchlist);
  const setWatchlist = useApp((s) => s.setWatchlist);
  const rows = useApp((s) => s.watchRows);
  const setWatchRows = useApp((s) => s.setWatchRows);
  const [pick, setPick] = useState('');

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

  return (
    <section data-panel="watchlist">
      <div className="flex h-10 items-center justify-between px-4">
        <span className="text-[12px] font-semibold text-tv-text">
          自选
          <span className="num ml-1.5 font-mono text-[11px] font-normal text-tv-muted">
            {watchlist.length}
          </span>
        </span>
        <div className="flex items-center gap-1.5">
          <select
            value={pick}
            onChange={(event) => setPick(event.target.value)}
            className="h-7 w-[104px] rounded-lg border border-tv-border bg-tv-raised px-1.5 text-[11px] text-tv-text outline-none focus:border-tv-accent"
          >
            <option value="">添加品种…</option>
            {candidates.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}
              </option>
            ))}
          </select>
          <button
            onClick={() => {
              if (!pick) return;
              save([...watchlist, pick]);
              setPick('');
            }}
            disabled={!pick}
            className={clsx(
              'h-7 rounded-md bg-tv-raised px-2 text-[11px] text-tv-text transition-colors hover:bg-tv-hover',
              !pick && 'cursor-not-allowed opacity-40',
            )}
          >
            添加
          </button>
        </div>
      </div>

      <div className="max-h-[320px] overflow-auto">
        {watchlist.length === 0 && (
          <div className="px-4 pb-4 text-[12px] text-tv-muted">
            {conn === 'open' ? '还没有自选品种，从右上角添加' : '等待网关连接…'}
          </div>
        )}
        {watchlist.map((name) => {
          const row = rows.find((item) => item.symbol === name);
          const active = name === symbol;
          return (
            <div
              key={name}
              onClick={() => {
                // 优先切到最近操作的图表；交易台没挂载时退回全局品种
                if (!requestSymbol(name)) setSymbol(name);
              }}
              className={clsx(
                'group flex cursor-pointer items-center gap-2 border-t border-tv-border/60 px-4 py-2.5 text-[12px] transition-colors',
                active ? 'bg-tv-accent-soft' : 'hover:bg-tv-hover',
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 truncate text-tv-text">
                  {row?.hasPosition && (
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-tv-accent"
                      title="有持仓"
                    />
                  )}
                  <span className="truncate font-medium">{name}</span>
                </div>
                <div className="truncate font-mono text-[11px] text-tv-muted">
                  {row
                    ? `点差 ${row.spreadPoints.toFixed(0)} · Bid ${fmtPrice(row.bid, row.digits)}`
                    : '—'}
                </div>
              </div>
              <span className={clsx('num font-mono text-[11px]', signedClass(row?.changePct))}>
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
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-tv-muted opacity-0 transition-colors hover:bg-tv-raised hover:text-tv-text group-hover:opacity-100"
              >
                <X size={13} strokeWidth={1.5} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="px-4 py-2 text-[11px] text-tv-muted">
        点差单位为「点」，涨跌幅按 D1 开盘价计算；圆点表示该品种有持仓。
      </div>
    </section>
  );
}
