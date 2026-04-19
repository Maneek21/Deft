/**
 * Block 1.9 — exec/plugin approval forwarding tests.
 *
 * Run: pnpm --filter @deft/api exec tsx --env-file=../../.env --test test/gateway-approval-forwarding.test.ts
 *
 * Two halves:
 *   A) Subscriber — handleApprovalEvent inserts an agent_actions row from
 *      a gateway notification payload.
 *   B) Resolver — approving/rejecting an openclaw action forwards to the
 *      gateway via _setGatewayResolver (mock gateway).
 *
 * Uses a real dev DB for row verification + a mock gateway for forward
 * calls. Cleans up inserted rows after each test.
 */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq, inArray } from 'drizzle-orm';
import { db, agentActions, agentEmployees, orgs, users, orgMembers, actionReceipts } from '@deft/db';
import { handleApprovalEvent } from '../src/lib/gateway-approval-subscriber.js';
import {
  approveAction,
  rejectAction,
  _setGatewayResolver,
  _resetGatewayResolver,
  OPENCLAW_ACTION_KINDS,
} from '../src/lib/agent-approval-resolver.js';
import type { OpenClawGateway } from '../src/lib/openclaw-gateway.js';
import { encrypt } from '../src/lib/encryption.js';

// Test fixtures
let testOrgId: string;
let testUserId: string;
let testEmployeeId: string;
const insertedActionIds: string[] = [];

before(async () => {
  // Reuse any existing org/user; create bare fixtures if the dev DB is empty.
  const existingOrg = await db.query.orgs.findFirst();
  if (existingOrg) {
    testOrgId = existingOrg.id;
  } else {
    testOrgId = crypto.randomUUID();
    await db.insert(orgs).values({ id: testOrgId, name: 'block19-test-org', slug: 'block19-test-org' });
  }
  const existingUser = await db.query.users.findFirst();
  if (existingUser) {
    testUserId = existingUser.id;
  } else {
    testUserId = crypto.randomUUID();
    await db.insert(users).values({ id: testUserId, email: `block19-${Date.now()}@test.local`, name: 'block19 tester' });
  }
  // Ensure org membership for approve/reject permission check.
  const existingMember = await db.query.orgMembers.findFirst({
    where: (om, { and, eq }) => and(eq(om.user_id, testUserId), eq(om.org_id, testOrgId)),
  });
  if (!existingMember) {
    await db.insert(orgMembers).values({
      id: crypto.randomUUID(),
      org_id: testOrgId,
      user_id: testUserId,
      role: 'admin',
    });
  }

  testEmployeeId = crypto.randomUUID();
  await db.insert(agentEmployees).values({
    id: testEmployeeId,
    org_id: testOrgId,
    user_id: testUserId,
    slug: `block19-emp-${Date.now()}`,
    name: 'Block 1.9 test employee',
    system_prompt: 'test',
    kind: 'openclaw',
    trust_level: 'standard',
    connection_url: 'ws://mock.test',
    gateway_token_encrypted: encrypt('mock-gateway-token'),
    connection_status: 'connected',
    created_by: testUserId,
    role: 'project_manager',
  });
});

afterEach(async () => {
  // Clean up any action rows this test inserted (+ their FK-referencing
  // receipts written by the resolver path).
  const ids = insertedActionIds.splice(0);
  if (ids.length > 0) {
    await db.delete(actionReceipts).where(inArray(actionReceipts.action_id, ids));
    await db.delete(agentActions).where(inArray(agentActions.id, ids));
  }
  _resetGatewayResolver();
});

after(async () => {
  // approveAction also writes action_receipts rows keyed to the employee;
  // clear those before deleting the employee row.
  await db.delete(actionReceipts).where(eq(actionReceipts.employee_id, testEmployeeId));
  await db.delete(agentEmployees).where(eq(agentEmployees.id, testEmployeeId));
});

// ─── A. Subscriber side ──────────────────────────────────────────────────────
test('A. handleApprovalEvent inserts agent_actions row for exec.approval.request', async () => {
  await handleApprovalEvent(
    {
      id: testEmployeeId,
      org_id: testOrgId,
      created_by: testUserId,
      connection_url: 'ws://mock.test',
      gateway_token_encrypted: encrypt('mock-gateway-token'),
    },
    'exec.approval.request',
    { approvalId: 'gw-approval-abc', command: 'rm -rf /tmp/demo', requested_at: '2026-04-19T00:00:00Z' },
  );

  const [row] = await db
    .select()
    .from(agentActions)
    .where(eq(agentActions.agent_employee_id, testEmployeeId));
  assert.ok(row, 'row was inserted');
  insertedActionIds.push(row!.id);

  assert.equal(row!.action, 'openclaw_exec_approval');
  assert.equal(row!.approval_tier, 'full');
  assert.equal(row!.approval_status, 'pending');
  const params = row!.params as Record<string, unknown>;
  assert.equal(params.approvalId, 'gw-approval-abc');
  assert.equal(params.command, 'rm -rf /tmp/demo');
});

