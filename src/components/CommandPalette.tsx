import { useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { Search } from 'lucide-react';
import { gateway } from '../gateway/client';
import { settingsSnapshot } from '../lib/dataExport';
import { checkForUpdates } from '../lib/updater';
import { useApp, type Page, type SettingsSection } from '../store/useApp';

const PAGE_LABELS: Record<Page, string> = {
  overview: '概览',
  trade: '交易台',
  journal: '交易日志',
  reports: '统计报表',
  executions: '执行质量',
  audit: '审计日志',
  settings: '设置',
};

const SETTINGS: { id: SettingsSection; label: string }[] = [
  { id: 'appearance', label: '外观' },
  { id: 'chart', label: '图表' },
  { id: 'pine', label: 'Pine 脚本' },
  { id: 'template', label: '交易模板' },
  { id: 'risk', label: '交易与风控' },
  { id: 'accounts', label: 'MT5 账户' },
  { id: 'alerts', label: '告警' },
  { id: 'data', label: '数据与备份' },
  { id: 'updates', label: '更新' },
  { id: 'about', label: '数据与连接' },
];

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
  const setSettingsSection = useApp((s) => s.setSettingsSection);
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
        label: '导出交易日志 CSV（30 天）',
        hint: '数据',
        run: async () => {
          const out = await gateway.call<{ name: string; rows: number }>(
            'data.export',
            { kind: 'journal', days: 30 },
            30_000,
          );
          notify('success', `已导出 ${out.name}（${out.rows} 行）`);
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
    for (const section of SETTINGS) {
      items.push({
        id: `settings-${section.id}`,
        label: `设置：${section.label}`,
        hint: '设置',
        keywords: `settings ${section.id}`,
        run: () => {
          setSettingsSection(section.id);
          setPage('settings');
        },
      });
    }
    return items;
  }, [notify, setCalendarOpen, setPage, setSettingsSection, setTheme]);

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
    <div
      data-modal
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/35 px-4 pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div className="w-[560px] max-w-full overflow-hidden rounded-xl border border-console-line bg-console-card shadow-2xl">
        <div className="flex h-12 items-center gap-2.5 border-b border-console-line px-4">
          <Search size={16} strokeWidth={1.5} className="shrink-0 text-console-muted" />
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
            className="h-full flex-1 bg-transparent text-[14px] text-console-ink outline-none placeholder:text-console-faint"
          />
          <kbd className="shrink-0 rounded border border-console-line-2 bg-console-canvas px-1.5 py-0.5 font-mono text-[10px] text-console-muted">
            Esc
          </kbd>
        </div>

        <div className="max-h-[360px] overflow-auto p-2">
          {items.length === 0 && (
            <div className="px-3 py-8 text-center text-[12px] text-console-muted">没有匹配的命令</div>
          )}
          {items.map((action, index) => (
            <button
              key={action.id}
              onMouseEnter={() => setSelected(index)}
              onClick={() => run(action)}
              className={clsx(
                'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors',
                index === selected ? 'bg-console-selected' : 'hover:bg-console-hover',
              )}
            >
              <span className="min-w-0 flex-1 truncate text-[13px] text-console-ink">
                {action.label}
              </span>
              <span className="shrink-0 text-[11px] text-console-muted">{action.hint}</span>
            </button>
          ))}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-console-line px-4 py-2 text-[10.5px] text-console-faint">
          <span>↑↓ 选择</span>
          <span>Enter 执行</span>
          <span>Ctrl K 开关</span>
        </div>
      </div>
    </div>
  );
}
