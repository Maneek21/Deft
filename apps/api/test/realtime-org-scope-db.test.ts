/**
 * Lane S3: realtime delivery and presence never cross organisations.
 *
 * One `users` row can be an active member of several orgs, but a socket is
 * authenticated for exactly one org. Per-user events (notifications, meeting
 * briefs, attention items) must reach only the sockets of the org the event
 * belongs to; presence must only describe sockets connected to the viewer's
 * org; and the forward route must not reveal that a foreign message id exists.
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/realtime-org-scope-db.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { Hono } from 'hono';
import pg from 'pg';
import { setupSocket, emitToUser, type SocketUser } from '../src/socket.js';

const { io: connectSocket } = createRequire(new URL('../../web/package.json', import.meta.url))('socket.io-client');

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const stamp = Date.now();
const ORG_A = `s3-org-a-${stamp}`;
const ORG_B = `s3-org-b-${stamp}`;
/** Member of both orgs: the person whose org-A socket must not see org-B events. */
const DUAL = `s3-dual-${stamp}`;
/** Member of org B only: sends messages and changes tasks in org B. */
const SENDER_B = `s3-sender-b-${stamp}`;
const SPACE_B = `s3-space-b-${stamp}`;
const SPACE_A = `s3-space-a-${stamp}`;
const MESSAGE_B = `s3-message-b-${stamp}`;
/** An org-A space DUAL is not a member of, with a message in it. */
const SPACE_A_CLOSED = `s3-space-a-closed-${stamp}`;
const MESSAGE_A_CLOSED = `s3-message-a-closed-${stamp}`;
const PROJECT_B = `s3-project-b-${stamp}`;
const TASK_B = `s3-task-b-${stamp}`;
const RULE_B = `s3-rule-b-${stamp}`;
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
    for (const org of [ORG_A, ORG_B]) {
      await c.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, $1, $1)`, [org]);
    }
    for (const [id, name] of [[DUAL, 'S3 Dual'], [SENDER_B, 'S3 Sender']] as const) {
      await c.query(`INSERT INTO users (id, email, name, is_agent) VALUES ($1, $2, $3, false)`, [id, `${id}@test.local`, name]);
    }
    for (const [org, user] of [[ORG_A, DUAL], [ORG_B, DUAL], [ORG_B, SENDER_B]] as const) {
      await c.query(
        `INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES (gen_random_uuid()::text, $1, $2, 'member', true)`,
        [org, user],
      );
    }
    for (const [space, org, members] of [[SPACE_B, ORG_B, [DUAL, SENDER_B]], [SPACE_A, ORG_A, [DUAL]]] as const) {
      await c.query(
        `INSERT INTO spaces (id, org_id, name, type, is_default, is_archived, agent_enabled, created_by, created_at, updated_at)
         VALUES ($1, $2, $1, 'private', false, false, false, $3, NOW(), NOW())`,
        [space, org, members[0]],
      );
      for (const member of members) {
        await c.query(
          `INSERT INTO space_members (id, space_id, user_id, is_muted, notification_level, joined_at)
           VALUES (gen_random_uuid()::text, $1, $2, false, 'all', NOW())`,
          [space, member],
        );
      }
    }
    // An org-B message that DUAL cannot see from an org-A session.
    await c.query(
      `INSERT INTO messages (id, org_id, space_id, user_id, content, is_pinned, is_deleted, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 's3 org B secret', false, false, NOW(), NOW())`,
      [MESSAGE_B, ORG_B, SPACE_B, SENDER_B],
    );
    await c.query(
      `INSERT INTO spaces (id, org_id, name, type, is_default, is_archived, agent_enabled, created_by, created_at, updated_at)
       VALUES ($1, $2, $1, 'private', false, false, false, $3, NOW(), NOW())`,
      [SPACE_A_CLOSED, ORG_A, DUAL],
    );
    await c.query(
      `INSERT INTO messages (id, org_id, space_id, user_id, content, is_pinned, is_deleted, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 's3 closed A secret', false, false, NOW(), NOW())`,
      [MESSAGE_A_CLOSED, ORG_A, SPACE_A_CLOSED, DUAL],
    );
    await c.query(
      `INSERT INTO projects (id, org_id, name, prefix, created_at, updated_at) VALUES ($1, $2, 'S3 project', 'SIII', NOW(), NOW())`,
      [PROJECT_B, ORG_B],
    );
    await c.query(
      `INSERT INTO tasks (id, org_id, project_id, number, title, status, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, 1, 's3 task', 'todo', $4, NOW(), NOW())`,
      [TASK_B, ORG_B, PROJECT_B, SENDER_B],
    );
    await c.query(
      `INSERT INTO workflow_rules (id, org_id, name, trigger_type, trigger_config, action_type, action_config, created_by, is_active)
       VALUES ($1, $2, 's3 rule', 'task.status_changed', '{}'::jsonb, 'notify', $3::jsonb, $4, true)`,
      [RULE_B, ORG_B, JSON.stringify({ user_id: DUAL, title: 's3 workflow notify' }), SENDER_B],
    );
  });
});

after(async () => {
  await withClient(async (c) => {
    const users = [DUAL, SENDER_B];
    const spaces = [SPACE_A, SPACE_B, SPACE_A_CLOSED];
    await c.query(`DELETE FROM job_queue WHERE payload::text LIKE $1`, [`%s3-%${stamp}%`]).catch(() => undefined);
    await c.query(`DELETE FROM workflow_runs WHERE rule_id = $1`, [RULE_B]).catch(() => undefined);
    await c.query(`DELETE FROM workflow_rules WHERE id = $1`, [RULE_B]).catch(() => undefined);
    await c.query(`DELETE FROM attention_items WHERE user_id = ANY($1)`, [users]).catch(() => undefined);
    await c.query(`DELETE FROM notifications WHERE user_id = ANY($1)`, [users]).catch(() => undefined);
    await c.query(`DELETE FROM reminders WHERE user_id = ANY($1)`, [users]).catch(() => undefined);
    await c.query(`DELETE FROM task_activity WHERE task_id = $1`, [TASK_B]).catch(() => undefined);
    await c.query(`DELETE FROM task_assignees WHERE task_id = $1`, [TASK_B]).catch(() => undefined);
    await c.query(`DELETE FROM tasks WHERE id = $1`, [TASK_B]).catch(() => undefined);
    await c.query(`DELETE FROM projects WHERE id = $1`, [PROJECT_B]).catch(() => undefined);
    await c.query(`DELETE FROM idempotency_keys WHERE user_id = ANY($1)`, [users]).catch(() => undefined);
    await c.query(`DELETE FROM messages WHERE space_id = ANY($1)`, [spaces]).catch(() => undefined);
    await c.query(`DELETE FROM space_members WHERE space_id = ANY($1)`, [spaces]).catch(() => undefined);
    await c.query(`DELETE FROM spaces WHERE id = ANY($1)`, [spaces]).catch(() => undefined);
    await c.query(`DELETE FROM org_members WHERE user_id = ANY($1)`, [users]).catch(() => undefined);
    await c.query(`DELETE FROM users WHERE id = ANY($1)`, [users]).catch(() => undefined);
    await c.query(`DELETE FROM orgs WHERE id = ANY($1)`, [[ORG_A, ORG_B]]).catch(() => undefined);
  });
});

// ── harness ──────────────────────────────────────────────────────────────

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
  /** Opens a client and resolves once the server finished initialization (presence:init is the last step). */
  const open = async (token: string) => {
    const client = connectSocket(`http://127.0.0.1:${port}`, { auth: { token }, transports: ['websocket'], reconnection: false });
    clients.push(client);
    const events: Array<{ event: string; data: any }> = [];
    client.onAny((event: string, data: unknown) => events.push({ event, data }));
    const init = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`presence:init timed out for ${token}`)), 5_000);
      client.once('presence:init', (value: unknown) => { clearTimeout(timer); resolve(value); });
    });
    return { client, events, init };
  };
  return {
    sockets,
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

const settle = () => new Promise((r) => setTimeout(r, 150));

function principal(id: string, org: string, sid: string): Principal {
  return { id, org_id: org, email: `${id}@test.local`, sid, exp };
}

async function callRoute(route: 'messages' | 'tasks', actor: { id: string; org_id: string }, method: string, path: string, body?: unknown) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: actor.id, org_id: actor.org_id, email: `${actor.id}@test.local`, sid: `s3-sid-${stamp}`, role: 'member' });
    await next();
  });
  if (route === 'messages') app.route('/api/messages', (await import('../src/routes/messages.js')).messageRoutes);
  if (route === 'tasks') app.route('/api/tasks', (await import('../src/routes/tasks.js')).taskRoutes);
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const res = await app.request(path, init);
  const text = await res.text();
  let json: unknown = text;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, json, text };
}

