import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayClient, GatewayRequestError } from './client';

class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  /** 浏览器里 close 之后的 onclose 是异步的，这里也保持异步由测试手动触发 */
  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  fireClose(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent<string>);
  }
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function connected(url = 'ws://test') {
  const client = new GatewayClient(url);
  client.start();
  const socket = FakeSocket.instances.at(-1)!;
  socket.open();
  return { client, socket };
}

function lastRequest(socket: FakeSocket): { id: string; method: string; params: unknown } {
  return JSON.parse(socket.sent.at(-1)!) as { id: string; method: string; params: unknown };
}

describe('GatewayClient 连接状态', () => {
  it('初始为 closed，start 后依次变为 connecting / open', () => {
    const client = new GatewayClient();
    const states: string[] = [];
    client.onState((state) => states.push(state));

    expect(states).toEqual(['closed']);
    client.start();
    expect(states).toEqual(['closed', 'connecting']);

    FakeSocket.instances[0].open();
    expect(states).toEqual(['closed', 'connecting', 'open']);
    expect(client.state).toBe('open');
  });

  it('断开后按退避重连', async () => {
    const { client, socket } = connected();

    socket.fireClose();
    expect(client.state).toBe('closed');
    await vi.advanceTimersByTimeAsync(499);
    expect(FakeSocket.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(client.state).toBe('connecting');
  });
});

describe('GatewayClient.call', () => {
  it('未连接时立即拒绝', async () => {
    const client = new GatewayClient();
    await expect(client.call('system.health')).rejects.toMatchObject({ code: 'OFFLINE' });
  });

  it('发送请求并匹配 id 解析结果', async () => {
    const { client, socket } = connected();

    const promise = client.call<{ ok: boolean }>('system.health');
    const request = lastRequest(socket);
    expect(request.method).toBe('system.health');
    expect(request.params).toEqual({});

    socket.receive({ id: request.id, result: { ok: true } });
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('错误响应转成 GatewayRequestError', async () => {
    const { client, socket } = connected();
    const promise = client.call('order.place');
    const request = lastRequest(socket);

    socket.receive({
      id: request.id,
      error: { code: 'DENIED', message: '不允许下单', detail: { ticket: 7 } },
    });

    const error = await promise.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(GatewayRequestError);
    expect(error).toMatchObject({ code: 'DENIED', message: '不允许下单', detail: { ticket: 7 } });
  });

  it('超时后拒绝并清掉挂起请求', async () => {
    const { client, socket } = connected();
    const promise = client.call('slow.call', {}, 1000);
    const expectation = expect(promise).rejects.toMatchObject({ code: 'TIMEOUT' });

    await vi.advanceTimersByTimeAsync(1000);
    await expectation;

    // 迟到的响应不会再次影响任何东西
    socket.receive({ id: lastRequest(socket).id, result: 'late' });
  });

  it('连接断开时在途请求全部拒绝', async () => {
    const { client, socket } = connected();
    const first = client.call('a');
    const second = client.call('b');
    const expectations = Promise.all([
      expect(first).rejects.toMatchObject({ code: 'CLOSED', message: '网关连接已断开' }),
      expect(second).rejects.toMatchObject({ code: 'CLOSED', message: '网关连接已断开' }),
    ]);

    socket.fireClose();
    await expectations;
  });
});

describe('GatewayClient.stop', () => {
  it('主动停止会关闭状态、拒绝在途请求且不再重连', async () => {
    const { client, socket } = connected();
    const promise = client.call('x');
    const expectation = expect(promise).rejects.toMatchObject({
      code: 'CLOSED',
      message: '网关已停止',
    });

    client.stop();
    await expectation;
    expect(client.state).toBe('closed');

    socket.fireClose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeSocket.instances).toHaveLength(1);
    await expect(client.call('x')).rejects.toMatchObject({ code: 'OFFLINE' });
  });

  it('旧连接迟到的 close 不会影响已经建立的新连接', async () => {
    const { client, socket } = connected();

    socket.fireClose();
    await vi.advanceTimersByTimeAsync(500);
    const next = FakeSocket.instances.at(-1)!;
    next.open();
    expect(client.state).toBe('open');

    const promise = client.call<number>('ping');
    const expectation = expect(promise).resolves.toBe(42);
    socket.onclose?.(); // 旧连接的 close 事件晚到

    expect(client.state).toBe('open');
    next.receive({ id: lastRequest(next).id, result: 42 });
    await expectation;
  });
});

describe('GatewayClient 事件', () => {
  it('按事件名分发并支持取消订阅', () => {
    const { client, socket } = connected();
    const handler = vi.fn();
    const off = client.on('quote', handler);

    socket.receive({ event: 'quote', data: { symbol: 'XAUUSD', bid: 3980 } });
    expect(handler).toHaveBeenCalledWith({ symbol: 'XAUUSD', bid: 3980 });

    off();
    socket.receive({ event: 'quote', data: { symbol: 'XAUUSD', bid: 3981 } });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ symbol: 'XAUUSD', bid: 3980 });
  });

  it('无法解析的消息被忽略', () => {
    const { socket } = connected();
    expect(() => socket.onmessage?.({ data: '{not json' } as MessageEvent<string>)).not.toThrow();
  });
});
