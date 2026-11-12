/**
 * W2-a6-X: the new-space event sent to the org room carries the space id only.
 *
 * Every member of an org joins `org:<orgId>`. Space names, descriptions, types
 * and creators reach a client only through the membership-checked space reads
 * (`GET /api/spaces` lists the caller's own spaces).
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/space-created-event-db.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { Hono } from 'hono';
import pg from 'pg';
import { setupSocket, type SocketUser } from '../src/socket.js';

const { io: connectSocket } = createRequire(new URL('../../web/package.json', import.meta.url))('socket.io-client');

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const stamp = Date.now();
const ORG = `w2a6x-org-${stamp}`;
/** Creates the spaces. */
const OWNER = `w2a6x-owner-${stamp}`;
/** Ordinary org member listening on the org room. */
const OTHER = `w2a6x-other-${stamp}`;
const exp = Math.floor(Date.now() / 1000) + 600;

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

before(async () => {
  await withClient(async (c) => {
    await c.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, $1, $1)`, [ORG]);
    for (const [id, name] of [[OWNER, 'W2a6x Owner'], [OTHER, 'W2a6x Other']] as const) {
      await c.query(`INSERT INTO users (id, email, name, is_agent) VALUES ($1, $2, $3, false)`, [id, `${id}@test.local`, name]);
      await c.query(
        `INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES (gen_random_uuid()::text, $1, $2, 'member', true)`,
        [ORG, id],
      );
    }
  });
});

after(async () => {
  await withClient(async (c) => {
    const users = [OWNER, OTHER];
    await c.query(`DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id = $1)`, [ORG]).catch(() => undefined);
    await c.query(`DELETE FROM spaces WHERE org_id = $1`, [ORG]).catch(() => undefined);
    await c.query(`DELETE FROM org_members WHERE org_id = $1`, [ORG]).catch(() => undefined);
    await c.query(`DELETE FROM users WHERE id = ANY($1)`, [users]).catch(() => undefined);
    await c.query(`DELETE FROM orgs WHERE id = $1`, [ORG]).catch(() => undefined);
  });
});

type Principal = SocketUser & { exp: number };

async function socketHarness(principals: Record<string, Principal>) {
  const server = createServer();
  const sockets = setupSocket(server, {
    verifyAccess: async (token: string) => {
      const principal = principals[token];
      if (!principal) throw new Error('unknown token');
      return principal as any;
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

async function callSpaces(actorId: string, method: string, path: string, body?: unknown) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: actorId, org_id: ORG, email: `${actorId}@test.local`, sid: `w2a6x-sid-${stamp}`, role: 'member' });
    await next();
  });
  app.route('/api/spaces', (await import('../src/routes/spaces.js')).spaceRoutes);
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const res = await app.request(path, init);
  const text = await res.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, json, text };
}

test('W2-a6-X: space:created carries only the space id for private, DM and public spaces', async () => {
  const harness = await socketHarness({ other: { id: OTHER, org_id: ORG, email: `${OTHER}@test.local`, sid: `w2a6x-ws-${stamp}`, exp } });
  try {
    const other = await harness.open('other');
    const cases = [
      { label: 'private', body: { name: `w2a6x secret private ${stamp}`, type: 'private', description: `w2a6x secret desc ${stamp}` } },
      { label: 'dm', body: { name: `w2a6x secret dm ${stamp}`, type: 'dm', user_ids: [OTHER] } },
      { label: 'public', body: { name: `w2a6x public ${stamp}`, type: 'public', description: `w2a6x public desc ${stamp}` } },
    ];
    const ids: Record<string, string> = {};
    for (const { label, body } of cases) {
      const created = await callSpaces(OWNER, 'POST', '/api/spaces', body);
      assert.equal(created.status, 201, created.text);
      const id = created.json.id as string;
      ids[label] = id;
      await waitFor(() => other.events.some((e) => e.event === 'space:created' && e.data?.id === id), `${label} space:created delivered`);
      const event = other.events.find((e) => e.event === 'space:created' && e.data?.id === id)!;
      assert.deepEqual(event.data, { id }, `${label}: payload is exactly { id }`);
      const serialized = JSON.stringify(event.data);
      for (const secret of [body.name, (body as { description?: string }).description, OWNER].filter(Boolean) as string[]) {
        assert.ok(!serialized.includes(secret), `${label}: payload must not contain "${secret}"`);
      }
    }

    const listed = await callSpaces(OTHER, 'GET', '/api/spaces');
    assert.equal(listed.status, 200, listed.text);
    const listedIds = (listed.json as Array<{ id: string }>).map((s) => s.id);
    assert.ok(!listedIds.includes(ids.private!), 'a non-member does not see the private space in GET /api/spaces');
    assert.ok(listedIds.includes(ids.dm!), 'the DM participant sees the DM in GET /api/spaces');
  } finally {
    await harness.close();
  }
});
