import { useEffect, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import {
  Bell,
  ChartCandlestick,
  Check,
  Info,
  Palette,
  RefreshCw,
  Save,
  ShieldCheck,
  X,
} from 'lucide-react';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import type { GatewayConfig } from '../gateway/types';
import { checkForUpdates, isUpdateUiAvailable } from '../lib/updater';

const NAV = [
  { id: 'appearance', label: '外观', hint: '主题与界面', icon: Palette },
  { id: 'chart', label: '图表', hint: '布局与周期', icon: ChartCandlestick },
  { id: 'risk', label: '交易与风控', hint: '手数与风险上限', icon: ShieldCheck },
  { id: 'alerts', label: '告警', hint: '声音与通知', icon: Bell },
  { id: 'updates', label: '更新', hint: '版本与检查更新', icon: RefreshCw },
  { id: 'about', label: '数据与账户', hint: '连接与本机路径', icon: Info },
] as const;

type SectionId = (typeof NAV)[number]['id'];

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

function pickRisk(config: GatewayConfig): RiskForm {
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

/** 桌面版设置页：覆盖在交易台之上，图表保持挂载，关闭后回到原状态 */
export function SettingsPanel() {
  const open = useApp((s) => s.settingsOpen);
  const setOpen = useApp((s) => s.setSettingsOpen);
  const [section, setSection] = useState<SectionId>('appearance');

  useEffect(() => {
    if (!open) {
      setSection('appearance');
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, setOpen]);

  if (!open) return null;

  const active = NAV.find((item) => item.id === section) ?? NAV[0];

  return (
    <div data-page="settings" className="fixed inset-0 z-40 flex bg-tv-bg text-tv-text">
      <aside className="flex w-[212px] shrink-0 flex-col border-r border-tv-border bg-tv-panel/70 px-3 py-4">
        <div className="px-2">
          <div className="text-[15px] font-semibold">设置</div>
          <div className="mt-0.5 text-[10px] text-tv-muted">MyTrade · MT5</div>
        </div>

        <nav className="mt-6 space-y-0.5">
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                onClick={() => setSection(item.id)}
                className={clsx(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
                  section === item.id
                    ? 'bg-tv-bg text-tv-text'
                    : 'text-tv-muted hover:bg-tv-bg/70 hover:text-tv-text',
                )}
              >
                <Icon size={14} />
                <span className="flex-1 text-[11px]">{item.label}</span>
                {section === item.id && <span className="h-1 w-1 rounded-full bg-tv-accent" />}
              </button>
            );
          })}
        </nav>

        <div className="mt-auto space-y-2 px-1">
          <div className="rounded-lg border border-tv-border bg-tv-bg/50 p-2.5 text-[10px] leading-relaxed text-tv-muted">
            设置保存在本机，不会上传。
          </div>
          <button
            onClick={() => setOpen(false)}
            className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-tv-bg text-[11px] text-tv-text hover:bg-tv-border"
          >
            <X size={12} />
            返回交易台
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[780px] px-8 py-8">
          <header className="mb-6">
            <h1 className="text-[24px] font-semibold tracking-tight">{active.label}</h1>
            <p className="mt-1 text-[11px] text-tv-muted">{active.hint}</p>
          </header>

          {section === 'appearance' && <AppearanceSection />}
          {section === 'chart' && <ChartSection />}
          {section === 'risk' && <RiskSection />}
          {section === 'alerts' && <AlertsSection />}
          {section === 'updates' && <UpdatesSection />}
          {section === 'about' && <AboutSection />}
        </div>
      </main>
    </div>
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
    <section className="mb-4 rounded-xl border border-tv-border bg-tv-panel p-5 shadow-sm">
      <div className="text-[13px] font-semibold">{title}</div>
      {description && (
        <p className="mt-1 text-[11px] leading-relaxed text-tv-muted">{description}</p>
      )}
      <div className="mt-4">{children}</div>
      {footer && <div className="mt-4 border-t border-tv-border/60 pt-3">{footer}</div>}
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
    <div className="flex items-center justify-between gap-6 border-t border-tv-border/50 py-3 first:border-t-0 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="text-[11px] text-tv-text">{label}</div>
        {hint && <div className="mt-0.5 text-[10px] leading-relaxed text-tv-muted">{hint}</div>}
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
    <div className="flex rounded-lg border border-tv-border bg-tv-bg p-0.5">
      {options.map((item) => (
        <button
          key={item.value}
          onClick={() => onChange(item.value)}
          className={clsx(
            'h-6 rounded-md px-2.5 text-[10px] transition-colors',
            value === item.value
              ? 'bg-tv-panel text-tv-text shadow-sm'
              : 'text-tv-muted hover:text-tv-text',
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
        'relative h-5 w-9 rounded-full transition-colors',
        checked ? 'bg-tv-accent' : 'bg-tv-border',
      )}
    >
      <span
        className={clsx(
          'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
          checked ? 'left-[18px]' : 'left-0.5',
        )}
      />
    </button>
  );
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px]',
        ok ? 'bg-tv-up/10 text-tv-up' : 'bg-tv-down/10 text-tv-down',
      )}
    >
      <span className={clsx('h-1.5 w-1.5 rounded-full', ok ? 'bg-tv-up' : 'bg-tv-down')} />
      {label}
    </span>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-tv-border bg-tv-bg px-1 font-mono text-[10px] text-tv-text">
      {children}
    </kbd>
  );
}

