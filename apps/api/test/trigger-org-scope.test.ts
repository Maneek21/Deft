/**
 * Trigger jobs are delivered only to agent employees of the workspace they
 * belong to, and agent webhooks are managed by owners and admins.
 *
 * Two orgs (A and B) each have an active agent employee subscribed to the
 * same trigger kinds.
 *
 * Run: pnpm --filter @deft/api test test/trigger-org-scope.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  db, orgs, users, orgMembers, agentEmployees, agentActions, agentWebhooks,
  spaces, triggers, projects, tasks, workflowRules, workflowRuns, jobQueue, notifications,
} from '@deft/db';
import { handleTriggerDispatch } from '../src/workers/handlers/trigger-dispatch.js';
import { handleEmployeeTrigger } from '../src/workers/handlers/employee-trigger.js';
import { handleAgentEmployeeTrigger } from '../src/workers/handlers/agent-employee-trigger.js';
import { handleWorkflowExecute } from '../src/workers/handlers/workflow-execute.js';
import { emitMemberJoinedTrigger } from '../src/lib/member-joined-trigger.js';
import { githubWebhookRoutes } from '../src/routes/webhooks/github.js';
import { agentWebhookRoutes, publicAgentWebhookRoutes } from '../src/routes/agent-webhooks.js';

const stamp = `lg${Date.now().toString(36)}`;
const KIND = `event:lane-g-${stamp}`;
const ORG_A = crypto.randomUUID();
const ORG_B = crypto.randomUUID();
const ids = {
  ownerA: crypto.randomUUID(), adminA: crypto.randomUUID(), memberA: crypto.randomUUID(), guestA: crypto.randomUUID(),
  adminB: crypto.randomUUID(), agentUserA: crypto.randomUUID(), agentUserB: crypto.randomUUID(),
  empA: crypto.randomUUID(), empB: crypto.randomUUID(),
  spaceA: crypto.randomUUID(), spaceB: crypto.randomUUID(),
  projectB: crypto.randomUUID(), taskB: crypto.randomUUID(), ruleB: crypto.randomUUID(),
  triggerA: crypto.randomUUID(),
};
const allUsers = [ids.ownerA, ids.adminA, ids.memberA, ids.guestA, ids.adminB, ids.agentUserA, ids.agentUserB];

function job(name: string, data: Record<string, unknown>) {
  return { id: `${stamp}-${crypto.randomUUID()}`, name, data, attempts: 1 } as any;
}

async function triggerJobs(kind = KIND) {
  return db.select({ data: jobQueue.data }).from(jobQueue).where(and(
    eq(jobQueue.name, 'employee-trigger'),
    sql`${jobQueue.data}->>'trigger_kind' = ${kind}`,
  ));
}

async function actionsFor(employeeId: string, kind: string) {
  return db.select({ org_id: agentActions.org_id }).from(agentActions).where(and(
    eq(agentActions.agent_employee_id, employeeId),
    sql`${agentActions.params}->>'trigger_kind' = ${kind}`,
  ));
}

before(async () => {
  await db.insert(orgs).values([
    { id: ORG_A, name: `${stamp}-a`, slug: `${stamp}-a` },
    { id: ORG_B, name: `${stamp}-b`, slug: `${stamp}-b` },
  ]);
  await db.insert(users).values(allUsers.map((id, i) => ({
    id, email: `${stamp}-${i}@t.local`, name: `${stamp} user ${i}`,
    ...(id === ids.agentUserA || id === ids.agentUserB ? { kind: 'agent' as const, is_agent: true } : {}),
  })));
  await db.insert(orgMembers).values([
    { id: crypto.randomUUID(), org_id: ORG_A, user_id: ids.ownerA, role: 'owner' },
    { id: crypto.randomUUID(), org_id: ORG_A, user_id: ids.adminA, role: 'admin' },
    { id: crypto.randomUUID(), org_id: ORG_A, user_id: ids.memberA, role: 'member' },
    { id: crypto.randomUUID(), org_id: ORG_A, user_id: ids.guestA, role: 'guest' },
    { id: crypto.randomUUID(), org_id: ORG_B, user_id: ids.adminB, role: 'admin' },
  ] as any);
  const emp = (id: string, org: string, user: string, creator: string) => ({
    id, org_id: org, user_id: user, slug: `${stamp}-${id.slice(0, 8)}`, name: `${stamp} agent`,
    system_prompt: 'test', is_byoa: true, trust_level: 'standard', created_by: creator,
    role: 'project_manager', trigger_subscriptions: [KIND, 'member.joined', 'cron:nightly-review'],
  });
  await db.insert(agentEmployees).values([
    emp(ids.empA, ORG_A, ids.agentUserA, ids.ownerA),
    emp(ids.empB, ORG_B, ids.agentUserB, ids.adminB),
  ] as any);
  await db.insert(spaces).values([
    { id: ids.spaceA, org_id: ORG_A, name: `${stamp}-a`, created_by: ids.ownerA },
    { id: ids.spaceB, org_id: ORG_B, name: `${stamp}-b`, created_by: ids.adminB },
  ] as any);
  await db.insert(triggers).values({
    id: ids.triggerA, org_id: ORG_A, name: `${stamp} trigger`, event_type: 'task_overdue',
    actions: [{ type: 'run_agent', prompt: 'look at {{event}}' }], agent_employee_id: ids.empA,
    created_by: ids.ownerA,
  } as any);
  await db.insert(projects).values({
    id: ids.projectB, org_id: ORG_B, name: `${stamp}-p`, prefix: `LG${Date.now()}`.slice(0, 10), created_by: ids.adminB,
  } as any);
  await db.insert(tasks).values({
    id: ids.taskB, org_id: ORG_B, project_id: ids.projectB, number: 1, title: 'b task', status: 'todo', created_by: ids.adminB,
  } as any);
  await db.insert(workflowRules).values({
    id: ids.ruleB, org_id: ORG_B, name: `${stamp}-rule`, trigger_type: 'task.status_changed',
    trigger_config: {}, action_type: 'add_comment', action_config: { actions: [] }, is_active: true, created_by: ids.adminB,
  } as any);
});

after(async () => {
  await db.delete(jobQueue).where(sql`${jobQueue.data}::text LIKE ${'%' + stamp + '%'}`);
  await db.delete(jobQueue).where(inArray(jobQueue.org_id, [ORG_A, ORG_B]));
  await db.delete(notifications).where(inArray(notifications.org_id, [ORG_A, ORG_B]));
  await db.delete(workflowRuns).where(eq(workflowRuns.rule_id, ids.ruleB));
  await db.delete(workflowRules).where(eq(workflowRules.id, ids.ruleB));
  await db.delete(tasks).where(eq(tasks.id, ids.taskB));
  await db.delete(projects).where(eq(projects.id, ids.projectB));
  await db.delete(triggers).where(eq(triggers.id, ids.triggerA));
  await db.delete(agentActions).where(inArray(agentActions.org_id, [ORG_A, ORG_B]));
  await db.delete(agentWebhooks).where(inArray(agentWebhooks.org_id, [ORG_A, ORG_B]));
  await db.delete(spaces).where(inArray(spaces.id, [ids.spaceA, ids.spaceB]));
  await db.delete(agentEmployees).where(inArray(agentEmployees.id, [ids.empA, ids.empB]));
  await db.delete(orgMembers).where(inArray(orgMembers.org_id, [ORG_A, ORG_B]));
  await db.delete(users).where(inArray(users.id, allUsers));
  await db.delete(orgs).where(inArray(orgs.id, [ORG_A, ORG_B]));
});

test('a trigger event for org A is delivered only to org A agent employees', async () => {
  await handleTriggerDispatch(job('trigger-dispatch', { trigger_kind: KIND, org_id: ORG_A, context: { stamp }, goal: 'go' }));
  const rows = await triggerJobs();
  assert.equal(rows.length, 1);
  assert.equal((rows[0]!.data as any).employee_id, ids.empA);
  assert.equal((rows[0]!.data as any).org_id, ORG_A);
  await db.delete(jobQueue).where(sql`${jobQueue.data}->>'trigger_kind' = ${KIND}`);
});

test('a trigger event without a workspace, or with an unknown one, delivers nothing', async () => {
  for (const data of [
    { trigger_kind: KIND, context: { stamp }, goal: 'go' },
    { trigger_kind: KIND, org_id: '', context: { stamp }, goal: 'go' },
    { trigger_kind: KIND, org_id: crypto.randomUUID(), context: { stamp }, goal: 'go' },
    { trigger_kind: '', org_id: ORG_A },
    { org_id: ORG_A },
  ]) {
    await handleTriggerDispatch(job('trigger-dispatch', data));
  }
  assert.equal((await triggerJobs()).length, 0);
});

test('only the scheduler job sweeps cron kinds, tagging each job with its employee\'s workspace', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 13, 21, 5) });
  const nightly = async () => (await triggerJobs('cron:nightly-review'))
    .map((r) => r.data as any).filter((d) => d.employee_id === ids.empA || d.employee_id === ids.empB);
  await handleTriggerDispatch(job('trigger-dispatch', {}));
  await handleTriggerDispatch({ ...job('trigger-dispatch', {}), cronKey: 'cron:other' });
  assert.equal((await nightly()).length, 0);
  await handleTriggerDispatch({ ...job('trigger-dispatch', {}), cronKey: 'cron:trigger-dispatch' });
  const rows = await nightly();
  t.mock.timers.reset();
  assert.equal(rows.length, 2);
  for (const d of rows) assert.equal(d.org_id, d.employee_id === ids.empA ? ORG_A : ORG_B);
  await db.delete(jobQueue).where(and(
    sql`${jobQueue.data}->>'trigger_kind' = 'cron:nightly-review'`,
    sql`${jobQueue.data}->>'employee_id' IN (${ids.empA}, ${ids.empB})`,
  ));
});

test('a trigger event whose queue row belongs to another workspace delivers nothing', async () => {
  await handleTriggerDispatch({ ...job('trigger-dispatch', { trigger_kind: KIND, org_id: ORG_A }), orgId: ORG_B });
  await handleTriggerDispatch(job('trigger-dispatch', { trigger_kind: KIND, org_id: ORG_A, orgId: ORG_B }));
  assert.equal((await triggerJobs()).length, 0);
});

test('a signed GitHub merged-PR delivery is acknowledged and dispatches nothing', async (t) => {
  const previous = process.env.GITHUB_WEBHOOK_SECRET;
  process.env.GITHUB_WEBHOOK_SECRET = `${stamp}-secret`;
  t.after(() => { if (previous === undefined) delete process.env.GITHUB_WEBHOOK_SECRET; else process.env.GITHUB_WEBHOOK_SECRET = previous; });
  const body = JSON.stringify({
    action: 'closed', repository: { full_name: `acme/${stamp}` },
    pull_request: { merged: true, number: 7, title: `${stamp} pr`, html_url: 'https://example.invalid/pr/7', user: { login: 'x' } },
  });
  const sig = 'sha256=' + crypto.createHmac('sha256', `${stamp}-secret`).update(body).digest('hex');
  const app = new Hono();
  app.route('/api/webhooks', githubWebhookRoutes);
  const res = await app.request('/api/webhooks/github', {
    method: 'POST', headers: { 'x-github-event': 'pull_request', 'x-hub-signature-256': sig }, body,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, skipped: 'unattributed' });
  const queued = await db.select({ id: jobQueue.id }).from(jobQueue).where(and(
    eq(jobQueue.name, 'trigger-dispatch'), sql`${jobQueue.data}::text LIKE ${'%' + stamp + '%'}`,
  ));
  assert.equal(queued.length, 0);
});

test('an employee trigger for the employee\'s own workspace queues work for it', async () => {
  const kind = `${KIND}-own`;
  await handleEmployeeTrigger(job('employee-trigger', {
    employee_id: ids.empA, org_id: ORG_A, trigger_kind: kind, context: {}, goal: 'go', target_space_id: ids.spaceA,
  }));
  const rows = await actionsFor(ids.empA, kind);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.org_id, ORG_A);
});

test('an employee trigger with a missing or mismatched workspace queues nothing', async () => {
  const kind = `${KIND}-bad`;
  for (const data of [
    { employee_id: ids.empA, trigger_kind: kind, context: {}, goal: 'go' },
    { employee_id: ids.empA, org_id: ORG_B, trigger_kind: kind, context: {}, goal: 'go' },
    { employee_id: ids.empA, org_id: ORG_A, trigger_kind: kind, context: {}, goal: 'go', target_space_id: ids.spaceB },
    { employee_id: ids.empA, org_id: ORG_A, orgId: ORG_B, trigger_kind: kind, context: {}, goal: 'go' },
  ]) {
    await handleEmployeeTrigger(job('employee-trigger', data));
  }
  await handleEmployeeTrigger({
    ...job('employee-trigger', { employee_id: ids.empA, org_id: ORG_A, trigger_kind: kind, context: {}, goal: 'go' }),
    orgId: ORG_B,
  });
  assert.equal((await actionsFor(ids.empA, kind)).length, 0);
});

test('a stored trigger runs only for the workspace that owns it', async () => {
  const count = async () => (await db.select({ id: agentActions.id }).from(agentActions).where(and(
    eq(agentActions.agent_employee_id, ids.empA), sql`${agentActions.params}->>'trigger_id' = ${ids.triggerA}`,
  ))).length;
  await handleAgentEmployeeTrigger(job('agent-employee-trigger', { triggerId: ids.triggerA, orgId: ORG_B, eventType: 'x', eventData: {} }));
  await handleAgentEmployeeTrigger(job('agent-employee-trigger', { triggerId: ids.triggerA, eventType: 'x', eventData: {} }));
  await handleAgentEmployeeTrigger(job('agent-employee-trigger', { triggerId: ids.triggerA, orgId: ORG_A, org_id: ORG_B, eventType: 'x', eventData: {} }));
  await handleAgentEmployeeTrigger({ ...job('agent-employee-trigger', { triggerId: ids.triggerA, orgId: ORG_A, eventType: 'x', eventData: {} }), orgId: ORG_B });
  assert.equal(await count(), 0);
  await handleAgentEmployeeTrigger(job('agent-employee-trigger', { triggerId: ids.triggerA, orgId: ORG_A, eventType: 'x', eventData: {} }));
  assert.equal(await count(), 1);
});

test('member.joined trigger jobs carry the joining workspace and target only its employees', async () => {
  const n = await emitMemberJoinedTrigger({ org_id: ORG_A, new_user_id: ids.memberA, inviter_user_id: ids.ownerA, role: 'member' });
  assert.equal(n, 1);
  const rows = await db.select({ data: jobQueue.data }).from(jobQueue).where(and(
    eq(jobQueue.name, 'employee-trigger'),
    sql`${jobQueue.data}->>'trigger_kind' = 'member.joined'`,
    sql`${jobQueue.data}->>'employee_id' IN (${ids.empA}, ${ids.empB})`,
  ));
  assert.equal(rows.length, 1);
  assert.equal((rows[0]!.data as any).employee_id, ids.empA);
  assert.equal((rows[0]!.data as any).org_id, ORG_A);
});

test('an external agent webhook delivery carries the webhook\'s workspace', async () => {
  const slug = `${stamp}-slug`;
  const hmacKey = 'k';
  const { encrypt } = await import('../src/lib/encryption.js');
  await db.insert(agentWebhooks).values({
    id: crypto.randomUUID(), org_id: ORG_A, agent_employee_id: ids.empA, slug,
    secret_hash: 'x', hmac_key_encrypted: encrypt(hmacKey), enabled: true, created_by: ids.ownerA,
  } as any);
  const body = JSON.stringify({ stamp });
  const app = new Hono();
  app.route('/api/agent-webhooks', publicAgentWebhookRoutes);
  const res = await app.request(`/api/agent-webhooks/${slug}`, {
    method: 'POST', body,
    headers: { 'x-deft-webhook-signature': 'sha256=' + crypto.createHmac('sha256', hmacKey).update(body).digest('hex') },
  });
  assert.equal(res.status, 200);
  const rows = await db.select({ data: jobQueue.data }).from(jobQueue).where(and(
    eq(jobQueue.name, 'employee-trigger'), sql`${jobQueue.data}->'context'->>'webhook_slug' = ${slug}`,
  ));
  assert.equal(rows.length, 1);
  assert.equal((rows[0]!.data as any).org_id, ORG_A);
});

test('a workflow job runs only for the workspace that owns the rule', async () => {
  const runs = async () => (await db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.rule_id, ids.ruleB))).length;
  for (const data of [
    { workflow_id: ids.ruleB, task_id: ids.taskB, actor_user_id: ids.adminB },
    { workflow_id: ids.ruleB, task_id: ids.taskB, actor_user_id: ids.adminB, org_id: ORG_A },
    { workflow_id: ids.ruleB, task_id: ids.taskB, actor_user_id: ids.adminB, org_id: ORG_B, orgId: ORG_A },
  ]) {
    await handleWorkflowExecute(job('workflow-execute', data));
  }
  await handleWorkflowExecute({
    ...job('workflow-execute', { workflow_id: ids.ruleB, task_id: ids.taskB, actor_user_id: ids.adminB, org_id: ORG_B }),
    orgId: ORG_A,
  });
  assert.equal(await runs(), 0);
  await handleWorkflowExecute(job('workflow-execute', { workflow_id: ids.ruleB, task_id: ids.taskB, actor_user_id: ids.adminB, org_id: ORG_B }));
  assert.equal(await runs(), 1);
});

test('workflow actions assign and notify only members of the rule\'s workspace', async () => {
  await db.update(workflowRules).set({
    action_config: { actions: [{ kind: 'assign_to', user_id: ids.ownerA }, { kind: 'notify', user_id: ids.ownerA }] },
  } as any).where(eq(workflowRules.id, ids.ruleB));
  await handleWorkflowExecute(job('workflow-execute', { workflow_id: ids.ruleB, task_id: ids.taskB, actor_user_id: ids.adminB, org_id: ORG_B }));
  const [task] = await db.select({ assignee_id: tasks.assignee_id }).from(tasks).where(eq(tasks.id, ids.taskB));
  assert.equal(task!.assignee_id, null);
  const notified = await db.select({ id: notifications.id }).from(notifications).where(eq(notifications.user_id, ids.ownerA));
  assert.equal(notified.length, 0);
});

function managementApp(userId: string, orgId: string, role: string) {
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('user' as never, { id: userId, org_id: orgId, role, email: 'x@t.local' } as never); await next(); });
  app.route('/api/agent-webhooks', agentWebhookRoutes);
  return app;
}

test('members and guests cannot create, list or revoke agent webhooks', async () => {
  const [hook] = await db.insert(agentWebhooks).values({
    id: crypto.randomUUID(), org_id: ORG_A, agent_employee_id: ids.empA, slug: `${stamp}-m`,
    secret_hash: 'x', enabled: true, created_by: ids.ownerA,
  } as any).returning();
  for (const [userId, role] of [[ids.memberA, 'member'], [ids.guestA, 'guest']] as const) {
    const app = managementApp(userId, ORG_A, role);
    const created = await app.request('/api/agent-webhooks', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent_employee_id: ids.empA }),
    });
    assert.equal(created.status, 403);
    assert.equal(((await created.json()) as any).code, 'FORBIDDEN');
    assert.equal((await app.request(`/api/agent-webhooks?employee_id=${ids.empA}`)).status, 403);
    assert.equal((await app.request(`/api/agent-webhooks/${hook!.id}`, { method: 'DELETE' })).status, 403);
  }
  const still = await db.select({ id: agentWebhooks.id }).from(agentWebhooks).where(eq(agentWebhooks.org_id, ORG_A));
  assert.equal(still.length, 2);
});

test('owners and admins manage agent webhooks of their own workspace only', async () => {
  for (const [userId, role] of [[ids.ownerA, 'owner'], [ids.adminA, 'admin']] as const) {
    const app = managementApp(userId, ORG_A, role);
    const created = await app.request('/api/agent-webhooks', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent_employee_id: ids.empA }),
    });
    assert.equal(created.status, 201);
    const id = ((await created.json()) as any).webhook.id;
    const listed = await app.request(`/api/agent-webhooks?employee_id=${ids.empA}`);
    assert.equal(listed.status, 200);
    assert.ok(((await listed.json()) as any).webhooks.some((w: any) => w.id === id));
    assert.equal((await app.request(`/api/agent-webhooks/${id}`, { method: 'DELETE' })).status, 200);
  }
  const [hookB] = await db.insert(agentWebhooks).values({
    id: crypto.randomUUID(), org_id: ORG_B, agent_employee_id: ids.empB, slug: `${stamp}-b`,
    secret_hash: 'x', enabled: true, created_by: ids.adminB,
  } as any).returning();
  const adminA = managementApp(ids.adminA, ORG_A, 'admin');
  const missing = await adminA.request(`/api/agent-webhooks/${crypto.randomUUID()}`, { method: 'DELETE' });
  const other = await adminA.request(`/api/agent-webhooks/${hookB!.id}`, { method: 'DELETE' });
  assert.equal(other.status, 404);
  assert.deepEqual(await other.json(), await missing.json());
  const otherCreate = await adminA.request('/api/agent-webhooks', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent_employee_id: ids.empB }),
  });
  assert.equal(otherCreate.status, 404);
  const otherList = await adminA.request(`/api/agent-webhooks?employee_id=${ids.empB}`);
  assert.deepEqual(((await otherList.json()) as any).webhooks, []);
  assert.equal((await db.select({ id: agentWebhooks.id }).from(agentWebhooks).where(eq(agentWebhooks.id, hookB!.id))).length, 1);
});
