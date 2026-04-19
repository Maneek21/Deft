/**
 * OpenClaw Gateway RPC client tests — Block 1.1.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/openclaw-gateway.test.ts
 *
 * Uses MockTransport (no real WebSocket) so tests are hermetic. Live
 * integration against a running gateway is exercised via the audit suite,
 * not here.
 *
 * Coverage:
 *   1. JSON-RPC multiplex — two in-flight calls resolve independently
 *   2. Error response rejects with code + message
 *   3. Timeout rejects when no response arrives
 *   4. Server-initiated notification dispatches to subscribers
 *   5. Disconnect rejects pending calls
 *   6. Typed namespace dispatch (skills.install frame shape)
 *   7. Deployment cache reuses instance
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OpenClawGateway,
  type Transport,
  getGatewayForDeployment,
  _clearGatewayCache,
} from '../src/lib/openclaw-gateway.js';

// ─── Mock transport ──────────────────────────────────────────────────────────
class MockTransport implements Transport {
  public sent: string[] = [];
  private openCb: (() => void) | null = null;
  private messageCb: ((frame: string) => void) | null = null;
  private errorCb: ((err: Error) => void) | null = null;
  private closeCb: (() => void) | null = null;
  public closed = false;

  constructor(public autoOpen = true) {
    if (autoOpen) {
      // Fire async so subscribers have time to attach
      queueMicrotask(() => this.openCb?.());
    }
  }
  send(frame: string): void {
    if (this.closed) throw new Error('closed');
    this.sent.push(frame);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.closeCb?.());
  }
  onOpen(cb: () => void): void { this.openCb = cb; if (this.autoOpen && !this.closed) queueMicrotask(() => cb()); }
  onMessage(cb: (frame: string) => void): void { this.messageCb = cb; }
  onError(cb: (err: Error) => void): void { this.errorCb = cb; }
  onClose(cb: () => void): void { this.closeCb = cb; }

  /** Test hook: simulate server sending a frame. */
  emit(frame: string): void {
    this.messageCb?.(frame);
  }
  /** Test hook: simulate server closing the socket. */
  forceClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCb?.();
  }
}

function makeGateway(mock: MockTransport, opts: { disableReconnect?: boolean } = {}) {
  return new OpenClawGateway('ws://mock', 'test-token', {
    transportFactory: () => mock,
    disableReconnect: opts.disableReconnect ?? true,
    logWarn: () => undefined, // suppress noise
  });
}

// ─── 1. JSON-RPC multiplex ───────────────────────────────────────────────────
test('JSON-RPC multiplex: two in-flight calls resolve independently', async () => {
  const mock = new MockTransport();
  const g = makeGateway(mock);

  const p1 = g.call<{ v: number }>('alpha');
  const p2 = g.call<{ v: number }>('beta');

  // Wait a tick for sends to flush
  await new Promise((r) => queueMicrotask(() => r(undefined)));
  await new Promise((r) => queueMicrotask(() => r(undefined)));

  assert.equal(mock.sent.length, 2);
  const r1 = JSON.parse(mock.sent[0]);
  const r2 = JSON.parse(mock.sent[1]);
  assert.equal(r1.method, 'alpha');
  assert.equal(r2.method, 'beta');
  assert.notEqual(r1.id, r2.id);

  // Respond out of order
  mock.emit(JSON.stringify({ jsonrpc: '2.0', id: r2.id, result: { v: 2 } }));
  mock.emit(JSON.stringify({ jsonrpc: '2.0', id: r1.id, result: { v: 1 } }));

  const [v1, v2] = await Promise.all([p1, p2]);
  assert.deepEqual(v1, { v: 1 });
  assert.deepEqual(v2, { v: 2 });

  g.close();
});

// ─── 2. Error response ───────────────────────────────────────────────────────
test('Error response rejects with code + message', async () => {
  const mock = new MockTransport();
  const g = makeGateway(mock);

  const p = g.call('broken');
  await new Promise((r) => queueMicrotask(() => r(undefined)));
  const req = JSON.parse(mock.sent[0]);

  mock.emit(JSON.stringify({
    jsonrpc: '2.0',
    id: req.id,
    error: { code: -32601, message: 'method not found' },
  }));

  await assert.rejects(() => p, /method not found.*code -32601/);
  g.close();
});

// ─── 3. Timeout ──────────────────────────────────────────────────────────────
test('Call rejects on timeout when no response arrives', async () => {
  const mock = new MockTransport();
  const g = makeGateway(mock);

  const p = g.call('slow', {}, { timeoutMs: 25 });
  await assert.rejects(() => p, /timed out after 25ms/);
  g.close();
});

