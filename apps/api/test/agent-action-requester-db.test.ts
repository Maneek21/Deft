/**
 * An action's requester is its own user, or, for a Defty capture action,
 * the author of the source message. Its reviewers are the requester when an
 * active human member, otherwise the active owners/admins; an approver
 * assignment counts when it names one of them. Every review surface (the
 * resolver, the web routes, the Inbox, the Attention feed, personal MCP)
 * answers with that rule.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/agent-action-requester-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';

import { agentRoutes } from '../src/routes/agent.js';
import { inboxRoutes } from '../src/routes/inbox.js';
import { attentionRoutes } from '../src/routes/attention.js';
import {
  durabilityDatabaseUrl,
  setupDurabilityFixture,
  type DurabilityFixture,
} from './fixtures/agent-action-durability-fixture.js';

const canRun = Boolean(durabilityDatabaseUrl);
let f: DurabilityFixture;
let foreignOrgId: string;
let foreignAdminId: string;
let app: Hono;
let guestId: string;
let shadowId: string;
let employeeId: string;
const roles = new Map<string, string>();

before(async () => {
  if (!canRun) return;
  f = await setupDurabilityFixture('R1');
  roles.set(f.requesterId, 'member').set(f.otherId, 'member').set(f.adminId, 'admin');
  guestId = randomUUID();
  shadowId = randomUUID();
  employeeId = randomUUID();
  await f.client.query(
    `INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES
       ($1, $2, 'Requester guest', 'human', false, true), ($3, $4, 'Requester agent', 'agent', true, true)`,
    [guestId, `r1-guest-${guestId}@example.test`, shadowId, `r1-agent-${shadowId}@example.test`],
  );
  await f.client.query(
    `INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, 'guest', true), ($4, $2, $5, 'member', true)`,
    [randomUUID(), f.orgId, guestId, randomUUID(), shadowId],
  );
  roles.set(guestId, 'guest');
  // An admin of another workspace.
  foreignOrgId = randomUUID();
  foreignAdminId = randomUUID();
  await f.client.query("INSERT INTO orgs (id, name, slug, trust_level) VALUES ($1, 'R1 foreign', $2, 'standard')",
    [foreignOrgId, `r1-foreign-${foreignOrgId.slice(0, 8)}`]);
  await f.client.query(`INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES ($1, $2, 'Foreign admin', 'human', false, true)`,
    [foreignAdminId, `r1-foreign-${foreignAdminId}@example.test`]);
  await f.client.query(`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, 'admin', true)`,
    [randomUUID(), foreignOrgId, foreignAdminId]);
  await f.client.query(
    `INSERT INTO agent_employees (id, org_id, user_id, name, slug, role, system_prompt, trust_level, is_byoa, is_active, created_by)
     VALUES ($1, $2, $3, 'Requester agent', $4, 'project_manager', 'Fixture', 'conservative', true, true, $5)`,
    [employeeId, f.orgId, shadowId, `r1-agent-${employeeId.slice(0, 8)}`, f.requesterId],
  );
  await f.client.query('UPDATE users SET agent_employee_id = $2 WHERE id = $1', [shadowId, employeeId]);
  app = new Hono();
  app.use('*', async (c, next) => {
    const id = c.req.header('x-test-user')!;
    c.set('user', { id, org_id: f.orgId, email: `${id}@example.test`, sid: '', role: roles.get(id) } as any);
    await next();
  });
  app.route('/api/agent', agentRoutes).route('/api/inbox', inboxRoutes).route('/api/attention', attentionRoutes);
});

after(async () => {
  if (!f) return;
  await f.client.query('DELETE FROM org_members WHERE org_id = $1', [foreignOrgId]).catch(() => undefined);
  await f.client.query('DELETE FROM users WHERE id = $1', [foreignAdminId]).catch(() => undefined);
  await f.client.query('DELETE FROM orgs WHERE id = $1', [foreignOrgId]).catch(() => undefined);
  await f.teardown();
});

type ActionSpec = { source: string; userId: string; employee?: boolean; params?: Record<string, unknown>; approvers?: string[] };

async function pendingAction(spec: ActionSpec): Promise<string> {
  const id = randomUUID();
  await f.client.query(
    `INSERT INTO agent_actions (id, org_id, user_id, agent_employee_id, source, action, params, approval_tier, approval_status)
     VALUES ($1, $2, $3, $4, $5, 'task_create', $6::jsonb, 'full', 'pending')`,
    [id, f.orgId, spec.userId, spec.employee ? employeeId : null, spec.source,
      JSON.stringify({ title: `r1 ${id.slice(0, 6)}`, project_id: f.projectId, ...spec.params })],
  );
  for (const userId of spec.approvers ?? []) {
    await f.client.query(
      `INSERT INTO agent_action_approvers (id, org_id, action_id, user_id, decision) VALUES ($1, $2, $3, $4, 'pending')`,
      [randomUUID(), f.orgId, id, userId],
    );
  }
  return id;
}

const REVIEWER_REFUSALS = new Set([
  'only the requester or an org owner/admin may approve this action',
  'only the requester or an org owner/admin may reject this action',
]);

/** Whether the web route takes this user's decision; any other answer fails the test. */
async function routeAccepts(userId: string, actionId: string, decision: 'approve' | 'reject'): Promise<boolean> {
  const response = await app.request(`/api/agent/actions/${actionId}/${decision}`, {
    method: 'POST', body: '{}', headers: { 'x-test-user': userId, 'content-type': 'application/json' },
  });
  const text = await response.text();
  if (response.status === 404) return false;
  if (response.status === 403 && REVIEWER_REFUSALS.has((JSON.parse(text) as { error?: string }).error ?? '')) return false;
  assert.equal(response.status, 200, text);
  return true;
}

