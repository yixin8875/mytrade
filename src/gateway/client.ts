import type { ConnState } from './types';

export class GatewayRequestError extends Error {
  code: string;
  detail?: unknown;

  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.name = 'GatewayRequestError';
    this.code = code;
    this.detail = detail;
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: number;
};

type EventHandler = (data: unknown) => void;
type StateHandler = (state: ConnState) => void;

export class GatewayClient {
  state: ConnState = 'closed';

  private ws: WebSocket | null = null;
  private readonly url: string;
  private seq = 0;
  private retry = 0;
  private stopped = true;
  private reconnectTimer: number | null = null;
  private pending = new Map<string, Pending>();
  private handlers = new Map<string, Set<EventHandler>>();
  private stateHandlers = new Set<StateHandler>();

  constructor(url = 'ws://127.0.0.1:8765/ws') {
    this.url = url;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer != null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setState('closed');
    // 浏览器的 close 事件是异步的；主动停止时立刻结束在途请求，别让它们等到超时
    this.rejectAll('网关已停止');
  }

  on(event: string, handler: EventHandler): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => set?.delete(handler);
  }

  onState(handler: StateHandler): () => void {
    this.stateHandlers.add(handler);
    handler(this.state);
    return () => this.stateHandlers.delete(handler);
  }

  call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 8000): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new GatewayRequestError('OFFLINE', '网关未连接'));
    }
    const id = String(++this.seq);
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new GatewayRequestError('TIMEOUT', `请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.ws?.send(JSON.stringify({ id, method, params }));
    });
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.setState('open');
      this.emit('open', null);
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      try {
        this.handle(JSON.parse(event.data));
      } catch {
        // 忽略无法解析的消息
      }
    };

    ws.onerror = () => {
      // onclose 会负责重连
    };

    ws.onclose = () => {
      // 已经换过连接（stop 后重新 start、或重连已建立）时，旧连接迟到的 close 不再影响当前状态
      if (this.ws !== ws) return;
      this.ws = null;
      this.setState('closed');
      this.rejectAll('网关连接已断开');
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer != null) return;
    const delay = Math.min(5000, 500 * 2 ** Math.min(this.retry, 4));
    this.retry += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private setState(state: ConnState): void {
    if (this.state === state) return;
    this.state = state;
    this.stateHandlers.forEach((handler) => handler(state));
  }

  private handle(message: {
    id?: string | null;
    result?: unknown;
    error?: { code: string; message: string; detail?: unknown };
    event?: string;
    data?: unknown;
  }): void {
    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      window.clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new GatewayRequestError(message.error.code, message.error.message, message.error.detail),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.event) this.emit(message.event, message.data);
  }

  private emit(event: string, data: unknown): void {
    this.handlers.get(event)?.forEach((handler) => handler(data));
  }

  private rejectAll(reason: string): void {
    this.pending.forEach((pending) => {
      window.clearTimeout(pending.timer);
      pending.reject(new GatewayRequestError('CLOSED', reason));
    });
    this.pending.clear();
  }
}

export const gateway = new GatewayClient();
