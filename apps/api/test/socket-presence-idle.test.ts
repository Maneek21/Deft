/**
 * Idle presence must not go stale when a user's socket set changes. Presence
 * is tracked per (org, user) across all of that user's sockets; peers learn
 * of changes only through `presence:update`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { setupSocket, getUserStatus, type SocketUser } from '../src/socket.js';

const { io: connectSocket } = createRequire(new URL('../../web/package.json', import.meta.url))('socket.io-client');

const stamp = Date.now();
const ORG = `presence-org-${stamp}`;
const exp = Math.floor(Date.now() / 1000) + 600;
type Principal = SocketUser & { exp: number };
const principal = (id: string, sid: string): Principal => ({ id, org_id: ORG, email: `${id}@test.local`, sid, exp });

async function harness(principals: Record<string, Principal>) {
  const server = createServer();
  const sockets = setupSocket(server, {
    verifyAccess: async (token: string) => {
      const found = principals[token];
      if (!found) throw new Error('unknown token');
      return found as any;
    },
    requireMembership: async () => ({ role: 'member' }) as any,
    getSpaceAccess: async () => undefined,
    recordLastSeen: () => {},
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const clients: any[] = [];
  const open = async (token: string) => {
    const client = connectSocket(`http://127.0.0.1:${port}`, { auth: { token }, transports: ['websocket'], reconnection: false });
    clients.push(client);
    const events: Array<{ event: string; data: any }> = [];
    client.onAny((event: string, data: unknown) => events.push({ event, data }));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`presence:init timed out for ${token}`)), 5_000);
      client.once('presence:init', () => { clearTimeout(timer); resolve(); });
    });
    return { client, events };
  };
  return {
    open,
    close: async () => {
      for (const client of clients) client.close();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
    },
  };
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), `timed out: ${label}`);
}
const settle = () => new Promise((r) => setTimeout(r, 200));

test('presence: a new tab for an idle user tells peers the user is online again', async () => {
  const viewerId = `presence-viewer-${stamp}`;
  const userId = `presence-user-${stamp}`;
  const h = await harness({ viewer: principal(viewerId, 'p-1'), tab1: principal(userId, 'p-2'), tab2: principal(userId, 'p-3') });
  try {
    const viewer = await h.open('viewer');
    const tab1 = await h.open('tab1');
    tab1.client.emit('presence:idle');
    const statusesFor = () => viewer.events.filter((e) => e.event === 'presence:update' && e.data?.user_id === userId).map((e) => e.data.status);
    await waitFor(() => statusesFor().at(-1) === 'idle', 'viewer sees idle');
    await h.open('tab2');
    await settle();
    // The server now reports the user as online; peers must not keep showing idle.
    assert.equal(getUserStatus(ORG, userId), 'online');
    assert.equal(statusesFor().at(-1), 'online', 'peers were left with a stale idle status');
  } finally {
    await h.close();
  }
});

test('presence: last socket closing while idle clears idle, and reconnecting reports online', async () => {
  const viewerId = `presence-viewer2-${stamp}`;
  const userId = `presence-user2-${stamp}`;
  const h = await harness({ viewer: principal(viewerId, 'q-1'), tab: principal(userId, 'q-2'), again: principal(userId, 'q-3') });
  try {
    const viewer = await h.open('viewer');
    const tab = await h.open('tab');
    tab.client.emit('presence:idle');
    const statusesFor = () => viewer.events.filter((e) => e.event === 'presence:update' && e.data?.user_id === userId).map((e) => e.data.status);
    await waitFor(() => statusesFor().at(-1) === 'idle', 'viewer sees idle');
    tab.client.close();
    await waitFor(() => statusesFor().at(-1) === 'offline', 'viewer sees offline');
    assert.equal(getUserStatus(ORG, userId), 'offline');
    await h.open('again');
    await waitFor(() => statusesFor().at(-1) === 'online', 'viewer sees online after reconnect');
    assert.equal(getUserStatus(ORG, userId), 'online');
  } finally {
    await h.close();
  }
});