async function listed(userId: string, path: string, actionId: string): Promise<boolean> {
  const response = await app.request(path, { headers: { 'x-test-user': userId } });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.text()).includes(actionId);
}

async function loadAction(id: string) {
  const { db } = await import('../src/lib/db.js');
  const { agentActions } = await import('@deft/db/schema');
  const { eq } = await import('drizzle-orm');
  const [row] = await db.select().from(agentActions).where(eq(agentActions.id, id));
  return row!;
}

async function approverIds(actionId: string): Promise<string[]> {
  return (await f.client.query('SELECT user_id FROM agent_action_approvers WHERE action_id = $1 ORDER BY user_id', [actionId]))
    .rows.map((row) => row.user_id as string);
}

/** Asserts the user gains no read of detail, decision, listing or assignment. */
async function assertNoReviewRights(userId: string, actionId: string, label: string, assigned = false) {
  const { approveAction, rejectAction } = await import('../src/lib/agent-approval-resolver.js');
  const { humanApprovalGet, humanApprovalList } = await import('../src/lib/mcp-tools/human.js');
  const role = roles.get(userId) as 'member' | 'guest';
  for (const result of [await approveAction(actionId, userId), await rejectAction(actionId, userId)]) {
    assert.equal(result.status, 'error', label);
    assert.equal((result as { code?: string }).code, 'FORBIDDEN', label);
  }
  for (const decision of ['reject', 'approve'] as const) {
    assert.equal(await routeAccepts(userId, actionId, decision), false, `${label} ${decision} route`);
  }
  assert.equal(await listed(userId, '/api/inbox?kind=pending_approval&limit=100', actionId), false, `${label} inbox`);
  assert.equal(await listed(userId, '/api/attention?lane=needs_you&limit=100', actionId), false, `${label} attention`);
  const ctx = { org_id: f.orgId, user_id: userId, role, scopes: ['read:workspace'] };
  assert.equal((await humanApprovalGet({ action_id: actionId }, ctx)).isError, true, `${label} mcp get`);
  assert.equal(JSON.stringify((await humanApprovalList({ status: 'pending' }, ctx)).content).includes(actionId), false, `${label} mcp list`);
  assert.equal((await approverIds(actionId)).includes(userId), assigned, `${label} approver row`);
  assert.equal((await f.client.query('SELECT 1 FROM agent_actions WHERE id = $1 AND approval_status = $2', [actionId, 'pending'])).rowCount, 1);
}

test('an external agent\'s params never make a member, a guest or a foreign user its requester', { skip: !canRun, timeout: 900_000 }, async () => {
  const { syncApprovalToAttention } = await import('../src/lib/attention.js');
  for (const source of ['mcp', 'mcp_api']) {
    for (const [label, named] of [['member', f.otherId], ['guest', guestId], ['foreign admin', foreignAdminId]] as const) {
      for (const key of ['source_user_id', 'origin_user_id']) {
        const actionId = await pendingAction({ source, userId: shadowId, employee: true, params: { [key]: named } });
        // The attention sync assigns the action's reviewers: the owners/admins.
        const items = await syncApprovalToAttention(await loadAction(actionId), { deliver: false });
        assert.deepEqual(items.map((item) => item?.user_id), [f.adminId], `${source} ${label} ${key} attention`);
        assert.deepEqual(await approverIds(actionId), [f.adminId]);
        if (label !== 'foreign admin') await assertNoReviewRights(named, actionId, `${source} ${label} ${key}`);
        else {
          const { approveAction } = await import('../src/lib/agent-approval-resolver.js');
          assert.equal((await approveAction(actionId, named)).status, 'error');
        }
        assert.equal(await routeAccepts(f.adminId, actionId, 'reject'), true, `${source} ${label} ${key}: admin reviews`);
      }
    }
  }
});

