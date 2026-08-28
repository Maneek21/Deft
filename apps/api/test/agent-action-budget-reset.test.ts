import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  actionReceipts,
  agentActions,
  agentEmployees,
  db,
  orgMembers,
  orgs,
  users,
} from '@deft/db';
import { verifyReceipt } from '../src/lib/receipts.js';
import { agentEmployeeRoutes } from '../src/routes/agent-employees.js';

const suffix = crypto.randomUUID();
const orgId = crypto.randomUUID();
const otherOrgId = crypto.randomUUID();
const adminId = crypto.randomUUID();
const memberId = crypto.randomUUID();
const employeeUserId = crypto.randomUUID();
const otherEmployeeUserId = crypto.randomUUID();
const employeeId = crypto.randomUUID();
const otherEmployeeId = crypto.randomUUID();

let actorId = adminId;

const app = new Hono();
app.use('*', async (c, next) => {
  c.set('user', { id: actorId, org_id: orgId, email: `${actorId}@test.local` });
  await next();
});
app.route('/api/agent-employees', agentEmployeeRoutes);

before(async () => {
  await db.insert(orgs).values([
    { id: orgId, name: `Budget reset ${suffix}`, slug: `budget-reset-${suffix}` },
    { id: otherOrgId, name: `Other budget reset ${suffix}`, slug: `other-budget-reset-${suffix}` },
  ]);
  await db.insert(users).values([
    { id: adminId, email: `budget-admin-${suffix}@test.local`, name: 'Budget Admin' },
    { id: memberId, email: `budget-member-${suffix}@test.local`, name: 'Budget Member' },
    { id: employeeUserId, email: `budget-agent-${suffix}@test.local`, name: 'Budget Agent', is_agent: true },
    { id: otherEmployeeUserId, email: `other-budget-agent-${suffix}@test.local`, name: 'Other Budget Agent', is_agent: true },
  ]);
  await db.insert(orgMembers).values([
    { org_id: orgId, user_id: adminId, role: 'admin' },
    { org_id: orgId, user_id: memberId, role: 'member' },
  ]);
  await db.insert(agentEmployees).values([
    {
      id: employeeId,
      org_id: orgId,
      user_id: employeeUserId,
      slug: `budget-agent-${suffix}`,
      name: 'Budget Agent',
      role: 'project_manager',
      system_prompt: 'Test action budget reset.',
      trust_level: 'standard',
      max_daily_actions: 50,
      daily_action_count: 45,
      is_byoa: true,
      created_by: adminId,
    },
    {
      id: otherEmployeeId,
      org_id: otherOrgId,
      user_id: otherEmployeeUserId,
      slug: `other-budget-agent-${suffix}`,
      name: 'Other Budget Agent',
      role: 'project_manager',
      system_prompt: 'Cross-tenant test employee.',
      trust_level: 'standard',
      max_daily_actions: 50,
      daily_action_count: 45,
      is_byoa: true,
      created_by: otherEmployeeUserId,
    },
  ]);
});

beforeEach(async () => {
  actorId = adminId;
  await db.delete(actionReceipts).where(eq(actionReceipts.employee_id, employeeId));
  await db.delete(agentActions).where(eq(agentActions.agent_employee_id, employeeId));
  await db.update(agentEmployees)
    .set({ daily_action_count: 45 })
    .where(and(eq(agentEmployees.id, employeeId), eq(agentEmployees.org_id, orgId)));
});

after(async () => {
  await db.delete(actionReceipts).where(eq(actionReceipts.employee_id, employeeId));
  await db.delete(agentActions).where(eq(agentActions.agent_employee_id, employeeId));
  await db.delete(agentEmployees).where(eq(agentEmployees.id, employeeId));
  await db.delete(agentEmployees).where(eq(agentEmployees.id, otherEmployeeId));
  await db.delete(orgMembers).where(eq(orgMembers.org_id, orgId));
  await db.delete(users).where(eq(users.id, adminId));
  await db.delete(users).where(eq(users.id, memberId));
  await db.delete(users).where(eq(users.id, employeeUserId));
  await db.delete(users).where(eq(users.id, otherEmployeeUserId));
  await db.delete(orgs).where(eq(orgs.id, orgId));
  await db.delete(orgs).where(eq(orgs.id, otherOrgId));
});

test('admin reset is concurrency-safe and emits one governed action with a valid receipt', async () => {
  const [first, second] = await Promise.all([
    app.request(`/api/agent-employees/${employeeId}/action-budget/reset`, { method: 'POST' }),
    app.request(`/api/agent-employees/${employeeId}/action-budget/reset`, { method: 'POST' }),
  ]);
  const bodies = await Promise.all([first.json(), second.json()]) as Array<{
    action_id: string | null;
    daily_action_count: number;
    max_daily_actions: number;
  }>;
  assert.equal(first.status, 200, JSON.stringify(bodies[0]));
  assert.equal(second.status, 200, JSON.stringify(bodies[1]));
  assert.deepEqual(bodies.map((body) => body.daily_action_count), [0, 0]);
  assert.deepEqual(bodies.map((body) => body.max_daily_actions), [50, 50]);
  assert.equal(bodies.filter((body) => body.action_id !== null).length, 1);

  const actions = await db.select().from(agentActions).where(and(
    eq(agentActions.agent_employee_id, employeeId),
    eq(agentActions.action, 'action_budget_reset'),
  ));
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.user_id, adminId);
  assert.deepEqual(actions[0]!.params, { previous_count: 45 });
  assert.deepEqual(actions[0]!.result, {
    previous_count: 45,
    daily_action_count: 0,
    max_daily_actions: 50,
  });

  const receipts = await db.select().from(actionReceipts).where(eq(actionReceipts.action_id, actions[0]!.id));
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.org_id, orgId);
  assert.equal(receipts[0]!.employee_id, employeeId);
  assert.equal(receipts[0]!.approver_id, adminId);
  assert.equal(await verifyReceipt(receipts[0]!), true);
});

test('ordinary members cannot reset an employee action budget', async () => {
  actorId = memberId;
  const response = await app.request(`/api/agent-employees/${employeeId}/action-budget/reset`, { method: 'POST' });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: 'Only owners or admins can manage agent employees and runtime diagnostics',
    code: 'FORBIDDEN',
  });

  const [employee] = await db.select({ count: agentEmployees.daily_action_count })
    .from(agentEmployees)
    .where(eq(agentEmployees.id, employeeId));
  assert.equal(employee!.count, 45);
});

test('an admin cannot discover or reset an employee from another organization', async () => {
  const response = await app.request(`/api/agent-employees/${otherEmployeeId}/action-budget/reset`, { method: 'POST' });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: 'Agent employee not found',
    code: 'NOT_FOUND',
  });

  const [employee] = await db.select({ count: agentEmployees.daily_action_count })
    .from(agentEmployees)
    .where(eq(agentEmployees.id, otherEmployeeId));
  assert.equal(employee!.count, 45);
});
