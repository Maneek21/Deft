/**
 * Block 1.10 — trace forwarder tests.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/gateway-trace-forwarder.test.ts
 *
 * Pure unit tests — no DB, no Socket.io. Mock gateway + captured emit
 * calls exercise the subscribe/filter/forward path.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTraceForwarderForSession,
  stopTraceForwarderForSession,
  _setTraceEmitter,
  _resetTraceEmitter,
  _setTraceGatewayResolver,
  _resetTraceGatewayResolver,
  _clearTraceSubs,
  _activeTraceSessionCount,
} from '../src/lib/gateway-trace-forwarder.js';
import { encrypt } from '../src/lib/encryption.js';
import type { OpenClawGateway } from '../src/lib/openclaw-gateway.js';

type EmitCall = { room: string; event: string; payload: any };
let emits: EmitCall[] = [];
type SessionSubscriber = (params: unknown) => void;
let gatewaySubs: Array<{ method: string; cb: SessionSubscriber }>;

function mockGateway(): OpenClawGateway {
  gatewaySubs = [];
  const mock = {
    subscribe: (method: string, cb: SessionSubscriber) => {
      gatewaySubs.push({ method, cb });
      return () => {
        const idx = gatewaySubs.findIndex((s) => s.cb === cb);
        if (idx >= 0) gatewaySubs.splice(idx, 1);
      };
    },
  };
  return mock as unknown as OpenClawGateway;
}

function fireGatewayEvent(method: string, params: unknown) {
  for (const s of gatewaySubs) {
    if (s.method === method) s.cb(params);
  }
}

beforeEach(() => {
  emits = [];
  _clearTraceSubs();
  _setTraceEmitter((room, event, payload) => { emits.push({ room, event, payload }); });
});

afterEach(() => {
  _clearTraceSubs();
  _resetTraceEmitter();
  _resetTraceGatewayResolver();
});

// ─── 1. Happy path forwarding ────────────────────────────────────────────────
test('forwards session.tool + session.message events to org room', async () => {
  _setTraceGatewayResolver(() => mockGateway());

  await startTraceForwarderForSession(
    {
      id: 'emp-1',
      org_id: 'org-A',
      connection_url: 'ws://mock',
      gateway_token_encrypted: encrypt('tok'),
    },
    'session-abc',
  );

  assert.equal(_activeTraceSessionCount(), 1);
  assert.equal(gatewaySubs.length, 2, 'subscribed to both event kinds');

  fireGatewayEvent('session.tool', {
    sessionId: 'session-abc',
    tool_name: 'bash',
    input: { command: 'ls' },
  });
  fireGatewayEvent('session.message', {
    sessionId: 'session-abc',
    role: 'assistant',
    text: 'hello',
  });

  assert.equal(emits.length, 2);
  assert.equal(emits[0]!.room, 'org:org-A');
  assert.equal(emits[0]!.event, 'agent:trace');
  assert.equal(emits[0]!.payload.sessionId, 'session-abc');
  assert.equal(emits[0]!.payload.kind, 'session.tool');
  assert.equal(emits[1]!.payload.kind, 'session.message');
});

// ─── 2. Session filtering ────────────────────────────────────────────────────
test('filters events from other sessions on the same gateway', async () => {
  _setTraceGatewayResolver(() => mockGateway());

  await startTraceForwarderForSession(
    {
      id: 'emp-1',
      org_id: 'org-A',
      connection_url: 'ws://mock',
      gateway_token_encrypted: encrypt('tok'),
    },
    'session-abc',
  );

  fireGatewayEvent('session.tool', { sessionId: 'session-xyz', tool_name: 'other' });
  assert.equal(emits.length, 0, 'other session events filtered out');

  fireGatewayEvent('session.tool', { sessionId: 'session-abc', tool_name: 'mine' });
  assert.equal(emits.length, 1, 'matching session forwarded');
});

// ─── 3. Idempotent start ─────────────────────────────────────────────────────
test('re-calling start for same session replaces subscribers (no leak)', async () => {
  _setTraceGatewayResolver(() => mockGateway());

  const emp = {
    id: 'emp-2',
    org_id: 'org-B',
    connection_url: 'ws://mock',
    gateway_token_encrypted: encrypt('tok'),
  };
  await startTraceForwarderForSession(emp, 'sess-1');
  await startTraceForwarderForSession(emp, 'sess-1');
  await startTraceForwarderForSession(emp, 'sess-1');

  // Only one session registered at a time.
  assert.equal(_activeTraceSessionCount(), 1);

  // Fire one event — only one forward, not three.
  fireGatewayEvent('session.tool', { sessionId: 'sess-1', tool_name: 'ping' });
  assert.equal(emits.length, 1);
});

// ─── 4. Stop unsubscribes ────────────────────────────────────────────────────
test('stop removes subscribers; no further events forwarded', async () => {
  _setTraceGatewayResolver(() => mockGateway());
  await startTraceForwarderForSession(
    {
      id: 'emp-3',
      org_id: 'org-C',
      connection_url: 'ws://mock',
      gateway_token_encrypted: encrypt('tok'),
    },
    'sess-2',
  );
  stopTraceForwarderForSession('sess-2');

  fireGatewayEvent('session.tool', { sessionId: 'sess-2' });
  assert.equal(emits.length, 0);
  assert.equal(_activeTraceSessionCount(), 0);
});

// ─── 5. No gateway connection → silent skip ─────────────────────────────────
test('employees without connection_url are silently skipped', async () => {
  _setTraceGatewayResolver(() => mockGateway());
  await startTraceForwarderForSession(
    {
      id: 'emp-4',
      org_id: 'org-D',
      connection_url: null,
      gateway_token_encrypted: null,
    },
    'sess-3',
  );
  assert.equal(_activeTraceSessionCount(), 0);
});

// ─── 6. Decrypt failure → silent skip ───────────────────────────────────────
test('decrypt failures do not throw', async () => {
  _setTraceGatewayResolver(() => mockGateway());
  await startTraceForwarderForSession(
    {
      id: 'emp-5',
      org_id: 'org-E',
      connection_url: 'ws://mock',
      gateway_token_encrypted: 'not-valid-ciphertext',
    },
    'sess-4',
  );
  assert.equal(_activeTraceSessionCount(), 0);
});