/**
 * Opens DUAL once in org A and once in org B, runs `trigger` (an org-B event
 * for DUAL), and checks the org-B socket gets it while the org-A socket gets
 * nothing.
 */
async function assertOrgBOnly(label: string, event: string, trigger: () => Promise<void>, match: (data: any) => boolean) {
  const harness = await socketHarness({
    dualA: principal(DUAL, ORG_A, `s3-${label}-a`),
    dualB: principal(DUAL, ORG_B, `s3-${label}-b`),
  });
  try {
    const inA = await harness.open('dualA');
    const inB = await harness.open('dualB');
    await trigger();
    await waitFor(() => inB.events.some((e) => e.event === event && match(e.data)), `${label}: org-B socket receives ${event}`);
    await settle();
    const leaked = inA.events.filter((e) => e.event === event);
    assert.deepEqual(leaked, [], `${label}: org-B ${event} reached the same user's org-A socket`);
  } finally {
    await harness.close();
  }
}

// ── S3-a: per-user events ───────────────────────────────────────────────

test('S3-a: a notification for org B is not delivered to the same user\'s org A socket (message notification)', async () => {
  await assertOrgBOnly('message', 'notification:new', async () => {
    const posted = await callRoute('messages', { id: SENDER_B, org_id: ORG_B }, 'POST', `/api/messages/${SPACE_B}`, { content: 's3 hello from org B' });
    assert.equal(posted.status, 201, posted.text);
  }, (data) => data?.org_id === ORG_B && data?.user_id === DUAL && data?.type === 'message');
});

