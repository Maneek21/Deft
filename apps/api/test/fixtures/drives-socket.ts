/**
 * Socket.io clients for people of a drives fixture's workspace, through the
 * real socket server (setupSocket; roles come from org_members), recording
 * every event each one receives. Used to check who is sent document events
 * (consult rule C4).
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { setupSocket } from '../../src/socket.js';

const { io: connectSocket } = createRequire(new URL('../../../web/package.json', import.meta.url))('socket.io-client');

type Received = Array<{ event: string; data: any }>;

export type SocketHarness = {
  /** The `document:updated` payloads `userId` received, in order. */
  updates(userId: string): any[];
  /** The payloads of `event` that `userId` received, in order (e.g. `document:shared`). */
  received(userId: string, event: string): any[];
  close(): Promise<void>;
};

export async function socketHarness(orgId: string, people: string[]): Promise<SocketHarness> {
  const server = createServer();
  const principals = new Map(people.map((id) => [`token-${id}`, { id, email: `${id}@drives.test`, org_id: orgId, sid: `sid-${id}`, exp: Math.floor(Date.now() / 1000) + 600 }]));
  const sockets = setupSocket(server, {
    verifyAccess: async (token: string) => {
      const principal = principals.get(token);
      if (!principal) throw new Error('unknown token');
      return principal as any;
    },
    getSpaceAccess: async () => undefined,
    recordLastSeen: () => {},
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const clients: any[] = [];
  const received = new Map<string, Received>();
  for (const id of people) {
    const client = connectSocket(`http://127.0.0.1:${port}`, { auth: { token: `token-${id}` }, transports: ['websocket'], reconnection: false });
    clients.push(client);
    const events: Received = [];
    received.set(id, events);
    client.onAny((event: string, data: unknown) => events.push({ event, data }));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`presence:init timed out for ${id}`)), 5_000);
      client.once('presence:init', () => { clearTimeout(timer); resolve(); });
    });
  }
  return {
    updates: (id: string) => received.get(id)!.filter((entry) => entry.event === 'document:updated').map((entry) => entry.data),
    received: (id: string, event: string) => received.get(id)!.filter((entry) => entry.event === event).map((entry) => entry.data),
    close: async () => {
      for (const client of clients) client.close();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
    },
  };
}

/** Polls `cond` every 10 ms until it holds, failing with `label` after `timeoutMs`. */
export async function waitFor(cond: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), `timed out: ${label}`);
}