test('an external agent\'s action naming its own agent user is reviewed by owners/admins', { skip: !canRun, timeout: 900_000 }, async () => {
  const { syncApprovalToAttention } = await import('../src/lib/attention.js');
  const actionId = await pendingAction({ source: 'mcp', userId: shadowId, employee: true, params: { source_user_id: shadowId } });
  await syncApprovalToAttention(await loadAction(actionId), { deliver: false });
  assert.deepEqual(await approverIds(actionId), [f.adminId]);
  for (const human of [f.requesterId, f.otherId, guestId]) {
    assert.equal(await routeAccepts(human, actionId, 'reject'), false);
  }
});

test('existing assignments count only when they name a reviewer', { skip: !canRun, timeout: 900_000 }, async () => {
  const { upsertAttentionItem, approvalToAttentionDraft, filterVisibleAttentionItems } = await import('../src/lib/attention.js');
  // An assignment and an attention item for a member the params named.
  const forged = await pendingAction({ source: 'mcp', userId: shadowId, employee: true, params: { source_user_id: f.otherId }, approvers: [f.otherId] });
  const item = await upsertAttentionItem(approvalToAttentionDraft(await loadAction(forged), f.otherId), { deliver: false });
  assert.deepEqual(await filterVisibleAttentionItems(f.otherId, [item!]), []);
  await assertNoReviewRights(f.otherId, forged, 'assigned member', true);
  assert.equal(await routeAccepts(f.adminId, forged, 'reject'), true, 'owners/admins review it');

  // An assignment naming an admin on an action whose own user is an active human.
  const named = await pendingAction({ source: 'mention', userId: f.requesterId, params: { source_user_id: f.adminId }, approvers: [f.adminId] });
  assert.equal(await routeAccepts(f.adminId, named, 'reject'), false, 'the named admin');
  assert.equal(await routeAccepts(f.requesterId, named, 'reject'), true, 'the requester');

  // An assignment of a requester who has left the workspace.
  const departedId = randomUUID();
  await f.client.query(`INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES ($1, $2, 'Departed', 'human', false, true)`,
    [departedId, `r1-departed-${departedId}@example.test`]);
  await f.client.query(`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, 'member', true)`,
    [randomUUID(), f.orgId, departedId]);
  const departed = await pendingAction({ source: 'mention', userId: departedId, approvers: [departedId] });
  await f.client.query('UPDATE org_members SET is_active = false WHERE org_id = $1 AND user_id = $2', [f.orgId, departedId]);
  assert.equal(await routeAccepts(f.adminId, departed, 'reject'), true, 'owners/admins recover it');
});

test('each legitimate requester keeps review of their action', { skip: !canRun, timeout: 900_000 }, async () => {
  const { syncApprovalToAttention } = await import('../src/lib/attention.js');
  const { viewerReviewAuthority } = await import('../src/lib/agent-approval-resolver.js');
  const requester = { id: f.requesterId, org_id: f.orgId, role: 'member' };
  // Defty capture: the source message author.
  for (const key of ['source_user_id', 'origin_user_id']) {
    const capture = await pendingAction({ source: 'defty_capture', userId: shadowId, params: { [key]: f.requesterId } });
    await syncApprovalToAttention(await loadAction(capture), { deliver: false });
    assert.deepEqual(await approverIds(capture), [f.requesterId], key);
    assert.deepEqual((await viewerReviewAuthority(requester, [capture])).get(capture), { viewer_can_approve: true, viewer_can_reject: true });
    assert.equal(await listed(f.requesterId, '/api/inbox?kind=work_capture&limit=100', capture), true, `${key} inbox`);
    assert.equal(await routeAccepts(f.otherId, capture, 'reject'), false, `${key} other member`);
    assert.equal(await routeAccepts(f.requesterId, capture, 'reject'), true, `${key} requester`);
  }
  // A capture action whose author is not a member falls to owners/admins.
  const foreignCapture = await pendingAction({ source: 'defty_capture', userId: shadowId, params: { source_user_id: foreignAdminId } });
  await syncApprovalToAttention(await loadAction(foreignCapture), { deliver: false });
  assert.deepEqual(await approverIds(foreignCapture), [f.adminId]);
  // A Defty reply and an approval requested by an external agent for its creator: the action's own user.
  for (const spec of [{ source: 'mention', userId: f.requesterId }, { source: 'mcp', userId: f.requesterId, employee: true }]) {
    const actionId = await pendingAction(spec);
    await syncApprovalToAttention(await loadAction(actionId), { deliver: false });
    assert.deepEqual(await approverIds(actionId), [f.requesterId], spec.source);
    assert.equal(await routeAccepts(f.requesterId, actionId, 'reject'), true, spec.source);
  }
  // A guest's own Defty reply stays theirs.
  const guestOwn = await pendingAction({ source: 'mention', userId: guestId });
  assert.equal(await routeAccepts(guestId, guestOwn, 'reject'), true, 'guest own reply');
});