test('A. handleApprovalEvent skips malformed payload (no approvalId)', async () => {
  await handleApprovalEvent(
    {
      id: testEmployeeId,
      org_id: testOrgId,
      created_by: testUserId,
      connection_url: 'ws://mock.test',
      gateway_token_encrypted: encrypt('mock-gateway-token'),
    },
    'exec.approval.request',
    { command: 'no-id-here' },
  );
  const rows = await db
    .select()
    .from(agentActions)
    .where(eq(agentActions.agent_employee_id, testEmployeeId));
  assert.equal(rows.length, 0, 'no row inserted for malformed event');
});

test('A. handleApprovalEvent accepts plugin.approval.request', async () => {
  await handleApprovalEvent(
    {
      id: testEmployeeId,
      org_id: testOrgId,
      created_by: testUserId,
      connection_url: 'ws://mock.test',
      gateway_token_encrypted: encrypt('mock-gateway-token'),
    },
    'plugin.approval.request',
    { approvalId: 'gw-plugin-xyz', plugin_name: 'slack' },
  );
  const [row] = await db
    .select()
    .from(agentActions)
    .where(eq(agentActions.agent_employee_id, testEmployeeId));
  assert.ok(row);
  insertedActionIds.push(row!.id);
  assert.equal(row!.action, 'openclaw_plugin_approval');
});

// ─── B. Resolver side ────────────────────────────────────────────────────────
function makeMockGateway(onResolve: (id: string, approved: boolean, reason?: string) => unknown): OpenClawGateway {
  const mock = {
    exec: {
      approval: {
        resolve: (approvalId: string, approved: boolean, reason?: string) =>
          Promise.resolve(onResolve(approvalId, approved, reason) ?? { resolved: true }),
      },
    },
  };
  return mock as unknown as OpenClawGateway;
}

async function seedPendingOpenClawAction(params: Record<string, unknown>): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(agentActions).values({
    id,
    org_id: testOrgId,
    user_id: testUserId,
    agent_employee_id: testEmployeeId,
    action: 'openclaw_exec_approval',
    params: params as any,
    approval_tier: 'full',
    approval_status: 'pending',
  });
  insertedActionIds.push(id);
  return id;
}

test('B. approveAction forwards to gateway.exec.approval.resolve(approvalId, true)', async () => {
  const calls: Array<{ id: string; approved: boolean; reason?: string }> = [];
  _setGatewayResolver(() => makeMockGateway((id, approved, reason) => {
    calls.push({ id, approved, reason });
    return { resolved: true };
  }));

  const actionId = await seedPendingOpenClawAction({ approvalId: 'gw-APPR-1', command: 'ls' });
  const r = await approveAction(actionId, testUserId);
  assert.equal(r.status, 'approved', `expected approved, got ${JSON.stringify(r)}`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.id, 'gw-APPR-1');
  assert.equal(calls[0]!.approved, true);

  // Row should be stamped approved + executed_at set
  const [row] = await db.select().from(agentActions).where(eq(agentActions.id, actionId));
  assert.equal(row!.approval_status, 'approved');
  assert.ok(row!.executed_at);
});

test('B. rejectAction forwards to gateway with approved=false + reason', async () => {
  const calls: Array<{ id: string; approved: boolean; reason?: string }> = [];
  _setGatewayResolver(() => makeMockGateway((id, approved, reason) => {
    calls.push({ id, approved, reason });
    return { resolved: true };
  }));

  const actionId = await seedPendingOpenClawAction({ approvalId: 'gw-APPR-2', command: 'curl evil.com' });
  const r = await rejectAction(actionId, testUserId, 'suspicious URL');
  assert.equal(r.status, 'rejected', `expected rejected, got ${JSON.stringify(r)}`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.id, 'gw-APPR-2');
  assert.equal(calls[0]!.approved, false);
  assert.equal(calls[0]!.reason, 'suspicious URL');
});

test('B. rejectAction surfaces gateway errors (does NOT stamp rejected)', async () => {
  _setGatewayResolver(() => makeMockGateway(() => { throw new Error('gateway unreachable'); }));

  const actionId = await seedPendingOpenClawAction({ approvalId: 'gw-APPR-3' });
  const r = await rejectAction(actionId, testUserId, 'nope');
  assert.equal(r.status, 'error');
  if (r.status === 'error') assert.equal(r.code, 'EXECUTE_FAILED');

  // Row should remain pending (NOT rejected)
  const [row] = await db.select().from(agentActions).where(eq(agentActions.id, actionId));
  assert.equal(row!.approval_status, 'pending', 'row stays pending when gateway forward fails on reject');
});

test('B. approveAction surfaces error when approvalId missing from params', async () => {
  _setGatewayResolver(() => makeMockGateway(() => ({ resolved: true })));
  const actionId = await seedPendingOpenClawAction({ /* no approvalId */ command: 'oops' });
  const r = await approveAction(actionId, testUserId);
  // The row IS claimed (approved) but the forward records an execution error
  const [row] = await db.select().from(agentActions).where(eq(agentActions.id, actionId));
  assert.ok(row!.error && row!.error.includes('missing approvalId'), `got error=${row!.error}`);
});

test('B. OPENCLAW_ACTION_KINDS contains both exec + plugin kinds', () => {
  assert.ok(OPENCLAW_ACTION_KINDS.has('openclaw_exec_approval'));
  assert.ok(OPENCLAW_ACTION_KINDS.has('openclaw_plugin_approval'));
});