function AppearanceSection() {
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);

  return (
    <>
      <Card title="主题" description="设置保存在本机，重启后保留。">
        <div className="grid grid-cols-2 gap-3">
          {(['light', 'dark'] as const).map((value) => (
            <button
              key={value}
              onClick={() => setTheme(value)}
              className={clsx(
                'rounded-xl border p-3 text-left transition-colors',
                theme === value
                  ? 'border-tv-accent ring-1 ring-tv-accent'
                  : 'border-tv-border hover:border-tv-muted/50',
              )}
            >
              <div
                className={clsx(
                  'mb-2 h-16 rounded-lg border p-2',
                  value === 'light'
                    ? 'border-[#e7e5df] bg-[#f6f6f3]'
                    : 'border-[#2a2e39] bg-[#131722]',
                )}
              >
                <div
                  className={clsx(
                    'h-2 w-12 rounded',
                    value === 'light' ? 'bg-white' : 'bg-[#1e222d]',
                  )}
                />
                <div
                  className={clsx(
                    'mt-1.5 h-1.5 w-20 rounded',
                    value === 'light' ? 'bg-[#d7dde5]' : 'bg-[#2a2e39]',
                  )}
                />
                <div
                  className={clsx(
                    'mt-1 h-1.5 w-14 rounded',
                    value === 'light' ? 'bg-[#d7dde5]' : 'bg-[#2a2e39]',
                  )}
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium">
                  {value === 'light' ? '浅色' : '深色'}
                </span>
                {theme === value && <Check size={12} className="text-tv-accent" />}
              </div>
            </button>
          ))}
        </div>
      </Card>

      <Card
        title="界面说明"
        description="这一步先把设置从顶部工具栏和各个弹窗里收拢出来；日志、统计和复盘页会在后续继续拆分。"
      >
        <ul className="space-y-1.5 text-[11px] leading-relaxed text-tv-muted">
          <li>· 顶部保留品种、周期、布局、告警和急停等高频操作。</li>
          <li>· 主题、风控、告警偏好、更新统一放在设置页。</li>
          <li>· 画线模板和收藏仍在图表上操作，位置不变。</li>
        </ul>
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
      <Card title="图表布局" description="四图是同一品种的 2×2 多周期布局，十字线联动。">
        <Row label="默认布局">
          <Segmented
            value={layout}
            options={[
              { value: 'single', label: '单图' },
              { value: 'quad', label: '四图' },
            ]}
            onChange={setLayout}
          />
        </Row>
        <Row label="默认周期" hint="切换后主图立即生效，下次启动沿用。">
          <select
            value={resolution}
            onChange={(event) => setResolution(event.target.value)}
            className="h-7 rounded-lg border border-tv-border bg-tv-bg px-2 text-[11px] text-tv-text outline-none focus:border-tv-accent"
          >
            {FRAMES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Row>
      </Card>

      <Card
        title="画线工具"
        description="画线模板面板在图表左下角；收藏工具在左侧工具栏右键或展开工具组里设置。"
      >
        <div className="text-[11px] leading-relaxed text-tv-muted">
          这些内容仍保存在图表本地存储，不会上传。
        </div>
      </Card>
    </>
  );
}

