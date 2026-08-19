import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import pg from 'pg';

import {
  agentModuleActionClaimKey,
  agentModuleActionIdempotencyDigest,
  executeAction,
  executeActionDirect,
} from '../src/lib/agent-actions.js';
import { persistAgentReplyWithActions } from '../src/lib/agent-action-proposals.js';
import { closeDb } from '../src/lib/db.js';
import {
  humanModuleActor,
  installBundledModule,
  updateModuleInstallation,
} from '../src/lib/module-service.js';
import { verifyReceipt } from '../src/lib/receipts.js';

const TEST_DATABASE_URL = process.env.DEFT_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

function isSafeTestDatabase(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return /(?:test|ci|acceptance)/i.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

const canRun = isSafeTestDatabase(TEST_DATABASE_URL);
const ciRequiresDatabase = /^(?:1|true)$/i.test(process.env.CI ?? '');
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ORG_ID = `module-direct-denial-org-${suffix}`;
const OWNER_ID = `module-direct-denial-owner-${suffix}`;
const EMPLOYEE_USER_ID = `module-direct-denial-shadow-${suffix}`;
const EMPLOYEE_ID = `module-direct-denial-employee-${suffix}`;
const SPACE_ID = `module-direct-denial-space-${suffix}`;

let client: pg.Client | null = null;
let manifestDigest = '';

const adminActor = humanModuleActor({
  orgId: ORG_ID,
  userId: OWNER_ID,
  role: 'owner',
});

function mutationInput(label: string) {
  return {
    module_id: 'com.deft.contacts',
    collection_key: 'contacts',
    data: {
      name: `Generic Direct ${label} ${suffix}`,
      notes: `raw-${label}-secret-${suffix}`,
    },
    expected_manifest_digest: manifestDigest,
    idempotency_key: `raw-${label}-key-${suffix}`,
  };
}

async function directCreate(input: ReturnType<typeof mutationInput>) {
  return executeActionDirect(
    'module_record_create',
    input,
    ORG_ID,
    EMPLOYEE_USER_ID,
    null,
    'quick',
    { agentEmployeeId: EMPLOYEE_ID, source: 'agent_chat' },
  );
}

async function waitForSessionBlockedBy(blockingPid: number, timeoutMs = 5_000): Promise<void> {
  assert.ok(TEST_DATABASE_URL);
  const observer = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await observer.connect();
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const waiting = await observer.query(
        `SELECT count(*)::int AS count
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND $1 = ANY(pg_blocking_pids(pid))`,
        [blockingPid],
      );
      if (waiting.rows[0].count > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for a session blocked by pid ${blockingPid}`);
  } finally {
    await observer.end();
  }
}

async function assertEmployeePolicyBarrierWins(input: {
  policy: 'unhealthy' | 'disabled';
  path: 'proposal' | 'direct';
}) {
  assert.ok(TEST_DATABASE_URL && client);
  const mutation = mutationInput(`${input.policy}-${input.path}-preflight`);
  const digest = await agentModuleActionIdempotencyDigest(
    'module_record_create',
    mutation,
    ORG_ID,
    EMPLOYEE_USER_ID,
    EMPLOYEE_ID,
  );
  assert.ok(digest);
  const claimKey = agentModuleActionClaimKey(ORG_ID, 'module_record_create', digest);
  const claimBlocker = new pg.Client({ connectionString: TEST_DATABASE_URL });
  const policyUpdater = new pg.Client({ connectionString: TEST_DATABASE_URL });
  let claimTransactionOpen = false;
  let policyTransactionOpen = false;
  let operation: Promise<unknown> | undefined;
  const expectedError = input.policy === 'unhealthy' ? /unhealthy/i : /disabled for this agent employee/i;
  const budget = await client.query(
    'SELECT daily_action_count::int AS count FROM agent_employees WHERE id = $1',
    [EMPLOYEE_ID],
  );
  const budgetBefore = budget.rows[0].count as number;

  await claimBlocker.connect();
  await policyUpdater.connect();
  try {
    await claimBlocker.query('BEGIN');
    claimTransactionOpen = true;
    await claimBlocker.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [claimKey],
    );
    const claimPid = await claimBlocker.query('SELECT pg_backend_pid()::int AS pid');

    operation = input.path === 'proposal'
      ? persistAgentReplyWithActions({
        orgId: ORG_ID,
        spaceId: SPACE_ID,
        userId: EMPLOYEE_USER_ID,
        agentUserId: OWNER_ID,
        content: `The ${input.policy} proposal was rejected by live employee policy.`,
        metadata: {
          source: 'employee-policy-preflight-test',
          action_graph: {
            actions: [{
              id: `${input.policy}-proposal`,
              tool: 'module_record_create',
              params: mutation,
            }],
          },
        },
        pendingActions: [{
          action: 'module_record_create',
          params: mutation,
          approval_tier: 'quick',
          source: 'agent_chat',
          agent_employee_id: EMPLOYEE_ID,
        }],
      })
      : directCreate(mutation);
    void operation.catch(() => undefined);

    // The non-transactional preflight passed under the old healthy/enabled
    // policy. The operation is now paused at its action-claim boundary.
    await waitForSessionBlockedBy(claimPid.rows[0].pid as number);

    await policyUpdater.query('BEGIN');
    policyTransactionOpen = true;
    const policyPid = await policyUpdater.query('SELECT pg_backend_pid()::int AS pid');
    if (input.policy === 'unhealthy') {
      await policyUpdater.query(
        `UPDATE agent_employees
         SET unhealthy = true, unhealthy_reason = 'policy barrier test'
         WHERE id = $1 AND org_id = $2`,
        [EMPLOYEE_ID, ORG_ID],
      );
    } else {
      await policyUpdater.query(
        `UPDATE agent_employees
         SET disabled_tools = ARRAY['module_record_create']::text[]
         WHERE id = $1 AND org_id = $2`,
        [EMPLOYEE_ID, ORG_ID],
      );
    }

    await claimBlocker.query('COMMIT');
    claimTransactionOpen = false;

    // The transaction-bound actor lookup must now block on the employee row,
    // then observe the winning lifecycle update instead of inserting an action.
    await waitForSessionBlockedBy(policyPid.rows[0].pid as number);
    await policyUpdater.query('COMMIT');
    policyTransactionOpen = false;

    if (input.path === 'proposal') {
      const persisted = await operation as Awaited<ReturnType<typeof persistAgentReplyWithActions>>;
      assert.deepEqual(persisted.actions, []);
      assert.deepEqual(
        (persisted.message.metadata as Record<string, unknown>).rejected_module_actions,
        ['module_record_create'],
      );
      assert.equal(JSON.stringify(persisted.message).includes(mutation.data.notes), false);
      assert.equal(JSON.stringify(persisted.message).includes(mutation.idempotency_key), false);
    } else {
      await assert.rejects(operation, expectedError);
    }

    const durable = await client.query(
      `SELECT
         (SELECT count(*)::int FROM agent_actions WHERE org_id = $1) AS actions,
         (SELECT count(*)::int FROM module_records
          WHERE org_id = $1 AND data->>'name' = $2) AS records,
         (SELECT count(*)::int FROM module_mutation_receipts WHERE org_id = $1) AS mutation_receipts,
         (SELECT count(*)::int FROM action_receipts WHERE org_id = $1) AS action_receipts,
         (SELECT count(*)::int FROM messages row_value
          WHERE org_id = $1
            AND (row_to_json(row_value)::text LIKE '%' || $3 || '%'
              OR row_to_json(row_value)::text LIKE '%' || $4 || '%')) AS leaked_messages,
         (SELECT daily_action_count::int FROM agent_employees
          WHERE id = $5 AND org_id = $1) AS daily_action_count`,
      [
        ORG_ID,
        mutation.data.name,
        mutation.data.notes,
        mutation.idempotency_key,
        EMPLOYEE_ID,
      ],
    );
    assert.deepEqual(durable.rows[0], {
      actions: 0,
      records: 0,
      mutation_receipts: 0,
      action_receipts: 0,
      leaked_messages: 0,
      daily_action_count: budgetBefore,
    });
  } finally {
    if (claimTransactionOpen) await claimBlocker.query('ROLLBACK').catch(() => undefined);
    if (policyTransactionOpen) await policyUpdater.query('ROLLBACK').catch(() => undefined);
    await claimBlocker.end();
    await policyUpdater.end();
    if (operation) await operation.catch(() => undefined);
    await client.query(
      `UPDATE agent_employees
       SET unhealthy = false, unhealthy_reason = NULL, disabled_tools = NULL
       WHERE id = $1 AND org_id = $2`,
      [EMPLOYEE_ID, ORG_ID],
    );
  }
}

async function assertTerminalFailureTruth(input: {
  actionId: string;
  mutation: ReturnType<typeof mutationInput>;
  errorPattern: RegExp;
  budgetBefore: number;
}) {
  assert.ok(client);
  const action = await client.query(
    `SELECT approval_status, params, result, after_state, error, executed_at
     FROM agent_actions WHERE id = $1 AND org_id = $2`,
    [input.actionId, ORG_ID],
  );
  assert.equal(action.rows.length, 1);
  assert.equal(action.rows[0].approval_status, 'approved');
  assert.ok(action.rows[0].executed_at);
  assert.match(action.rows[0].error, input.errorPattern);
  assert.equal(action.rows[0].result, null);
  assert.equal(action.rows[0].after_state, null);
  assert.equal('data' in action.rows[0].params, false);
  assert.equal('idempotency_key' in action.rows[0].params, false);
  assert.deepEqual(action.rows[0].params.changed_fields, ['name', 'notes']);
  assert.match(action.rows[0].params.idempotency_digest, /^sha256:[a-f0-9]{64}$/);
  assert.match(action.rows[0].params.input_digest, /^sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(
    JSON.stringify(action.rows[0]),
    new RegExp(`${input.mutation.data.notes}|${input.mutation.idempotency_key}`),
  );

  const receipts = await client.query(
    `SELECT * FROM action_receipts WHERE action_id = $1 ORDER BY created_at`,
    [input.actionId],
  );
  assert.equal(receipts.rows.length, 1);
  assert.equal(receipts.rows[0].decision, 'auto_executed');
  assert.equal(receipts.rows[0].result_json, null);
  assert.match(receipts.rows[0].decision_reason, input.errorPattern);
  assert.equal('data' in receipts.rows[0].action_params_json, false);
  assert.equal('idempotency_key' in receipts.rows[0].action_params_json, false);
  assert.doesNotMatch(
    JSON.stringify(receipts.rows[0]),
    new RegExp(`${input.mutation.data.notes}|${input.mutation.idempotency_key}`),
  );
  assert.equal(await verifyReceipt(receipts.rows[0]), true);

  const durable = await client.query(
    `SELECT
       (SELECT count(*)::int FROM agent_actions
        WHERE org_id = $1 AND id = $2) AS actions,
       (SELECT count(*)::int FROM module_records
        WHERE org_id = $1 AND data->>'name' = $3) AS records,
       (SELECT count(*)::int FROM module_mutation_receipts
        WHERE org_id = $1 AND agent_action_id = $2) AS mutation_receipts,
       (SELECT daily_action_count::int FROM agent_employees
        WHERE org_id = $1 AND id = $4) AS daily_action_count`,
    [ORG_ID, input.actionId, input.mutation.data.name, EMPLOYEE_ID],
  );
  assert.deepEqual(durable.rows[0], {
    actions: 1,
    records: 0,
    mutation_receipts: 0,
    daily_action_count: input.budgetBefore,
  });
}

before(async () => {
  if (!canRun || !TEST_DATABASE_URL) return;
  client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  await client.query(
    `INSERT INTO orgs (id, name, slug)
     VALUES ($1, 'Module direct denial', $2)`,
    [ORG_ID, `module-direct-denial-${suffix}`],
  );
  await client.query(
    `INSERT INTO users (id, email, name, is_agent, email_verified)
     VALUES ($1, $2, 'Module Direct Owner', false, true),
            ($3, NULL, 'Module Direct Employee', true, true)`,
    [OWNER_ID, `module-direct-owner-${suffix}@test.local`, EMPLOYEE_USER_ID],
  );
  await client.query(
    `INSERT INTO org_members (id, org_id, user_id, role, is_active)
     VALUES ($1, $2, $3, 'owner', true)`,
    [`module-direct-member-${suffix}`, ORG_ID, OWNER_ID],
  );
  await client.query(
    `INSERT INTO spaces (id, org_id, name, type, created_by)
     VALUES ($1, $2, 'Module direct denial', 'public', $3)`,
    [SPACE_ID, ORG_ID, OWNER_ID],
  );
  await client.query(
    `INSERT INTO agent_employees
      (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
       max_daily_actions, daily_action_count, is_byoa, is_active, created_by)
     VALUES ($1, $2, $3, 'Module Direct Employee', $4, 'custom',
       'Direct denial test', 'standard', 50, 0, true, true, $5)`,
    [EMPLOYEE_ID, ORG_ID, EMPLOYEE_USER_ID, `module-direct-${suffix}`, OWNER_ID],
  );
  const installed = await installBundledModule(adminActor, 'contacts');
  manifestDigest = installed.manifest_digest;
  await updateModuleInstallation(adminActor, 'contacts', { agent_access: 'write' });
});

after(async () => {
  if (client) {
    await client.query('DELETE FROM attention_items WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM action_receipts WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM module_mutation_receipts WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM agent_actions WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM messages WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM module_records WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM module_versions WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM module_installations WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM audit_log WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM agent_employees WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM spaces WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM org_members WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM users WHERE id = ANY($1::text[])', [[OWNER_ID, EMPLOYEE_USER_ID]]);
    await client.query('DELETE FROM orgs WHERE id = $1', [ORG_ID]);
    await client.end();
  }
  await closeDb();
});

for (const policy of ['unhealthy', 'disabled'] as const) {
  for (const path of ['proposal', 'direct'] as const) {
    test(
      `${path} employee ${policy} race is rejected before action persistence`,
      { skip: !canRun && !ciRequiresDatabase },
      async () => {
        assert.ok(
          canRun && TEST_DATABASE_URL && client,
          'CI must provide a DEFT_TEST_DATABASE_URL (or DATABASE_URL) whose database name contains test, ci, or acceptance',
        );
        await assertEmployeePolicyBarrierWins({ policy, path });
      },
    );
  }
}

test(
  'live trust downgrade queues direct action and a later upgrade cannot auto-promote it',
  { skip: !canRun && !ciRequiresDatabase },
  async () => {
    assert.ok(
      canRun && TEST_DATABASE_URL && client,
      'CI must provide a DEFT_TEST_DATABASE_URL (or DATABASE_URL) whose database name contains test, ci, or acceptance',
    );
    const mutation = mutationInput('trust-downgrade');
    const digest = await agentModuleActionIdempotencyDigest(
      'module_record_create',
      mutation,
      ORG_ID,
      EMPLOYEE_USER_ID,
      EMPLOYEE_ID,
    );
    assert.ok(digest);
    const claimKey = agentModuleActionClaimKey(ORG_ID, 'module_record_create', digest);
    const claimBlocker = new pg.Client({ connectionString: TEST_DATABASE_URL });
    const trustUpdater = new pg.Client({ connectionString: TEST_DATABASE_URL });
    const budget = await client.query(
      'SELECT daily_action_count::int AS count FROM agent_employees WHERE id = $1',
      [EMPLOYEE_ID],
    );
    const budgetBefore = budget.rows[0].count as number;
    let claimTransactionOpen = false;
    let trustTransactionOpen = false;
    let direct: ReturnType<typeof directCreate> | undefined;
    await claimBlocker.connect();
    await trustUpdater.connect();
    try {
      await claimBlocker.query('BEGIN');
      claimTransactionOpen = true;
      await claimBlocker.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [claimKey],
      );
      const claimPid = await claimBlocker.query('SELECT pg_backend_pid()::int AS pid');
      direct = directCreate(mutation);
      void direct.catch(() => undefined);
      await waitForSessionBlockedBy(claimPid.rows[0].pid as number);

      await trustUpdater.query('BEGIN');
      trustTransactionOpen = true;
      const trustPid = await trustUpdater.query('SELECT pg_backend_pid()::int AS pid');
      await trustUpdater.query(
        `UPDATE agent_employees SET trust_level = 'conservative'
         WHERE id = $1 AND org_id = $2`,
        [EMPLOYEE_ID, ORG_ID],
      );
      await claimBlocker.query('COMMIT');
      claimTransactionOpen = false;
      await waitForSessionBlockedBy(trustPid.rows[0].pid as number);
      await trustUpdater.query('COMMIT');
      trustTransactionOpen = false;

      const queued = await direct;
      assert.equal(queued.success, false);
      assert.equal(queued.requiresApproval, true);
      assert.equal(queued.approvalTier, 'quick');
      assert.match(queued.error ?? '', /queued for fresh review/i);

      const pending = await client.query(
        `SELECT id, approval_status, approved_at, params, executed_at, result
         FROM agent_actions
         WHERE id = $1 AND org_id = $2`,
        [queued.actionId, ORG_ID],
      );
      assert.equal(pending.rows.length, 1);
      assert.equal(pending.rows[0].approval_status, 'pending');
      assert.equal(pending.rows[0].approved_at, null);
      assert.equal(pending.rows[0].executed_at, null);
      assert.equal(pending.rows[0].result, null);
      assert.equal(pending.rows[0].params.idempotency_key, mutation.idempotency_key);
      assert.equal(pending.rows[0].params.data.notes, mutation.data.notes);

      // Raise trust again before the same-key retry. The existing review card
      // remains authoritative and must not be silently promoted or executed.
      await client.query(
        `UPDATE agent_employees SET trust_level = 'standard'
         WHERE id = $1 AND org_id = $2`,
        [EMPLOYEE_ID, ORG_ID],
      );
      const retry = await directCreate(mutation);
      assert.equal(retry.actionId, queued.actionId);
      assert.equal(retry.success, false);
      assert.equal(retry.requiresApproval, true);
      assert.equal(retry.approvalTier, 'quick');

      const durable = await client.query(
        `SELECT
           (SELECT count(*)::int FROM agent_actions
            WHERE org_id = $1 AND id = $2 AND approval_status = 'pending') AS actions,
           (SELECT count(*)::int FROM module_records
            WHERE org_id = $1 AND data->>'name' = $3) AS records,
           (SELECT count(*)::int FROM module_mutation_receipts
            WHERE org_id = $1 AND agent_action_id = $2) AS mutation_receipts,
           (SELECT count(*)::int FROM action_receipts
            WHERE org_id = $1 AND action_id = $2) AS action_receipts,
           (SELECT daily_action_count::int FROM agent_employees
            WHERE id = $4 AND org_id = $1) AS daily_action_count`,
        [ORG_ID, queued.actionId, mutation.data.name, EMPLOYEE_ID],
      );
      assert.deepEqual(durable.rows[0], {
        actions: 1,
        records: 0,
        mutation_receipts: 0,
        action_receipts: 0,
        daily_action_count: budgetBefore,
      });
    } finally {
      if (claimTransactionOpen) await claimBlocker.query('ROLLBACK').catch(() => undefined);
      if (trustTransactionOpen) await trustUpdater.query('ROLLBACK').catch(() => undefined);
      await claimBlocker.end();
      await trustUpdater.end();
      if (direct) await direct.catch(() => undefined);
      await client.query(
        `UPDATE agent_employees SET trust_level = 'standard'
         WHERE id = $1 AND org_id = $2`,
        [EMPLOYEE_ID, ORG_ID],
      );
    }
  },
);

test(
  'generic direct budget denial is terminal, scrubbed, receipted once, and sticky on retry',
  { skip: !canRun && !ciRequiresDatabase },
  async () => {
    assert.ok(
      canRun && TEST_DATABASE_URL && client,
      'CI must provide a DEFT_TEST_DATABASE_URL (or DATABASE_URL) whose database name contains test, ci, or acceptance',
    );
    const mutation = mutationInput('budget-denial');
    const original = await client.query(
      `SELECT daily_action_count::int AS count, max_daily_actions::int AS max
       FROM agent_employees WHERE id = $1`,
      [EMPLOYEE_ID],
    );
    const budgetBefore = original.rows[0].count as number;
    const originalMax = original.rows[0].max as number;
    await client.query(
      'UPDATE agent_employees SET max_daily_actions = daily_action_count WHERE id = $1 AND org_id = $2',
      [EMPLOYEE_ID, ORG_ID],
    );

    try {
      const first = await directCreate(mutation);
      assert.equal(first.success, false);
      assert.match(first.error ?? '', /daily action limit/i);

      // Make budget available before retry; the terminal failed action still
      // has precedence and must not execute under the now-permissive policy.
      await client.query(
        'UPDATE agent_employees SET max_daily_actions = $3 WHERE id = $1 AND org_id = $2',
        [EMPLOYEE_ID, ORG_ID, originalMax],
      );
      const retry = await directCreate(mutation);
      assert.equal(retry.actionId, first.actionId);
      assert.equal(retry.success, false);
      assert.equal(retry.error, first.error);
      await assertTerminalFailureTruth({
        actionId: first.actionId,
        mutation,
        errorPattern: /daily action limit/i,
        budgetBefore,
      });
    } finally {
      await client.query(
        'UPDATE agent_employees SET max_daily_actions = $3 WHERE id = $1 AND org_id = $2',
        [EMPLOYEE_ID, ORG_ID, originalMax],
      );
    }
  },
);

test(
  'successful generic module execution clears a stale action error',
  { skip: !canRun && !ciRequiresDatabase },
  async () => {
    assert.ok(
      canRun && TEST_DATABASE_URL && client,
      'CI must provide a DEFT_TEST_DATABASE_URL (or DATABASE_URL) whose database name contains test, ci, or acceptance',
    );
    const mutation = mutationInput('success-clears-error');
    const actionId = randomUUID();
    await client.query(
      `INSERT INTO agent_actions
        (id, org_id, user_id, agent_employee_id, source, action, params,
         approval_tier, approval_status, approved_at, error)
       VALUES ($1, $2, $3, $4, 'agent_chat', 'module_record_create', $5::jsonb,
         'quick', 'approved', now(), 'stale pre-execution error')`,
      [actionId, ORG_ID, EMPLOYEE_USER_ID, EMPLOYEE_ID, JSON.stringify(mutation)],
    );

    const executed = await executeAction(
      actionId,
      'module_record_create',
      mutation,
      ORG_ID,
      EMPLOYEE_USER_ID,
      { agentEmployeeId: EMPLOYEE_ID },
    );
    assert.equal(executed.success, true, executed.error);

    const action = await client.query(
      `SELECT error, executed_at, params, result
       FROM agent_actions WHERE id = $1 AND org_id = $2`,
      [actionId, ORG_ID],
    );
    assert.equal(action.rows[0].error, null);
    assert.ok(action.rows[0].executed_at);
    assert.equal(action.rows[0].result.record_id, executed.result.record_id);
    assert.equal('data' in action.rows[0].params, false);
    assert.equal('idempotency_key' in action.rows[0].params, false);
  },
);
