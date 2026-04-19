/**
 * OpenClaw Gateway RPC client — Block 1.1 of OpenClaw Unlock plan.
 *
 * WebSocket JSON-RPC 2.0 client against the OpenClaw Gateway protocol
 * (docs.openclaw.ai/gateway/protocol). Scope here is control-plane
 * operations only: skills.install, agents.files.get/set, exec.approval.*,
 * sessions.messages.subscribe, config.set, cron.*.
 *
 * We do NOT replace openclaw-client.ts (HTTP SSE chat dispatch). The two
 * serve different concerns and the additive model keeps chat streaming
 * stable while we incrementally wire control operations over WebSocket.
 *
 * Design:
 *   - One OpenClawGateway instance per deployment_id. Lazy connect on
 *     first RPC call.
 *   - JSON-RPC multiplex by numeric id; each pending call is a Promise
 *     keyed in `this.pending`.
 *   - Auto-reconnect with exponential backoff: 1s → 2s → 4s → 8s → 30s.
 *     Pending calls in flight at disconnect reject with 'disconnected'
 *     so callers can retry at the application layer.
 *   - 30s default per-call timeout; caller can override via opts.
 *   - Metrics emitted to the optional `metrics` callback; no hard
 *     dependency on a metrics library so tests can plug in.
 *
 * Transport is abstracted via the `Transport` interface so tests can
 * inject a MockTransport without opening a real socket.
 */

// ─── JSON-RPC types ───────────────────────────────────────────────────
export type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
};

export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: number; result: unknown }
  | { jsonrpc: '2.0'; id: number; error: { code: number; message: string; data?: unknown } };

export type JsonRpcNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
};

// ─── Transport abstraction (WebSocket in prod, mock in tests) ─────────
export interface Transport {
  send(frame: string): void;
  close(): void;
  /** Called when connection is ready to accept sends. */
  onOpen(cb: () => void): void;
  /** Each incoming text frame. */
  onMessage(cb: (frame: string) => void): void;
  onError(cb: (err: Error) => void): void;
  onClose(cb: () => void): void;
}

export class WebSocketTransport implements Transport {
  private ws: WebSocket | null = null;
  private openCb: (() => void) | null = null;
  private messageCb: ((frame: string) => void) | null = null;
  private errorCb: ((err: Error) => void) | null = null;
  private closeCb: (() => void) | null = null;

  constructor(private url: string, private authToken: string) {
    this.connect();
  }

  private connect() {
    try {
      // Node >=22 has WebSocket global. Bearer auth via subprotocol OR header.
      // OpenClaw supports bearer via `Sec-WebSocket-Protocol: deft, bearer.<token>`
      // per docs, but browsers restrict header setting. For Node we use query
      // string `?token=...` which the gateway accepts as equivalent.
      const sep = this.url.includes('?') ? '&' : '?';
      const url = `${this.url}${sep}token=${encodeURIComponent(this.authToken)}`;
      this.ws = new WebSocket(url);
      this.ws.addEventListener('open', () => {
        if (this.openCb) this.openCb();
      });
      this.ws.addEventListener('message', (ev: MessageEvent) => {
        if (this.messageCb) this.messageCb(String(ev.data));
      });
      this.ws.addEventListener('error', (ev: Event) => {
        if (this.errorCb) this.errorCb(new Error(`WebSocket error: ${(ev as ErrorEvent).message ?? 'unknown'}`));
      });
      this.ws.addEventListener('close', () => {
        if (this.closeCb) this.closeCb();
      });
    } catch (err) {
      if (this.errorCb) this.errorCb(err as Error);
    }
  }

  send(frame: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('transport not open');
    }
    this.ws.send(frame);
  }

  close(): void {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      this.ws.close();
    }
  }

  onOpen(cb: () => void): void { this.openCb = cb; }
  onMessage(cb: (frame: string) => void): void { this.messageCb = cb; }
  onError(cb: (err: Error) => void): void { this.errorCb = cb; }
  onClose(cb: () => void): void { this.closeCb = cb; }
}

// ─── Gateway client ───────────────────────────────────────────────────
export type GatewayMetrics = {
  rpc_count: number;
  rpc_latency_ms: number[];
  reconnect_count: number;
  errors: number;
};

