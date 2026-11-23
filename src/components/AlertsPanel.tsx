import { useEffect, useRef, useState } from 'react';
import { Bell, Pause, Pencil, Play, Trash2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import { beep, desktopNotify, desktopPermission, requestDesktopPermission } from '../lib/alert';
import { fmtPrice } from '../lib/format';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Empty, EmptyDescription } from './ui/empty';
import type { PriceAlert } from '../gateway/types';

const inputClass =
  'h-7 min-w-0 rounded-lg border border-input bg-background px-2 font-mono text-[12px] text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 disabled:opacity-40';

/** 稳定的空数组：选择器每次返回新 [] 会触发 useSyncExternalStore 无限重渲染 */
const NO_CHANNELS: string[] = [];

/** 交易台右侧的价格告警面板：依附图表，不再单独弹窗 */
export function AlertsPanel() {
  const setOpen = useApp((s) => s.setAlertsOpen);
  const alerts = useApp((s) => s.alerts);
  const setAlerts = useApp((s) => s.setAlerts);
  const symbol = useApp((s) => s.symbol);
  const symbols = useApp((s) => s.symbols);
  const sound = useApp((s) => s.alertSound);
  const desktop = useApp((s) => s.alertDesktop);
  const setAlertPrefs = useApp((s) => s.setAlertPrefs);
  const notify = useApp((s) => s.notify);
  const channelNames = useApp((s) => s.health?.config.alert_channel_names);
  const channels = channelNames ?? NO_CHANNELS;
  const prefill = useApp((s) => s.alertPrefill);
  const clearAlertPrefill = useApp((s) => s.clearAlertPrefill);

  const [kind, setKind] = useState<'above' | 'below'>('above');
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');
  const [repeat, setRepeat] = useState(false);
  const [cooldown, setCooldown] = useState('60');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<PriceAlert | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const prefSymbol = useRef(symbol);

  const digitsFor = (name: string) => symbols.find((item) => item.name === name)?.digits ?? 5;
  const formSymbol = editing?.symbol ?? symbol;
  const digits = digitsFor(formSymbol);
  const activeCount = alerts.filter((item) => item.enabled).length;

  const refresh = () =>
    gateway
      .call<PriceAlert[]>('alerts.list')
      .then(setAlerts)
      .catch(() => {
        /* 网关没连上就保留旧列表 */
      });

  // 面板打开时刷新，并用当前价（有十字线就用十字线）预填价格和方向
  useEffect(() => {
    const state = useApp.getState();
    const base = state.crosshairPrice ?? state.quote?.bid ?? 0;
    if (base > 0) {
      setPrice(base.toFixed(digits));
      if (state.quote?.bid) setKind(base >= state.quote.bid ? 'above' : 'below');
    }
    void refresh();
    // 只在面板挂载时预填一次，之后用户改过的输入不被覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 图表快捷操作（价格轴 + / 右键 / Alt+A）送来的价格：套用一次后清空，
  // 否则面板下次打开会把旧价再填一遍
  useEffect(() => {
    if (!prefill) return;
    setEditing(null);
    setPrice(prefill.price.toFixed(digitsFor(prefill.symbol)));
    setKind(prefill.kind);
    setNote('');
    clearAlertPrefill();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.nonce]);

  // 面板开着时换品种，清掉旧品种的价格，避免把 A 的价位挂到 B 上
  useEffect(() => {
    if (prefSymbol.current === symbol) return;
    prefSymbol.current = symbol;
    if (editing) return;
    setPrice('');
    setKind('above');
    // 编辑中的告警跟着它自己的品种，不随图表切换清空
  }, [symbol, editing]);

  const resetForm = () => {
    setEditing(null);
    setNote('');
  };

  const startEdit = (alert: PriceAlert) => {
    setEditing(alert);
    setKind(alert.kind);
    setPrice(String(alert.price));
    setNote(alert.note ?? '');
    setRepeat(!!alert.repeat);
    setCooldown(String(alert.cooldown_sec || 60));
  };

  const save = async () => {
    const value = Number(price);
    const target = editing?.symbol ?? symbol;
    if (!target || !Number.isFinite(value) || value <= 0) {
      notify('error', '请输入有效的告警价格');
      return;
    }
    setBusy(true);
    try {
      if (editing) {
        await gateway.call('alerts.update', {
          id: editing.id,
          kind,
          price: value,
          note: note.trim() || '',
          repeat,
          cooldownSec: repeat ? Number(cooldown) || 60 : 0,
        });
        await refresh();
        notify('success', '告警已更新');
      } else {
        await gateway.call('alerts.create', {
          symbol: target,
          kind,
          price: value,
          note: note.trim() || undefined,
          repeat,
          cooldownSec: Number(cooldown) || 60,
        });
        await refresh();
        notify('success', `已添加 ${target} ${kind === 'above' ? '上穿' : '下穿'} ${price}`);
      }
      resetForm();
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
    if (confirmId !== alert.id) {
      setConfirmId(alert.id);
      window.setTimeout(() => setConfirmId((id) => (id === alert.id ? null : id)), 4000);
      return;
    }
    setConfirmId(null);
    if (editing?.id === alert.id) resetForm();
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
    desktopNotify('Tally 告警', '桌面通知已开启，价格触发时会弹出提醒');
  };

  return (
    <aside
      data-panel="alerts"
      className="absolute inset-y-0 right-0 z-20 flex w-[320px] flex-col border-l border-border bg-card shadow-lg/5"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
        <Bell size={14} strokeWidth={1.5} className="text-muted-foreground" />
        <span className="text-[12px] font-medium text-foreground">价格告警</span>
        {activeCount > 0 && (
          <span className="num font-mono text-[11px] text-muted-foreground">{activeCount}</span>
        )}
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setOpen(false)}
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          title="关闭告警面板"
          aria-label="关闭告警面板"
        >
          <X size={14} strokeWidth={1.5} />
        </Button>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2.5">
        <Button
          variant={sound ? 'secondary' : 'ghost'}
          size="xs"
          onClick={toggleSound}
          aria-pressed={sound}
          className={cn(
            'h-7 gap-1.5 px-2.5 text-[11px] font-normal',
            !sound && 'text-muted-foreground hover:text-foreground',
          )}
        >
          <span
            className={cn('h-1.5 w-1.5 rounded-full', sound ? 'bg-success' : 'bg-muted-foreground/60')}
          />
          声音
        </Button>
        <Button
          variant={desktop ? 'secondary' : 'ghost'}
          size="xs"
          onClick={() => void toggleDesktop()}
          aria-pressed={desktop}
          className={cn(
            'h-7 gap-1.5 px-2.5 text-[11px] font-normal',
            !desktop && 'text-muted-foreground hover:text-foreground',
          )}
        >
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              desktop ? 'bg-success' : 'bg-muted-foreground/60',
            )}
          />
          桌面通知
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => void test()}
          className="ml-auto h-7 px-2 text-[11px] font-normal text-muted-foreground hover:text-foreground"
        >
          测试
        </Button>
      </div>

      <div className="space-y-2.5 border-b border-border px-3 py-3">
        <div className="flex items-center gap-2">
          <span className="w-8 shrink-0 text-[11px] text-muted-foreground">品种</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
            {formSymbol || '—'}
            {editing && <span className="ml-1.5 text-[10px] text-muted-foreground">编辑中</span>}
          </span>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setKind('above')}
              aria-pressed={kind === 'above'}
              className={cn(
                'h-7 rounded-lg border px-2 text-[11px] font-normal',
                kind === 'above'
                  ? 'border-success/40 bg-success/10 text-success-foreground hover:bg-success/10'
                  : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              上穿
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setKind('below')}
              aria-pressed={kind === 'below'}
              className={cn(
                'h-7 rounded-lg border px-2 text-[11px] font-normal',
                kind === 'below'
                  ? 'border-destructive/40 bg-destructive/10 text-destructive-foreground hover:bg-destructive/10'
                  : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              下穿
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="w-8 shrink-0 text-[11px] text-muted-foreground">价格</span>
          <input
            type="number"
            step={Math.pow(10, -digits)}
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            className={cn(inputClass, 'flex-1')}
          />
          {!editing && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                const base = useApp.getState().quote?.bid;
                if (base) setPrice(base.toFixed(digits));
              }}
              className="h-7 shrink-0 px-2 text-[11px] font-normal text-muted-foreground hover:text-foreground"
            >
              现价
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span className="w-8 shrink-0 text-[11px] text-muted-foreground">备注</span>
          <input
            type="text"
            maxLength={80}
            value={note}
            placeholder="前高 / 日线阻力"
            onChange={(event) => setNote(event.target.value)}
            className={cn(inputClass, 'flex-1')}
          />
        </div>

        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <label className="flex items-center gap-1.5">
            <Checkbox
              checked={repeat}
              onCheckedChange={setRepeat}
              aria-label="重复"
              className="size-3.5"
            />
            重复
          </label>
          <input
            type="number"
            min={0}
            value={cooldown}
            onChange={(event) => setCooldown(event.target.value)}
            disabled={!repeat}
            className="h-6 w-11 rounded-md border border-input bg-background px-1 text-right font-mono text-[11px] text-foreground outline-none focus-visible:border-ring disabled:opacity-40"
          />
          <span>秒</span>
          {editing && (
            <Button
              variant="ghost"
              size="xs"
              onClick={resetForm}
              className="ml-auto h-7 px-2 text-[11px] font-normal text-muted-foreground hover:text-foreground"
            >
              取消编辑
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => void save()}
            disabled={busy}
            className={cn('h-7 px-3 text-[12px]', !editing && 'ml-auto')}
          >
            {busy ? '保存中…' : editing ? '保存修改' : '添加告警'}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {alerts.length === 0 && (
          <Empty className="gap-1 px-4 py-8">
            <EmptyDescription className="text-[12px] leading-relaxed text-muted-foreground">
              还没有告警。
              <br />
              选中价格和方向后添加。
            </EmptyDescription>
          </Empty>
        )}
        {alerts.map((alert) => (
          <div
            key={alert.id}
            className={cn(
              'group flex items-center gap-2 border-b border-border/60 px-3 py-2.5 text-[12px]',
              !alert.enabled && 'opacity-55',
            )}
          >
            <span
              className={cn(
                'flex w-9 shrink-0 items-center gap-1 text-[11px]',
                alert.kind === 'above' ? 'text-success-foreground' : 'text-destructive-foreground',
              )}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  alert.kind === 'above' ? 'bg-success' : 'bg-destructive',
                )}
              />
              {alert.kind === 'above' ? '上穿' : '下穿'}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-foreground">
                {alert.symbol} · {fmtPrice(alert.price, digitsFor(alert.symbol))}
                {alert.repeat ? (
                  <span className="ml-1.5 font-mono text-[11px] text-muted-foreground/60">
                    ×{alert.cooldown_sec}s
                  </span>
                ) : null}
              </div>
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {alert.note || '无备注'}
                {alert.trigger_count > 0 ? ` · 触发 ${alert.trigger_count} 次` : ''}
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => void toggleEnabled(alert)}
              title={alert.enabled ? '停用' : '启用'}
              aria-label={alert.enabled ? '停用告警' : '启用告警'}
              className={cn(
                'h-6 w-6 shrink-0',
                alert.enabled
                  ? 'text-muted-foreground hover:text-foreground'
                  : 'text-brand hover:bg-brand/10',
              )}
            >
              {alert.enabled ? (
                <Pause size={13} strokeWidth={1.5} />
              ) : (
                <Play size={13} strokeWidth={1.5} />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => startEdit(alert)}
              title="编辑"
              aria-label="编辑告警"
              className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
            >
              <Pencil size={13} strokeWidth={1.5} />
            </Button>
            <Button
              variant={confirmId === alert.id ? 'destructive' : 'ghost'}
              size={confirmId === alert.id ? 'xs' : 'icon-xs'}
              onClick={() => void remove(alert)}
              title={confirmId === alert.id ? '再点一次确认删除' : '删除'}
              aria-label="删除告警"
              className={cn(
                'h-6 shrink-0',
                confirmId === alert.id
                  ? 'px-1.5 text-[10px]'
                  : 'w-6 text-muted-foreground hover:bg-destructive/10 hover:text-destructive-foreground',
              )}
            >
              {confirmId === alert.id ? '确认' : <Trash2 size={13} strokeWidth={1.5} />}
            </Button>
          </div>
        ))}
      </div>

      <div className="shrink-0 border-t border-border px-4 py-2.5 text-[11px] leading-relaxed text-muted-foreground/60">
        第三方推送：{channels.length > 0 ? channels.join(' / ') : '未配置（见 config.json）'}。
        声音与桌面通知需要页面保持打开。
      </div>
    </aside>
  );
}
