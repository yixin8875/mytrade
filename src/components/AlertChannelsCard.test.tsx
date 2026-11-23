import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gateway } from '../gateway/client';
import { AlertChannelsCard } from './AlertChannelsCard';

const SCHEMA = {
  telegram: {
    label: 'Telegram',
    fields: [
      {
        key: 'token',
        label: 'Bot Token',
        kind: 'password',
        required: true,
        secret: true,
        placeholder: '123456:ABC',
      },
      {
        key: 'chatId',
        label: 'Chat ID',
        kind: 'text',
        required: true,
        placeholder: '-100123',
      },
    ],
  },
};

const CHANNEL = {
  id: 'c1',
  type: 'telegram',
  typeLabel: 'Telegram',
  name: '交易群',
  fields: { chatId: '-100' },
  secretKeys: ['token'],
};

type CallImpl = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

function mockGateway() {
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const impl: CallImpl = (method, params) => {
    calls.push({ method, params });
    if (method === 'alerts.channels.list') {
      return Promise.resolve({ channels: [CHANNEL], schema: SCHEMA });
    }
    if (method === 'alerts.channels.save') {
      return Promise.resolve({
        channels: [CHANNEL],
        saved: { id: 'c1', type: 'telegram', name: '交易群' },
      });
    }
    if (method === 'alerts.channels.delete') {
      return Promise.resolve({ channels: [], deleted: CHANNEL });
    }
    if (method === 'alerts.channels.test') return Promise.resolve({ queued: true, id: 'c1' });
    return Promise.resolve(null);
  };
  vi.spyOn(gateway, 'call').mockImplementation(impl as unknown as typeof gateway.call);
  return calls;
}

function captureEvents() {
  const handlers = new Map<string, (data: unknown) => void>();
  vi.spyOn(gateway, 'on').mockImplementation(((event: string, handler: (data: unknown) => void) => {
    handlers.set(event, handler);
    return () => handlers.delete(event);
  }) as unknown as typeof gateway.on);
  return handlers;
}

function savePayload(calls: { method: string; params?: Record<string, unknown> }[]) {
  const call = calls.find((item) => item.method === 'alerts.channels.save');
  return (call?.params ?? {}) as { channel?: Record<string, unknown> };
}

afterEach(() => vi.restoreAllMocks());

describe('AlertChannelsCard', () => {
  it('列出通道，只显示类型、名称与非密钥摘要', async () => {
    mockGateway();
    render(<AlertChannelsCard />);

    expect(await screen.findByText('交易群')).toBeInTheDocument();
    expect(screen.getByText('Telegram')).toBeInTheDocument();
    expect(screen.getByText('chat -100')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加通道' })).toBeEnabled();
  });

  it('新增通道时提交填写的密钥', async () => {
    const calls = mockGateway();
    const user = userEvent.setup();
    render(<AlertChannelsCard />);

    await user.click(await screen.findByRole('button', { name: '添加通道' }));
    await user.type(screen.getByPlaceholderText('Telegram'), '新群');
    await user.type(screen.getByPlaceholderText('123456:ABC'), 'tok-123');
    await user.type(screen.getByPlaceholderText('-100123'), '-200');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(savePayload(calls).channel).toBeTruthy());
    expect(savePayload(calls).channel).toEqual({
      type: 'telegram',
      name: '新群',
      token: 'tok-123',
      chatId: '-200',
    });
  });

  it('编辑时密钥留空，保存不携带密钥字段', async () => {
    const calls = mockGateway();
    const user = userEvent.setup();
    render(<AlertChannelsCard />);

    await user.click(await screen.findByRole('button', { name: '编辑 交易群' }));
    expect(screen.getByPlaceholderText('已配置，留空保持不变')).toBeInTheDocument();

    const nameInput = screen.getByPlaceholderText('Telegram') as HTMLInputElement;
    expect(nameInput.value).toBe('交易群');
    await user.clear(nameInput);
    await user.type(nameInput, '改名');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(savePayload(calls).channel).toBeTruthy());
    const payload = savePayload(calls).channel ?? {};
    expect(payload).not.toHaveProperty('token');
    expect(payload).toMatchObject({
      id: 'c1',
      type: 'telegram',
      name: '改名',
      chatId: '-100',
    });
  });

  it('删除需要第二次点击确认', async () => {
    const calls = mockGateway();
    const user = userEvent.setup();
    render(<AlertChannelsCard />);

    await user.click(await screen.findByRole('button', { name: '删除 交易群' }));
    expect(calls.some((item) => item.method === 'alerts.channels.delete')).toBe(false);

    await user.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() =>
      expect(calls.find((item) => item.method === 'alerts.channels.delete')?.params).toEqual({
        id: 'c1',
      }),
    );
  });

  it('旧网关缺少通道 RPC 时提示升级并禁用新增', async () => {
    vi.spyOn(gateway, 'call').mockImplementation(((method: string) => {
      if (method === 'alerts.channels.list') {
        return Promise.reject(
          Object.assign(new Error('未知方法: alerts.channels.list'), { code: 'UNKNOWN_METHOD' }),
        );
      }
      return Promise.resolve(null);
    }) as unknown as typeof gateway.call);

    render(<AlertChannelsCard />);

    expect(
      await screen.findByText('当前网关版本不支持通道管理，请升级后重试'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加通道' })).toBeDisabled();
  });

  it('测试单个通道，收到事件后结束「测试中」状态', async () => {
    const calls = mockGateway();
    const handlers = captureEvents();
    const user = userEvent.setup();
    render(<AlertChannelsCard />);

    await user.click(await screen.findByRole('button', { name: '测试' }));
    await waitFor(() =>
      expect(calls.find((item) => item.method === 'alerts.channels.test')?.params).toMatchObject({
        id: 'c1',
      }),
    );
    expect(screen.getByRole('button', { name: '测试中…' })).toBeInTheDocument();

    act(() => {
      handlers.get('alertChannelTest')?.({
        id: 'c1',
        requestId: 'r1',
        label: 'Telegram',
        type: 'telegram',
        ok: true,
      });
    });

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '测试中…' })).not.toBeInTheDocument(),
    );
  });
});