export type GatewayOptions = {
  /** Per-call timeout. Default 30s. */
  callTimeoutMs?: number;
  /** Factory for transports — override in tests. */
  transportFactory?: (url: string, token: string) => Transport;
  /** Metrics sink called on each completed RPC. */
  onMetric?: (metric: { method: string; latency_ms: number; ok: boolean }) => void;
  /** Disable auto-reconnect (useful for tests). */
  disableReconnect?: boolean;
  /** Logger. Defaults to console.warn. */
  logWarn?: (msg: string, ...args: unknown[]) => void;
};

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  method: string;
  startedAt: number;
  timeout: NodeJS.Timeout;
};

const MAX_BACKOFF_MS = 30_000;

export class OpenClawGateway {
  private transport: Transport | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private subscribers = new Map<string, Set<(params: unknown) => void>>();
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private closed = false;
  public metrics: GatewayMetrics = { rpc_count: 0, rpc_latency_ms: [], reconnect_count: 0, errors: 0 };

  constructor(
    public readonly url: string,
    public readonly authToken: string,
    private opts: GatewayOptions = {},
  ) {}

  // ─── Connection lifecycle ───────────────────────────────────────────
  private createTransport(): Transport {
    if (this.opts.transportFactory) {
      return this.opts.transportFactory(this.url, this.authToken);
    }
    return new WebSocketTransport(this.url, this.authToken);
  }

  private ensureConnected(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('gateway closed'));
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const t = this.createTransport();
      this.transport = t;

      const onOpen = () => {
        this.reconnectAttempt = 0;
        resolve();
      };
      const onMessage = (frame: string) => this.handleFrame(frame);
      const onError = (err: Error) => {
        this.metrics.errors++;
        this.logWarn(`gateway error: ${err.message}`);
      };
      const onClose = () => {
        const wasConnecting = !!this.connectPromise;
        this.connectPromise = null;
        // Reject any pending calls — they lost their response channel.
        for (const [id, p] of this.pending) {
          clearTimeout(p.timeout);
          p.reject(new Error('gateway disconnected'));
          this.pending.delete(id);
        }
        if (wasConnecting && this.reconnectAttempt === 0) {
          reject(new Error('gateway closed during connect'));
        }
        if (!this.closed && !this.opts.disableReconnect) {
          this.scheduleReconnect();
        }
      };

