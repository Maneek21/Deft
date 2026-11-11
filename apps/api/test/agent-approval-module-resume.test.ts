/**
 * Lane W2 approval recovery — module approvals left by a lost lease.
 *
 * A module mutation approval whose request lost its lease is left approved
 * and unexecuted. The maintenance sweep drives the resolver's own
 * idempotent module resume for it, acting as the stored approver: a
 * mutation that already committed is recorded without a second mutation,
 * one that did not commit runs once, and a row whose executor still holds
 * its lease is skipped.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/agent-approval-module-resume.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import pg from 'pg';

import { closeDb } from '../src/lib/db.js';
import { executeAction } from '../src/lib/agent-actions.js';
import { syncApprovalToAttention } from '../src/lib/attention.js';
import { humanModuleActor, installBundledModule, updateModuleInstallation } from '../src/lib/module-service.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const TEST_DATABASE_URL = safeTestDatabaseUrl();
const canRun = Boolean(TEST_DATABASE_URL);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ORG_ID = `module-resume-org-${suffix}`;
const OWNER_ID = `module-resume-owner-${suffix}`;

let client: pg.Client | null = null;
let manifestDigest = '';
let recoverNow: () => Promise<unknown>;

before(async () => {
  if (!canRun || !TEST_DATABASE_URL) return;
  client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  await client.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Module resume', $2)`, [ORG_ID, `module-resume-${suffix}`]);
  await client.query(
    `INSERT INTO users (id, email, name, is_agent, email_verified) VALUES ($1, $2, 'Module Resume Owner', false, true)`,
    [OWNER_ID, `module-resume-owner-${suffix}@test.local`],
  );
  await client.query(
    `INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, 'owner', true)`,
    [`module-resume-member-${suffix}`, ORG_ID, OWNER_ID],
  );
  const actor = humanModuleActor({ orgId: ORG_ID, userId: OWNER_ID, role: 'owner' });
  const installed = await installBundledModule(actor, 'contacts');
  manifestDigest = installed.manifest_digest;
  await updateModuleInstallation(actor, 'contacts', { agent_access: 'write' });
  recoverNow = (await import('../src/routes/agent.js')).recoverInterruptedApprovalsNow;
});

after(async () => {
  if (client) {
    for (const table of ['attention_events', 'attention_items', 'action_receipts', 'module_mutation_receipts',
      'agent_action_approvers', 'agent_actions', 'module_record_relations', 'module_records', 'module_versions',
      'module_installations', 'audit_log', 'job_queue', 'org_members']) {
      await client.query(`DELETE FROM ${table} WHERE org_id = $1`, [ORG_ID]).catch(() => undefined);
    }
    await client.query('DELETE FROM users WHERE id = $1', [OWNER_ID]).catch(() => undefined);
    await client.query('DELETE FROM orgs WHERE id = $1', [ORG_ID]).catch(() => undefined);
    await client.end();
  }
  await closeDb();
});

function createParams(name: string) {
  return {
    module_id: 'com.deft.contacts',
    collection_key: 'contacts',
    data: { name, email: `${name.replaceAll(' ', '-')}@example.test` },
    relations: {},
    expected_manifest_digest: manifestDigest,
    idempotency_key: `resume-${name.replaceAll(' ', '-')}`,
  };
}

/** A pending Defty module proposal with its approval Attention item. */
async function pendingCreate(name: string): Promise<string> {
  const [row] = (await client!.query(
    `INSERT INTO agent_actions (id, org_id, user_id, source, action, params, approval_tier, approval_status)
     VALUES (gen_random_uuid()::text, $1, $2, 'mention', 'module_record_create', $3::jsonb, 'quick', 'pending')
     RETURNING *`,
    [ORG_ID, OWNER_ID, JSON.stringify(createParams(name))],
  )).rows;
  await syncApprovalToAttention(row, { deliver: false });
  return row.id as string;
}

/** The row as a request that lost its lease right after its claim leaves it. */
async function leaveClaimed(actionId: string, name: string): Promise<void> {
  await client!.query(
    `UPDATE agent_actions
        SET approval_status = 'approved', approved_by_user_id = $2,
            approved_at = clock_timestamp() - interval '1 hour', executed_at = NULL, error = NULL,
            params = $3::jsonb,
            result = jsonb_build_object('lifecycle_state', 'executing', 'started_at', now()::text)
      WHERE id = $1`,
    [actionId, OWNER_ID, JSON.stringify(createParams(name))],
  );
}

