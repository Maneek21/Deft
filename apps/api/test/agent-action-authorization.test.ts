/**
 * Lane W2-a1 — agent action authorization.
 *
 * C01  undo requires requester or owner/admin plus current target access.
 * C02  action history / recent / pending / dashboard feed hide another
 *      member's private Defty action.
 * C03  native executors check the acting principal's wiki / space access.
 * C13  note promotion executes for a space-visible note the proposal accepted.
 * PLAN plan payload marks destructive steps; a destructive leaf step of an
 *      approved plan waits for its own approval.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/agent-action-authorization.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';

import { closeDb } from '../src/lib/db.js';
import { executeAction } from '../src/lib/agent-actions.js';
import { createPlanRow } from '../src/lib/agent-plans.js';
import { agentRoutes } from '../src/routes/agent.js';
import { agentPlanRoutes } from '../src/routes/agent-plans.js';
import { dashboardRoutes } from '../src/routes/dashboard.js';
import { handlePlanExecutor } from '../src/workers/handlers/plan-executor.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const databaseUrl = safeTestDatabaseUrl();
const canRun = Boolean(databaseUrl);
const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const requesterId = randomUUID();
const otherMemberId = randomUUID();
const adminId = randomUUID();
const guestId = randomUUID();
const privateSpaceId = randomUUID();
const sharedSpaceId = randomUUID();
const privateSpaceName = `w2a1-private-${suffix}`;
const projectId = randomUUID();
const prefix = `WA${suffix.slice(0, 4)}`.toUpperCase().replace(/[^A-Z]/g, 'Q');

const roles: Record<string, string> = {
  [requesterId]: 'member',
  [otherMemberId]: 'member',
  [adminId]: 'admin',
  [guestId]: 'guest',
};

let client: pg.Client;
const app = new Hono();
app.use('*', async (c, next) => {
  const id = c.req.header('x-test-user') ?? requesterId;
  c.set('user', { id, org_id: orgId, email: `${id}@example.test`, role: roles[id] } as any);
  await next();
});
app.route('/api/agent', agentRoutes);
app.route('/api/agent-plans', agentPlanRoutes);
app.route('/api/dashboard', dashboardRoutes);

function as(userId: string, path: string, init?: RequestInit) {
  return app.request(path, { ...init, headers: { ...(init?.headers ?? {}), 'x-test-user': userId } });
}

async function insertAction(values: {
  userId: string;
  action: string;
  params: Record<string, unknown>;
  status?: 'pending' | 'approved';
  result?: Record<string, unknown> | null;
  executed?: boolean;
  tier?: 'auto' | 'quick' | 'full';
}): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO agent_actions
       (id, org_id, user_id, agent_employee_id, source, action, params, result,
        approval_tier, approval_status, executed_at, before_state, after_state)
     VALUES ($1, $2, $3, NULL, 'mention', $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10::jsonb, $11::jsonb)`,
    [
      id, orgId, values.userId, values.action, JSON.stringify(values.params),
      values.result ? JSON.stringify(values.result) : null,
      values.tier ?? 'full', values.status ?? 'approved',
      values.executed === false ? null : new Date(),
      JSON.stringify({ secret_before: 'private-before' }),
      JSON.stringify({ secret_after: 'private-after' }),
    ],
  );
  return id;
}

async function insertMessage(spaceId: string, userId: string, content: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    'INSERT INTO messages (id, org_id, space_id, user_id, content) VALUES ($1, $2, $3, $4, $5)',
    [id, orgId, spaceId, userId, content],
  );
  return id;
}

before(async () => {
  if (!canRun) return;
  client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query("INSERT INTO orgs (id, name, slug, trust_level) VALUES ($1, 'W2-a1', $2, 'standard')", [orgId, `w2a1-${suffix}`]);
  for (const id of [requesterId, otherMemberId, adminId, guestId]) {
    await client.query(
      `INSERT INTO users (id, email, name, kind, is_agent, email_verified)
       VALUES ($1, $2, $3, 'human', false, true)`,
      [id, `w2a1-${id}@example.test`, `W2a1 ${roles[id]} ${id.slice(0, 4)}`],
    );
    await client.query(
      'INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, $4, true)',
      [randomUUID(), orgId, id, roles[id]],
    );
  }
  await client.query(
    `INSERT INTO spaces (id, org_id, name, type, created_by)
     VALUES ($1, $3, $4, 'private', $5), ($2, $3, $6, 'private', $5)`,
    [privateSpaceId, sharedSpaceId, orgId, privateSpaceName, requesterId, `w2a1-shared-${suffix}`],
  );
  await client.query(
    `INSERT INTO space_members (id, space_id, user_id)
     VALUES ($1, $2, $3), ($4, $5, $3), ($6, $5, $7)`,
    [randomUUID(), privateSpaceId, requesterId, randomUUID(), sharedSpaceId, randomUUID(), otherMemberId],
  );
  await client.query(
    'INSERT INTO projects (id, org_id, name, prefix, lead_id) VALUES ($1, $2, $3, $4, $5)',
    [projectId, orgId, `W2a1 project ${suffix}`, prefix, requesterId],
  );
});

after(async () => {
  if (!client) {
    await closeDb();
    return;
  }
  try {
    await client.query('DELETE FROM agent_plans WHERE org_id = $1', [orgId]);
    for (const table of ['action_receipts', 'notifications', 'attention_items', 'job_queue', 'agent_actions',
      'audit_log', 'task_activity', 'wiki_ops_log', 'wiki_page_versions', 'wiki_links']) {
      await client.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]).catch(() => undefined);
    }
    await client.query('DELETE FROM wiki_page_versions WHERE page_id IN (SELECT id FROM wiki_pages WHERE org_id = $1)', [orgId]).catch(() => undefined);
    await client.query('DELETE FROM wiki_pages WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM notes WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM canvases WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM messages WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM tasks WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM projects WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id = $1)', [orgId]);
    await client.query('DELETE FROM spaces WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM org_members WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM orgs WHERE id = $1', [orgId]);
    await client.query('DELETE FROM users WHERE id = ANY($1::text[])', [[requesterId, otherMemberId, adminId, guestId]]);
  } finally {
    await client.end();
    await closeDb();
  }
});

// ─── C01 ─────────────────────────────────────────────────────────────────────

test('C01: another member cannot undo a private Defty post; answer matches a missing action', { skip: !canRun }, async () => {
  const messageId = await insertMessage(privateSpaceId, requesterId, `private post ${suffix}`);
  const actionId = await insertAction({
    userId: requesterId,
    action: 'post_message',
    params: { space_id: privateSpaceId, content: 'private post' },
    result: { message_id: messageId, space_id: privateSpaceId },
  });

  const missing = await as(otherMemberId, `/api/agent/actions/${randomUUID()}/undo`, { method: 'POST' });
  const denied = await as(otherMemberId, `/api/agent/actions/${actionId}/undo`, { method: 'POST' });
  assert.equal(denied.status, missing.status);
  assert.deepEqual(await denied.json(), await missing.json());
  const guest = await as(guestId, `/api/agent/actions/${actionId}/undo`, { method: 'POST' });
  assert.equal(guest.status, 404);

  // An admin who cannot see the target space cannot undo it either.
  const admin = await as(adminId, `/api/agent/actions/${actionId}/undo`, { method: 'POST' });
  assert.equal(admin.status, 404);

  const message = await client.query('SELECT is_deleted FROM messages WHERE id = $1', [messageId]);
  assert.equal(message.rows[0]?.is_deleted, false, 'the message must not be deleted by a non-requester');
  const action = await client.query('SELECT undone_at FROM agent_actions WHERE id = $1', [actionId]);
  assert.equal(action.rows[0]?.undone_at, null);

  const own = await as(requesterId, `/api/agent/actions/${actionId}/undo`, { method: 'POST' });
  assert.equal(own.status, 200, await own.text());
  const after = await client.query('SELECT is_deleted FROM messages WHERE id = $1', [messageId]);
  assert.equal(after.rows[0]?.is_deleted, true);
});

test('C01: an admin with access to the target may undo another member\'s action', { skip: !canRun }, async () => {
  const messageId = await insertMessage(sharedSpaceId, requesterId, `shared post ${suffix}`);
  await client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), sharedSpaceId, adminId]);
  const actionId = await insertAction({
    userId: requesterId,
    action: 'post_message',
    params: { space_id: sharedSpaceId, content: 'shared post' },
    result: { message_id: messageId, space_id: sharedSpaceId },
  });
  // Space membership alone does not make another member the requester.
  const member = await as(otherMemberId, `/api/agent/actions/${actionId}/undo`, { method: 'POST' });
  assert.equal(member.status, 404);
  const admin = await as(adminId, `/api/agent/actions/${actionId}/undo`, { method: 'POST' });
  assert.equal(admin.status, 200, await admin.text());
  await client.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [sharedSpaceId, adminId]);
});

// ─── C02 / E01 ───────────────────────────────────────────────────────────────

test('C02/E01: private Defty action payloads reach only requester, assigned approver and owner/admin', { skip: !canRun }, async () => {
  const marker = `c02-secret-${suffix}`;
  const executed = await insertAction({
    userId: requesterId,
    action: 'create_note',
    params: { title: marker, content: marker, visibility: 'private' },
    result: { note_id: randomUUID(), title: marker },
    tier: 'quick',
  });
  const pending = await insertAction({
    userId: requesterId,
    action: 'post_message',
    params: { space_id: privateSpaceId, content: marker },
    status: 'pending',
    executed: false,
  });

  const readers: Array<[string, string]> = [
    ['/api/agent/actions', 'list'],
    ['/api/agent/actions/recent?limit=50', 'recent'],
    ['/api/agent/actions/pending', 'pending'],
    ['/api/dashboard/agent-activity', 'dashboard'],
  ];
  for (const [path, label] of readers) {
    for (const reader of [otherMemberId, guestId]) {
      const res = await as(reader, path);
      assert.equal(res.status, 200, `${label} ${roles[reader]}`);
      const text = await res.text();
      assert.equal(text.includes(marker), false, `${label}: ${roles[reader]} must not receive another member's private payload`);
      assert.equal(text.includes(executed) || text.includes(pending), false, `${label}: ${roles[reader]} must not see the rows`);
    }
  }
  const receipt = await as(otherMemberId, `/api/agent/actions/${executed}/receipt`);
  assert.equal(receipt.status, 404);

  for (const reader of [requesterId, adminId]) {
    const list = await (await as(reader, '/api/agent/actions')).text();
    assert.ok(list.includes(executed), `${roles[reader]} keeps the action history row`);
    const recent = await (await as(reader, '/api/agent/actions/recent?limit=50')).text();
    assert.ok(recent.includes(pending), `${roles[reader]} keeps the recent row`);
    const feed = await (await as(reader, '/api/dashboard/agent-activity')).text();
    assert.ok(feed.includes(executed), `${roles[reader]} keeps the dashboard row`);
  }
  const requesterPending = await (await as(requesterId, '/api/agent/actions/pending')).text();
  assert.ok(requesterPending.includes(pending), 'requester still sees the pending approval');

  // An assigned approver keeps what they approve.
  await client.query(
    'INSERT INTO agent_action_approvers (id, org_id, action_id, user_id) VALUES ($1, $2, $3, $4)',
    [randomUUID(), orgId, pending, otherMemberId],
  );
  const approverPending = await (await as(otherMemberId, '/api/agent/actions/pending')).text();
  assert.ok(approverPending.includes(pending), 'assigned approver sees the pending action');
  const approverHistory = await (await as(otherMemberId, '/api/agent/actions')).text();
  assert.ok(approverHistory.includes(pending), 'assigned approver sees the action in history');
  assert.equal(approverHistory.includes(executed), false, 'approval on one action does not open another');
});

// ─── C03 ─────────────────────────────────────────────────────────────────────

test('C03: wiki_write cannot update a space wiki page the acting user cannot see', { skip: !canRun }, async () => {
  const slug = `w2a1-private-page-${suffix}`;
  await client.query(
    `INSERT INTO wiki_pages (id, org_id, scope, space_id, user_id, type, title, slug, content)
     VALUES ($1, $2, 'space', $3, $4, 'fact', 'Private page', $5, 'original')`,
    [randomUUID(), orgId, privateSpaceId, requesterId, slug],
  );
  const params = { slug, content: 'overwritten' };
  const actionId = await insertAction({ userId: otherMemberId, action: 'wiki_write', params, status: 'pending', executed: false });
  const result = await executeAction(actionId, 'wiki_write', params, orgId, otherMemberId);
  assert.equal(result.success, false);
  assert.equal(result.error, `Wiki page "${slug}" not found`, 'refusal reads like a missing page');
  const page = await client.query('SELECT content FROM wiki_pages WHERE slug = $1 AND org_id = $2', [slug, orgId]);
  assert.equal(page.rows[0]?.content, 'original');

  const own = await executeAction(actionId, 'wiki_write', params, orgId, requesterId);
  assert.equal(own.success, true, own.error);
});

test('C03: write_canvas, post_thread_reply, post_message and space notes require space membership', { skip: !canRun }, async () => {
  const parentId = await insertMessage(privateSpaceId, requesterId, `parent ${suffix}`);
  const cases: Array<[string, Record<string, unknown>]> = [
    ['write_canvas', { space_name: privateSpaceName, content: 'canvas body' }],
    ['post_thread_reply', { parent_message_id: parentId, content: 'reply body' }],
    ['post_message', { space_id: privateSpaceId, content: 'post body' }],
    ['post_message', { space_name: privateSpaceName, content: 'post body by name' }],
    ['create_note', { title: `space note ${suffix}`, visibility: 'space', visibility_space_id: privateSpaceId }],
  ];
  for (const [action, params] of cases) {
    const actionId = await insertAction({ userId: otherMemberId, action, params, status: 'pending', executed: false });
    const result = await executeAction(actionId, action, params, orgId, otherMemberId);
    assert.equal(result.success, false, `${action} ${JSON.stringify(params)}`);
    assert.doesNotMatch(result.error ?? '', /member|permission|forbidden/i, 'refusal does not reveal that the target exists');
  }
  const canvas = await client.query('SELECT count(*)::int AS n FROM canvases WHERE space_id = $1', [privateSpaceId]);
  assert.equal(canvas.rows[0]?.n, 0);
  const msgs = await client.query(
    "SELECT count(*)::int AS n FROM messages WHERE space_id = $1 AND content IN ('reply body', 'post body', 'post body by name')",
    [privateSpaceId],
  );
  assert.equal(msgs.rows[0]?.n, 0);
  const note = await client.query('SELECT count(*)::int AS n FROM notes WHERE org_id = $1 AND visibility_space_id = $2', [orgId, privateSpaceId]);
  assert.equal(note.rows[0]?.n, 0);

  // A member of the space keeps every one of these writes.
  for (const [action, params] of cases) {
    const actionId = await insertAction({ userId: requesterId, action, params, status: 'pending', executed: false });
    const result = await executeAction(actionId, action, params, orgId, requesterId);
    assert.equal(result.success, true, `${action}: ${result.error}`);
  }
});

test('R2-2: malformed target types are rejected before any native write', { skip: !canRun }, async () => {
  const numericSlug = Number(`9${Date.now() % 1_000_000_000}`);
  await client.query(
    `INSERT INTO wiki_pages (id, org_id, scope, space_id, user_id, type, title, slug, content)
     VALUES ($1, $2, 'space', $3, $4, 'fact', 'Numeric page', $5, 'numeric original')`,
    [randomUUID(), orgId, privateSpaceId, requesterId, String(numericSlug)],
  );
  const cases: Array<[string, Record<string, unknown>]> = [
    ['add_knowledge', { space_name: [privateSpaceName], title: `malformed ${suffix}`, content: 'x' }],
    ['add_knowledge', { space_name: { name: privateSpaceName }, title: `malformed2 ${suffix}`, content: 'x' }],
    ['write_canvas', { space_name: [privateSpaceName], content: 'x' }],
    ['wiki_write', { slug: numericSlug, content: 'overwritten' }],
    ['wiki_write', { slug: `ok-${suffix}`, related_slugs: [numericSlug], content: 'x' }],
    ['post_message', { space_id: [privateSpaceId], content: 'x' }],
    ['post_message', { space_name: 42, content: 'x' }],
    ['post_thread_reply', { parent_message_id: 7, content: 'x' }],
    ['create_note', { title: 'n', visibility: 'space', visibility_space_id: [privateSpaceId] }],
  ];
  for (const [action, params] of cases) {
    const actionId = await insertAction({ userId: otherMemberId, action, params, status: 'pending', executed: false });
    const result = await executeAction(actionId, action, params, orgId, otherMemberId);
    assert.equal(result.success, false, `${action} ${JSON.stringify(params)}`);
    assert.equal(result.error, 'Invalid action target', `${action} ${JSON.stringify(params)}`);
  }
  const wiki = await client.query("SELECT count(*)::int AS n FROM wiki_pages WHERE org_id = $1 AND title LIKE 'malformed%'", [orgId]);
  assert.equal(wiki.rows[0]?.n, 0);
  const page = await client.query('SELECT content FROM wiki_pages WHERE org_id = $1 AND slug = $2', [orgId, String(numericSlug)]);
  assert.equal(page.rows[0]?.content, 'numeric original');
});

test('R2-4: one accessible target resolves even when an inaccessible sibling shares the name', { skip: !canRun }, async () => {
  const base = `w2a1-eng-${suffix}`;
  const openId = randomUUID();
  const siblingId = randomUUID();
  const dupHiddenId = randomUUID();
  await client.query(
    `INSERT INTO spaces (id, org_id, name, type, created_by)
     VALUES ($1, $4, $5, 'private', $7), ($2, $4, $6, 'private', $7), ($3, $4, $5, 'private', $7)`,
    [openId, siblingId, dupHiddenId, orgId, base, `${base}-private`, requesterId],
  );
  // otherMember belongs only to the plainly named space; the prefixed sibling
  // and a second space with the same name are private to the requester.
  await client.query(
    `INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3), ($4, $5, $6), ($7, $8, $6)`,
    [randomUUID(), openId, otherMemberId, randomUUID(), siblingId, requesterId, randomUUID(), dupHiddenId],
  );
  const cases: Array<[string, Record<string, unknown>]> = [
    ['add_knowledge', { space_name: base, title: `sibling knowledge ${suffix}`, content: 'k' }],
    ['write_canvas', { space_name: base, content: 'sibling canvas' }],
    ['post_message', { space_name: base, content: `sibling post ${suffix}` }],
  ];
  for (const [action, params] of cases) {
    const actionId = await insertAction({ userId: otherMemberId, action, params, status: 'pending', executed: false });
    const result = await executeAction(actionId, action, params, orgId, otherMemberId);
    assert.equal(result.success, true, `${action}: ${result.error}`);
  }
  const knowledge = await client.query('SELECT space_id FROM wiki_pages WHERE org_id = $1 AND title = $2', [orgId, `sibling knowledge ${suffix}`]);
  assert.deepEqual(knowledge.rows.map((r) => r.space_id), [openId]);
  const canvas = await client.query('SELECT space_id FROM canvases WHERE space_id = ANY($1::text[])', [[openId, siblingId, dupHiddenId]]);
  assert.deepEqual(canvas.rows.map((r) => r.space_id), [openId]);
  const post = await client.query('SELECT space_id FROM messages WHERE org_id = $1 AND content = $2', [orgId, `sibling post ${suffix}`]);
  assert.deepEqual(post.rows.map((r) => r.space_id), [openId]);

  // A name only an inaccessible space carries reads as missing, without naming it.
  const hiddenOnly = await insertAction({ userId: otherMemberId, action: 'post_message', params: { space_name: `${base}-private`, content: 'x' }, status: 'pending', executed: false });
  const refused = await executeAction(hiddenOnly, 'post_message', { space_name: `${base}-private`, content: 'x' }, orgId, otherMemberId);
  assert.equal(refused.success, false);
  assert.doesNotMatch(refused.error ?? '', /#/, 'no space is listed');
  // A caller-supplied resolved id is never trusted over the authorized target.
  const forged = { space_name: base, resolved_space_id: siblingId, content: 'forged canvas' };
  const forgedId = await insertAction({ userId: otherMemberId, action: 'write_canvas', params: forged, status: 'pending', executed: false });
  const forgedResult = await executeAction(forgedId, 'write_canvas', forged, orgId, otherMemberId);
  assert.equal(forgedResult.success, true, forgedResult.error);
  const siblingCanvas = await client.query('SELECT count(*)::int AS n FROM canvases WHERE space_id = $1', [siblingId]);
  assert.equal(siblingCanvas.rows[0]?.n, 0);
});

// ─── C13 ─────────────────────────────────────────────────────────────────────

test('C13: note_to_wiki executes for a space-visible note when the actor is a space member', { skip: !canRun }, async () => {
  const sharedNoteId = randomUUID();
  const hiddenNoteId = randomUUID();
  await client.query(
    `INSERT INTO notes (id, org_id, user_id, title, content, visibility, visibility_space_id)
     VALUES ($1, $3, $4, $5, 'shared body', 'space', $6), ($2, $3, $4, $7, 'hidden body', 'space', $8)`,
    [sharedNoteId, hiddenNoteId, orgId, requesterId, `Shared note ${suffix}`, sharedSpaceId, `Hidden note ${suffix}`, privateSpaceId],
  );
  const sharedParams = { note_id: sharedNoteId, type: 'fact' };
  const sharedAction = await insertAction({ userId: otherMemberId, action: 'note_to_wiki', params: sharedParams, status: 'pending', executed: false });
  const shared = await executeAction(sharedAction, 'note_to_wiki', sharedParams, orgId, otherMemberId);
  assert.equal(shared.success, true, shared.error);

  const hiddenParams = { note_id: hiddenNoteId, type: 'fact' };
  const hiddenAction = await insertAction({ userId: otherMemberId, action: 'note_to_wiki', params: hiddenParams, status: 'pending', executed: false });
  const hidden = await executeAction(hiddenAction, 'note_to_wiki', hiddenParams, orgId, otherMemberId);
  assert.equal(hidden.success, false);
  assert.equal(hidden.error, 'Note not found or not visible to caller');
});

// ─── Plan approval ───────────────────────────────────────────────────────────

test('PLAN: plan payload marks destructive steps from the server classifier', { skip: !canRun }, async () => {
  const { plan_id } = await createPlanRow({
    org_id: orgId,
    user_id: requesterId,
    title: `W2a1 plan ${suffix}`,
    steps: [
      { id: 's1', description: 'Create', tool: 'create_task', params: { title: 'x' } },
      { id: 's2', description: 'Delete', tool: 'delete_task', params: {} },
      { id: 's3', description: 'Drop trigger', tool: 'manage_triggers', params: { action: 'delete', trigger_id: 't' } },
      { id: 's4', description: 'Status', tool: 'update_task_status', params: { mode: 'delete' } },
      { id: 's5', description: 'Unlink', tool: 'remove_dependency', params: {} },
      { id: 's6', description: 'Client sent flag', tool: 'create_task', params: {}, destructive: true } as any,
    ],
  });
  const expected = { s1: false, s2: true, s3: true, s4: true, s5: true, s6: false };
  for (const path of [`/api/agent-plans/${plan_id}`, '/api/agent-plans']) {
    const res = await as(requesterId, path);
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    const plan = Array.isArray(body) ? body.find((p: any) => p.id === plan_id) : body;
    for (const step of plan.steps) {
      assert.equal(step.destructive, expected[step.id as keyof typeof expected], `${path} ${step.id}`);
    }
  }
  const approved = await as(requesterId, `/api/agent-plans/${plan_id}/approve`, { method: 'POST' });
  assert.equal(approved.status, 200);
  const approvedBody = await approved.json() as any;
  assert.equal(approvedBody.steps.find((s: any) => s.id === 's2').destructive, true);
  const stored = await client.query('SELECT steps FROM agent_plans WHERE id = $1', [plan_id]);
  assert.equal(stored.rows[0].steps.find((s: any) => s.id === 's6').destructive, true, 'stored step is untouched; marking is response-only');
});

test('PLAN: a destructive leaf step of an approved plan waits for its own approval', { skip: !canRun }, async () => {
  const taskId = randomUUID();
  await client.query(
    `INSERT INTO tasks (id, org_id, project_id, number, title, status, created_by)
     VALUES ($1, $2, $3, 1, 'Plan target', 'todo', $4)`,
    [taskId, orgId, projectId, requesterId],
  );
  const { plan_id } = await createPlanRow({
    org_id: orgId,
    user_id: requesterId,
    title: `W2a1 leaf ${suffix}`,
    steps: [{
      id: 'leaf',
      description: 'Status change flagged destructive',
      tool: 'update_task_status',
      params: { resolved_task_id: taskId, new_status: 'done', mode: 'delete' },
    }],
    fail_fast: true,
  });
  await client.query("UPDATE agent_plans SET status = 'approved' WHERE id = $1", [plan_id]);
  await handlePlanExecutor({ id: randomUUID(), name: 'plan-executor', data: { planId: plan_id, orgId, userId: requesterId }, attempts: 1 } as any);

  const task = await client.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  assert.equal(task.rows[0]?.status, 'todo', 'the destructive step must not run under the plan approval alone');
  const plan = await client.query('SELECT status, error, steps FROM agent_plans WHERE id = $1', [plan_id]);
  assert.equal(plan.rows[0]?.status, 'paused', JSON.stringify(plan.rows[0]));
  assert.equal(plan.rows[0]?.steps[0]?.status, 'waiting_approval');
  const actions = await client.query(
    "SELECT approval_status, executed_at FROM agent_actions WHERE plan_id = $1 AND plan_step_id = 'leaf'",
    [plan_id],
  );
  assert.equal(actions.rows.length, 1);
  assert.equal(actions.rows[0]?.approval_status, 'pending');
  assert.equal(actions.rows[0]?.executed_at, null);
});