test('S3-a: a notification for org B is not delivered to the same user\'s org A socket (task assignment)', async () => {
  await assertOrgBOnly('task', 'notification:new', async () => {
    const patched = await callRoute('tasks', { id: SENDER_B, org_id: ORG_B }, 'PATCH', `/api/tasks/${TASK_B}`, { assignee_id: DUAL });
    assert.equal(patched.status, 200, patched.text);
  }, (data) => data?.org_id === ORG_B && data?.type === 'task_assigned');
});

test('S3-a: a notification for org B is not delivered to the same user\'s org A socket (reminder)', async () => {
  const { reminderFireHandler } = await import('../src/workers/handlers/reminder-fire.js');
  const reminderId = `s3-reminder-${stamp}`;
  await withClient((c) => c.query(
    `INSERT INTO reminders (id, org_id, user_id, message, remind_at, is_sent, created_at, updated_at)
     VALUES ($1, $2, $3, 's3 reminder', NOW() - interval '1 minute', false, NOW(), NOW())`,
    [reminderId, ORG_B, DUAL],
  ));
  await assertOrgBOnly('reminder', 'notification:new', async () => {
    await reminderFireHandler({ id: `s3-job-${stamp}`, name: 'reminder-fire', data: { reminderId }, attempts: 1 } as any);
  }, (data) => data?.org_id === ORG_B && data?.type === 'reminder');
});

test('S3-a: a notification for org B is not delivered to the same user\'s org A socket (workflow notify)', async () => {
  const { handleWorkflowExecute } = await import('../src/workers/handlers/workflow-execute.js');
  await assertOrgBOnly('workflow', 'notification:new', async () => {
    await handleWorkflowExecute({
      id: `s3-wf-job-${stamp}`, name: 'workflow-execute', attempts: 1,
      data: { workflow_id: RULE_B, task_id: TASK_B, actor_user_id: SENDER_B },
    } as any);
  }, (data) => data?.org_id === ORG_B && data?.title === 's3 workflow notify');
});

test('S3-a: emitToUser routes every per-user event family to the org-scoped room only', async () => {
  // Every server emitter of per-user data goes through emitToUser(orgId, userId, …)
  // (the org id is a required parameter, so the compiler flags any caller that
  // omits it). This table covers the event names those emitters use.
  for (const event of ['notification:new', 'meeting-brief:new', 'attention:new', 'attention:updated']) {
    await assertOrgBOnly(`helper-${event}`, event, async () => {
      emitToUser(ORG_B, DUAL, event, { org_id: ORG_B, marker: event });
    }, (data) => data?.marker === event);
  }
});

