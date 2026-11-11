/**
 * Approval rows in the Inbox and the Attention feed say whether the viewer
 * may approve or reject them (`viewer_can_approve`, `viewer_can_reject`).
 * The flags must equal what the approve and reject routes answer for the
 * same viewer, so the web card never offers a control the server refuses.
 *
 * Every pair (viewer, action) is checked against the real routes: one fresh
 * action is approved and another rejected through `/api/agent/actions/...`.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/approval-viewer-can-review.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';

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
let app: Hono;
let employeeId: string;
let shadowId: string;
let ownerId: string;
let assignedMemberId: string;
let assignedGuestId: string;
const roles = new Map<string, string>();

async function addHuman(role: string): Promise<string> {
  const id = randomUUID();
  await f.client.query(
    `INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES ($1, $2, $3, 'human', false, true)`,
    [id, `review-flag-${id}@example.test`, `Review ${role} ${id.slice(0, 4)}`],
  );
  await f.client.query('INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, $4, true)',
    [randomUUID(), f.orgId, id, role]);
  roles.set(id, role);
  return id;
}

before(async () => {
  if (!canRun) return;
  f = await setupDurabilityFixture('VR');
  roles.set(f.requesterId, 'member');
  roles.set(f.otherId, 'member');
  roles.set(f.adminId, 'admin');
  ownerId = await addHuman('owner');
  assignedMemberId = await addHuman('member');
  assignedGuestId = await addHuman('guest');
  employeeId = randomUUID();
  shadowId = randomUUID();
  await f.client.query(
    `INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES ($1, $2, $3, 'agent', true, true)`,
    [shadowId, `review-flag-agent-${shadowId}@example.test`, `Review agent ${shadowId.slice(0, 4)}`],
  );
  await f.client.query('INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, $4, true)',
    [randomUUID(), f.orgId, shadowId, 'member']);
  await f.client.query(
    `INSERT INTO agent_employees (id, org_id, user_id, name, slug, role, system_prompt, trust_level, is_byoa, is_active, created_by)
     VALUES ($1, $2, $3, 'Review agent', $4, 'project_manager', 'Fixture', 'conservative', true, true, $5)`,
    [employeeId, f.orgId, shadowId, `review-agent-${employeeId.slice(0, 8)}`, f.requesterId],
  );
  await f.client.query('UPDATE users SET agent_employee_id = $2 WHERE id = $1', [shadowId, employeeId]);

  app = new Hono();
  app.use('*', async (c, next) => {
    const id = c.req.header('x-test-user')!;
    c.set('user', { id, org_id: f.orgId, email: `${id}@example.test`, sid: '', role: roles.get(id) } as any);
    await next();
  });
  app.route('/api/agent', agentRoutes);
  app.route('/api/inbox', inboxRoutes);
  app.route('/api/attention', attentionRoutes);
});

after(async () => {
  if (f) await f.teardown();
});

function as(userId: string, path: string, init?: RequestInit) {
  return app.request(path, { ...init, headers: { ...(init?.headers ?? {}), 'x-test-user': userId, 'content-type': 'application/json' } });
}

type Kind = 'defty' | 'employee' | 'employee_for_requester' | 'record_mirror';

/** A pending action of the given kind, optionally with assigned reviewers. */
async function pendingAction(kind: Kind, assigned: boolean): Promise<string> {
  const id = randomUUID();
  const title = `review flag ${kind} ${id.slice(0, 6)}`;
  if (kind === 'defty') {
    await f.client.query(
      `INSERT INTO agent_actions (id, org_id, user_id, source, action, params, approval_tier, approval_status)
       VALUES ($1, $2, $3, 'mention', 'create_task', $4::jsonb, 'full', 'pending')`,
      [id, f.orgId, f.requesterId, JSON.stringify({ title, project_id: f.projectId })],
    );
  } else if (kind === 'employee' || kind === 'employee_for_requester') {
    const params: Record<string, unknown> = { title, project_id: f.projectId };
    if (kind === 'employee_for_requester') params.source_user_id = f.requesterId;
    await f.client.query(
      `INSERT INTO agent_actions (id, org_id, user_id, agent_employee_id, source, action, params, approval_tier, approval_status)
       VALUES ($1, $2, $3, $4, 'mcp', 'task_create', $5::jsonb, 'full', 'pending')`,
      [id, f.orgId, shadowId, employeeId, JSON.stringify(params)],
    );
  } else {
    await f.client.query(
      `INSERT INTO agent_actions (id, org_id, user_id, agent_employee_id, source, action, params, approval_tier, approval_status)
       VALUES ($1, $2, $3, $4, 'mcp', 'app_record_mirror_nominate', '{}'::jsonb, 'full', 'pending')`,
      [id, f.orgId, f.requesterId, employeeId],
    );
  }
  if (assigned) {
    for (const userId of [assignedMemberId, assignedGuestId]) {
      await f.client.query(
        `INSERT INTO agent_action_approvers (id, org_id, action_id, user_id, decision) VALUES ($1, $2, $3, $4, 'pending')`,
        [randomUUID(), f.orgId, id, userId],
      );
    }
  }
  return id;
}

