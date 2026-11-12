/**
 * W2-a5a: task events sent to the org room carry identifiers only.
 *
 * Every member of an org joins `org:<orgId>`. Task content (titles,
 * descriptions, field values, comment text) reaches a client only through the
 * audience-checked task reads, so a member who cannot read a restricted task
 * learns nothing about it beyond its id.
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/task-events-org-room-db.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import pg from 'pg';
import { setupSocket, getIO, type SocketUser } from '../src/socket.js';

const { io: connectSocket } = createRequire(new URL('../../web/package.json', import.meta.url))('socket.io-client');

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const stamp = Date.now();
const ORG = `w2a5a-org-${stamp}`;
/** Creates the restricted task and acts on it. */
const OWNER = `w2a5a-owner-${stamp}`;
/** Ordinary member with no relation to the restricted task. */
const OTHER = `w2a5a-other-${stamp}`;
const PROJECT = randomUUID();
const SECRET_TITLE = `w2a5a secret title ${stamp}`;
const SECRET_DESCRIPTION = `w2a5a secret description ${stamp}`;
const SECRET_COMMENT = `w2a5a secret comment ${stamp}`;
const exp = Math.floor(Date.now() / 1000) + 600;
const ALLOWED_KEYS = new Set(['id', 'task_id', 'task_ids', 'project_id', 'changed_fields']);

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
    for (const [id, name] of [[OWNER, 'W2a5a Owner'], [OTHER, 'W2a5a Other']] as const) {
      await c.query(`INSERT INTO users (id, email, name, is_agent) VALUES ($1, $2, $3, false)`, [id, `${id}@test.local`, name]);
      await c.query(
        `INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES (gen_random_uuid()::text, $1, $2, 'member', true)`,
        [ORG, id],
      );
    }
    await c.query(
      `INSERT INTO projects (id, org_id, name, prefix, created_at, updated_at) VALUES ($1, $2, 'W2a5a project', $3, NOW(), NOW())`,
      [PROJECT, ORG, `W${String(stamp).slice(-6)}`],
    );
  });
});

after(async () => {
  await withClient(async (c) => {
    const users = [OWNER, OTHER];
    await c.query(`DELETE FROM job_queue WHERE payload::text LIKE $1`, [`%${ORG}%`]).catch(() => undefined);
    await c.query(`DELETE FROM notifications WHERE org_id = $1`, [ORG]).catch(() => undefined);
    await c.query(`DELETE FROM task_activity WHERE org_id = $1`, [ORG]).catch(() => undefined);
    await c.query(`DELETE FROM task_assignees WHERE task_id IN (SELECT id FROM tasks WHERE org_id = $1)`, [ORG]).catch(() => undefined);
    await c.query(`DELETE FROM task_watchers WHERE task_id IN (SELECT id FROM tasks WHERE org_id = $1)`, [ORG]).catch(() => undefined);
    await c.query(`DELETE FROM tasks WHERE org_id = $1`, [ORG]).catch(() => undefined);
    await c.query(`DELETE FROM projects WHERE org_id = $1`, [ORG]).catch(() => undefined);
    await c.query(`DELETE FROM idempotency_keys WHERE user_id = ANY($1)`, [users]).catch(() => undefined);
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

function principal(id: string, sid: string): Principal {
  return { id, org_id: ORG, email: `${id}@test.local`, sid, exp };
}

async function callTasks(actorId: string, method: string, path: string, body?: unknown) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: actorId, org_id: ORG, email: `${actorId}@test.local`, sid: `w2a5a-sid-${stamp}`, role: 'member' });
    await next();
  });
  app.route('/api/tasks', (await import('../src/routes/tasks.js')).taskRoutes);
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

function assertIdentifierOnly(label: string, data: unknown) {
  assert.ok(data && typeof data === 'object', `${label}: payload is an object`);
  const keys = Object.keys(data as Record<string, unknown>);
  const extra = keys.filter((key) => !ALLOWED_KEYS.has(key));
  assert.deepEqual(extra, [], `${label}: payload carries only identifiers and changed field names`);
  const serialized = JSON.stringify(data);
  for (const secret of [SECRET_TITLE, SECRET_DESCRIPTION, SECRET_COMMENT, 'W2a5a Owner']) {
    assert.ok(!serialized.includes(secret), `${label}: payload must not contain "${secret}"`);
  }
}