/** The capture rule as written before it moved into SQL alone: the expected answers below. */
function expectedRequester(row: { user_id: string; source: string | null; params: unknown }): string {
  if (row.source !== 'defty_capture' || !row.params || typeof row.params !== 'object' || Array.isArray(row.params)) return row.user_id;
  const params = row.params as Record<string, unknown>;
  const claimed = params.source_user_id ?? params.origin_user_id;
  return typeof claimed === 'string' && /[^ \t\n\v\f\r]/.test(claimed) ? claimed : row.user_id;
}

test('the batch requester loader answers the SQL rule for each row', { skip: !canRun, timeout: 120_000 }, async () => {
  const { loadActionRequesterIds, loadActionReviewers } = await import('../src/lib/agent-action-requester.js');
  const cases: Array<[string, unknown]> = [
    ['absent', {}], ['source', { source_user_id: 'u-src' }], ['origin', { origin_user_id: 'u-origin' }],
    ['precedence', { source_user_id: 'u-src', origin_user_id: 'u-origin' }],
    ['null source', { source_user_id: null, origin_user_id: 'u-origin' }],
    ['empty', { source_user_id: '' }], ['blank', { source_user_id: '  ', origin_user_id: 'u-origin' }],
    ['number', { source_user_id: 7, origin_user_id: 'u-origin' }], ['object', { source_user_id: { id: 'u-src' } }],
    ['tabs', { source_user_id: '\t\n\r\f\v ' }], ['no-break space', { source_user_id: '\u00a0' }],
    ['byte order mark', { source_user_id: '\ufeff' }],
    ['array params', ['u-src']], ['scalar params', 'u-src'],
  ];
  const rows = [];
  for (const source of ['defty_capture', 'mcp', null]) {
    for (const [label, params] of cases) {
      rows.push({
        id: `${source} ${label}`, org_id: 'o', user_id: 'u-own', source, params,
        message_id: null, agent_employee_id: null, conversation_id: null, created_at: new Date(),
      });
    }
  }
  const requesters = await loadActionRequesterIds(rows);
  assert.equal(requesters.size, rows.length);
  for (const row of rows) assert.equal(requesters.get(row.id), expectedRequester(row), row.id);
  assert.equal(requesters.get('defty_capture precedence'), 'u-src');
  assert.equal(requesters.get('mcp source'), 'u-own');

  // Reviewers of committed rows come from the same loader.
  const capture = await pendingAction({ source: 'defty_capture', userId: shadowId, params: { source_user_id: f.requesterId } });
  const own = await pendingAction({ source: 'mcp', userId: shadowId, employee: true, params: { source_user_id: f.requesterId } });
  const reviewers = await loadActionReviewers([await loadAction(capture), await loadAction(own)]);
  assert.deepEqual(reviewers.get(capture), [f.requesterId]);
  assert.deepEqual(reviewers.get(own), [f.adminId]);
});

test('requester readers outside the helper load the requester rather than derive it', { timeout: 60_000 }, async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const files: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.ts')) files.push(path);
    }
  };
  await walk(root);
  const helper = await readFile(join(root, 'lib/agent-action-requester.ts'), 'utf8');
  // The rule is stated once, in SQL; the only synchronous export reads a capture's author.
  assert.doesNotMatch(helper, /export function actionRequesterId\b/);
  for (const path of files) {
    const source = await readFile(path, 'utf8');
    assert.doesNotMatch(source, /\bactionRequesterId\s*\(/, path);
    // A capture author with a fallback to the action's own user restates the rule.
    if (!path.endsWith('agent-action-requester.ts')) {
      assert.doesNotMatch(source, /captureSourceUserId\([^)]*\)\s*\?\?/, path);
    }
  }
  for (const file of ['lib/agent-approval-resolver.ts', 'lib/agent-action-visibility.ts', 'lib/connected-tool-access.ts']) {
    assert.match(await readFile(join(root, file), 'utf8'), /loadActionRequesterIds?\(/, file);
  }
});