function RiskSection() {
  const health = useApp((s) => s.health);
  const notify = useApp((s) => s.notify);
  const config = health?.config;
  const [form, setForm] = useState<RiskForm | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!config) return;
    setForm((prev) => prev ?? pickRisk(config));
  }, [config]);

  if (!config || !form) {
    return (
      <Card title="交易与风控" description="连接网关后可以在这里查看和修改风控参数。">
        <div className="text-[11px] text-tv-muted">等待网关连接…</div>
      </Card>
    );
  }

  const dirty = RISK_FIELDS.some(
    (field) => Number(form[field.key]) !== Number(config[field.key]),
  );
  const error = validateRisk(form);
  const changes = RISK_FIELDS.filter(
    (field) => Number(form[field.key]) !== Number(config[field.key]),
  ).map(
    (field) =>
      `${field.label}：${config[field.key]}${field.suffix ?? ''} → ${form[field.key]}${
        field.suffix ?? ''
      }`,
  );

  const setValue = (key: RiskKey, value: number) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));

  const save = async () => {
    const problem = validateRisk(form);
    if (problem) {
      notify('error', problem);
      return;
    }
    setSaving(true);
    try {
      const next = await gateway.call<GatewayConfig>('system.setConfig', { ...form });
      const latest = useApp.getState().health;
      if (latest) useApp.getState().setHealth({ ...latest, config: next });
      setForm(pickRisk(next));
      setConfirm(false);
      notify('success', '风控参数已更新，立即生效');
    } catch (err) {
      notify('error', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Card
        title="风控上限"
        description="修改会立即生效，并写入 gateway/config.json。放大手数或风险上限会增加单笔亏损，请谨慎操作。"
        footer={
          <div className="flex items-center justify-between gap-3">
            <div className="text-[10px] text-tv-muted">
              {error ? (
                <span className="text-tv-down">{error}</span>
              ) : dirty ? (
                '有未保存的修改'
              ) : (
                '当前配置已生效'
              )}
            </div>
            <div className="flex items-center gap-2">
              {dirty && (
                <button
                  onClick={() => setForm(pickRisk(config))}
                  className="h-7 rounded-md bg-tv-bg px-2.5 text-[10px] text-tv-muted hover:text-tv-text"
                >
                  撤销
                </button>
              )}
              <button
                onClick={() => setConfirm(true)}
                disabled={!dirty || !!error || saving}
                className={clsx(
                  'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[10px] font-semibold transition-colors',
                  dirty && !error
                    ? 'bg-tv-accent text-white hover:opacity-90'
                    : 'cursor-not-allowed bg-tv-bg text-tv-muted',
                )}
              >
                <Save size={11} />
                保存风控
              </button>
            </div>
          </div>
        }
      >
        {RISK_FIELDS.map((field) => (
          <Row key={field.key} label={field.label} hint={field.hint}>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={field.min}
                max={field.max}
                step={field.step}
                value={form[field.key]}
                onChange={(event) => setValue(field.key, Number(event.target.value))}
                className="h-7 w-24 rounded-md border border-tv-border bg-tv-bg px-2 text-right font-mono text-[11px] text-tv-text outline-none focus:border-tv-accent"
              />
              {field.suffix && <span className="text-[10px] text-tv-muted">{field.suffix}</span>}
            </div>
          </Row>
        ))}

        <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[10px] leading-relaxed text-tv-text">
          <Info size={12} className="mt-0.5 shrink-0 text-amber-500" />
          <span>
            0.5 手是 MyTrade 的风控上限，不是券商限制。自动手数会被截到该值，手动超过会被网关拒绝；
            即使放大手数，单笔风险超过 {config.max_risk_pct}% 仍会被拒绝。
          </span>
        </div>
      </Card>

      <Card title="运行模式" description="交易模式由顶部按钮切换；实盘开关只在配置文件里修改。">
        <Row label="当前模式">
          <span className="text-[11px]">
            {health?.tradeMode === 'readonly'
              ? '只读'
              : health?.tradeMode === 'demo'
                ? '模拟可交易'
                : '实盘交易'}
          </span>
        </Row>
        <Row label="实盘开关">
          <span className={clsx('text-[11px]', config.allow_live ? 'text-tv-down' : 'text-tv-muted')}>
            {config.allow_live ? '已允许' : '关闭'}
          </span>
        </Row>
        <Row label="告警通道">
          <span className="text-[11px] text-tv-muted">
            {config.alert_channel_names?.length
              ? config.alert_channel_names.join('、')
              : '未配置第三方通道'}
          </span>
        </Row>
      </Card>

      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-[420px] max-w-full rounded-xl border border-tv-border bg-tv-panel p-5 shadow-2xl">
            <div className="text-[13px] font-semibold">确认修改风控参数？</div>
            <div className="mt-1.5 text-[11px] leading-relaxed text-tv-muted">
              保存后立即生效，并写入 gateway/config.json。放大手数或风险上限会增加单笔亏损。
            </div>
            <div className="mt-3 max-h-40 space-y-1 overflow-auto rounded-lg bg-tv-bg p-3 text-[10px]">
              {changes.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirm(false)}
                className="h-7 rounded-md bg-tv-bg px-3 text-[10px] text-tv-muted hover:text-tv-text"
              >
                取消
              </button>
              <button
                onClick={() => void save()}
                disabled={saving}
                className="h-7 rounded-md bg-tv-accent px-3 text-[10px] font-semibold text-white hover:opacity-90 disabled:cursor-wait disabled:opacity-50"
              >
                {saving ? '保存中…' : '确认保存'}
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

      <Card
        title="第三方通道"
        description="Webhook / Discord / Telegram / 企业微信在 gateway/config.json 的 alert_channels 里配置，密钥不会下发到前端。"
      >
        <div className="text-[11px] text-tv-muted">
          {config?.alert_channel_names?.length
            ? `已配置：${config.alert_channel_names.join('、')}`
            : '未配置第三方通道'}
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
          <span className="font-mono text-[11px]">v{health?.version ?? '—'}</span>
        </Row>
        <Row label="自动检查" hint="桌面版启动约 6 秒后静默检查一次，失败不会打扰。">
          <span className="text-[10px] text-tv-muted">已启用</span>
        </Row>
        <Row label="手动检查">
          <button
            onClick={() => void checkForUpdates(true)}
            disabled={!available}
            className={clsx(
              'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[10px]',
              available
                ? 'bg-tv-bg text-tv-text hover:bg-tv-border'
                : 'cursor-not-allowed bg-tv-bg text-tv-muted',
            )}
          >
            <RefreshCw size={11} />
            检查更新
          </button>
        </Row>
      </Card>

      {!available && (
        <Card
          title="开发模式"
          description="当前在浏览器里运行，更新功能只在 Tauri 桌面版可用。"
        >
          <div className="text-[11px] text-tv-muted">打包后的桌面版会自动显示更新提示。</div>
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
      <Card title="连接" description="只显示连接状态与终端信息，不展示账户登录号或服务器。">
        <Row label="网关">
          <StatusPill ok={!!health?.connected} label={health?.connected ? '已连接' : '未连接'} />
        </Row>
        <Row label="终端">
          <span className="text-[11px] text-tv-muted">
            {terminal ? `${terminal.company} · ${terminal.name} (build ${terminal.build})` : '未连接'}
          </span>
        </Row>
        <Row label="账户类型">
          <span className="text-[11px]">
            {account?.accountType === 'real'
              ? '实盘'
              : account?.accountType === 'demo'
                ? '模拟'
                : '—'}
          </span>
        </Row>
        <Row label="交易模式">
          <span className="text-[11px]">
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
          <span className="font-mono text-[10px] text-tv-muted">gateway/data</span>
        </Row>
        <Row label="审计日志">
          <span className="font-mono text-[10px] text-tv-muted">gateway/audit</span>
        </Row>
        <Row label="风控配置">
          <span className="font-mono text-[10px] text-tv-muted">gateway/config.json</span>
        </Row>
      </Card>

      <Card title="快捷键">
        <div className="grid grid-cols-[64px_1fr] gap-x-3 gap-y-2 text-[11px]">
          <Kbd>B</Kbd>
          <span className="text-tv-muted">建立买入市价草稿</span>
          <Kbd>S</Kbd>
          <span className="text-tv-muted">建立卖出市价草稿</span>
          <Kbd>Esc</Kbd>
          <span className="text-tv-muted">关闭弹窗 / 清除划线草稿</span>
          <Kbd>Shift</Kbd>
          <span className="text-tv-muted">拖动价格时吸附整数点位</span>
        </div>
      </Card>
    </>
  );
}