async function createRestrictedTask(): Promise<string> {
  const created = await callTasks(OWNER, 'POST', `/api/tasks/project/${PROJECT}`, {
    title: SECRET_TITLE,
    description: SECRET_DESCRIPTION,
    metadata: { visibility: 'restricted' },
  });
  assert.equal(created.status, 201, created.text);
  return created.json.id as string;
}

test('W2-a5a-1: task:created reaches the org room with identifiers only', async () => {
  const harness = await socketHarness({ other: principal(OTHER, `w2a5a-created-${stamp}`) });
  try {
    const other = await harness.open('other');
    const taskId = await createRestrictedTask();
    await waitFor(() => other.events.some((e) => e.event === 'task:created' && e.data?.id === taskId), 'task:created delivered');
    const event = other.events.find((e) => e.event === 'task:created' && e.data?.id === taskId)!;
    assertIdentifierOnly('task:created', event.data);
    assert.equal(event.data.project_id, PROJECT);

    // The client reads content through the audience-checked task read.
    const asOther = await callTasks(OTHER, 'GET', `/api/tasks/${taskId}`);
    assert.equal(asOther.status, 404, 'a member unrelated to the restricted task cannot read it');
    const asOwner = await callTasks(OWNER, 'GET', `/api/tasks/${taskId}`);
    assert.equal(asOwner.status, 200, asOwner.text);
    assert.equal(asOwner.json.title, SECRET_TITLE);
  } finally {
    await harness.close();
  }
});

test('W2-a5a-1: task:updated reaches the org room with identifiers and changed field names only', async () => {
  const taskId = await createRestrictedTask();
  const harness = await socketHarness({ other: principal(OTHER, `w2a5a-updated-${stamp}`) });
  try {
    const other = await harness.open('other');
    const patched = await callTasks(OWNER, 'PATCH', `/api/tasks/${taskId}`, { status: 'in_progress' });
    assert.equal(patched.status, 200, patched.text);
    await waitFor(() => other.events.some((e) => e.event === 'task:updated' && e.data?.id === taskId), 'task:updated delivered');
    const event = other.events.find((e) => e.event === 'task:updated' && e.data?.id === taskId)!;
    assertIdentifierOnly('task:updated', event.data);
    assert.ok(!('status' in event.data), 'the new status value is not in the org-room payload');
  } finally {
    await harness.close();
  }
});

test('W2-a5a-1: task:bulk_updated carries task ids and changed field names, not values', async () => {
  const taskId = await createRestrictedTask();
  const harness = await socketHarness({ other: principal(OTHER, `w2a5a-bulk-${stamp}`) });
  try {
    const other = await harness.open('other');
    const patched = await callTasks(OWNER, 'PATCH', '/api/tasks/bulk', { task_ids: [taskId], updates: { priority: 'p0', estimation: SECRET_COMMENT } });
    assert.equal(patched.status, 200, patched.text);
    await waitFor(() => other.events.some((e) => e.event === 'task:bulk_updated' && e.data?.task_ids?.includes(taskId)), 'task:bulk_updated delivered');
    const event = other.events.find((e) => e.event === 'task:bulk_updated')!;
    assertIdentifierOnly('task:bulk_updated', event.data);
    assert.deepEqual([...event.data.changed_fields].sort(), ['estimation', 'priority']);
  } finally {
    await harness.close();
  }
});

test('W2-a5a-1: any task event addressed to the org room is reduced to identifiers before delivery', async () => {
  const taskId = randomUUID();
  const harness = await socketHarness({ other: principal(OTHER, `w2a5a-guard-${stamp}`) });
  try {
    const other = await harness.open('other');
    // Shape used by emitters that pass a comment or a full row.
    getIO()!.to(`org:${ORG}`).emit('task:updated', {
      id: taskId,
      comment_added: { id: randomUUID(), content: SECRET_COMMENT, user_id: OWNER },
    });
    getIO()!.to(`org:${ORG}`).emit('task:created', {
      id: taskId, project_id: PROJECT, title: SECRET_TITLE, description: SECRET_DESCRIPTION, assignee_name: 'W2a5a Owner',
    });
    await waitFor(() => other.events.filter((e) => e.event.startsWith('task:')).length === 2, 'both task events delivered');
    for (const event of other.events.filter((e) => e.event.startsWith('task:'))) {
      assertIdentifierOnly(event.event, event.data);
      assert.equal(event.data.id, taskId);
    }
    const updated = other.events.find((e) => e.event === 'task:updated')!;
    assert.deepEqual(updated.data.changed_fields, ['comment_added']);
  } finally {
    await harness.close();
  }
});