/**
 * Refusals that concern who the reviewer is. Any other answer (success,
 * execution failure, a missing web session for a record-mirror approval)
 * means the route accepted this reviewer.
 */
const REVIEWER_REFUSALS = new Set([
  'only the owning user may approve a record-mirror nomination',
  'only the requester or an org owner/admin may approve this action',
  'only the requester or an org owner/admin may reject this action',
  'The action source is no longer available',
]);

async function routeAccepts(userId: string, actionId: string, decision: 'approve' | 'reject'): Promise<boolean> {
  const response = await as(userId, `/api/agent/actions/${actionId}/${decision}`, { method: 'POST', body: '{}' });
  if (response.status === 404) return false;
  if (response.status === 403) {
    const body = await response.json() as { error?: string };
    return !REVIEWER_REFUSALS.has(body.error ?? '');
  }
  return true;
}

type Flags = { viewer_can_approve?: unknown; viewer_can_reject?: unknown };

async function inboxFlags(userId: string, actionId: string): Promise<Flags | null> {
  const response = await as(userId, '/api/inbox?kind=pending_approval&limit=100');
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json() as { items: Array<{ approval?: Flags & { action_id: string } }> };
  return body.items.find((item) => item.approval?.action_id === actionId)?.approval ?? null;
}

async function attentionFlags(userId: string, actionId: string): Promise<Flags | null> {
  const response = await as(userId, '/api/attention?lane=needs_you&limit=100');
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json() as { items: Array<{ approval?: (Flags & { id: string }) | null }> };
  return body.items.find((item) => item.approval?.id === actionId)?.approval ?? null;
}

const viewers = () => ({
  requester: f.requesterId,
  owner: ownerId,
  admin: f.adminId,
  assigned_member: assignedMemberId,
  assigned_guest: assignedGuestId,
  unassigned_member: f.otherId,
});

for (const kind of ['defty', 'employee', 'employee_for_requester', 'record_mirror'] as const) {
  for (const assigned of [false, true]) {
    test(`B-review: ${kind} action${assigned ? ' with assigned reviewers' : ''}: the review flags equal the routes' answers`, { skip: !canRun, timeout: 120_000 }, async () => {
      const { viewerReviewAuthority } = await import('../src/lib/agent-approval-resolver.js');
      let shown = 0;
      const answers = new Set<boolean>();
      for (const [label, userId] of Object.entries(viewers())) {
        for (const decision of ['approve', 'reject'] as const) {
          const actionId = await pendingAction(kind, assigned);
          const flag = decision === 'approve' ? 'viewer_can_approve' : 'viewer_can_reject';
          const user = { id: userId, org_id: f.orgId, role: roles.get(userId) };
          const predicted = (await viewerReviewAuthority(user, [actionId])).get(actionId);
          const inbox = await inboxFlags(userId, actionId);
          const attention = await attentionFlags(userId, actionId);
          const accepted = await routeAccepts(userId, actionId, decision);
          answers.add(accepted);
          assert.equal(predicted?.[flag], accepted, `${label} ${decision}: predicate`);
          if (inbox) {
            shown += 1;
            assert.equal(inbox[flag], accepted, `${label} ${decision}: inbox flag`);
          }
          if (attention) assert.equal(attention[flag], accepted, `${label} ${decision}: attention flag`);
        }
      }
      // The inbox shows each action to at least the requester or an owner/admin.
      assert.ok(shown > 0);
      // Every case has viewers the routes accept and viewers they refuse.
      assert.deepEqual([...answers].sort(), [false, true]);
    });
  }
}