// ─── 4. Subscription ─────────────────────────────────────────────────────────
test('Server notification dispatches to subscribers', async () => {
  const mock = new MockTransport();
  const g = makeGateway(mock);

  // Kick a connection so mock.onOpen fires + socket is ready.
  const p = g.call('handshake');
  await new Promise((r) => queueMicrotask(() => r(undefined)));
  mock.emit(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(mock.sent[0]).id, result: 'ok' }));
  await p;

  const received: unknown[] = [];
  const unsub = g.subscribe('session.message', (params) => received.push(params));

  mock.emit(JSON.stringify({ jsonrpc: '2.0', method: 'session.message', params: { body: 'hi' } }));
  mock.emit(JSON.stringify({ jsonrpc: '2.0', method: 'session.message', params: { body: 'two' } }));

  assert.deepEqual(received, [{ body: 'hi' }, { body: 'two' }]);

  unsub();
  mock.emit(JSON.stringify({ jsonrpc: '2.0', method: 'session.message', params: { body: 'three' } }));
  assert.equal(received.length, 2, 'unsubscribe stops delivery');

  g.close();
});

// ─── 5. Disconnect rejects pending ───────────────────────────────────────────
test('Disconnect rejects pending calls with "gateway disconnected"', async () => {
  const mock = new MockTransport();
  const g = makeGateway(mock);

  const p = g.call('inflight');
  await new Promise((r) => queueMicrotask(() => r(undefined)));
  mock.forceClose();

  await assert.rejects(() => p, /gateway disconnected/);
});

// ─── 6. Typed namespace ──────────────────────────────────────────────────────
test('skills.install sends correct JSON-RPC frame', async () => {
  const mock = new MockTransport();
  const g = makeGateway(mock);

  const p = g.skills.install('slack', '1.2.3');
  await new Promise((r) => queueMicrotask(() => r(undefined)));

  const req = JSON.parse(mock.sent[0]);
  assert.equal(req.jsonrpc, '2.0');
  assert.equal(req.method, 'skills.install');
  assert.deepEqual(req.params, { slug: 'slack', version: '1.2.3' });

  mock.emit(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { installed: true, slug: 'slack' } }));
  const r = await p;
  assert.deepEqual(r, { installed: true, slug: 'slack' });
  g.close();
});

test('agents.files.set sends correct JSON-RPC frame', async () => {
  const mock = new MockTransport();
  const g = makeGateway(mock);

  const p = g.agents.files.set('agent-1', 'SOUL.md', '# persona');
  await new Promise((r) => queueMicrotask(() => r(undefined)));

  const req = JSON.parse(mock.sent[0]);
  assert.equal(req.method, 'agents.files.set');
  assert.deepEqual(req.params, { agentId: 'agent-1', filename: 'SOUL.md', content: '# persona' });

  mock.emit(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { written: true } }));
  assert.deepEqual(await p, { written: true });
  g.close();
});

// ─── 7. Deployment cache ─────────────────────────────────────────────────────
test('getGatewayForDeployment reuses instance across calls', () => {
  _clearGatewayCache();
  const g1 = getGatewayForDeployment('dep-1', 'ws://mock', 't', {
    transportFactory: () => new MockTransport(),
    disableReconnect: true,
    logWarn: () => undefined,
  });
  const g2 = getGatewayForDeployment('dep-1', 'ws://other', 'different', {
    transportFactory: () => new MockTransport(),
    disableReconnect: true,
    logWarn: () => undefined,
  });
  assert.equal(g1, g2, 'same deployment id returns cached instance');
  const g3 = getGatewayForDeployment('dep-2', 'ws://mock', 't', {
    transportFactory: () => new MockTransport(),
    disableReconnect: true,
    logWarn: () => undefined,
  });
  assert.notEqual(g1, g3, 'different deployment id returns new instance');
  _clearGatewayCache();
});

// ─── 8. Metrics ──────────────────────────────────────────────────────────────
test('Metrics: rpc_count + onMetric fire on resolved calls', async () => {
  const mock = new MockTransport();
  const metrics: Array<{ method: string; ok: boolean }> = [];
  const g = new OpenClawGateway('ws://mock', 't', {
    transportFactory: () => mock,
    disableReconnect: true,
    onMetric: (m) => metrics.push({ method: m.method, ok: m.ok }),
    logWarn: () => undefined,
  });

  const p = g.call('ping');
  await new Promise((r) => queueMicrotask(() => r(undefined)));
  const req = JSON.parse(mock.sent[0]);
  mock.emit(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: 'pong' }));
  await p;

  assert.equal(g.metrics.rpc_count, 1);
  assert.deepEqual(metrics, [{ method: 'ping', ok: true }]);
  g.close();
});
