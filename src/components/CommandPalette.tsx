import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { Search } from 'lucide-react';
import { gateway } from '../gateway/client';
import { settingsSnapshot } from '../lib/dataExport';
import { checkForUpdates } from '../lib/updater';
import { goReplayList, goReplaySession } from '../replay/route';
import { useReplay } from '../replay/store';
import { useApp, type Page } from '../store/useApp';
import { SETTINGS_NAV } from './SettingsPanel';
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from './ui/dialog';
import { Kbd } from './ui/kbd';

const PAGE_LABELS: Record<Page, string> = {
  overview: '概览',
  trade: '交易台',
  replay: '历史复盘',
  records: '记录',
  insights: '分析',
  discipline: '纪律',
  journal: '交易日志',
  diary: '盈亏日历',
  strategy: '策略手册',
  routines: '例行清单',
  missed: '错过机会',
  trends: '绩效趋势',
  analysis: '深度分析',
  score: '过程评分',
  reports: '统计报表',
  executions: '执行质量',
  audit: '审计日志',
  settings: '设置',
};

interface Action {
  id: string;
  label: string;
  hint: string;
  keywords?: string;
  run: () => void | Promise<void>;
}

/** Ctrl/Cmd+K 命令面板：页面跳转、主题切换、导出与备份 */
export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const setOpen = useApp((s) => s.setPaletteOpen);
  const setPage = useApp((s) => s.setPage);
  const setTheme = useApp((s) => s.setTheme);
  const openSettings = useApp((s) => s.openSettings);
  const exportDays = useApp((s) => s.exportDays);
  const sessions = useReplay((s) => s.sessions);
  const setCalendarOpen = useApp((s) => s.setCalendarOpen);
  const notify = useApp((s) => s.notify);

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const actions = useMemo<Action[]>(() => {
    const items: Action[] = Object.entries(PAGE_LABELS).map(([page, label]) => ({
      id: `page-${page}`,
      label: `前往${label}`,
      hint: '页面',
      keywords: page,
      run: () => setPage(page as Page),
    }));
    items.push(
      {
        id: 'theme',
        label: '切换主题（浅色 / 白色 / 深色）',
        hint: '外观',
        run: () => {
          const current = useApp.getState().theme;
          setTheme(current === 'light' ? 'white' : current === 'white' ? 'dark' : 'light');
        },
      },
      {
        id: 'calendar',
        label: '打开财经日历',
        hint: '交易台',
        run: () => {
          setPage('trade');
          setCalendarOpen(true);
        },
      },
      {
        id: 'export-journal',
        label: `导出交易日志 CSV（${exportDays === 0 ? '全部' : `${exportDays} 天`}）`,
        hint: '数据',
        keywords: 'export csv',
        run: async () => {
          const out = await gateway.call<{ name: string; rows: number }>(
            'data.export',
            { kind: 'journal', days: exportDays },
            30_000,
          );
          notify('success', `已导出 ${out.name}（${out.rows} 行）`);
        },
      },
      {
        id: 'replay-new',
        label: '新建复盘',
        hint: '回放',
        keywords: 'replay new',
        run: () => {
          goReplayList();
          setPage('replay');
        },
      },
      {
        id: 'replay-resume',
        label: '继续上次复盘',
        hint: '回放',
        keywords: 'replay resume',
        run: () => {
          const latest = [...sessions]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .find((item) => !['finished', 'archived', 'error'].includes(item.status));
          if (latest) goReplaySession(latest.id);
          else goReplayList();
          setPage('replay');
        },
      },
      {
        id: 'backup',
        label: '创建整库备份',
        hint: '数据',
        run: async () => {
          const out = await gateway.call<{ name: string }>(
            'data.backup.create',
            { settings: settingsSnapshot() },
            60_000,
          );
          notify('success', `备份已创建：${out.name}`);
        },
      },
      {
        id: 'update',
        label: '检查更新',
        hint: '版本',
        run: () => checkForUpdates(true),
      },
    );
    for (const section of SETTINGS_NAV) {
      items.push({
        id: `settings-${section.id}`,
        label: `设置：${section.label}`,
        hint: '设置',
        keywords: `settings ${section.id}`,
        run: () => openSettings(section.id),
      });
    }
    return items;
  }, [exportDays, notify, openSettings, sessions, setCalendarOpen, setPage, setTheme]);

  const items = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return actions;
    return actions.filter((action) =>
      `${action.label} ${action.hint} ${action.keywords ?? ''}`.toLowerCase().includes(text),
    );
  }, [actions, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  if (!open) return null;

  const run = (action: Action) => {
    setOpen(false);
    try {
      Promise.resolve(action.run()).catch((error: unknown) =>
        notify('error', (error as Error).message),
      );
    } catch (error) {
      notify('error', (error as Error).message);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) setOpen(false);
      }}
    >
      <DialogPopup
        data-modal
        showCloseButton={false}
        className="mt-[10vh] w-[560px] max-w-full gap-0 self-start overflow-hidden rounded-xl p-0"
      >
        <DialogTitle className="sr-only">命令面板</DialogTitle>
        <DialogDescription className="sr-only">
          搜索并执行页面跳转、数据导出与设置命令
        </DialogDescription>

        <div className="flex h-12 items-center gap-2.5 border-b border-border px-4">
          <Search size={16} strokeWidth={1.5} className="shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setOpen(false);
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                setSelected((index) => Math.min(items.length - 1, index + 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setSelected((index) => Math.max(0, index - 1));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                const action = items[selected];
                if (action) run(action);
              }
            }}
            placeholder="跳转页面、导出数据、打开日历…"
            className="h-full flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground/60"
          />
          <Kbd className="shrink-0">Esc</Kbd>
        </div>

        <div className="max-h-[360px] overflow-auto p-2">
          {items.length === 0 && (
            <div className="px-3 py-8 text-center text-[12px] text-muted-foreground">
              没有匹配的命令
            </div>
          )}
          {items.map((action, index) => (
            <button
              key={action.id}
              onMouseEnter={() => setSelected(index)}
              onClick={() => run(action)}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors',
                index === selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
              )}
            >
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                {action.label}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{action.hint}</span>
            </button>
          ))}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-border px-4 py-2 text-[10.5px] text-muted-foreground/60">
          <span>↑↓ 选择</span>
          <span>Enter 执行</span>
          <span>Ctrl K 开关</span>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