test('S3-a: no server code emits to the shared cross-org `user:<id>` room', () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(name) || full.includes(`${join('src', 'scripts')}`)) continue;
      const lines = readFileSync(full, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (/\.(to|in)\(\s*[`'"]user:/.test(line) || /\.(to|in)\(\s*['"]user:['"]\s*\+/.test(line)) {
          offenders.push(`${full}:${index + 1}: ${line.trim()}`);
        }
      });
    }
  };
  walk(root);
  assert.deepEqual(offenders, [], 'per-user data must go to org-user:<orgId>:<userId>');
});

test('S3-a: sockets no longer join the shared `user:<id>` room', async () => {
  const harness = await socketHarness({ dualA: principal(DUAL, ORG_A, 's3-rooms-a') });
  try {
    await harness.open('dualA');
    const serverSocket = [...harness.sockets.sockets.sockets.values()][0]!;
    assert.equal(serverSocket.rooms.has(`user:${DUAL}`), false);
    assert.equal(serverSocket.rooms.has(`org-user:${ORG_A}:${DUAL}`), true);
  } finally {
    await harness.close();
  }
});

// ── S3-b: presence ──────────────────────────────────────────────────────

test('S3-b: presence:init lists only users of the socket\'s org', async () => {
  const onlyA = `s3-only-a-${stamp}`;
  const onlyB = `s3-only-b-${stamp}`;
  const viewerA = `s3-viewer-a-${stamp}`;
  const harness = await socketHarness({
    onlyA: principal(onlyA, ORG_A, 's3-p-1'),
    onlyB: principal(onlyB, ORG_B, 's3-p-2'),
    dualB: principal(DUAL, ORG_B, 's3-p-3'),
    viewerA: principal(viewerA, ORG_A, 's3-p-4'),
  });
  try {
    await harness.open('onlyA');
    await harness.open('onlyB');
    await harness.open('dualB');
    const viewer = await harness.open('viewerA');
    const ids = (viewer.init as Array<{ user_id: string }>).map((entry) => entry.user_id).sort();
    // DUAL is a member of org A too, but is only connected to org B: org A
    // members must not learn that DUAL is online (that is org-B activity).
    assert.deepEqual(ids, [onlyA]);
  } finally {
    await harness.close();
  }
});

test('S3-b: presence updates describe only sockets connected to the viewer\'s org', async () => {
  const viewerA = `s3-watch-a-${stamp}`;
  const harness = await socketHarness({
    viewerA: principal(viewerA, ORG_A, 's3-q-1'),
    dualA: principal(DUAL, ORG_A, 's3-q-2'),
    dualB: principal(DUAL, ORG_B, 's3-q-3'),
  });
  try {
    const viewer = await harness.open('viewerA');
    const dualA = await harness.open('dualA');
    await waitFor(() => viewer.events.some((e) => e.event === 'presence:update' && e.data?.user_id === DUAL && e.data?.status === 'online'), 'DUAL online in A');
    await harness.open('dualB');
    // DUAL leaves org A while still connected to org B: org A must see offline.
    dualA.client.close();
    await waitFor(() => viewer.events.some((e) => e.event === 'presence:update' && e.data?.user_id === DUAL && e.data?.status === 'offline'), 'DUAL offline in A while online in B');
  } finally {
    await harness.close();
  }
});

// ── S3-c: forward lookup ────────────────────────────────────────────────

test('S3-c: forwarding a foreign message id is indistinguishable from a missing one', async () => {
  const actor = { id: DUAL, org_id: ORG_A };
  const foreign = await callRoute('messages', actor, 'POST', '/api/messages/forward', { message_id: MESSAGE_B, target_space_id: SPACE_A });
  const missing = await callRoute('messages', actor, 'POST', '/api/messages/forward', { message_id: `s3-missing-${stamp}`, target_space_id: SPACE_A });
  assert.equal(missing.status, 404, missing.text);
  assert.equal(foreign.status, missing.status, `foreign status (body: ${foreign.text})`);
  assert.deepEqual(foreign.json, missing.json);
  assert.ok(!foreign.text.includes('s3 org B secret'));
  // Same org, but a space the caller is not in: also indistinguishable.
  const closed = await callRoute('messages', actor, 'POST', '/api/messages/forward', { message_id: MESSAGE_A_CLOSED, target_space_id: SPACE_A });
  assert.equal(closed.status, missing.status, `closed-space status (body: ${closed.text})`);
  assert.deepEqual(closed.json, missing.json);
  const copied = await withClient(async (c) => Number((await c.query(
    `SELECT count(*)::int AS n FROM messages WHERE space_id = $1 AND content LIKE '%s3 org B secret%'`, [SPACE_A],
  )).rows[0].n));
  assert.equal(copied, 0);

  // The legitimate path still works: same user, org-B session, org-B source and target.
  const ok = await callRoute('messages', { id: DUAL, org_id: ORG_B }, 'POST', '/api/messages/forward', { message_id: MESSAGE_B, target_space_id: SPACE_B });
  assert.equal(ok.status, 201, ok.text);
});
