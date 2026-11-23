import { useMemo, useRef, useState } from 'react';
import { Plus, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useApp } from '../store/useApp';
import { fmtPrice } from '../lib/format';
import { Button } from './ui/button';

/**
 * 交易台顶部品种标签：最近看过的品种一直留着，切换不用再开面板。
 * 价格优先取实时报价，其次取自选表快照；只有当前品种有逐笔报价。
 */
export function SymbolTabs() {
  const symbols = useApp((s) => s.symbols);
  const openSymbols = useApp((s) => s.openSymbols);
  const symbol = useApp((s) => s.symbol);
  const quote = useApp((s) => s.quote);
  const watchRows = useApp((s) => s.watchRows);
  const setSymbol = useApp((s) => s.setSymbol);
  const closeOpenSymbol = useApp((s) => s.closeOpenSymbol);
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const tabs = openSymbols.length ? openSymbols : symbol ? [symbol] : [];

  const rowFor = (name: string) => watchRows.find((row) => row.symbol === name);
  const infoFor = (name: string) => symbols.find((item) => item.name === name);

  const priceFor = (name: string): { bid: number | null; digits: number; change: number | null } => {
    const info = infoFor(name);
    const row = rowFor(name);
    if (name === symbol && quote) {
      return { bid: quote.bid, digits: info?.digits ?? 5, change: row?.changePct ?? null };
    }
    return {
      bid: row?.bid ?? null,
      digits: info?.digits ?? row?.digits ?? 5,
      change: row?.changePct ?? null,
    };
  };

  const matches = useMemo(() => {
    const needle = query.trim().toUpperCase();
    if (!needle) return symbols.slice(0, 60);
    return symbols
      .filter(
        (item) =>
          item.name.toUpperCase().includes(needle) ||
          item.description.toUpperCase().includes(needle),
      )
      .slice(0, 60);
  }, [query, symbols]);

  const openMenu = () => {
    setMenuOpen(true);
    setQuery('');
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const choose = (name: string) => {
    setSymbol(name);
    setMenuOpen(false);
  };

  return (
    <div className="relative flex min-w-0 flex-1 items-center gap-1">
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((name) => {
          const active = name === symbol;
          const { bid, digits, change } = priceFor(name);
          return (
            <div
              key={name}
              className={cn(
                'group flex h-8 shrink-0 items-center rounded-md border pr-1 transition-colors',
                active
                  ? 'border-border bg-muted text-foreground'
                  : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              <button
                onClick={() => setSymbol(name)}
                className="flex h-full items-center gap-2 pl-2.5 text-[12px]"
                title={infoFor(name)?.description ?? name}
              >
                <span className={cn('font-medium', active && 'text-foreground')}>{name}</span>
                <span className="num font-mono text-[11px] text-muted-foreground">
                  {fmtPrice(bid, digits)}
                </span>
                {change != null && (
                  <span
                    className={cn(
                      'num font-mono text-[10px]',
                      change > 0
                        ? 'text-success-foreground'
                        : change < 0
                          ? 'text-destructive-foreground'
                          : 'text-muted-foreground/60',
                    )}
                  >
                    {change > 0 ? '+' : ''}
                    {change.toFixed(2)}%
                  </span>
                )}
              </button>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => closeOpenSymbol(name)}
                className={cn(
                  'ml-0.5 h-5 w-5 text-muted-foreground/60 hover:bg-border/60 hover:text-foreground',
                  active ? 'opacity-70' : 'opacity-0 group-hover:opacity-70',
                )}
                aria-label={`关闭 ${name}`}
                title="关闭标签"
              >
                <X size={12} strokeWidth={1.5} className="size-3" />
              </Button>
            </div>
          );
        })}

        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => (menuOpen ? setMenuOpen(false) : openMenu())}
          aria-label="添加品种"
          title="添加品种"
          aria-expanded={menuOpen}
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
        >
          <Plus size={15} strokeWidth={1.5} />
        </Button>
      </div>

      {menuOpen && (
        <>
          <button
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setMenuOpen(false)}
            aria-label="关闭品种列表"
            tabIndex={-1}
          />
          <div className="absolute left-0 top-9 z-50 w-[320px] overflow-hidden rounded-lg border border-border bg-popover shadow-lg/5">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Search size={14} strokeWidth={1.5} className="text-muted-foreground/60" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setMenuOpen(false);
                  if (event.key === 'Enter' && matches[0]) choose(matches[0].name);
                }}
                placeholder="搜索品种 / 名称"
                aria-label="搜索品种"
                className="h-6 flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground/60"
              />
            </div>
            <div className="max-h-72 overflow-y-auto py-1">
              {matches.length === 0 && (
                <div className="px-3 py-4 text-center text-[12px] text-muted-foreground">没有匹配的品种</div>
              )}
              {matches.map((item) => {
                const row = rowFor(item.name);
                const active = item.name === symbol;
                return (
                  <button
                    key={item.name}
                    onClick={() => choose(item.name)}
                    className={cn(
                      'flex w-full items-center gap-3 px-3 py-1.5 text-left text-[12px] hover:bg-accent',
                      active && 'bg-muted',
                    )}
                  >
                    <span className="w-[76px] shrink-0 font-medium text-foreground">{item.name}</span>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                      {item.description}
                    </span>
                    {row?.changePct != null && (
                      <span
                        className={cn(
                          'num shrink-0 font-mono text-[11px]',
                          row.changePct > 0
                            ? 'text-success-foreground'
                            : row.changePct < 0
                              ? 'text-destructive-foreground'
                              : 'text-muted-foreground/60',
                        )}
                      >
                        {row.changePct > 0 ? '+' : ''}
                        {row.changePct.toFixed(2)}%
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
