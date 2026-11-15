/**
 * Paused start on live connections: events that write or notify are refused,
 * presence bookkeeping is not written, reading stays open.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { setupSocket, type SocketUser } from '../src/socket.js';
import { _setPausedStartForTest } from '../src/lib/paused-start.js';

const { io: connectSocket } = createRequire(new URL('../../web/package.json', import.meta.url))('socket.io-client');

const stamp = Date.now();
const ORG = `paused-socket-org-${stamp}`;
const exp = Math.floor(Date.now() / 1000) + 600;

afterEach(() => _setPausedStartForTest(false));

async function harness() {
  const principal: SocketUser & { exp: number } = { id: `paused-user-${stamp}`, org_id: ORG, email: 'p@test.local', sid: 's-1', exp };
  const calls = { spaceAccess: 0, lastSeen: 0 };
  const server = createServer();
  const sockets = setupSocket(server, {
    verifyAccess: async (token: string) => { if (token !== 'good') throw new Error('bad'); return principal as any; },
    requireMembership: async () => ({ role: 'member' }) as any,
    getSpaceAccess: async () => { calls.spaceAccess++; return undefined; },
    recordLastSeen: () => { calls.lastSeen++; },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const client = connectSocket(`http://127.0.0.1:${port}`, { auth: { token: 'good' }, transports: ['websocket'], reconnection: false });
  const events: Array<{ event: string; data: any }> = [];
  client.onAny((event: string, data: unknown) => events.push({ event, data }));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('presence:init timed out')), 5_000);
    client.once('presence:init', () => { clearTimeout(timer); resolve(); });
  });
  return {
    client, events, calls,
    close: async () => { client.close(); await new Promise<void>((resolve) => sockets.close(() => resolve())); },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 200));

test('paused: huddle:create is refused, last-seen is not written, reads still answered', async () => {
  _setPausedStartForTest(true);
  const h = await harness();
  try {
    assert.equal(h.calls.lastSeen, 0, 'connect wrote last_seen_at while paused');
    h.client.emit('huddle:create', { space_id: 'space-1' });
    h.client.emit('presence:active');
    h.client.emit('space:join', 'space-1');
    await settle();
    assert.equal(h.calls.lastSeen, 0, 'presence:active wrote last_seen_at while paused');
    const refused = h.events.find((e) => e.event === 'paused:refused');
    assert.equal(refused?.data?.code, 'PAUSED');
    assert.equal(refused?.data?.event, 'huddle:create');
    // huddle:create never reached its handler (which checks space access); space:join (a read) did.
    assert.equal(h.calls.spaceAccess, 1);
  } finally {
    await h.close();
  }
});

test('not paused: huddle:create reaches its handler and last-seen is written', async () => {
  const h = await harness();
  try {
    h.client.emit('huddle:create', { space_id: 'space-1' });
    await settle();
    assert.equal(h.calls.lastSeen, 1);
    assert.equal(h.calls.spaceAccess, 1);
    assert.equal(h.events.some((e) => e.event === 'paused:refused'), false);
  } finally {
    await h.close();
  }
});
