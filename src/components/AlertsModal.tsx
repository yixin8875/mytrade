import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import { beep, desktopNotify, desktopPermission, requestDesktopPermission } from '../lib/alert';
import { fmtPrice } from '../lib/format';
import type { PriceAlert } from '../gateway/types';

const inputClass =
  'h-7 w-full rounded border border-tv-border bg-tv-bg px-2 font-mono text-[11px] text-tv-text outline-none focus:border-tv-accent';

/** 稳定的空数组：选择器每次返回新 [] 会触发 useSyncExternalStore 无限重渲染 */
const NO_CHANNELS: string[] = [];

export function AlertsModal() {
  const open = useApp((s) => s.alertsOpen);
  const setOpen = useApp((s) => s.setAlertsOpen);
  const alerts = useApp((s) => s.alerts);
  const setAlerts = useApp((s) => s.setAlerts);
  const symbol = useApp((s) => s.symbol);
  const symbols = useApp((s) => s.symbols);
  const quote = useApp((s) => s.quote);
  const sound = useApp((s) => s.alertSound);
  const desktop = useApp((s) => s.alertDesktop);
  const setAlertPrefs = useApp((s) => s.setAlertPrefs);
  const notify = useApp((s) => s.notify);
  const channelNames = useApp((s) => s.health?.config.alert_channel_names);
  const channels = channelNames ?? NO_CHANNELS;

  const [kind, setKind] = useState<'above' | 'below'>('above');
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');
  const [repeat, setRepeat] = useState(false);
  const [cooldown, setCooldown] = useState('60');
  const [busy, setBusy] = useState(false);

  const digitsFor = (name: string) => symbols.find((item) => item.name === name)?.digits ?? 5;
  const digits = digitsFor(symbol);

  const refresh = () =>
    gateway
      .call<PriceAlert[]>('alerts.list')
      .then(setAlerts)
      .catch(() => {
        /* 网关没连上就保留旧列表 */
      });

  // 打开时刷新，并用当前价（有十字线就用十字线）预填价格和方向
  useEffect(() => {
    if (!open) return;
    const state = useApp.getState();
    const base = state.crosshairPrice ?? state.quote?.bid ?? 0;
    if (base > 0) {
      setPrice(base.toFixed(digits));
      if (state.quote?.bid) setKind(base >= state.quote.bid ? 'above' : 'below');
    }
    void refresh();
    // 只在打开时预填一次，之后用户改过的输入不被覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const create = async () => {
    const value = Number(price);
    if (!symbol || !Number.isFinite(value) || value <= 0) {
      notify('error', '请输入有效的告警价格');
      return;
    }
    setBusy(true);
    try {
      await gateway.call('alerts.create', {
        symbol,
        kind,
        price: value,
        note: note.trim() || undefined,
        repeat,
        cooldownSec: Number(cooldown) || 60,
      });
      await refresh();
      setNote('');
      notify('success', `已添加 ${symbol} ${kind === 'above' ? '上穿' : '下穿'} ${price}`);
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async (alert: PriceAlert) => {
    try {
      await gateway.call('alerts.update', { id: alert.id, enabled: !alert.enabled });
      await refresh();
    } catch (error) {
      notify('error', (error as Error).message);
    }
  };

  const remove = async (alert: PriceAlert) => {
    try {
      await gateway.call('alerts.delete', { id: alert.id });
      await refresh();
    } catch (error) {
      notify('error', (error as Error).message);
    }
  };

  const test = async () => {
    try {
      // 网关会广播 alert 事件，声音/桌面通知由 App 统一处理
      await gateway.call('alerts.test', { symbol });
    } catch (error) {
      notify('error', (error as Error).message);
    }
  };

  const toggleSound = () => {
    const next = !sound;
    setAlertPrefs({ alertSound: next });
    if (next) beep();
  };

  const toggleDesktop = async () => {
    if (desktop) {
      setAlertPrefs({ alertDesktop: false });
      return;
    }
    const ok = await requestDesktopPermission();
    if (!ok) {
      notify(
        'error',
        desktopPermission() === 'denied'
          ? '浏览器已拒绝通知权限，请在地址栏的站点设置里允许'
          : '当前浏览器不支持桌面通知',
      );
      return;
    }
    setAlertPrefs({ alertDesktop: true });
    desktopNotify('MyTrade 告警', '桌面通知已开启，价格触发时会弹出提醒');
  };

  return (
    <div
      data-modal="alerts"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="flex max-h-[86vh] w-[560px] flex-col rounded border border-tv-border bg-tv-panel shadow-2xl">
        <div className="flex items-center justify-between border-b border-tv-border px-4 py-2.5">
          <div className="text-sm font-medium text-tv-text">
            价格告警
            <span className="ml-2 text-[10px] font-normal text-tv-muted">
              网关常驻检查 · 每 0.5 秒
            </span>
          </div>
          <button
            onClick={() => setOpen(false)}
            className="h-6 w-6 rounded text-tv-muted hover:bg-tv-hover hover:text-tv-text"
          >
            ✕
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-tv-border/60 px-4 py-2 text-[11px]">
          <button
            onClick={toggleSound}
            className={clsx(
              'h-6 rounded px-2 text-[10px] transition-colors',
              sound ? 'bg-tv-accent text-white' : 'bg-tv-bg text-tv-muted hover:text-tv-text',
            )}
          >
            {sound ? '声音 开' : '声音 关'}
          </button>
          <button
            onClick={toggleDesktop}
            className={clsx(
              'h-6 rounded px-2 text-[10px] transition-colors',
              desktop ? 'bg-tv-accent text-white' : 'bg-tv-bg text-tv-muted hover:text-tv-text',
            )}
          >
            {desktop ? '桌面通知 开' : '桌面通知 关'}
          </button>
          <button
            onClick={test}
            className="h-6 rounded bg-tv-border px-2 text-[10px] text-tv-text hover:bg-tv-hover"
          >
            测试提醒
          </button>
          <span className="flex-1" />
          <span className="text-[10px] text-tv-muted">
            第三方推送：
            {channels.length > 0 ? channels.join(' / ') : '未配置（见 config.json）'}
          </span>
        </div>

        <div className="space-y-2 border-b border-tv-border/60 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="w-10 shrink-0 text-[10px] text-tv-muted">品种</span>
            <span className="font-mono text-[11px] text-tv-text">{symbol || '—'}</span>
            <span className="flex-1" />
            <div className="flex gap-1">
              <button
                onClick={() => setKind('above')}
                className={clsx(
                  'h-6 rounded px-2 text-[10px]',
                  kind === 'above' ? 'bg-tv-up text-white' : 'bg-tv-bg text-tv-muted',
                )}
              >
                上穿 ≥
              </button>
              <button
                onClick={() => setKind('below')}
                className={clsx(
                  'h-6 rounded px-2 text-[10px]',
                  kind === 'below' ? 'bg-tv-down text-white' : 'bg-tv-bg text-tv-muted',
                )}
              >
                下穿 ≤
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-10 shrink-0 text-[10px] text-tv-muted">价格</span>
            <input
              type="number"
              step={Math.pow(10, -digits)}
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              className={inputClass}
            />
            <button
              onClick={() => {
                const base = useApp.getState().quote?.bid;
                if (base) setPrice(base.toFixed(digits));
              }}
              className="h-7 shrink-0 rounded bg-tv-bg px-2 text-[10px] text-tv-muted hover:text-tv-text"
            >
              现价
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-10 shrink-0 text-[10px] text-tv-muted">备注</span>
            <input
              type="text"
              maxLength={80}
              value={note}
              placeholder="例如：前高 / 日线阻力"
              onChange={(event) => setNote(event.target.value)}
              className={inputClass}
            />
          </div>
          <div className="flex items-center gap-2 text-[10px] text-tv-muted">
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={repeat}
                onChange={(event) => setRepeat(event.target.checked)}
              />
              重复提醒
            </label>
            <span>冷却</span>
            <input
              type="number"
              min={0}
              value={cooldown}
              onChange={(event) => setCooldown(event.target.value)}
              disabled={!repeat}
              className="h-6 w-16 rounded border border-tv-border bg-tv-bg px-1 text-right font-mono text-[10px] text-tv-text outline-none focus:border-tv-accent disabled:opacity-40"
            />
            <span>秒</span>
            <span className="flex-1" />
            <button
              onClick={create}
              disabled={busy}
              className={clsx(
                'h-7 rounded bg-tv-accent px-3 text-[11px] font-semibold text-white hover:opacity-90',
                busy && 'opacity-50',
              )}
            >
              {busy ? '添加中…' : '添加告警'}
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {alerts.length === 0 && (
            <div className="px-4 py-6 text-center text-[11px] text-tv-muted">
              还没有告警。打开图表把鼠标放到价位上，再点顶部「告警」即可快速添加。
            </div>
          )}
          {alerts.map((alert) => (
            <div
              key={alert.id}
              className={clsx(
                'flex items-center gap-2 border-b border-tv-border/50 px-4 py-2 text-[11px]',
                !alert.enabled && 'opacity-50',
              )}
            >
              <span
                className={clsx(
                  'w-10 shrink-0 rounded px-1 py-0.5 text-center text-[9px] font-semibold text-white',
                  alert.kind === 'above' ? 'bg-tv-up' : 'bg-tv-down',
                )}
              >
                {alert.kind === 'above' ? '上穿' : '下穿'}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-tv-text">
                  {alert.symbol} · {fmtPrice(alert.price, digitsFor(alert.symbol))}
                  {alert.repeat ? (
                    <span className="ml-1 rounded bg-tv-accent/20 px-1 text-[9px] text-tv-accent">
                      重复 {alert.cooldown_sec}s
                    </span>
                  ) : null}
                </div>
                <div className="truncate text-[10px] text-tv-muted">
                  {alert.note || '无备注'}
                  {alert.trigger_count > 0 ? ` · 已触发 ${alert.trigger_count} 次` : ''}
                </div>
              </div>
              <button
                onClick={() => toggleEnabled(alert)}
                className={clsx(
                  'h-5 rounded px-1.5 text-[10px]',
                  alert.enabled
                    ? 'bg-tv-border text-tv-text hover:bg-tv-hover'
                    : 'bg-tv-accent/20 text-tv-accent hover:bg-tv-accent/30',
                )}
              >
                {alert.enabled ? '停用' : '启用'}
              </button>
              <button
                onClick={() => remove(alert)}
                className="h-5 rounded px-1.5 text-[10px] text-tv-muted hover:bg-tv-down/20 hover:text-tv-down"
              >
                删除
              </button>
            </div>
          ))}
        </div>

        <div className="border-t border-tv-border px-4 py-2 text-[9px] text-tv-muted">
          声音和桌面通知需要页面保持打开；第三方通道（webhook / Discord / Telegram / 企业微信）由网关发送，
          关掉页面也会推送，密钥只存在 gateway/config.json。
        </div>
      </div>
    </div>
  );
}