async function recordsNamed(name: string): Promise<number> {
  return (await client!.query(
    `SELECT count(*)::int AS n FROM module_records WHERE org_id = $1 AND data->>'name' = $2`, [ORG_ID, name],
  )).rows[0].n as number;
}

async function settledState(actionId: string) {
  const [action] = (await client!.query(
    'SELECT approval_status, error, executed_at IS NOT NULL AS executed, result, approved_by_user_id FROM agent_actions WHERE id = $1',
    [actionId],
  )).rows;
  return {
    action,
    receipts: (await client!.query(
      'SELECT decision, approver_id FROM action_receipts WHERE action_id = $1 ORDER BY decision', [actionId])).rows,
    decisions: (await client!.query(
      'SELECT user_id, decision FROM agent_action_approvers WHERE action_id = $1 ORDER BY user_id', [actionId])).rows,
    attention: (await client!.query(
      `SELECT i.state, e.actor_user_id FROM attention_items i
         LEFT JOIN attention_events e ON e.attention_item_id = i.id AND e.event_type = 'resolved'
        WHERE i.org_id = $1 AND i.source_type = 'agent_action' AND i.source_id = $2`, [ORG_ID, actionId])).rows,
  };
}

function assertSettledOnce(state: Awaited<ReturnType<typeof settledState>>) {
  assert.equal(state.action.approval_status, 'approved');
  assert.equal(state.action.error, null);
  assert.equal(state.action.executed, true);
  assert.notEqual(state.action.result?.lifecycle_state, 'executing');
  assert.deepEqual(state.receipts, [{ decision: 'approved', approver_id: OWNER_ID }]);
  assert.deepEqual(state.decisions, [{ user_id: OWNER_ID, decision: 'approved' }]);
  assert.ok(state.attention.length > 0);
  for (const item of state.attention) {
    assert.equal(item.state, 'resolved');
    assert.equal(item.actor_user_id, OWNER_ID);
  }
}

test('module-resume: a mutation that committed before the lease was lost is recorded once, with no second mutation', { skip: !canRun }, async () => {
  const name = `Committed ${suffix}`;
  const actionId = await pendingCreate(name);
  // The mutation committed (as the executor does), then the request lost its
  // lease before the resolver recorded the outcome.
  const executed = await executeAction(actionId, 'module_record_create', createParams(name), ORG_ID, OWNER_ID);
  assert.equal(executed.success, true, executed.error);
  await leaveClaimed(actionId, name);
  assert.equal(await recordsNamed(name), 1);

  await recoverNow();
  const settled = await settledState(actionId);
  assertSettledOnce(settled);
  assert.equal(await recordsNamed(name), 1);

  await recoverNow();
  assert.deepEqual(await settledState(actionId), settled);
  assert.equal(await recordsNamed(name), 1);
});

test('module-resume: a mutation that never ran is run once', { skip: !canRun }, async () => {
  const name = `Uncommitted ${suffix}`;
  const actionId = await pendingCreate(name);
  await leaveClaimed(actionId, name);
  assert.equal(await recordsNamed(name), 0);

  await recoverNow();
  const settled = await settledState(actionId);
  assertSettledOnce(settled);
  assert.equal(await recordsNamed(name), 1);

  await recoverNow();
  assert.deepEqual(await settledState(actionId), settled);
  assert.equal(await recordsNamed(name), 1);
});

test('module-resume: a row whose executor still holds its lease is skipped', { skip: !canRun }, async () => {
  const name = `Live ${suffix}`;
  const actionId = await pendingCreate(name);
  await leaveClaimed(actionId, name);
  const holder = new pg.Client({ connectionString: TEST_DATABASE_URL! });
  await holder.connect();
  try {
    await holder.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`agent-approval:${actionId}`]);
    await recoverNow();
    const state = await settledState(actionId);
    assert.equal(state.action.executed, false);
    assert.equal(state.action.result?.lifecycle_state, 'executing');
    assert.equal(state.receipts.length, 0);
    assert.equal(await recordsNamed(name), 0);
  } finally {
    await holder.end();
  }
});
