import { useEffect, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import {
  ArchiveRestore,
  Bell,
  Braces,
  Bug,
  ChartCandlestick,
  Check,
  Database,
  Download,
  FileClock,
  FolderOpen,
  Info,
  KeyRound,
  ListChecks,
  Palette,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { gateway } from '../gateway/client';
import { downloadDiagnostics } from '../lib/diagnostics';
import { THEMES, useApp, type SettingsSection, type Theme } from '../store/useApp';
import { fmtNum, templateStepsSummary } from '../lib/template';
import { AccountManager } from './AccountManager';
import { TemplateEditor } from './TemplateEditor';
import { LayoutGallery, SyncToggles } from './LayoutPicker';
import { AuditPanel } from '../views/Audit';
import {
  isDesktopApp,
  restoreBackup,
  revealPath,
  settingsSnapshot,
} from '../lib/dataExport';
import type {
  AiStatus,
  BackupInfo,
  DataPaths,
  DisciplineMode,
  ExportResult,
  GatewayConfig,
  GatewayHealth,
  Playbook,
  RiskLimits,
  TradeMode,
} from '../gateway/types';
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  accentForTheme,
  normalizeHex,
} from '../lib/accent';
import {
  deletePineScript,
  readPineScripts,
  savePineScript,
  type PineScriptRecord,
} from '../lib/pineScripts';
import { checkForUpdates, isUpdateUiAvailable } from '../lib/updater';

const NAV = [
  { id: 'appearance', label: '外观', hint: '主题与界面', icon: Palette, group: '界面' },
  { id: 'chart', label: '图表', hint: '布局与周期', icon: ChartCandlestick, group: '界面' },
  { id: 'template', label: '交易模板', hint: '风险、止盈与分批', icon: Target, group: '交易' },
  { id: 'risk', label: '交易与风控', hint: '手数与风险上限', icon: ShieldCheck, group: '交易' },
  { id: 'discipline', label: '开仓纪律', hint: '下单前的清单门禁', icon: ListChecks, group: '交易' },
  { id: 'accounts', label: 'MT5 账户', hint: '自动登录与切换', icon: Users, group: '账户与通知' },
  { id: 'alerts', label: '告警', hint: '声音与通知', icon: Bell, group: '账户与通知' },
  { id: 'data', label: '数据与备份', hint: '导出、备份与恢复', icon: Database, group: '数据' },
  { id: 'diagnostics', label: '诊断', hint: '审计日志与对账', icon: FileClock, group: '数据' },
  { id: 'pine', label: 'Pine 脚本', hint: '实验：本地执行', icon: Braces, group: '实验与系统' },
  { id: 'ai', label: 'AI 复盘', hint: '自带 Key，默认关闭', icon: Sparkles, group: '实验与系统' },
  { id: 'updates', label: '更新', hint: '版本与检查更新', icon: RefreshCw, group: '实验与系统' },
  { id: 'about', label: '数据与连接', hint: '终端状态与本机路径', icon: Info, group: '实验与系统' },
] as const;

/** 设置分区清单：命令面板直接复用，新增分区不必两处各写一遍 */
export const SETTINGS_NAV = NAV;

const FRAMES: [string, string][] = [
  ['1', '1m'],
  ['5', '5m'],
  ['15', '15m'],
  ['30', '30m'],
  ['60', '1h'],
  ['240', '4h'],
  ['1D', '1D'],
  ['1W', '1W'],
];

type RiskKey =
  | 'max_lot'
  | 'max_risk_pct'
  | 'max_positions'
  | 'daily_loss_pct'
  | 'max_trades_per_day'
  | 'max_consecutive_losses'
  | 'cooldown_minutes'
  | 'max_spread_points';

type RiskForm = Record<RiskKey, number>;

const RISK_FIELDS: {
  key: RiskKey;
  label: string;
  hint: string;
  step: number;
  min: number;
  max: number;
  suffix?: string;
}[] = [
  {
    key: 'max_lot',
    label: '单笔最大手数',
    hint: '自动手数会被截断到这个值，手动超过会被网关拒绝',
    step: 0.01,
    min: 0.01,
    max: 1000,
    suffix: '手',
  },
  {
    key: 'max_risk_pct',
    label: '单笔最大风险',
    hint: '按止损距离计算的本单风险占净值比例',
    step: 0.1,
    min: 0.01,
    max: 100,
    suffix: '%',
  },
  {
    key: 'max_positions',
    label: '最大持仓数',
    hint: '达到后拒绝开新仓',
    step: 1,
    min: 1,
    max: 100,
    suffix: '个',
  },
  {
    key: 'daily_loss_pct',
    label: '当日亏损上限',
    hint: '已实现 + 浮动亏损，0 = 不限制',
    step: 0.1,
    min: 0,
    max: 100,
    suffix: '%',
  },
  {
    key: 'max_trades_per_day',
    label: '当日最多开仓',
    hint: '0 = 不限制',
    step: 1,
    min: 0,
    max: 10_000,
    suffix: '次',
  },
  {
    key: 'max_consecutive_losses',
    label: '连亏冷却次数',
    hint: '连续亏损达到该次数后进入冷却，0 = 不启用',
    step: 1,
    min: 0,
    max: 1_000,
    suffix: '次',
  },
  {
    key: 'cooldown_minutes',
    label: '冷却时长',
    hint: '触发连亏后禁止开仓的分钟数',
    step: 1,
    min: 0,
    max: 10_080,
    suffix: '分钟',
  },
  {
    key: 'max_spread_points',
    label: '最大点差',
    hint: '超过后拒绝下单，0 = 不限制',
    step: 1,
    min: 0,
    max: 1_000_000,
    suffix: '点',
  },
];

function pickRisk(config: RiskLimits): RiskForm {
  return {
    max_lot: config.max_lot,
    max_risk_pct: config.max_risk_pct,
    max_positions: config.max_positions,
    daily_loss_pct: config.daily_loss_pct,
    max_trades_per_day: config.max_trades_per_day,
    max_consecutive_losses: config.max_consecutive_losses,
    cooldown_minutes: config.cooldown_minutes,
    max_spread_points: config.max_spread_points,
  };
}

function validateRisk(form: RiskForm): string | null {
  for (const field of RISK_FIELDS) {
    const value = Number(form[field.key]);
    if (!Number.isFinite(value)) return `${field.label}必须是数字`;
    if (
      field.key === 'max_positions' ||
      field.key === 'max_trades_per_day' ||
      field.key === 'max_consecutive_losses' ||
      field.key === 'cooldown_minutes' ||
      field.key === 'max_spread_points'
    ) {
      if (!Number.isInteger(value)) return `${field.label}必须是整数`;
    }
    if (value < field.min || value > field.max) {
      return `${field.label}必须在 ${field.min} 到 ${field.max} 之间`;
    }
  }
  return null;
}

/** 设置页：控制台中的一个整页，分区导航在页内左侧 */
export function SettingsPanel() {
  const setPage = useApp((s) => s.setPage);
  const section = useApp((s) => s.settingsSection);
  const setSection = useApp((s) => s.setSettingsSection);
  const settingsReturn = useApp((s) => s.settingsReturn);

  const active = NAV.find((item) => item.id === section) ?? NAV[0];

  return (
    <div
      data-page="settings"
      className="console-scope flex h-full min-h-0 bg-console-canvas text-console-ink"
    >
      <aside className="flex w-[208px] shrink-0 flex-col border-r border-console-line bg-console-sidebar px-3 py-5">
        <div className="px-2.5">
          <div className="text-[13px] font-semibold text-console-ink">设置</div>
          <div className="mt-0.5 text-[11px] text-console-muted">Tally · MT5</div>
        </div>

        <nav className="mt-5 space-y-0.5">
          {NAV.map((item, index) => {
            const Icon = item.icon;
            const showGroup = index === 0 || NAV[index - 1].group !== item.group;
            return (
              <div key={item.id}>
                {showGroup && <div className="console-label px-2.5 pb-1.5 pt-3">{item.group}</div>}
                <button
                  onClick={() => setSection(item.id)}
                  className={clsx(
                    'flex h-[34px] w-full items-center gap-2.5 rounded-lg px-2.5 text-left transition-colors',
                    section === item.id
                      ? 'bg-console-selected font-medium text-console-ink'
                      : 'text-console-muted hover:bg-console-hover hover:text-console-ink',
                  )}
                >
                  <Icon size={16} strokeWidth={1.5} className="shrink-0" />
                  <span className="flex-1 truncate text-[13px]">{item.label}</span>
                  {section === item.id && (
                    <span className="h-1.5 w-1.5 rounded-full bg-console-accent" />
                  )}
                </button>
              </div>
            );
          })}
        </nav>

        <div className="mt-auto space-y-2 px-1">
          <div className="rounded-lg border border-console-line bg-console-card px-3 py-2.5 text-[11px] leading-relaxed text-console-muted">
            设置保存在本机，不会上传。
          </div>
          <button
            onClick={() => setPage(settingsReturn ?? 'overview')}
            className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-console-line bg-console-card text-[12px] text-console-ink-2 transition-colors hover:bg-console-hover hover:text-console-ink"
          >
            <X size={14} strokeWidth={1.5} />
            返回
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[820px] px-8 py-8">
          <header className="mb-6">
            <h1 className="text-[24px] font-medium tracking-[-0.01em] text-console-ink">
              {active.label}
            </h1>
            <p className="mt-1.5 text-[13px] text-console-muted">{active.hint}</p>
          </header>

          {section === 'appearance' && <AppearanceSection />}
          {section === 'chart' && <ChartSection />}
          {section === 'pine' && <PineSection />}
          {section === 'template' && <TemplateSection />}
          {section === 'risk' && <RiskSection />}
          {section === 'discipline' && <DisciplineSection />}
          {section === 'accounts' && <AccountManager />}
          {section === 'alerts' && <AlertsSection />}
          {section === 'data' && <DataSection />}
          {section === 'diagnostics' && <AuditPanel />}
          {section === 'ai' && <AiSection />}
          {section === 'updates' && <UpdatesSection />}
          {section === 'about' && <AboutSection />}
        </div>
      </main>
    </div>
  );
}

const EXPORTS = [
  { kind: 'journal', label: '交易日志 CSV', hint: '已平仓交易、初始风险与 R' },
  { kind: 'executions', label: '执行质量 CSV', hint: '点差、滑点、延迟与拒单' },
  { kind: 'audit', label: '审计日志 JSONL', hint: '下单、风控、模板执行事件' },
  { kind: 'settings', label: '设置 JSON', hint: '风控参数、模板与界面偏好' },
  { kind: 'replay', label: '复盘会话 JSON', hint: '回放训练记录、图表与画线' },
] as const;

type ExportKind = (typeof EXPORTS)[number]['kind'];

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtWhen(ts: number): string {
  return new Date(ts * 1000).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function DataSection() {
  const notify = useApp((s) => s.notify);
  const days = useApp((s) => s.exportDays);
  const setDays = useApp((s) => s.setExportDays);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [paths, setPaths] = useState<DataPaths | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const desktop = isDesktopApp();

  const exportDiagnostics = async () => {
    setBusy('diagnostics');
    try {
      await downloadDiagnostics(gateway);
      notify('success', '诊断包已导出');
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '导出诊断失败');
    } finally {
      setBusy(null);
    }
  };

  const refreshBackups = () =>
    gateway
      .call<BackupInfo[]>('data.backup.list')
      .then(setBackups)
      .catch(() => {
        /* 网关不可用时保留旧列表 */
      });

  useEffect(() => {
    let alive = true;
    gateway
      .call<BackupInfo[]>('data.backup.list')
      .then((list) => {
        if (alive) setBackups(list);
      })
      .catch(() => {});
    gateway
      .call<DataPaths>('data.info')
      .then((info) => {
        if (alive) setPaths(info);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const exportData = async (kind: ExportKind) => {
    setBusy(kind);
    try {
      const out = await gateway.call<ExportResult>(
        'data.export',
        {
          kind,
          days,
          settings: kind === 'settings' ? settingsSnapshot() : undefined,
        },
        30_000,
      );
      setResult(out);
      notify('success', `已导出 ${out.name}（${out.rows} 行）`);
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const createBackup = async () => {
    setBusy('backup');
    try {
      const out = await gateway.call<BackupInfo>(
        'data.backup.create',
        { settings: settingsSnapshot() },
        60_000,
      );
      notify('success', `备份已创建：${out.name}（${fmtBytes(out.bytes)}）`);
      await refreshBackups();
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const restore = async (name: string) => {
    if (confirmRestore !== name) {
      setConfirmRestore(name);
      window.setTimeout(() => setConfirmRestore(null), 5000);
      return;
    }
    setConfirmRestore(null);
    setRestoring(true);
    try {
      const message = await restoreBackup(name);
      notify('success', message);
      window.setTimeout(() => window.location.reload(), 2500);
    } catch (error) {
      notify('error', (error as Error).message);
      setRestoring(false);
    }
  };

  const reveal = async (path: string) => {
    try {
      await revealPath(path);
    } catch (error) {
      notify('error', (error as Error).message);
    }
  };

  return (
    <>
      <Card
        title="导出交易数据"
        description="导出到本机数据目录，CSV 带 UTF-8 BOM，Excel 直接打开不乱码。"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-console-muted">区间</span>
          <Segmented
            value={String(days)}
            options={[
              { value: '7', label: '7 天' },
              { value: '30', label: '30 天' },
              { value: '90', label: '90 天' },
              { value: '0', label: '全部' },
            ]}
            onChange={(value) => setDays(Number(value))}
          />
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {EXPORTS.map((item) => (
            <button
              key={item.kind}
              onClick={() => void exportData(item.kind)}
              disabled={busy !== null}
              className="flex items-start gap-2.5 rounded-lg border border-console-line bg-console-card px-3 py-2.5 text-left transition-colors hover:bg-console-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Download size={15} strokeWidth={1.5} className="mt-0.5 shrink-0 text-console-muted" />
              <span className="min-w-0">
                <span className="block text-[12px] font-medium text-console-ink">
                  {busy === item.kind ? '导出中…' : item.label}
                </span>
                <span className="mt-0.5 block text-[11px] text-console-muted">{item.hint}</span>
              </span>
            </button>
          ))}
        </div>

        {result && (
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-console-line bg-console-canvas px-3 py-2 text-[11px] text-console-ink-2">
            <span className="min-w-0 flex-1 truncate font-mono">
              {result.name} · {result.rows} 行 · {fmtBytes(result.bytes)}
            </span>
            {desktop && (
              <button
                onClick={() => void reveal(result.path)}
                className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] text-console-muted transition-colors hover:bg-console-hover hover:text-console-ink"
              >
                <FolderOpen size={13} strokeWidth={1.5} />
                定位文件
              </button>
            )}
          </div>
        )}
      </Card>

      <Card
        title="整库备份"
        description="把交易库、审计日志、截图和设置打包成 zip，存放在本机 backups 目录。"
      >
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => void createBackup()}
            disabled={busy !== null || restoring}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-console-ink px-3 text-[12px] font-medium text-console-card transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ArchiveRestore size={14} strokeWidth={1.5} />
            {busy === 'backup' ? '备份中…' : '创建备份'}
          </button>
          <button
            onClick={() => void exportDiagnostics()}
            disabled={busy !== null || restoring}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-console-line px-3 text-[12px] text-console-ink-2 transition-colors hover:bg-console-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Bug size={14} strokeWidth={1.5} />
            {busy === 'diagnostics' ? '导出中…' : '导出诊断'}
          </button>
          <span className="text-[11px] text-console-muted">
            {backups.length > 0 ? `已有 ${backups.length} 个备份` : '还没有备份'}
          </span>
        </div>

        <div className="mt-4 divide-y divide-console-line/70">
          {backups.length === 0 && (
            <div className="py-6 text-center text-[12px] text-console-muted">
              备份会保存在本机，不含 MT5 登录凭据。
            </div>
          )}
          {backups.map((item) => (
            <div key={item.name} className="flex items-center gap-2 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[11.5px] text-console-ink">
                  {item.name}
                  {item.auto && (
                    <span className="ml-1.5 rounded bg-console-accent-soft px-1.5 py-0.5 font-sans text-[10px] text-console-accent">
                      自动
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-[11px] text-console-muted">
                  {fmtWhen(item.createdAt)} · {fmtBytes(item.bytes)}
                </div>
              </div>
              {desktop && (
                <button
                  onClick={() => void reveal(item.path)}
                  className="h-7 shrink-0 rounded-lg px-2 text-[11px] text-console-muted transition-colors hover:bg-console-hover hover:text-console-ink"
                >
                  定位
                </button>
              )}
              <button
                onClick={() => void restore(item.name)}
                disabled={!desktop || restoring}
                className={clsx(
                  'h-7 shrink-0 rounded-lg border px-2.5 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                  confirmRestore === item.name
                    ? 'border-console-loss bg-console-loss text-white'
                    : 'border-console-line text-console-ink-2 hover:bg-console-hover',
                )}
              >
                {restoring && confirmRestore !== item.name
                  ? '恢复中…'
                  : confirmRestore === item.name
                    ? '确认恢复？'
                    : '恢复'}
              </button>
            </div>
          ))}
        </div>

        <p className="mt-4 text-[11px] leading-relaxed text-console-muted">
          恢复会先停止网关、用备份替换数据库并重启，旧数据保留为 data.old-* 目录。
          {!desktop && ' 恢复和文件定位只能在桌面版使用。'}
        </p>
      </Card>

      <Card
        title="本机数据目录"
        description="所有交易数据只保存在这台电脑上，不会上传。"
        footer={
          desktop && paths ? (
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => void reveal(paths.exports)}
                className="h-8 rounded-lg border border-console-line bg-console-card px-3 text-[12px] text-console-ink-2 transition-colors hover:bg-console-hover hover:text-console-ink"
              >
                打开导出目录
              </button>
              <button
                onClick={() => void reveal(paths.backups)}
                className="h-8 rounded-lg border border-console-line bg-console-card px-3 text-[12px] text-console-ink-2 transition-colors hover:bg-console-hover hover:text-console-ink"
              >
                打开备份目录
              </button>
            </div>
          ) : undefined
        }
      >
        <div className="space-y-1.5 rounded-lg border border-console-line bg-console-canvas px-3 py-2.5 font-mono text-[11px] text-console-ink-2">
          <div className="truncate">{paths?.dir ?? '读取中…'}</div>
          {paths && (
            <>
              <div className="truncate text-console-muted">exports: {paths.exports}</div>
              <div className="truncate text-console-muted">backups: {paths.backups}</div>
            </>
          )}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-console-muted">
          备份不包含 config.json 与 MT5 登录凭据；换机后重新登录账户即可。审计日志是 JSONL，
          每行一个事件，便于外部分析。
        </p>
      </Card>
    </>
  );
}

function Card({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section className="mb-4 rounded-xl border border-console-line bg-console-card p-5">
      <div className="text-[13px] font-semibold text-console-ink">{title}</div>
      {description && (
        <p className="mt-1.5 text-[12px] leading-relaxed text-console-muted">{description}</p>
      )}
      <div className="mt-5">{children}</div>
      {footer && <div className="mt-5 border-t border-console-line pt-4">{footer}</div>}
    </section>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 border-t border-console-line/70 py-3.5 first:border-t-0 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="text-[12px] text-console-ink">{label}</div>
        {hint && <div className="mt-1 text-[11px] leading-relaxed text-console-muted">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex rounded-lg border border-console-line bg-console-canvas p-0.5">
      {options.map((item) => (
        <button
          key={item.value}
          onClick={() => onChange(item.value)}
          className={clsx(
            'h-7 rounded-md px-3 text-[12px] transition-colors',
            value === item.value
              ? 'bg-console-card text-console-ink shadow-[0_1px_2px_rgba(33,28,22,0.06)]'
              : 'text-console-muted hover:text-console-ink',
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative h-[22px] w-10 rounded-full transition-colors duration-150',
        checked ? 'bg-console-ink' : 'bg-console-line-2',
      )}
    >
      <span
        className={clsx(
          'absolute left-0.5 top-0.5 h-[18px] w-[18px] rounded-full bg-console-card shadow-sm transition-transform duration-150',
          checked && 'translate-x-[18px]',
        )}
      />
    </button>
  );
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 text-[12px]',
        ok ? 'text-console-gain' : 'text-console-loss',
      )}
    >
      <span className={clsx('h-1.5 w-1.5 rounded-full', ok ? 'bg-console-gain' : 'bg-console-loss')} />
      {label}
    </span>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-console-line-2 bg-console-card px-1 font-mono text-[11px] text-console-ink-2">
      {children}
    </kbd>
  );
}

const THEME_PREVIEWS: Record<
  Theme,
  { label: string; shell: string; rail: string; bar: string; line: string; faint: string }
> = {
  light: {
    label: '浅色',
    shell: 'border-[#e3e8ee] bg-[#eef1f5]',
    rail: 'bg-[#dde4ec]',
    bar: 'bg-white',
    line: 'bg-[#c9d3df]',
    faint: 'bg-[#d7dde5]',
  },
  white: {
    label: '白色',
    shell: 'border-[#e5e9ee] bg-white',
    rail: 'bg-[#f2f4f6]',
    bar: 'bg-white ring-1 ring-[#e5e9ee]',
    line: 'bg-[#dfe4ea]',
    faint: 'bg-[#eef0f3]',
  },
  dark: {
    label: '深色',
    shell: 'border-[#2a2f38] bg-[#14161b]',
    rail: 'bg-[#1f232a]',
    bar: 'bg-[#22262e]',
    line: 'bg-[#39414d]',
    faint: 'bg-[#2a2f38]',
  },
};

function AppearanceSection() {
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const accentColor = useApp((s) => s.accentColor);
  const setAccentColor = useApp((s) => s.setAccentColor);
  const [hexDraft, setHexDraft] = useState(accentColor);

  useEffect(() => setHexDraft(accentColor), [accentColor]);

  const commitHex = (value: string) => {
    const next = normalizeHex(value);
    if (next) setAccentColor(next);
    else setHexDraft(accentColor);
  };

  return (
    <>
      <Card
        title="主题"
        description="三种底材：浅色冷灰、纯白、深色墨面。字体、间距和语义色一致，只有底材不同；设置保存在本机，重启后保留。"
      >
        <div className="grid grid-cols-3 gap-3">
          {THEMES.map((value) => {
            const preview = THEME_PREVIEWS[value];
            return (
              <button
                key={value}
                onClick={() => setTheme(value)}
                className={clsx(
                  'rounded-xl border p-3 text-left transition-colors',
                  theme === value
                    ? 'border-console-accent ring-1 ring-console-accent'
                    : 'border-console-line hover:border-console-line-2',
                )}
              >
                <div
                  className={clsx(
                    'mb-2.5 flex h-16 gap-1.5 rounded-lg border p-2',
                    preview.shell,
                  )}
                >
                  <div className={clsx('w-6 rounded', preview.rail)} />
                  <div className="flex-1 space-y-1.5">
                    <div className={clsx('h-2.5 rounded', preview.bar)} />
                    <div className="flex gap-1">
                      <div className={clsx('h-1.5 flex-1 rounded', preview.line)} />
                      <div
                        className="h-1.5 w-4 rounded"
                        style={{ backgroundColor: accentForTheme(accentColor, value) }}
                      />
                    </div>
                    <div className={clsx('h-1.5 w-12 rounded', preview.faint)} />
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-medium text-console-ink">{preview.label}</span>
                  {theme === value && (
                    <Check size={13} strokeWidth={1.5} className="text-console-accent" />
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </Card>

      <Card
        title="强调色"
        description="只用于选中、焦点、链接这类强调元素；涨跌的绿红是语义色，不跟着变。深色下会自动提亮，保证在深底上看得清。"
      >
        <div className="flex flex-wrap gap-2">
          {ACCENT_PRESETS.map((preset) => {
            const active = accentColor === preset.value;
            return (
              <button
                key={preset.value}
                onClick={() => setAccentColor(preset.value)}
                className={clsx(
                  'flex h-9 items-center gap-2 rounded-lg border px-2.5 transition-colors',
                  active
                    ? 'border-console-ink bg-console-hover'
                    : 'border-console-line hover:border-console-line-2',
                )}
              >
                <span
                  className="h-4 w-4 rounded-full ring-1 ring-black/10"
                  style={{ backgroundColor: accentForTheme(preset.value, theme) }}
                />
                <span className="text-[12px] text-console-ink-2">{preset.name}</span>
                {active && <Check size={12} strokeWidth={2} className="text-console-ink" />}
              </button>
            );
          })}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-console-line pt-3">
          <label className="flex items-center gap-2 text-[12px] text-console-muted">
            自定义
            <input
              type="color"
              value={accentColor}
              onChange={(event) => setAccentColor(event.target.value)}
              className="h-8 w-10 cursor-pointer rounded border border-console-line bg-console-card p-0.5"
              aria-label="自定义强调色"
            />
          </label>
          <input
            value={hexDraft}
            onChange={(event) => setHexDraft(event.target.value)}
            onBlur={(event) => commitHex(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitHex(event.currentTarget.value);
            }}
            spellCheck={false}
            className="console-input w-28 font-mono uppercase"
            aria-label="强调色十六进制值"
          />
          <button
            onClick={() => setAccentColor(DEFAULT_ACCENT)}
            className="console-btn console-btn-secondary"
          >
            恢复默认
          </button>
        </div>
      </Card>
    </>
  );
}

function ChartSection() {
  const layout = useApp((s) => s.layout);
  const setLayout = useApp((s) => s.setLayout);
  const resolution = useApp((s) => s.resolution);
  const setResolution = useApp((s) => s.setResolution);

  return (
    <>
      <Card
        title="图表布局"
        description="单图到 16 图都可选；多图时可让品种、周期、十字线和可视区间在所有图表间同步。"
      >
        <div className="rounded-lg border border-console-line bg-console-canvas/60 p-3">
          <LayoutGallery value={layout} onChange={setLayout} />
          <div className="mt-3 border-t border-console-line pt-3">
            <div className="mb-2 text-[11px] font-medium text-console-muted">同步到所有图表</div>
            <SyncToggles />
          </div>
        </div>
        <Row label="默认周期" hint="切换后主图立即生效，下次启动沿用。">
          <select
            value={resolution}
            onChange={(event) => setResolution(event.target.value)}
            className="h-8 rounded-lg border border-console-line bg-console-card px-2 text-[12px] text-console-ink outline-none focus:border-console-accent"
          >
            {FRAMES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Row>
      </Card>
    </>
  );
}

/** 设置页：模板列表 + 编辑器；编辑器与下单票弹层共用 */
function TemplateSection() {
  const templates = useApp((s) => s.templates);
  const activeTemplateId = useApp((s) => s.activeTemplateId);
  const setActiveTemplate = useApp((s) => s.setActiveTemplate);
  const addTemplate = useApp((s) => s.addTemplate);
  const createTemplate = useApp((s) => s.createTemplate);
  const deleteTemplate = useApp((s) => s.deleteTemplate);

  const template = templates.find((item) => item.id === activeTemplateId) ?? templates[0];

  return (
    <>
      <Card
        title="模板"
        description="可以有多个模板（如「日内」「波段」），下单票的模板栏可快速切换；点「启用」后风险、止盈与阶段才会带入这一单。"
      >
        <div className="space-y-2">
          {templates.map((item) => (
            <div
              key={item.id}
              className={clsx(
                'flex items-center gap-2 rounded-lg border px-3 py-2 transition-colors',
                item.id === template.id
                  ? 'border-console-accent bg-console-canvas/70'
                  : 'border-console-line',
              )}
            >
              <button
                onClick={() => setActiveTemplate(item.id)}
                className="min-w-0 flex-1 text-left"
              >
                <div className="text-[12px] text-console-ink">{item.name}</div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-console-muted">
                  {fmtNum(item.riskPercent)}% 风险 ·{' '}
                  {item.rewardR > 0 ? `止盈 ${fmtNum(item.rewardR)}R` : '不自动设止盈'} ·{' '}
                  {templateStepsSummary(item)}
                </div>
              </button>
              <button
                onClick={() => deleteTemplate(item.id)}
                disabled={templates.length <= 1}
                title={templates.length <= 1 ? '至少保留一个模板' : '删除模板'}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-console-muted transition-colors hover:bg-console-hover hover:text-console-loss disabled:cursor-not-allowed disabled:opacity-30"
              >
                <Trash2 size={14} strokeWidth={1.5} />
              </button>
            </div>
          ))}
        </div>
        <div className="mt-4 flex gap-2 border-t border-console-line pt-4">
          <button
            onClick={createTemplate}
            className="h-8 rounded-lg border border-console-line bg-console-card px-3 text-[12px] text-console-ink-2 transition-colors hover:bg-console-hover hover:text-console-ink"
          >
            新建空白模板
          </button>
          <button
            onClick={addTemplate}
            className="h-8 rounded-lg border border-console-line bg-console-card px-3 text-[12px] text-console-ink-2 transition-colors hover:bg-console-hover hover:text-console-ink"
          >
            复制当前模板
          </button>
        </div>
      </Card>

      <Card
        title={`编辑「${template.name}」`}
        description="风险按余额百分比算手数；止盈按 R 倍数放置；阶段在浮盈到达对应 R 时依次执行。"
      >
        <TemplateEditor templateId={template.id} />
      </Card>

      <Card title="模板怎么执行" description="点「启用」后带入这一单；成交后的阶段由网关管理。">
        <ul className="space-y-2 text-[12px] leading-relaxed text-console-muted">
          <li>· 风险改为余额百分比，并打开自动手数；设好止损后手数自动算。</li>
          <li>
            · 已有委托价时保留限价/停损，否则准备市价草稿；图纸上拖出止损后，止盈按 R 倍数自动放置。
          </li>
          <li>
            · 挂单同样可以带模板：成交后自动登记阶段计划；撤单或过期则不再登记。
          </li>
          <li>
            · 成交后网关每 0.4 秒检查一次浮盈：到阶段触发价先按比例平仓，再把止损移到开仓价；
            计划持久化，重启后仍然保留；只读或急停期间暂停执行，恢复后继续。
          </li>
          <li>· 参数存在本机 mytrade.templates，不上传；网关风控上限仍会照常拦截超限订单。</li>
        </ul>
      </Card>
    </>
  );
}

type RiskScope = 'account' | 'global';

const SCOPE_OPTIONS: { value: RiskScope; label: string }[] = [
  { value: 'account', label: '当前账户' },
  { value: 'global', label: '全局默认' },
];

const DISCIPLINE_MODES: { value: DisciplineMode; label: string; hint: string }[] = [
  { value: 'off', label: '关闭', hint: '不弹清单，维持现有下单流程' },
  { value: 'confirm', label: '二次确认', hint: '清单未完成时需复核后才能发送' },
  { value: 'block', label: '强制拦截', hint: '未评估直接拒绝；违反需理由' },
];

/** 开仓纪律：把策略清单变成下单前的一次检查 */
function DisciplineSection() {
  const health = useApp((s) => s.health);
  const notify = useApp((s) => s.notify);
  const config = health?.config;
  const [books, setBooks] = useState<Playbook[]>([]);
  const [booksLoading, setBooksLoading] = useState(true);
  const [mode, setMode] = useState<DisciplineMode>('off');
  const [playbook, setPlaybook] = useState('');
  const [requireReason, setRequireReason] = useState(false);
  const [overrideMode, setOverrideMode] = useState<DisciplineMode | ''>('');
  const [saving, setSaving] = useState(false);
  const activeId = health?.activeAccountId ?? '';
  const activeAccount = health?.accounts?.find((item) => item.id === activeId);
  const accountOverride = activeAccount?.discipline?.mode ?? '';

  useEffect(() => {
    let alive = true;
    gateway
      .call<{ playbooks: Playbook[] }>('strategy.list', {})
      .then((res) => {
        if (alive) setBooks(res.playbooks ?? []);
      })
      .catch(() => {
        if (alive) setBooks([]);
      })
      .finally(() => {
        if (alive) setBooksLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 只跟随服务端的三个字段，避免 health 轮询把正在编辑的值冲掉
  useEffect(() => {
    if (!config) return;
    setMode(config.discipline_mode ?? 'off');
    setPlaybook(config.discipline_playbook ?? '');
    setRequireReason(!!config.discipline_require_reason);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    config?.discipline_mode,
    config?.discipline_playbook,
    config?.discipline_require_reason,
  ]);

  // 账户覆盖只跟随当前账户，避免切换账户后把旧账户的值保存到新账户
  useEffect(() => {
    setOverrideMode((accountOverride || '') as DisciplineMode | '');
  }, [activeId, accountOverride]);

  if (!config) {
    return (
      <Card title="开仓纪律门禁" description="连接网关后可以在这里配置下单前的清单。">
        <div className="text-[12px] text-console-muted">等待网关连接…</div>
      </Card>
    );
  }

  const globalDirty =
    mode !== (config.discipline_mode ?? 'off') ||
    playbook !== (config.discipline_playbook ?? '') ||
    requireReason !== !!config.discipline_require_reason;
  const overrideDirty = overrideMode !== accountOverride;
  const dirty = globalDirty || overrideDirty;
  const activeBook = books.find((book) => book.id === playbook);

  const save = async () => {
    setSaving(true);
    try {
      let next: GatewayConfig = config;
      if (globalDirty) {
        next = await gateway.call<GatewayConfig>('system.setConfig', {
          discipline_mode: mode,
          discipline_playbook: playbook,
          discipline_require_reason: requireReason,
        });
      }
      let accounts: NonNullable<GatewayHealth['accounts']> | undefined;
      if (overrideDirty && activeId) {
        const res = await gateway.call<{
          config: GatewayConfig;
          accounts?: NonNullable<GatewayHealth['accounts']>;
        }>('system.setAccountDiscipline', {
          id: activeId,
          // null 表示删掉账户覆盖、恢复跟随全局
          discipline: { mode: overrideMode || null },
        });
        next = res.config;
        accounts = res.accounts;
      }
      const latest = useApp.getState().health;
      if (latest) {
        useApp.getState().setHealth({
          ...latest,
          config: next,
          ...(accounts ? { accounts } : {}),
        });
      }
      notify('success', '开仓纪律门禁已更新，立即生效');
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title="开仓纪律门禁"
      description="只拦新开仓；平仓、改单、保本与移动止损永远不受影响，回放里的模拟下单也不经过这里。"
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="text-[11px] text-console-muted">
            {dirty ? '有未保存的修改' : '当前配置已生效'}
          </div>
          <button
            onClick={() => void save()}
            disabled={!dirty || saving}
            className={clsx(
              'h-8 rounded-lg px-3 text-[12px] font-medium transition-colors',
              dirty && !saving
                ? 'bg-console-ink text-console-canvas hover:opacity-90'
                : 'cursor-not-allowed bg-console-hover text-console-faint',
            )}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      }
    >
      <div className="space-y-5">
        <div>
          <div className="text-[12px] text-console-ink">模式</div>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {DISCIPLINE_MODES.map((item) => (
              <button
                key={item.value}
                onClick={() => setMode(item.value)}
                className={clsx(
                  'rounded-lg border px-3 py-2.5 text-left transition-colors',
                  mode === item.value
                    ? 'border-console-accent/50 bg-console-selected'
                    : 'border-console-line bg-console-card hover:bg-console-hover',
                )}
              >
                <span
                  className={clsx(
                    'block text-[12px] font-medium',
                    mode === item.value ? 'text-console-ink' : 'text-console-ink-2',
                  )}
                >
                  {item.label}
                </span>
                <span className="mt-1 block text-[10px] leading-4 text-console-muted">
                  {item.hint}
                </span>
              </button>
            ))}
          </div>
        </div>

        {activeAccount && (
          <Row
            label={`账户覆盖 · ${activeAccount.label}`}
            hint="只影响当前账户；其他账户继续跟随全局。切换账户后按各自的设置生效。"
          >
            <select
              value={overrideMode}
              onChange={(event) =>
                setOverrideMode(event.target.value as DisciplineMode | '')
              }
              aria-label="当前账户的门禁模式"
              className="h-8 w-[220px] rounded-lg border border-console-line bg-console-card px-2 text-[12px] text-console-ink outline-none focus:border-console-accent"
            >
              <option value="">
                跟随全局（
                {DISCIPLINE_MODES.find((item) => item.value === mode)?.label ?? '关闭'}）
              </option>
              {DISCIPLINE_MODES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </Row>
        )}

        <Row
          label="默认清单"
          hint="下单确认弹窗里可以临时改选；未指定时按「无清单」处理。"
        >
          <select
            value={playbook}
            onChange={(event) => setPlaybook(event.target.value)}
            disabled={booksLoading}
            aria-label="默认开仓清单"
            className="h-8 w-[220px] rounded-lg border border-console-line bg-console-card px-2 text-[12px] text-console-ink outline-none focus:border-console-accent disabled:opacity-50"
          >
            <option value="">不指定</option>
            {books.map((book) => (
              <option key={book.id} value={book.id}>
                {book.name}
              </option>
            ))}
          </select>
        </Row>

        {activeBook && activeBook.rules.length > 0 && (
          <div className="rounded-lg border border-console-line bg-console-canvas px-3 py-2.5">
            <div className="text-[11px] text-console-muted">
              清单规则 · {activeBook.rules.length} 条
            </div>
            <ul className="mt-1 space-y-0.5 text-[11px] leading-5 text-console-ink-2">
              {activeBook.rules.map((rule) => (
                <li key={rule}>· {rule}</li>
              ))}
            </ul>
          </div>
        )}

        {!booksLoading && books.length === 0 && (
          <div className="text-[11px] leading-5 text-console-muted">
            还没有策略清单：先到「策略」页创建规则，再回来选择。
          </div>
        )}

        <Row
          label="强行下单时必须填写理由"
          hint="开启后，存在违反或未评估项时，勾选复核还不够，还要写下这次破例的理由。"
        >
          <Toggle checked={requireReason} onChange={setRequireReason} />
        </Row>
      </div>
    </Card>
  );
}

function RiskSection() {
  const health = useApp((s) => s.health);
  const notify = useApp((s) => s.notify);
  const breakevenOffset = useApp((s) => s.breakevenOffset);
  const setBreakevenOffset = useApp((s) => s.setBreakevenOffset);
  const config = health?.config;
  const limits = health?.limits;
  const overrides = health?.accountRisk ?? {};
  const activeId = health?.activeAccountId ?? '';
  const activeAccount = health?.accounts?.find((item) => item.id === activeId);
  const accountLabel = activeAccount?.label ?? '当前账户';

  const [scope, setScope] = useState<RiskScope>('account');
  const [form, setForm] = useState<RiskForm | null>(null);
  const [cleared, setCleared] = useState<RiskKey[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [liveConfirm, setLiveConfirm] = useState(false);
  const [liveSaving, setLiveSaving] = useState(false);

  const ready = !!config;
  // 只在切换编辑范围或账户时重置表单，避免 health 轮询把正在编辑的值冲掉
  useEffect(() => {
    if (!config) return;
    setForm(pickRisk(scope === 'account' && limits ? limits : config));
    setCleared([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, activeId, ready]);

  if (!config || !form) {
    return (
      <Card title="交易与风控" description="连接网关后可以在这里查看和修改风控参数。">
        <div className="text-[12px] text-console-muted">等待网关连接…</div>
      </Card>
    );
  }

  const base = pickRisk(scope === 'account' && limits ? limits : config);
  const overrideKeys = Object.keys(overrides).filter((key): key is RiskKey =>
    RISK_FIELDS.some((field) => field.key === key),
  );
  const canEditAccount = !!limits;
  const dirty =
    scope === 'account'
      ? canEditAccount &&
        (cleared.length > 0 ||
          RISK_FIELDS.some((field) => Number(form[field.key]) !== Number(base[field.key])))
      : RISK_FIELDS.some((field) => Number(form[field.key]) !== Number(config[field.key]));
  const error = validateRisk(form);
  const changes = RISK_FIELDS.flatMap((field) => {
    if (scope === 'account' && cleared.includes(field.key)) {
      return [`${field.label}：恢复跟随全局（${config[field.key]}${field.suffix ?? ''}）`];
    }
    const before = scope === 'account' ? base[field.key] : config[field.key];
    if (Number(form[field.key]) === Number(before)) return [];
    return [
      `${field.label}：${before}${field.suffix ?? ''} → ${form[field.key]}${field.suffix ?? ''}`,
    ];
  });

  const setValue = (key: RiskKey, value: number) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
    setCleared((prev) => prev.filter((item) => item !== key));
  };

  const useGlobal = (key: RiskKey) => {
    setForm((prev) => (prev ? { ...prev, [key]: config[key] } : prev));
    setCleared((prev) => (prev.includes(key) ? prev : [...prev, key]));
  };

  const resetAllToGlobal = () => {
    setForm(pickRisk(config));
    setCleared(overrideKeys);
  };

  const save = async () => {
    const problem = validateRisk(form);
    if (problem) {
      notify('error', problem);
      return;
    }
    setSaving(true);
    try {
      if (scope === 'account') {
        if (!limits) {
          notify('error', '当前网关版本不支持账户级风控，请更新应用');
          return;
        }
        const patch: Partial<Record<RiskKey, number | null>> = {};
        for (const field of RISK_FIELDS) {
          if (cleared.includes(field.key)) patch[field.key] = null;
          else if (Number(form[field.key]) !== Number(limits[field.key])) {
            patch[field.key] = Number(form[field.key]);
          }
        }
        if (Object.keys(patch).length === 0) {
          setConfirm(false);
          notify('info', '没有需要保存的修改');
          return;
        }
        const res = await gateway.call<{
          config: GatewayConfig;
          limits: RiskLimits;
          accountRisk: Partial<RiskLimits>;
        }>('system.setAccountRisk', { id: activeId, risk: patch });
        const latest = useApp.getState().health;
        if (latest) {
          useApp.getState().setHealth({
            ...latest,
            config: res.config,
            limits: res.limits,
            accountRisk: res.accountRisk,
          });
        }
        setForm(pickRisk(res.limits));
        setCleared([]);
        setConfirm(false);
        notify('success', `「${accountLabel}」的风控参数已更新，立即生效`);
      } else {
        const next = await gateway.call<GatewayConfig>('system.setConfig', { ...form });
        const latest = useApp.getState().health;
        if (latest) useApp.getState().setHealth({ ...latest, config: next });
        setForm(pickRisk(next));
        setCleared([]);
        setConfirm(false);
        notify('success', '全局风控默认值已更新，立即生效');
      }
    } catch (err) {
      notify('error', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const setAllowLive = async (allow: boolean) => {
    setLiveSaving(true);
    try {
      const res = await gateway.call<{ config: GatewayConfig; tradeMode: TradeMode }>(
        'system.setAllowLive',
        { allow },
      );
      const latest = useApp.getState().health;
      if (latest) {
        useApp.getState().setHealth({ ...latest, config: res.config, tradeMode: res.tradeMode });
      }
      notify('success', allow ? '实盘开关已打开，可在顶部切换到实盘交易' : '实盘开关已关闭');
    } catch (err) {
      notify('error', (err as Error).message);
    } finally {
      setLiveSaving(false);
    }
  };

  return (
    <>
      <Card
        title="风控上限"
        description={
          scope === 'account'
            ? `修改只对「${accountLabel}」生效，未单独设置的项跟随全局默认；保存后立即生效。`
            : '修改全局默认值，没有单独覆盖的账户都会跟着变；保存后立即生效。'
        }
        footer={
          <div className="flex items-center justify-between gap-3">
            <div className="text-[11px] text-console-muted">
              {error ? (
                <span className="text-console-loss">{error}</span>
              ) : scope === 'account' && !canEditAccount ? (
                <span className="text-console-loss">当前网关版本不支持账户级风控</span>
              ) : dirty ? (
                '有未保存的修改'
              ) : scope === 'account' && overrideKeys.length > 0 ? (
                `本账户覆盖 ${overrideKeys.length} 项`
              ) : (
                '当前配置已生效'
              )}
            </div>
            <div className="flex items-center gap-2">
              {scope === 'account' && overrideKeys.length > 0 && (
                <button
                  onClick={resetAllToGlobal}
                  className="h-8 rounded-lg px-2.5 text-[12px] text-console-muted transition-colors hover:bg-console-hover hover:text-console-ink"
                >
                  全部跟随全局
                </button>
              )}
              {dirty && (
                <button
                  onClick={() => {
                    setForm(base);
                    setCleared([]);
                  }}
                  className="h-8 rounded-lg px-2.5 text-[12px] text-console-muted transition-colors hover:bg-console-hover hover:text-console-ink"
                >
                  撤销
                </button>
              )}
              <button
                onClick={() => setConfirm(true)}
                disabled={!dirty || !!error || saving || (scope === 'account' && !canEditAccount)}
                className={clsx(
                  'flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12px] font-medium transition-colors',
                  dirty && !error && (scope !== 'account' || canEditAccount)
                    ? 'bg-console-ink text-console-card hover:opacity-90'
                    : 'cursor-not-allowed bg-console-hover text-console-faint',
                )}
              >
                <Save size={14} strokeWidth={1.5} />
                保存风控
              </button>
            </div>
          </div>
        }
      >
        <Row
          label="编辑范围"
          hint={
            scope === 'account'
              ? '账户覆盖优先于全局默认；可以逐项恢复跟随全局'
              : '全局默认值；账户自己的覆盖仍会盖在它上面'
          }
        >
          <Segmented value={scope} options={SCOPE_OPTIONS} onChange={setScope} />
        </Row>

        {RISK_FIELDS.map((field) => (
          <Row key={field.key} label={field.label} hint={field.hint}>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={field.min}
                max={field.max}
                step={field.step}
                value={form[field.key]}
                disabled={scope === 'account' && !canEditAccount}
                onChange={(event) => setValue(field.key, Number(event.target.value))}
                className="h-8 w-24 rounded-lg border border-console-line bg-console-canvas px-2 text-right font-mono text-[12px] text-console-ink outline-none focus:border-console-accent disabled:opacity-50"
              />
              {field.suffix && <span className="text-[11px] text-console-muted">{field.suffix}</span>}
              {scope === 'account' &&
                canEditAccount &&
                (overrideKeys.includes(field.key) && !cleared.includes(field.key) ? (
                  <button
                    onClick={() => useGlobal(field.key)}
                    title={`恢复跟随全局：${config[field.key]}${field.suffix ?? ''}`}
                    className="h-8 rounded-lg px-2 text-[11px] text-console-muted transition-colors hover:bg-console-hover hover:text-console-ink"
                  >
                    用全局
                  </button>
                ) : (
                  <span className="text-[11px] text-console-faint">
                    {cleared.includes(field.key) ? '恢复全局' : '跟随全局'}
                  </span>
                ))}
            </div>
          </Row>
        ))}

        <div className="mt-4 flex items-start gap-2 rounded-lg border border-console-warn/30 bg-console-warn-soft px-3 py-2.5 text-[11px] leading-relaxed text-console-ink-2">
          <Info size={14} strokeWidth={1.5} className="mt-0.5 shrink-0 text-console-warn" />
          <span>
            当前生效：单笔上限 {base.max_lot} 手、单笔风险 {base.max_risk_pct}%。这些是 Tally
            的风控值，不是券商限制；自动手数会被截到上限，手动超过会被网关拒绝。
          </span>
        </div>
      </Card>

      <Card
        title="保本偏移"
        description="点差已经包含在开仓价里；这里只按点数补偿手续费、隔夜利息和止损滑点，让保本出场时账户不亏。"
      >
        <Row
          label="偏移点数"
          hint="0 = 只在开仓价保本。按成本折算：每点价值 × 点数 ≈ 往返手续费 + 负隔夜利息 + 预估滑点。"
        >
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={0}
              max={500}
              step={1}
              value={breakevenOffset}
              onChange={(event) => setBreakevenOffset(Number(event.target.value))}
              className="h-8 w-24 rounded-lg border border-console-line bg-console-canvas px-2 text-right font-mono text-[12px] text-console-ink outline-none focus:border-console-accent"
            />
            <span className="text-[11px] text-console-muted">点</span>
          </div>
        </Row>
        <Row
          label="适用范围"
          hint="「保本」「平一半」立即使用；分批档位的「移保本」在添加档位时记录，之后新增的档位使用新值。"
        >
          <span className="text-[12px] text-console-muted">多单加在开仓价上方，空单减在下方</span>
        </Row>
      </Card>

      <Card
        title="运行模式"
        description="交易模式由顶部按钮切换；实盘开关打开后，实盘/美分账户才能从只读切到实盘交易。"
      >
        <Row label="当前模式">
          <span className="text-[12px] text-console-ink">
            {health?.tradeMode === 'readonly'
              ? '只读'
              : health?.tradeMode === 'demo'
                ? '模拟可交易'
                : '实盘交易'}
          </span>
        </Row>
        <Row label="实盘开关" hint="只影响实盘账户，模拟账户仍走「模拟可交易」；打开后下单使用真实资金。">
          <div className="flex items-center gap-2">
            <span
              className={clsx(
                'text-[12px]',
                config.allow_live ? 'text-console-loss' : 'text-console-muted',
              )}
            >
              {config.allow_live ? '已允许' : '关闭'}
            </span>
            <button
              onClick={() => (config.allow_live ? void setAllowLive(false) : setLiveConfirm(true))}
              disabled={liveSaving}
              className={clsx(
                'h-8 rounded-lg border px-3 text-[12px] font-medium transition-colors',
                config.allow_live
                  ? 'border-console-line bg-console-card text-console-ink-2 hover:bg-console-hover'
                  : 'border-console-loss/35 text-console-loss hover:bg-console-loss-soft',
                liveSaving && 'cursor-wait opacity-50',
              )}
            >
              {liveSaving ? '保存中…' : config.allow_live ? '关闭实盘' : '开启实盘'}
            </button>
          </div>
        </Row>
        <Row label="告警通道">
          <span className="text-[12px] text-console-muted">
            {config.alert_channel_names?.length
              ? config.alert_channel_names.join('、')
              : '未配置第三方通道'}
          </span>
        </Row>
      </Card>

      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="w-[420px] max-w-full rounded-xl border border-console-line bg-console-card p-5 shadow-[0_24px_60px_-12px_rgba(33,28,22,0.28)]">
            <div className="text-[14px] font-medium text-console-ink">
              {scope === 'account' ? `确认修改「${accountLabel}」的风控？` : '确认修改全局风控默认值？'}
            </div>
            <div className="mt-1.5 text-[12px] leading-relaxed text-console-muted">
              {scope === 'account'
                ? '保存后只对当前账户立即生效；标为「恢复跟随全局」的项会删除账户覆盖。'
                : '保存后立即生效，所有未单独覆盖的账户都会使用新的默认值。'}
            </div>
            <div className="mt-4 max-h-40 space-y-1.5 overflow-auto rounded-lg border border-console-line bg-console-canvas p-3 text-[11px] leading-relaxed text-console-ink-2">
              {changes.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setConfirm(false)}
                className="h-8 rounded-lg border border-console-line bg-console-card px-3 text-[12px] text-console-ink-2 transition-colors hover:bg-console-hover"
              >
                取消
              </button>
              <button
                onClick={() => void save()}
                disabled={saving}
                className="h-8 rounded-lg bg-console-ink px-3 text-[12px] font-medium text-console-card transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-50"
              >
                {saving ? '保存中…' : '确认保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {liveConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="w-[420px] max-w-full rounded-xl border border-console-line bg-console-card p-5 shadow-[0_24px_60px_-12px_rgba(33,28,22,0.28)]">
            <div className="text-[14px] font-medium text-console-ink">打开实盘交易开关？</div>
            <div className="mt-1.5 text-[12px] leading-relaxed text-console-muted">
              打开后，顶部可以把实盘（含美分）账户从「只读」切到「实盘交易」，下单将使用真实资金。
              风控上限、日亏限制和急停仍然生效。
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setLiveConfirm(false)}
                className="h-8 rounded-lg border border-console-line bg-console-card px-3 text-[12px] text-console-ink-2 transition-colors hover:bg-console-hover"
              >
                取消
              </button>
              <button
                onClick={() => {
                  setLiveConfirm(false);
                  void setAllowLive(true);
                }}
                className="h-8 rounded-lg bg-console-loss px-3 text-[12px] font-medium text-console-card transition-opacity hover:opacity-90"
              >
                确认打开
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function AlertsSection() {
  const sound = useApp((s) => s.alertSound);
  const desktop = useApp((s) => s.alertDesktop);
  const setAlertPrefs = useApp((s) => s.setAlertPrefs);
  const config = useApp((s) => s.health?.config);

  return (
    <>
      <Card title="提醒方式" description="告警触发时在本机播放声音或弹桌面通知。">
        <Row label="声音提示">
          <Toggle checked={sound} onChange={(value) => setAlertPrefs({ alertSound: value })} />
        </Row>
        <Row label="桌面通知">
          <Toggle
            checked={desktop}
            onChange={(value) => setAlertPrefs({ alertDesktop: value })}
          />
        </Row>
      </Card>
    </>
  );
}

function AiSection() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [provider, setProvider] = useState('anthropic');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = (next: AiStatus) => {
    setStatus(next);
    setProvider(next.provider);
    setModel(next.model);
    setBaseUrl(next.baseUrl);
    setEnabled(next.enabled);
  };

  useEffect(() => {
    let alive = true;
    gateway
      .call<AiStatus>('ai.status')
      .then((next) => {
        if (alive) apply(next);
      })
      .catch((err) => {
        if (alive) setError(`读取失败：${(err as Error).message}`);
      });
    return () => {
      alive = false;
    };
  }, []);

  const save = async (extra: Record<string, unknown> = {}) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const next = await gateway.call<AiStatus>('ai.settings.save', {
        provider,
        model,
        baseUrl,
        enabled,
        ...extra,
      });
      apply(next);
      setApiKey('');
      setMessage('已保存');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const changeProvider = (id: string) => {
    setProvider(id);
    const found = status?.providers.find((item) => item.id === id);
    setModel(found?.defaultModel ?? '');
    setBaseUrl('');
  };

  const inputClass =
    'h-8 w-full rounded-lg border border-console-line bg-console-canvas px-2 text-[12px] text-console-ink outline-none focus:border-console-accent';

  return (
    <>
      <Card
        title="AI 复盘（可选）"
        description="用你自己的 Key 生成日/周复盘。默认关闭，关闭或没有 Key 时功能完全不可见；只发送聚合统计和你在面板里勾选的笔记，不含账户号、服务器、密码、截图。"
      >
        <Row label="启用" hint="关闭时交易数据完全不出本机">
          <Toggle checked={enabled} onChange={setEnabled} />
        </Row>
        <Row label="模型提供方">
          <Segmented
            value={provider}
            options={(status?.providers ?? [{ id: 'anthropic', label: 'Anthropic（Claude）' }]).map(
              (item) => ({ value: item.id, label: item.label }),
            )}
            onChange={changeProvider}
          />
        </Row>
        <Row label="模型" hint="换成你账号可用的模型名，例如 claude-sonnet-5-5">
          <input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            spellCheck={false}
            className={clsx(inputClass, 'w-56 font-mono')}
            aria-label="模型名"
          />
        </Row>
        <Row
          label="Base URL"
          hint={
            provider === 'compatible'
              ? 'OpenAI 兼容服务必填，例如 https://your-host/v1'
              : '留空使用官方地址；只有走代理时才需要改'
          }
        >
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            spellCheck={false}
            placeholder={provider === 'compatible' ? 'https://…/v1' : '默认'}
            className={clsx(inputClass, 'w-56 font-mono')}
            aria-label="Base URL"
          />
        </Row>
        <Row
          label="API Key"
          hint={
            status?.hasKey
              ? '已保存。留空表示不修改；Key 用 Windows DPAPI 加密，只有本机当前用户能解密，前端永远拿不到明文。'
              : '还没有保存。Key 用 Windows DPAPI 加密，只有本机当前用户能解密。'
          }
        >
          <div className="flex items-center gap-1.5">
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={status?.hasKey ? '已保存' : '粘贴 Key'}
              spellCheck={false}
              autoComplete="off"
              className={clsx(inputClass, 'w-56 font-mono')}
              aria-label="API Key"
            />
            <button
              onClick={() => void save(apiKey ? { apiKey } : {})}
              disabled={busy}
              className="console-btn console-btn-secondary h-8"
            >
              <KeyRound size={14} strokeWidth={1.5} />
              保存 Key
            </button>
          </div>
        </Row>
      </Card>

      <Card
        title="保存"
        description="切换提供方或模型后需要保存；勾选启用前必须先保存 Key。"
      >
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => void save()}
            disabled={busy}
            className="console-btn console-btn-primary"
          >
            <Save size={14} strokeWidth={1.5} />
            {busy ? '保存中…' : '保存设置'}
          </button>
          {status?.hasKey && (
            <button
              onClick={() => void save({ apiKey: '', enabled: false })}
              disabled={busy}
              className="console-btn console-btn-secondary"
            >
              <Trash2 size={14} strokeWidth={1.5} />
              清除 Key
            </button>
          )}
          {message && <span className="text-[11px] text-console-gain">{message}</span>}
        </div>
        {error && <div className="mt-3 text-[11px] text-console-warn">{error}</div>}
        <div className="mt-4 space-y-1 text-[11px] leading-relaxed text-console-faint">
          <div>· 每次生成前可以在复盘面板展开「将发送哪些字段」预览。</div>
          <div>· 笔记默认不发，必须勾选才会带上，并截断到 500 字/条。</div>
          <div>· 输出只作建议，不写回交易数据，也不影响下单。</div>
        </div>
      </Card>
    </>
  );
}

function UpdatesSection() {
  const health = useApp((s) => s.health);
  const available = isUpdateUiAvailable();

  return (
    <>
      <Card title="版本" description="桌面版通过 GitHub Releases 检查更新。">
        <Row label="网关版本">
          <span className="font-mono text-[12px] text-console-ink-2">v{health?.version ?? '—'}</span>
        </Row>
        <Row label="手动检查">
          <button
            onClick={() => void checkForUpdates(true)}
            disabled={!available}
            className={clsx(
              'flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12px] transition-colors',
              available
                ? 'border-console-line bg-console-card text-console-ink-2 hover:bg-console-hover'
                : 'cursor-not-allowed border-console-line bg-console-canvas text-console-faint',
            )}
          >
            <RefreshCw size={14} strokeWidth={1.5} />
            检查更新
          </button>
        </Row>
      </Card>

      {!available && (
        <Card
          title="开发模式"
          description="当前在浏览器里运行，更新功能只在 Tauri 桌面版可用。"
        >
          <div className="text-[12px] text-console-muted">打包后的桌面版会自动显示更新提示。</div>
        </Card>
      )}
    </>
  );
}

function AboutSection() {
  const health = useApp((s) => s.health);
  const account = health?.account;
  const terminal = health?.terminal;

  return (
    <>
      <Card title="连接" description="显示当前终端与账户连接状态，切换账户在顶部账户菜单。">
        <Row label="网关">
          <StatusPill ok={!!health?.connected} label={health?.connected ? '已连接' : '未连接'} />
        </Row>
        <Row label="终端">
          <span className="text-[12px] text-console-muted">
            {terminal ? `${terminal.company} · ${terminal.name} (build ${terminal.build})` : '未连接'}
          </span>
        </Row>
        <Row label="账户类型">
          <span className="text-[12px] text-console-ink">
            {account?.accountType === 'real'
              ? '实盘'
              : account?.accountType === 'demo'
                ? '模拟'
                : '—'}
          </span>
        </Row>
        <Row label="交易模式">
          <span className="text-[12px] text-console-ink">
            {health?.tradeMode === 'readonly'
              ? '只读'
              : health?.tradeMode === 'demo'
                ? '模拟可交易'
                : '实盘交易'}
          </span>
        </Row>
      </Card>

      <Card title="本机数据" description="以下内容只保存在本机，不会上传。">
        <Row label="交易日志与截图">
          <span className="font-mono text-[11px] text-console-muted">gateway/data（截图按账户号分目录）</span>
        </Row>
        <Row label="账户凭据">
          <span className="font-mono text-[11px] text-console-muted">
            gateway/data/credentials.json（DPAPI）
          </span>
        </Row>
        <Row label="审计日志">
          <span className="font-mono text-[11px] text-console-muted">gateway/audit</span>
        </Row>
        <Row label="风控配置">
          <span className="font-mono text-[11px] text-console-muted">gateway/config.json</span>
        </Row>
      </Card>

      <Card title="快捷键">
        <div className="grid grid-cols-[64px_1fr] gap-x-3 gap-y-2.5 text-[12px]">
          <Kbd>B</Kbd>
          <span className="text-console-muted">建立买入市价草稿</span>
          <Kbd>S</Kbd>
          <span className="text-console-muted">建立卖出市价草稿</span>
          <Kbd>Esc</Kbd>
          <span className="text-console-muted">关闭弹窗 / 清除划线草稿</span>
          <Kbd>Ctrl K</Kbd>
          <span className="text-console-muted">打开命令面板</span>
          <Kbd>Ctrl \</Kbd>
          <span className="text-console-muted">折叠 / 展开交易台左侧行情列</span>
          <Kbd>Ctrl J</Kbd>
          <span className="text-console-muted">折叠 / 展开交易台底部订单托盘</span>
          <Kbd>Shift</Kbd>
          <span className="text-console-muted">拖动价格时吸附整数点位</span>
        </div>
      </Card>
    </>
  );
}

/**
 * Pine 脚本（实验）。
 *
 * 粘贴 TradingView 的原生 indicator 源码，保存后由 Piner（失败时回退 PineTS）在本地执行。
 * 指标元信息只在图表创建时生成，所以保存/删除脚本后要刷新一次图表。
 */
function PineSection() {
  const notify = useApp((s) => s.notify);
  const [scripts, setScripts] = useState<PineScriptRecord[]>(() => readPineScripts());
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const refresh = () => setScripts(readPineScripts());
    window.addEventListener('mytrade:pine-scripts', refresh);
    return () => window.removeEventListener('mytrade:pine-scripts', refresh);
  }, []);

  const save = async () => {
    if (busy || !source.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const record = await savePineScript(source);
      setSource('');
      setMessage({
        ok: true,
        text: `已保存「${record.title}」，${
          record.plots.length > 0
            ? `${record.plots.length} 条曲线`
            : '仅绘图对象（box/label/table）'
        }。刷新图表后，在图表指标里搜索该名称添加。${
          record.warning ? `（${record.warning}）` : ''
        }`,
      });
      notify('success', `Pine 脚本「${record.title}」已保存`);
    } catch (error) {
      setMessage({ ok: false, text: (error as Error)?.message || '保存失败' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card
        title="Pine 脚本（实验）"
        description="在本地运行原生 Pine v5/v6 indicator 脚本，行情只来自当前 MT5 网关。"
      >
        <div className="space-y-2 text-[12px] leading-relaxed text-console-muted">
          <p>
            支持 plot / hline 折线、ta.*、input.* 和常用逻辑；暂不支持 plotshape、bgcolor、
            绘图对象（box/line/label）、strategy 和外部数据源，计算结果也不保证与
            TradingView 完全一致。
          </p>
          <p>保存或删除脚本后需要刷新图表：指标元信息只在图表创建时生成。</p>
        </div>
        <textarea
          value={source}
          onChange={(event) => setSource(event.target.value)}
          spellCheck={false}
          placeholder={'//@version=6\nindicator("EMA 示例", overlay=true)\nlen = input.int(20, "长度")\nplot(ta.ema(close, len), "EMA", color=color.orange)'}
          className="mt-4 h-56 w-full resize-y rounded-lg border border-console-line bg-console-canvas p-3 font-mono text-[12px] leading-relaxed text-console-ink outline-none placeholder:text-console-faint focus:border-console-accent"
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={() => void save()}
            disabled={busy || !source.trim()}
            className="h-8 rounded-lg bg-console-ink px-3 text-[12px] font-medium text-console-card transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {busy ? '解析中…' : '保存脚本'}
          </button>
          <button
            onClick={() => setSource('')}
            className="h-8 rounded-lg px-2.5 text-[12px] text-console-muted transition-colors hover:bg-console-hover hover:text-console-ink"
          >
            清空
          </button>
          <button
            onClick={() => window.location.reload()}
            className="ml-auto flex h-8 items-center gap-1.5 rounded-lg border border-console-line bg-console-card px-3 text-[12px] text-console-ink-2 transition-colors hover:bg-console-hover"
          >
            <RefreshCw size={14} strokeWidth={1.5} />
            刷新图表
          </button>
        </div>
        {message && (
          <div
            className={clsx(
              'mt-3 rounded-lg px-3 py-2 text-[11px] leading-relaxed',
              message.ok
                ? 'bg-console-gain-soft text-console-gain'
                : 'bg-console-loss-soft text-console-loss',
            )}
          >
            {message.text}
          </div>
        )}
        <p className="mt-4 text-[11px] leading-relaxed text-console-faint">
          Piner / PineTS 是独立的第三方运行时（AGPL-3.0 / 商业授权），与 TradingView 无关联；
          对外分发此功能前需要确认授权方式。
        </p>
      </Card>

      <Card
        title="已保存的脚本"
        description="在图表「指标」窗口搜索脚本名称即可添加；删除后已添加的指标会失效。"
      >
        {scripts.length === 0 ? (
          <p className="text-[12px] text-console-muted">还没有保存的脚本。</p>
        ) : (
          <div className="divide-y divide-console-line/70">
            {scripts.map((script) => (
              <div key={script.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] text-console-ink">{script.title}</div>
                  <div className="mt-1 text-[11px] text-console-muted">
                    {script.plots.length} 条曲线 · {script.inputs.length} 个参数
                    {script.warning ? ` · ${script.warning}` : ''}
                  </div>
                </div>
                <button
                  onClick={() => {
                    deletePineScript(script.id);
                    notify('success', `已删除「${script.title}」，刷新图表后生效`);
                  }}
                  title="删除脚本"
                  className="rounded-lg p-2 text-console-muted transition-colors hover:bg-console-hover hover:text-console-loss"
                >
                  <Trash2 size={14} strokeWidth={1.5} />
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
