import { useCallback, useEffect, useState } from 'react';
import { Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { gateway } from '../gateway/client';
import { useApp } from '../store/useApp';
import type {
  AlertChannelField,
  AlertChannelPublic,
  AlertChannelSaveResponse,
  AlertChannelTestEvent,
  AlertChannelsResponse,
  AlertChannelTypeSpec,
} from '../gateway/types';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from './ui/dialog';
import { Input } from './ui/input';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from './ui/select';
import { Switch } from './ui/switch';
import { Textarea } from './ui/textarea';

/**
 * 设置 → 告警 → 推送通道。
 *
 * 表单字段由网关下发的 schema 驱动，密钥值从不回传：编辑时密钥输入框永远为空，
 * 留空表示保持原值，只有点「清除」或填写新值才会改动。
 */
export function AlertChannelsCard() {
  const notify = useApp((s) => s.notify);
  const [channels, setChannels] = useState<AlertChannelPublic[]>([]);
  const [schema, setSchema] = useState<Record<string, AlertChannelTypeSpec>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editor, setEditor] = useState<{
    mode: 'new' | 'edit';
    channel?: AlertChannelPublic;
  } | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await gateway.call<AlertChannelsResponse>('alerts.channels.list');
      setChannels(Array.isArray(result.channels) ? result.channels : []);
      setSchema(result.schema ?? {});
    } catch (error) {
      const err = error as Error & { code?: string };
      setLoadError(err.code === 'UNKNOWN_METHOD' ? 'UNSUPPORTED' : err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 测试结果由网关以事件送回；App 负责弹 toast，这里只负责结束「测试中」状态
  useEffect(() => {
    const off = gateway.on('alertChannelTest', (data) => {
      const event = data as AlertChannelTestEvent;
      setTestingId((current) => (current === event.id ? null : current));
    });
    return off;
  }, []);

  useEffect(() => {
    if (!testingId) return;
    const timer = window.setTimeout(() => setTestingId(null), 25_000);
    return () => window.clearTimeout(timer);
  }, [testingId]);

  const test = async (channel: AlertChannelPublic) => {
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    setTestingId(channel.id);
    try {
      await gateway.call('alerts.channels.test', { id: channel.id, requestId });
    } catch (error) {
      setTestingId(null);
      notify('error', (error as Error).message);
    }
  };

  const remove = async (channel: AlertChannelPublic) => {
    if (confirmId !== channel.id) {
      setConfirmId(channel.id);
      window.setTimeout(
        () => setConfirmId((current) => (current === channel.id ? null : current)),
        4000,
      );
      return;
    }
    setConfirmId(null);
    setDeletingId(channel.id);
    try {
      const result = await gateway.call<{ channels: AlertChannelPublic[] }>(
        'alerts.channels.delete',
        { id: channel.id },
      );
      setChannels(Array.isArray(result.channels) ? result.channels : []);
      notify('success', `已删除通道「${channel.name}」`);
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      setDeletingId(null);
    }
  };

  const canAdd = !loadError && Object.keys(schema).length > 0;

  return (
    <div className="space-y-4">
      {loading ? (
        <div className="text-[12px] text-muted-foreground">读取中…</div>
      ) : loadError ? (
        <div className="flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5">
          <span className="min-w-0 flex-1 text-[12px] text-destructive-foreground">
            {loadError === 'UNSUPPORTED'
              ? '当前网关版本不支持通道管理，请升级后重试'
              : `读取失败：${loadError}`}
          </span>
          <Button variant="outline" size="xs" onClick={() => void load()}>
            重试
          </Button>
        </div>
      ) : channels.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-[12px] text-muted-foreground">
          还没有配置推送通道。添加后，价格告警会同时推送到这里。
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          {channels.map((channel) => (
            <div
              key={channel.id}
              className="flex items-center gap-2 border-t border-border px-3 py-2.5 first:border-t-0"
            >
              <Badge variant="outline">{channel.typeLabel}</Badge>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] text-foreground">{channel.name}</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {describeChannel(channel)}
                </div>
              </div>
              <Button
                variant="ghost"
                size="xs"
                disabled={testingId === channel.id}
                onClick={() => void test(channel)}
              >
                <Send size={12} />
                {testingId === channel.id ? '测试中…' : '测试'}
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`编辑 ${channel.name}`}
                onClick={() => setEditor({ mode: 'edit', channel })}
              >
                <Pencil size={13} />
              </Button>
              <Button
                variant={confirmId === channel.id ? 'destructive' : 'ghost'}
                size="xs"
                disabled={deletingId === channel.id}
                aria-label={confirmId === channel.id ? '确认删除' : `删除 ${channel.name}`}
                onClick={() => void remove(channel)}
              >
                {deletingId === channel.id ? (
                  '删除中…'
                ) : confirmId === channel.id ? (
                  '确认删除'
                ) : (
                  <Trash2 size={13} />
                )}
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] leading-relaxed text-muted-foreground">
          地址、Token 等密钥不会回显；编辑时留空表示保持不变。
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={!canAdd}
          onClick={() => setEditor({ mode: 'new' })}
        >
          <Plus size={14} />
          添加通道
        </Button>
      </div>

      {editor && (
        <ChannelDialog
          channel={editor.channel}
          schema={schema}
          onClose={() => setEditor(null)}
          onSaved={(next, saved) => {
            setChannels(next);
            notify('success', `已保存通道「${saved.name}」`);
            setEditor(null);
          }}
        />
      )}
    </div>
  );
}

function describeChannel(channel: AlertChannelPublic): string {
  const fields = channel.fields;
  const bits: string[] = [];
  const host = typeof fields.host === 'string' ? fields.host : '';
  if (host) bits.push(fields.port ? `${host}:${String(fields.port)}` : host);
  if (fields.chatId) bits.push(`chat ${String(fields.chatId)}`);
  if (Array.isArray(fields.to) && fields.to.length) bits.push(fields.to.join(', '));
  if (fields.title) bits.push(String(fields.title));
  if (!bits.length) bits.push(channel.secretKeys.length ? '密钥已配置' : '未配置密钥');
  return bits.join(' · ');
}

function defaultValues(spec: AlertChannelTypeSpec | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of spec?.fields ?? []) {
    if (field.default !== undefined) out[field.key] = field.default;
  }
  return out;
}

function ChannelDialog({
  channel,
  schema,
  onClose,
  onSaved,
}: {
  channel?: AlertChannelPublic;
  schema: Record<string, AlertChannelTypeSpec>;
  onClose: () => void;
  onSaved: (
    channels: AlertChannelPublic[],
    saved: { id: string; type: string; name: string },
  ) => void;
}) {
  const types = Object.keys(schema);
  const [type, setType] = useState(channel?.type ?? types[0] ?? '');
  const spec = schema[type];
  const [name, setName] = useState(channel?.name ?? '');
  const [values, setValues] = useState<Record<string, unknown>>(() => ({
    ...defaultValues(spec),
    ...(channel?.fields ?? {}),
  }));
  const [cleared, setCleared] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!spec) return null;

  const changeType = (next: string) => {
    setType(next);
    setValues(defaultValues(schema[next]));
    setCleared([]);
    setError(null);
  };

  const save = async () => {
    const problem = validateForm(spec, values, channel, cleared);
    if (problem) {
      setError(problem);
      return;
    }
    const payload: Record<string, unknown> = { type, name: name.trim() };
    if (channel) payload.id = channel.id;
    const clearList: string[] = [];
    for (const field of spec.fields) {
      const value = values[field.key];
      if (field.secret) {
        if (cleared.includes(field.key)) {
          clearList.push(field.key);
          continue;
        }
        if (value === undefined || value === '') continue;
        payload[field.key] = value;
        continue;
      }
      payload[field.key] = value ?? '';
    }
    if (clearList.length) payload.clear = clearList;

    setSaving(true);
    setError(null);
    try {
      const result = await gateway.call<AlertChannelSaveResponse>('alerts.channels.save', {
        channel: payload,
      });
      onSaved(Array.isArray(result.channels) ? result.channels : [], result.saved);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogPopup className="max-w-[480px]" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-[14px] font-medium">
            {channel ? '编辑推送通道' : '添加推送通道'}
          </DialogTitle>
          <DialogDescription className="text-[12px] leading-relaxed">
            密钥只保存在本机网关配置里，不会回传界面；编辑时留空表示保持不变。
          </DialogDescription>
        </DialogHeader>

        <div className="mx-6 max-h-[60vh] space-y-3 overflow-y-auto pr-1">
          {channel ? (
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-muted-foreground">通道类型</span>
              <Badge variant="outline">{spec.label}</Badge>
              <span className="text-[11px] text-muted-foreground">类型不可修改</span>
            </div>
          ) : (
            <label className="block">
              <span className="mb-1.5 block text-[12px] text-foreground">通道类型</span>
              <Select
                value={type}
                onValueChange={(next) => changeType(next ?? '')}
                items={types.map((item) => ({ value: item, label: schema[item].label }))}
              >
                <SelectTrigger
                  aria-label="通道类型"
                  className="h-8 min-h-8 w-full min-w-0 px-2 text-[12px]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {types.map((item) => (
                    <SelectItem key={item} value={item}>
                      {schema[item].label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>
          )}

          <label className="block">
            <span className="mb-1.5 block text-[12px] text-foreground">名称</span>
            <Input
              value={name}
              maxLength={40}
              placeholder={spec.label}
              onChange={(event) => setName(event.target.value)}
              className="h-8 text-[12px]"
            />
          </label>

          {spec.fields.map((field) => (
            <ChannelFieldControl
              key={field.key}
              field={field}
              value={values[field.key]}
              configured={channel?.secretKeys.includes(field.key) ?? false}
              cleared={cleared.includes(field.key)}
              onChange={(value) =>
                setValues((current) => ({ ...current, [field.key]: value }))
              }
              onToggleClear={() =>
                setCleared((current) =>
                  current.includes(field.key)
                    ? current.filter((key) => key !== field.key)
                    : [...current, field.key],
                )
              }
            />
          ))}

          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive-foreground">
              {error}
            </div>
          )}
        </div>

        <DialogFooter variant="bare">
          <Button variant="outline" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button size="sm" loading={saving} disabled={saving} onClick={() => void save()}>
            保存
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ChannelFieldControl({
  field,
  value,
  configured,
  cleared,
  onChange,
  onToggleClear,
}: {
  field: AlertChannelField;
  value: unknown;
  configured: boolean;
  cleared: boolean;
  onChange: (value: unknown) => void;
  onToggleClear: () => void;
}) {
  const showConfigured = field.secret && configured && !cleared;
  const placeholder = cleared
    ? '保存后会删除这个值'
    : showConfigured
      ? '已配置，留空保持不变'
      : field.placeholder;

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 text-[12px] text-foreground">
        <span>{field.label}</span>
        {field.required && <span className="text-destructive-foreground">*</span>}
        {showConfigured && (
          <Badge variant="secondary" size="sm">
            已配置
          </Badge>
        )}
        {field.secret && configured && !field.required && (
          <button
            type="button"
            onClick={onToggleClear}
            className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {cleared ? '撤销清除' : '清除已保存的值'}
          </button>
        )}
      </div>

      {field.kind === 'bool' ? (
        <Switch checked={Boolean(value)} onCheckedChange={(checked) => onChange(checked)} />
      ) : field.kind === 'select' ? (
        <Select
          value={value == null ? '' : String(value)}
          onValueChange={(next) => onChange(next ?? '')}
          items={
            field.required
              ? (field.options ?? [])
              : [{ value: '', label: '不设置' }, ...(field.options ?? [])]
          }
        >
          <SelectTrigger
            aria-label={field.label}
            className="h-8 min-h-8 w-full min-w-0 px-2 text-[12px]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {!field.required && <SelectItem value="">不设置</SelectItem>}
            {(field.options ?? []).map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : field.kind === 'headers' ? (
        <Textarea
          rows={3}
          size="sm"
          value={typeof value === 'string' ? value : ''}
          placeholder={placeholder}
          disabled={cleared}
          onChange={(event) => onChange(event.target.value)}
          className="text-[12px]"
        />
      ) : (
        <Input
          type={
            field.kind === 'password' ? 'password' : field.kind === 'number' ? 'number' : 'text'
          }
          inputMode={field.kind === 'number' ? 'numeric' : undefined}
          autoComplete={field.kind === 'password' ? 'new-password' : 'off'}
          value={value == null ? '' : String(value)}
          placeholder={placeholder}
          disabled={cleared}
          maxLength={field.maxLength}
          onChange={(event) => onChange(event.target.value)}
          className="h-8 text-[12px]"
        />
      )}

      {field.hint && (
        <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{field.hint}</div>
      )}
    </div>
  );
}

function validateForm(
  spec: AlertChannelTypeSpec,
  values: Record<string, unknown>,
  channel: AlertChannelPublic | undefined,
  cleared: string[],
): string | null {
  for (const field of spec.fields) {
    if (!field.required) continue;
    const configured = channel?.secretKeys.includes(field.key) ?? false;
    if (field.secret && configured && !cleared.includes(field.key)) continue;
    const value = values[field.key];
    const missing =
      value === undefined || value === null || (typeof value === 'string' && !value.trim());
    if (missing) return `${field.label}不能为空`;
  }
  return null;
}