      t.onOpen(onOpen);
      t.onMessage(onMessage);
      t.onError(onError);
      t.onClose(onClose);
    });
    return this.connectPromise;
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.closed) return;
    this.reconnectAttempt++;
    this.metrics.reconnect_count++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt - 1), MAX_BACKOFF_MS);
    this.logWarn(`gateway reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnected().catch(() => { /* scheduleReconnect re-fires on close */ });
    }, delay);
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.transport) this.transport.close();
    this.transport = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timeout);
      p.reject(new Error('gateway closed'));
      this.pending.delete(id);
    }
  }

  // ─── Frame handling ─────────────────────────────────────────────────
  private handleFrame(frame: string): void {
    let parsed: JsonRpcResponse | JsonRpcNotification;
    try {
      parsed = JSON.parse(frame);
    } catch {
      this.logWarn('gateway: unparsable frame', frame.slice(0, 200));
      return;
    }
    // Response to a pending call?
    if (parsed && typeof parsed === 'object' && 'id' in parsed && typeof parsed.id === 'number') {
      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      this.pending.delete(parsed.id);
      clearTimeout(pending.timeout);
      const latency = Date.now() - pending.startedAt;
      this.metrics.rpc_latency_ms.push(latency);
      if ('error' in parsed) {
        this.opts.onMetric?.({ method: pending.method, latency_ms: latency, ok: false });
        pending.reject(new Error(`${parsed.error.message} (code ${parsed.error.code})`));
      } else {
        this.opts.onMetric?.({ method: pending.method, latency_ms: latency, ok: true });
        pending.resolve(parsed.result);
      }
      return;
    }
    // Server-initiated notification (e.g. session.message, exec.approval.request)
    if (parsed && typeof parsed === 'object' && 'method' in parsed) {
      const subs = this.subscribers.get(parsed.method);
      if (subs) {
        for (const cb of subs) {
          try { cb(parsed.params); } catch (err) {
            this.logWarn(`subscriber for ${parsed.method} threw:`, (err as Error).message);
          }
        }
      }
    }
  }

  // ─── Core RPC ───────────────────────────────────────────────────────
  async call<T = unknown>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T> {
    await this.ensureConnected();
    const id = this.nextId++;
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const timeoutMs = opts?.timeoutMs ?? this.opts.callTimeoutMs ?? 30_000;

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        this.opts.onMetric?.({ method, latency_ms: timeoutMs, ok: false });
        reject(new Error(`gateway RPC ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        method,
        startedAt: Date.now(),
        timeout,
      });
      this.metrics.rpc_count++;
      try {
        this.transport!.send(JSON.stringify(request));
      } catch (err) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  // ─── Subscription to server-initiated events ────────────────────────
  subscribe(eventMethod: string, cb: (params: unknown) => void): () => void {
    let set = this.subscribers.get(eventMethod);
    if (!set) {
      set = new Set();
      this.subscribers.set(eventMethod, set);
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
      if (set!.size === 0) this.subscribers.delete(eventMethod);
    };
  }

  // ─── Typed namespaces ──────────────────────────────────────────────
  skills = {
    install: (slug: string, version?: string) =>
      this.call<{ installed: boolean; slug: string }>('skills.install', { slug, version }),
    remove: (slug: string) => this.call<{ removed: boolean }>('skills.remove', { slug }),
    list: () => this.call<Array<{ slug: string; version: string; enabled: boolean }>>('skills.list'),
    status: () => this.call<{ ready: boolean; count: number }>('skills.status'),
    search: (query: string) =>
      this.call<Array<{ slug: string; description: string; homepage?: string }>>('skills.search', { query }),
  };

  agents = {
    files: {
      get: (agentId: string, filename: string) =>
        this.call<{ content: string; exists: boolean }>('agents.files.get', { agentId, filename }),
      set: (agentId: string, filename: string, content: string) =>
        this.call<{ written: boolean }>('agents.files.set', { agentId, filename, content }),
      list: (agentId: string) =>
        this.call<Array<{ filename: string; size: number }>>('agents.files.list', { agentId }),
    },
  };

  exec = {
    approval: {
      list: () =>
        this.call<Array<{ id: string; command: string; requested_at: string }>>('exec.approval.list'),
      resolve: (approvalId: string, approved: boolean, reason?: string) =>
        this.call<{ resolved: boolean }>('exec.approval.resolve', { approvalId, approved, reason }),
    },
  };

  config = {
    set: (path: string, value: unknown) => this.call<{ set: boolean }>('config.set', { path, value }),
    get: (path: string) => this.call<{ value: unknown }>('config.get', { path }),
  };

  sessions = {
    send: (sessionId: string, message: string) =>
      this.call<{ accepted: boolean }>('sessions.send', { sessionId, message }),
    steer: (sessionId: string, steering: string) =>
      this.call<{ steered: boolean }>('sessions.steer', { sessionId, steering }),
    messages: {
      subscribe: (sessionId: string, cb: (event: unknown) => void): Promise<() => void> =>
        this.call<{ subscribed: boolean }>('sessions.messages.subscribe', { sessionId }).then(() => {
          const unsub = this.subscribe('session.message', (params) => {
            if (params && typeof params === 'object' && (params as { sessionId?: string }).sessionId === sessionId) {
              cb(params);
            }
          });
          return () => {
            unsub();
            this.call('sessions.messages.unsubscribe', { sessionId }).catch(() => undefined);
          };
        }),
    },
  };

  cron = {
    add: (spec: { name: string; schedule: string; target: string }) =>
      this.call<{ id: string }>('cron.add', spec),
    remove: (id: string) => this.call<{ removed: boolean }>('cron.remove', { id }),
    list: () => this.call<Array<{ id: string; name: string; schedule: string }>>('cron.list'),
  };

  private logWarn(msg: string, ...args: unknown[]) {
    const log = this.opts.logWarn ?? ((m: string, ...a: unknown[]) => console.warn(m, ...a));
    log(`[openclaw-gateway ${this.url}] ${msg}`, ...args);
  }
}

// ─── Deployment-id-scoped factory ─────────────────────────────────────
/**
 * In-memory cache of Gateway instances keyed by deployment_id so every
 * caller reuses the same WebSocket + pending-call multiplex. Safe across
 * routes + workers because the API runs single-process.
 */
const gatewayCache = new Map<string, OpenClawGateway>();

export function getGatewayForDeployment(
  deploymentId: string,
  url: string,
  token: string,
  opts?: GatewayOptions,
): OpenClawGateway {
  let g = gatewayCache.get(deploymentId);
  if (!g) {
    g = new OpenClawGateway(url, token, opts);
    gatewayCache.set(deploymentId, g);
  }
  return g;
}

export function closeGatewayForDeployment(deploymentId: string): void {
  const g = gatewayCache.get(deploymentId);
  if (g) {
    g.close();
    gatewayCache.delete(deploymentId);
  }
}

/** Test-only cache clear. */
export function _clearGatewayCache(): void {
  for (const g of gatewayCache.values()) g.close();
  gatewayCache.clear();
}
