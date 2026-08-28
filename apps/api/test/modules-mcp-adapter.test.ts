import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { after, before, test as nodeTest } from 'node:test';
import pg from 'pg';
import { Hono } from 'hono';

import {
  createModuleRecord,
  employeeModuleActor,
  humanModuleActor,
  installBundledModule,
  moduleIdempotencyDigest,
  updateModuleInstallation,
} from '../src/lib/module-service.js';
import {
  MODULE_MCP_READ_TOOLS,
  MODULE_MCP_WRITE_TOOLS,
} from '../src/lib/mcp-tools/modules.js';
import {
  humanApprovalApprove,
  humanApprovalGet,
  humanApprovalList,
  humanFetch,
  humanSearch,
} from '../src/lib/mcp-tools/human.js';
import type { ToolContext, ToolResult } from '../src/lib/mcp-tools/types.js';
import { issueEmployeeToken, issuePersonalMcpToken } from '../src/lib/mcp-token.js';
import {
  approveAction,
  rejectAction,
} from '../src/lib/agent-approval-resolver.js';
import { executeActionDirect } from '../src/lib/agent-actions.js';
import { MCP_ACTION_KINDS } from '../src/lib/mcp-approval-actions.js';
import { syncApprovalToAttention } from '../src/lib/attention.js';
import { mcpServerV1Routes } from '../src/routes/mcp-server-v1.js';

const TEST_DATABASE_URL = process.env.DEFT_TEST_DATABASE_URL;

function isSafeTestDatabase(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return /(?:test|ci|acceptance|gauntlet)/i.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

const canRun = isSafeTestDatabase(TEST_DATABASE_URL);
const ciRequiresDatabase = /^(?:1|true)$/i.test(process.env.CI ?? '');
if (!canRun && ciRequiresDatabase) {
  throw new Error(
    'CI must provide DEFT_TEST_DATABASE_URL whose database name contains test, ci, acceptance, or gauntlet',
  );
}
const test = canRun ? nodeTest : nodeTest.skip;
const DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://invalid.invalid/deft_modules_missing_test_database';
const suffix = randomUUID();
const ORG_ID = `module-mcp-org-${suffix}`;
const ADMIN_ID = `module-mcp-admin-${suffix}`;
const EMPLOYEE_USER_ID = `module-mcp-shadow-${suffix}`;
const EMPLOYEE_ID = `module-mcp-employee-${suffix}`;
const EMPLOYEE_SLUG = `module-mcp-${suffix.slice(0, 12)}`;

let manifestDigest = '';
let personalToken = '';
let employeeToken = '';

async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function waitForSessionBlockedBy(blockingPid: number, timeoutMs = 5_000): Promise<void> {
  const observer = new pg.Client({ connectionString: DATABASE_URL });
  await observer.connect();
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const waiting = await observer.query(
        `SELECT count(*)::int AS count
         FROM pg_stat_activity
         WHERE $1 = ANY(pg_blocking_pids(pid))`,
        [blockingPid],
      );
      if (waiting.rows[0].count > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for a session blocked by PostgreSQL pid ${blockingPid}`);
  } finally {
    await observer.end();
  }
}

async function waitForActionStatus(
  actionId: string,
  status: string,
  timeoutMs = 5_000,
): Promise<void> {
  const observer = new pg.Client({ connectionString: DATABASE_URL });
  await observer.connect();
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const action = await observer.query(
        `SELECT approval_status FROM agent_actions WHERE id = $1`,
        [actionId],
      );
      if (action.rows[0]?.approval_status === status) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for action ${actionId} to become ${status}`);
  } finally {
    await observer.end();
  }
}

async function cleanup(): Promise<void> {
  await withClient(async (client) => {
    await client.query('DELETE FROM attention_items WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM action_receipts WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM module_mutation_receipts WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM agent_actions WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM agent_mcp_call_audit WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM oauth_audit_events WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM mcp_tokens WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM module_records WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM module_versions WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM module_installations WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM audit_log WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM agent_employees WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM org_members WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM users WHERE id = ANY($1::text[])', [[ADMIN_ID, EMPLOYEE_USER_ID]]);
    await client.query('DELETE FROM orgs WHERE id = $1', [ORG_ID]);
  });
}

function textPayload(result: { content: Array<{ text: string }> }): any {
  return JSON.parse(result.content[0]!.text);
}

function employeeContext(trust_level: ToolContext['trust_level']): ToolContext {
  return {
    org_id: ORG_ID,
    employee_id: EMPLOYEE_ID,
    employee_slug: EMPLOYEE_SLUG,
    trust_level,
  };
}

before(async () => {
  if (!canRun) return;
  await cleanup().catch(() => undefined);
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO orgs (id, name, slug)
       VALUES ($1, 'Module MCP adapter test', $2)`,
      [ORG_ID, `module-mcp-${suffix.slice(0, 12)}`],
    );
    await client.query(
      `INSERT INTO users (id, email, name, email_verified)
       VALUES ($1, $2, 'Module MCP Admin', true),
              ($3, $4, 'Module MCP Agent', true)`,
      [
        ADMIN_ID,
        `module-mcp-admin-${suffix}@test.local`,
        EMPLOYEE_USER_ID,
        `module-mcp-agent-${suffix}@test.local`,
      ],
    );
    await client.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES ($1, $2, $3, 'owner', true)`,
      [`module-mcp-member-${suffix}`, ORG_ID, ADMIN_ID],
    );
    await client.query(
      `INSERT INTO agent_employees
        (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
         max_daily_actions, daily_action_count, is_byoa, is_active, created_by)
       VALUES ($1, $2, $3, 'Module MCP Employee', $4, 'custom', 'test', 'standard',
         50, 0, true, true, $5)`,
      [EMPLOYEE_ID, ORG_ID, EMPLOYEE_USER_ID, EMPLOYEE_SLUG, ADMIN_ID],
    );
  });

  const adminActor = humanModuleActor({
    orgId: ORG_ID,
    userId: ADMIN_ID,
    role: 'owner',
  });
  const installation = await installBundledModule(adminActor, 'contacts');
  manifestDigest = installation.manifest_digest;
  await updateModuleInstallation(adminActor, 'contacts', { agent_access: 'write' });
  employeeToken = await issueEmployeeToken(ORG_ID, EMPLOYEE_ID);
  personalToken = (await issuePersonalMcpToken({
    orgId: ORG_ID,
    userId: ADMIN_ID,
    name: 'Module MCP personal test',
    scopes: ['read:modules', 'write:modules'],
    createdBy: ADMIN_ID,
  })).raw;
});

after(async () => {
  if (!canRun) return;
  await cleanup();
});

test('standard employee writes directly and returns only the minimal mutation result', async () => {
  const privateName = `Adapter Alice ${suffix}`;
  const budgetBefore = await withClient(async (client) => {
    const state = await client.query(
      `SELECT daily_action_count FROM agent_employees WHERE id = $1`,
      [EMPLOYEE_ID],
    );
    return state.rows[0].daily_action_count as number;
  });
  const args = {
    caller_employee_slug: EMPLOYEE_SLUG,
    module_id: 'com.deft.contacts',
    collection_key: 'contacts',
    data: {
      name: privateName,
      email: `adapter-${suffix}@example.com`,
      notes: 'private adapter note',
    },
    expected_manifest_digest: manifestDigest,
    idempotency_key: `direct-${suffix}`,
  };
  const result = await MODULE_MCP_WRITE_TOOLS.module_record_create!(
    args,
    employeeContext('standard'),
  );
  assert.notEqual(result.isError, true);
  const mutation = textPayload(result);
  assert.equal(mutation.module_id, 'com.deft.contacts');
  assert.equal(mutation.revision, 1);
  assert.equal(mutation.replayed, false);
  assert.equal(JSON.stringify(mutation).includes(privateName), false);
  assert.equal(JSON.stringify(mutation).includes('private adapter note'), false);

  const replays = await Promise.all(Array.from({ length: 5 }, async () => (
    textPayload(await MODULE_MCP_WRITE_TOOLS.module_record_create!(
      args,
      employeeContext('standard'),
    ))
  )));
  for (const replay of replays) {
    assert.equal(replay.record_id, mutation.record_id);
    assert.equal(replay.replayed, true);
  }
  await withClient((client) => client.query(
    `UPDATE agent_employees
     SET unhealthy = true,
         unhealthy_reason = 'completed replay policy change',
         disabled_tools = ARRAY['module_record_create']::text[]
     WHERE id = $1 AND org_id = $2`,
    [EMPLOYEE_ID, ORG_ID],
  ));
  try {
    const app = new Hono();
    app.route('/api/mcp/v1', mcpServerV1Routes);
    const replayResponse = await app.request('/api/mcp/v1', {
      method: 'POST',
      headers: { Authorization: `Bearer ${employeeToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `completed-replay-${suffix}`,
        method: 'tools/call',
        params: { name: 'module_record_create', arguments: args },
      }),
    });
    assert.equal(replayResponse.status, 200);
    const replayBody = await replayResponse.json() as { result: ToolResult };
    const replayAfterPolicyChange = textPayload(replayBody.result);
    assert.equal(replayAfterPolicyChange.record_id, mutation.record_id);
    assert.equal(replayAfterPolicyChange.replayed, true);

    const deniedName = `Denied After Policy ${suffix}`;
    const deniedResponse = await app.request('/api/mcp/v1', {
      method: 'POST',
      headers: { Authorization: `Bearer ${employeeToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `denied-after-policy-${suffix}`,
        method: 'tools/call',
        params: {
          name: 'module_record_create',
          arguments: {
            ...args,
            data: { ...args.data, name: deniedName },
            idempotency_key: `denied-after-policy-${suffix}`,
          },
        },
      }),
    });
    assert.equal(deniedResponse.status, 200);
    const deniedBody = await deniedResponse.json() as { result: ToolResult };
    const denied = deniedBody.result;
    assert.equal(denied.isError, true);
    assert.match(denied.content[0]!.text, /unhealthy|disabled/i);
    await withClient(async (client) => {
      const records = await client.query(
        `SELECT count(*)::int AS count FROM module_records
         WHERE org_id = $1 AND data->>'name' = $2`,
        [ORG_ID, deniedName],
      );
      assert.equal(records.rows[0].count, 0);
    });
  } finally {
    await withClient((client) => client.query(
      `UPDATE agent_employees
       SET unhealthy = false, unhealthy_reason = NULL, disabled_tools = NULL
       WHERE id = $1 AND org_id = $2`,
      [EMPLOYEE_ID, ORG_ID],
    ));
  }
  const conflict = await MODULE_MCP_WRITE_TOOLS.module_record_create!({
    ...args,
    data: { ...args.data, name: `Different Contact ${suffix}` },
  }, employeeContext('standard'));
  assert.equal(conflict.isError, true);
  assert.match(conflict.content[0]!.text, /MODULE_IDEMPOTENCY_CONFLICT/);
  await withClient(async (client) => {
    const actions = await client.query(
      `SELECT params FROM agent_actions
       WHERE org_id = $1 AND agent_employee_id = $2
         AND action = 'module_record_create'
         AND params->>'idempotency_digest' IS NOT NULL`,
      [ORG_ID, EMPLOYEE_ID],
    );
    assert.equal(actions.rows.length, 1);
    assert.match(actions.rows[0].params.idempotency_digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal('idempotency_key' in actions.rows[0].params, false);
    assert.equal('data' in actions.rows[0].params, false);
    assert.equal(JSON.stringify(actions.rows[0].params).includes(privateName), false);
    const receipts = await client.query(
      `SELECT count(*)::int AS count FROM action_receipts
       WHERE action_id IN (
         SELECT id FROM agent_actions
         WHERE org_id = $1 AND agent_employee_id = $2
           AND action = 'module_record_create'
           AND params->>'idempotency_digest' = $3
       )`,
      [ORG_ID, EMPLOYEE_ID, actions.rows[0].params.idempotency_digest],
    );
    assert.equal(receipts.rows[0].count, 1);
    const budget = await client.query(
      `SELECT daily_action_count FROM agent_employees WHERE id = $1`,
      [EMPLOYEE_ID],
    );
    assert.equal(budget.rows[0].daily_action_count, budgetBefore + 1);
  });

  const fetched = await MODULE_MCP_READ_TOOLS.module_record_get!({
    caller_employee_slug: EMPLOYEE_SLUG,
    record_id: mutation.record_id,
  }, employeeContext('standard'));
  assert.equal(textPayload(fetched).record.data.name, privateName);
});

test('ModuleService waits for an in-flight employee policy update and denies the mutation', async () => {
  const blocker = new pg.Client({ connectionString: DATABASE_URL });
  await blocker.connect();
  const privateName = `Central Policy Race ${suffix}`;
  let transactionOpen = false;
  try {
    await blocker.query('BEGIN');
    transactionOpen = true;
    const pid = await blocker.query('SELECT pg_backend_pid() AS pid');
    await blocker.query(
      `UPDATE agent_employees
       SET unhealthy = true, unhealthy_reason = 'central module policy race'
       WHERE id = $1 AND org_id = $2`,
      [EMPLOYEE_ID, ORG_ID],
    );

    const mutation = createModuleRecord(employeeModuleActor({
      orgId: ORG_ID,
      employeeId: EMPLOYEE_ID,
      trustLevel: 'standard',
      source: 'mcp',
    }), {
      module_id: 'com.deft.contacts',
      collection_key: 'contacts',
      data: { name: privateName },
      expected_manifest_digest: manifestDigest,
      idempotency_key: `central-policy-race-${suffix}`,
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    await waitForSessionBlockedBy(pid.rows[0].pid as number);
    await blocker.query('COMMIT');
    transactionOpen = false;

    const outcome = await mutation;
    assert.equal(outcome.ok, false);
    if (outcome.ok) assert.fail('ModuleService mutation unexpectedly passed employee policy');
    assert.match(String(outcome.error), /unhealthy/i);
    await withClient(async (client) => {
      const records = await client.query(
        `SELECT count(*)::int AS count FROM module_records
         WHERE org_id = $1 AND data->>'name' = $2`,
        [ORG_ID, privateName],
      );
      assert.equal(records.rows[0].count, 0);
    });
  } finally {
    if (transactionOpen) await blocker.query('ROLLBACK').catch(() => undefined);
    await blocker.end();
    await withClient((client) => client.query(
      `UPDATE agent_employees
       SET unhealthy = false, unhealthy_reason = NULL
       WHERE id = $1 AND org_id = $2`,
      [EMPLOYEE_ID, ORG_ID],
    ));
  }
});

test('MCP queue and direct claims cannot persist after an in-flight employee policy change', async () => {
  const beforeBudget = await withClient(async (client) => {
    const state = await client.query(
      `SELECT daily_action_count FROM agent_employees WHERE id = $1 AND org_id = $2`,
      [EMPLOYEE_ID, ORG_ID],
    );
    return state.rows[0].daily_action_count as number;
  });

  const queueKey = `queue-policy-race-${suffix}`;
  const queueName = `Queue Policy Race ${suffix}`;
  const queueBlocker = new pg.Client({ connectionString: DATABASE_URL });
  await queueBlocker.connect();
  let queueTransactionOpen = false;
  try {
    await queueBlocker.query('BEGIN');
    queueTransactionOpen = true;
    const pid = await queueBlocker.query('SELECT pg_backend_pid() AS pid');
    await queueBlocker.query(
      `UPDATE agent_employees
       SET unhealthy = true, unhealthy_reason = 'queue claim policy race'
       WHERE id = $1 AND org_id = $2`,
      [EMPLOYEE_ID, ORG_ID],
    );
    const queued = MODULE_MCP_WRITE_TOOLS.module_record_create!({
      caller_employee_slug: EMPLOYEE_SLUG,
      module_id: 'com.deft.contacts',
      collection_key: 'contacts',
      data: { name: queueName },
      expected_manifest_digest: manifestDigest,
      idempotency_key: queueKey,
    }, employeeContext('conservative'));
    await waitForSessionBlockedBy(pid.rows[0].pid as number);
    await queueBlocker.query('COMMIT');
    queueTransactionOpen = false;
    assert.match((await queued).content[0]!.text, /unhealthy/i);
  } finally {
    if (queueTransactionOpen) await queueBlocker.query('ROLLBACK').catch(() => undefined);
    await queueBlocker.end();
    await withClient((client) => client.query(
      `UPDATE agent_employees
       SET unhealthy = false, unhealthy_reason = NULL
       WHERE id = $1 AND org_id = $2`,
      [EMPLOYEE_ID, ORG_ID],
    ));
  }

  const directKey = `direct-policy-race-${suffix}`;
  const directName = `Direct Policy Race ${suffix}`;
  const directBlocker = new pg.Client({ connectionString: DATABASE_URL });
  await directBlocker.connect();
  let directTransactionOpen = false;
  try {
    await directBlocker.query('BEGIN');
    directTransactionOpen = true;
    const pid = await directBlocker.query('SELECT pg_backend_pid() AS pid');
    await directBlocker.query(
      `UPDATE agent_employees
       SET disabled_tools = ARRAY['module_record_create']::text[]
       WHERE id = $1 AND org_id = $2`,
      [EMPLOYEE_ID, ORG_ID],
    );
    const direct = MODULE_MCP_WRITE_TOOLS.module_record_create!({
      caller_employee_slug: EMPLOYEE_SLUG,
      module_id: 'com.deft.contacts',
      collection_key: 'contacts',
      data: { name: directName },
      expected_manifest_digest: manifestDigest,
      idempotency_key: directKey,
    }, employeeContext('standard'));
    await waitForSessionBlockedBy(pid.rows[0].pid as number);
    await directBlocker.query('COMMIT');
    directTransactionOpen = false;
    assert.match((await direct).content[0]!.text, /disabled/i);
  } finally {
    if (directTransactionOpen) await directBlocker.query('ROLLBACK').catch(() => undefined);
    await directBlocker.end();
    await withClient((client) => client.query(
      `UPDATE agent_employees
       SET disabled_tools = NULL
       WHERE id = $1 AND org_id = $2`,
      [EMPLOYEE_ID, ORG_ID],
    ));
  }

  await withClient(async (client) => {
    const actions = await client.query(
      `SELECT count(*)::int AS count FROM agent_actions
       WHERE org_id = $1 AND params->>'idempotency_key' = ANY($2::text[])`,
      [ORG_ID, [queueKey, directKey]],
    );
    assert.equal(actions.rows[0].count, 0);
    const records = await client.query(
      `SELECT count(*)::int AS count FROM module_records
       WHERE org_id = $1 AND data->>'name' = ANY($2::text[])`,
      [ORG_ID, [queueName, directName]],
    );
    assert.equal(records.rows[0].count, 0);
    const state = await client.query(
      `SELECT daily_action_count FROM agent_employees WHERE id = $1 AND org_id = $2`,
      [EMPLOYEE_ID, ORG_ID],
    );
    assert.equal(state.rows[0].daily_action_count, beforeBudget);
  });
});

test('a live trust downgrade converts a stale direct claim into one pending action', async () => {
  const blocker = new pg.Client({ connectionString: DATABASE_URL });
  await blocker.connect();
  const rawKey = `trust-downgrade-${suffix}`;
  const privateName = `Trust Downgrade ${suffix}`;
  const args = {
    caller_employee_slug: EMPLOYEE_SLUG,
    module_id: 'com.deft.contacts',
    collection_key: 'contacts',
    data: { name: privateName },
    expected_manifest_digest: manifestDigest,
    idempotency_key: rawKey,
  };
  const budgetBefore = await withClient(async (client) => {
    const state = await client.query(
      `SELECT daily_action_count FROM agent_employees WHERE id = $1 AND org_id = $2`,
      [EMPLOYEE_ID, ORG_ID],
    );
    return state.rows[0].daily_action_count as number;
  });
  let transactionOpen = false;
  try {
    await blocker.query('BEGIN');
    transactionOpen = true;
    const pid = await blocker.query('SELECT pg_backend_pid() AS pid');
    await blocker.query(
      `UPDATE agent_employees SET trust_level = 'conservative'
       WHERE id = $1 AND org_id = $2`,
      [EMPLOYEE_ID, ORG_ID],
    );

    const staleDirect = MODULE_MCP_WRITE_TOOLS.module_record_create!(
      args,
      employeeContext('standard'),
    );
    await waitForSessionBlockedBy(pid.rows[0].pid as number);
    await blocker.query('COMMIT');
    transactionOpen = false;

    const proposed = textPayload(await staleDirect);
    assert.equal(typeof proposed.approval_id, 'string');
    const actionId = proposed.approval_id as string;
    await withClient(async (client) => {
      const actions = await client.query(
        `SELECT id, approval_status, params FROM agent_actions
         WHERE org_id = $1 AND agent_employee_id = $2
           AND action = 'module_record_create'
           AND params->>'idempotency_key' = $3`,
        [ORG_ID, EMPLOYEE_ID, rawKey],
      );
      assert.equal(actions.rows.length, 1);
      assert.equal(actions.rows[0].id, actionId);
      assert.equal(actions.rows[0].approval_status, 'pending');
      assert.equal(actions.rows[0].params.data.name, privateName);
      const attention = await client.query(
        `SELECT state FROM attention_items
         WHERE org_id = $1 AND source_type = 'agent_action' AND source_id = $2`,
        [ORG_ID, actionId],
      );
      assert.ok(attention.rows.length > 0);
      assert.ok(attention.rows.every((item) => String(item.state).startsWith('open_')));
      const records = await client.query(
        `SELECT count(*)::int AS count FROM module_records
         WHERE org_id = $1 AND data->>'name' = $2`,
        [ORG_ID, privateName],
      );
      assert.equal(records.rows[0].count, 0);
      const state = await client.query(
        `SELECT daily_action_count FROM agent_employees WHERE id = $1`,
        [EMPLOYEE_ID],
      );
      assert.equal(state.rows[0].daily_action_count, budgetBefore);

      // A later upgrade cannot auto-promote the already-pending proposal.
      await client.query(
        `UPDATE agent_employees SET trust_level = 'standard'
         WHERE id = $1 AND org_id = $2`,
        [EMPLOYEE_ID, ORG_ID],
      );
    });
    const retried = textPayload(await MODULE_MCP_WRITE_TOOLS.module_record_create!(
      args,
      employeeContext('conservative'),
    ));
    assert.equal(retried.approval_id, actionId);
    await withClient(async (client) => {
      const actions = await client.query(
        `SELECT count(*)::int AS count FROM agent_actions
         WHERE org_id = $1 AND agent_employee_id = $2
           AND action = 'module_record_create'
           AND params->>'idempotency_key' = $3
           AND approval_status = 'pending'`,
        [ORG_ID, EMPLOYEE_ID, rawKey],
      );
      assert.equal(actions.rows[0].count, 1);
    });
  } finally {
    if (transactionOpen) await blocker.query('ROLLBACK').catch(() => undefined);
    await blocker.end();
    await withClient((client) => client.query(
      `UPDATE agent_employees SET trust_level = 'standard'
       WHERE id = $1 AND org_id = $2`,
      [EMPLOYEE_ID, ORG_ID],
    ));
  }
});

test('MCP direct and native direct execution share one action, budget slot, mutation, and receipt', async () => {
  const privateName = `Cross Adapter Race ${suffix}`;
  const rawKey = `cross-adapter-race-${suffix}`;
  const mutationInput = {
    module_id: 'com.deft.contacts',
    collection_key: 'contacts',
    data: { name: privateName },
    expected_manifest_digest: manifestDigest,
    idempotency_key: rawKey,
  };
  const budgetBefore = await withClient(async (client) => {
    const state = await client.query(
      `SELECT daily_action_count FROM agent_employees WHERE id = $1`,
      [EMPLOYEE_ID],
    );
    return state.rows[0].daily_action_count as number;
  });

  const [mcpResult, nativeResult] = await Promise.all([
    MODULE_MCP_WRITE_TOOLS.module_record_create!({
      caller_employee_slug: EMPLOYEE_SLUG,
      ...mutationInput,
    }, employeeContext('standard')),
    executeActionDirect(
      'module_record_create',
      mutationInput,
      ORG_ID,
      EMPLOYEE_USER_ID,
      null,
      'quick',
      { agentEmployeeId: EMPLOYEE_ID, source: 'mcp' },
    ),
  ]);
  assert.notEqual(mcpResult.isError, true);
  assert.equal(nativeResult.success, true);
  const mcpMutation = textPayload(mcpResult);
  const nativeMutation = nativeResult.result as { record_id: string; replayed: boolean };
  assert.equal(mcpMutation.record_id, nativeMutation.record_id);
  assert.deepEqual(
    [mcpMutation.replayed, nativeMutation.replayed].sort(),
    [false, true],
  );

  await withClient(async (client) => {
    const actions = await client.query(
      `SELECT id, params, result FROM agent_actions
       WHERE org_id = $1 AND agent_employee_id = $2
         AND action = 'module_record_create'
         AND result->>'record_id' = $3`,
      [ORG_ID, EMPLOYEE_ID, mcpMutation.record_id],
    );
    assert.equal(actions.rows.length, 1);
    assert.equal(actions.rows[0].id, nativeResult.actionId);
    assert.equal('data' in actions.rows[0].params, false);
    assert.equal('idempotency_key' in actions.rows[0].params, false);

    const budget = await client.query(
      `SELECT daily_action_count FROM agent_employees WHERE id = $1`,
      [EMPLOYEE_ID],
    );
    assert.equal(budget.rows[0].daily_action_count, budgetBefore + 1);
    const mutations = await client.query(
      `SELECT count(*)::int AS count FROM module_mutation_receipts
       WHERE org_id = $1 AND agent_action_id = $2`,
      [ORG_ID, actions.rows[0].id],
    );
    assert.equal(mutations.rows[0].count, 1);
    const receipts = await client.query(
      `SELECT count(*)::int AS count FROM action_receipts WHERE action_id = $1`,
      [actions.rows[0].id],
    );
    assert.equal(receipts.rows[0].count, 1);
    const records = await client.query(
      `SELECT count(*)::int AS count FROM module_records
       WHERE org_id = $1 AND data->>'name' = $2`,
      [ORG_ID, privateName],
    );
    assert.equal(records.rows[0].count, 1);
  });
});

test('terminal direct failures stay failed and repair a missing receipt without retrying the mutation', async () => {
  const privateName = `Terminal Failure ${suffix}`;
  const args = {
    caller_employee_slug: EMPLOYEE_SLUG,
    module_id: 'com.deft.contacts',
    collection_key: 'contacts',
    data: { name: privateName },
    expected_manifest_digest: manifestDigest,
    idempotency_key: `terminal-failure-${suffix}`,
  };
  const original = await withClient(async (client) => {
    const state = await client.query(
      `SELECT daily_action_count, max_daily_actions
       FROM agent_employees WHERE id = $1`,
      [EMPLOYEE_ID],
    );
    await client.query(
      `UPDATE agent_employees SET max_daily_actions = daily_action_count WHERE id = $1`,
      [EMPLOYEE_ID],
    );
    return state.rows[0] as { daily_action_count: number; max_daily_actions: number };
  });

  try {
    const first = await MODULE_MCP_WRITE_TOOLS.module_record_create!(
      args,
      employeeContext('standard'),
    );
    assert.equal(first.isError, true);
    assert.match(first.content[0]!.text, /daily action limit/i);

    const actionId = await withClient(async (client) => {
      const action = await client.query(
        `SELECT id, error, executed_at, params
         FROM agent_actions
         WHERE org_id = $1 AND agent_employee_id = $2
           AND action = 'module_record_create'
           AND params->>'idempotency_digest' IS NOT NULL
           AND params->'changed_fields' ? 'name'
         ORDER BY created_at DESC LIMIT 1`,
        [ORG_ID, EMPLOYEE_ID],
      );
      assert.equal(action.rows.length, 1);
      assert.match(action.rows[0].error, /daily action limit/i);
      assert.ok(action.rows[0].executed_at);
      assert.equal('data' in action.rows[0].params, false);
      await client.query('DELETE FROM action_receipts WHERE action_id = $1', [action.rows[0].id]);
      await client.query(
        `UPDATE agent_employees SET max_daily_actions = $2 WHERE id = $1`,
        [EMPLOYEE_ID, original.max_daily_actions],
      );
      return action.rows[0].id as string;
    });

    const retry = await MODULE_MCP_WRITE_TOOLS.module_record_create!(
      args,
      employeeContext('standard'),
    );
    assert.equal(retry.isError, true);
    assert.match(retry.content[0]!.text, /daily action limit/i);

    await withClient(async (client) => {
      const actions = await client.query(
        `SELECT count(*)::int AS count FROM agent_actions
         WHERE org_id = $1 AND agent_employee_id = $2
           AND action = 'module_record_create'
           AND id = $3`,
        [ORG_ID, EMPLOYEE_ID, actionId],
      );
      assert.equal(actions.rows[0].count, 1);
      const receipts = await client.query(
        `SELECT count(*)::int AS count FROM action_receipts WHERE action_id = $1`,
        [actionId],
      );
      assert.equal(receipts.rows[0].count, 1);
      const records = await client.query(
        `SELECT count(*)::int AS count FROM module_records
         WHERE org_id = $1 AND data->>'name' = $2`,
        [ORG_ID, privateName],
      );
      assert.equal(records.rows[0].count, 0);
      const state = await client.query(
        `SELECT daily_action_count FROM agent_employees WHERE id = $1`,
        [EMPLOYEE_ID],
      );
      assert.equal(state.rows[0].daily_action_count, original.daily_action_count);
    });
  } finally {
    await withClient((client) => client.query(
      `UPDATE agent_employees SET max_daily_actions = $2 WHERE id = $1`,
      [EMPLOYEE_ID, original.max_daily_actions],
    ));
  }
});

test('concurrent Conservative retries create one pending action with one approval id', async () => {
  const args = {
    caller_employee_slug: EMPLOYEE_SLUG,
    module_id: 'com.deft.contacts',
    collection_key: 'contacts',
    data: { name: `Queued Contact ${suffix}` },
    expected_manifest_digest: manifestDigest,
    idempotency_key: `queued-${suffix}`,
  };
  const results = await Promise.all(
    Array.from({ length: 5 }, () => (
      MODULE_MCP_WRITE_TOOLS.module_record_create!(args, employeeContext('conservative'))
    )),
  );
  const approvalIds = new Set(results.map((result) => textPayload(result).approval_id));
  assert.equal(approvalIds.size, 1);
  const [approvalId] = [...approvalIds];
  assert.equal(typeof approvalId, 'string');
  await withClient(async (client) => {
    const count = await client.query(
      `SELECT count(*)::int AS count
       FROM agent_actions
       WHERE org_id = $1 AND agent_employee_id = $2
         AND action = 'module_record_create'
         AND params->>'idempotency_key' = $3`,
      [ORG_ID, EMPLOYEE_ID, args.idempotency_key],
    );
    assert.equal(count.rows[0].count, 1);
  });

  const approved = await approveAction(approvalId!, ADMIN_ID);
  assert.equal(approved.status, 'approved');
  const approvedRecordId = (approved as { result: { record_id: string } }).result.record_id;
  const replay = textPayload(await MODULE_MCP_WRITE_TOOLS.module_record_create!(
    args,
    employeeContext('conservative'),
  ));
  assert.equal(replay.record_id, approvedRecordId);
  assert.equal(replay.replayed, true);
  await withClient(async (client) => {
    const receipt = await client.query(
      `SELECT decision, approver_id, action_name, action_params_json, result_json
       FROM action_receipts WHERE action_id = $1`,
      [approvalId],
    );
    assert.equal(receipt.rows.length, 1);
    assert.equal(receipt.rows[0].decision, 'approved');
    assert.equal(receipt.rows[0].approver_id, ADMIN_ID);
    assert.equal(receipt.rows[0].action_name, 'module_record_create');
    assert.deepEqual(receipt.rows[0].action_params_json.changed_fields, ['name']);
    assert.equal('data' in receipt.rows[0].action_params_json, false);
    assert.equal(JSON.stringify(receipt.rows[0]).includes(`Queued Contact ${suffix}`), false);
    assert.equal(receipt.rows[0].result_json.module_id, 'com.deft.contacts');
    const action = await client.query(
      `SELECT params FROM agent_actions WHERE id = $1`,
      [approvalId],
    );
    assert.match(action.rows[0].params.idempotency_digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal('idempotency_key' in action.rows[0].params, false);
    assert.equal('data' in action.rows[0].params, false);
    assert.equal(JSON.stringify(action.rows[0].params).includes(`Queued Contact ${suffix}`), false);
  });
});

test('an approved-but-unexecuted Conservative retry preserves human approval provenance', async () => {
  const privateName = `Approval Crash Recovery ${suffix}`;
  const args = {
    caller_employee_slug: EMPLOYEE_SLUG,
    module_id: 'com.deft.contacts',
    collection_key: 'contacts',
    data: { name: privateName },
    expected_manifest_digest: manifestDigest,
    idempotency_key: `approval-crash-${suffix}`,
  };
  const queued = await MODULE_MCP_WRITE_TOOLS.module_record_create!(
    args,
    employeeContext('conservative'),
  );
  const actionId = textPayload(queued).approval_id as string;
  await withClient((client) => client.query(
    `UPDATE agent_actions
     SET approval_status = 'approved', approved_at = now(), approved_by_user_id = $2
     WHERE id = $1 AND approval_status = 'pending'`,
    [actionId, ADMIN_ID],
  ));

  const recovered = textPayload(await MODULE_MCP_WRITE_TOOLS.module_record_create!(
    args,
    employeeContext('conservative'),
  ));
  assert.equal(recovered.module_id, 'com.deft.contacts');
  assert.equal(recovered.replayed, false);

  await withClient(async (client) => {
    const action = await client.query(
      `SELECT approval_status, approved_by_user_id, executed_at, result, params
       FROM agent_actions WHERE id = $1`,
      [actionId],
    );
    assert.equal(action.rows.length, 1);
    assert.equal(action.rows[0].approval_status, 'approved');
    assert.equal(action.rows[0].approved_by_user_id, ADMIN_ID);
    assert.ok(action.rows[0].executed_at);
    assert.equal(action.rows[0].result.record_id, recovered.record_id);
    assert.equal('data' in action.rows[0].params, false);

    const receipt = await client.query(
      `SELECT decision, approver_id, action_params_json
       FROM action_receipts WHERE action_id = $1`,
      [actionId],
    );
    assert.equal(receipt.rows.length, 1);
    assert.equal(receipt.rows[0].decision, 'approved');
    assert.equal(receipt.rows[0].approver_id, ADMIN_ID);
    assert.equal('data' in receipt.rows[0].action_params_json, false);
    assert.doesNotMatch(JSON.stringify(receipt.rows[0]), new RegExp(privateName));
  });
});

test('rejected module writes use the MCP resolver and emit sanitized receipts', async () => {
  assert.equal(MCP_ACTION_KINDS.has('module_record_create'), true);
  assert.equal(MCP_ACTION_KINDS.has('module_record_update'), true);
  assert.equal(MCP_ACTION_KINDS.has('module_record_archive'), true);
  const privateValue = `Rejected Contact ${suffix}`;
  const queued = await MODULE_MCP_WRITE_TOOLS.module_record_create!({
    caller_employee_slug: EMPLOYEE_SLUG,
    module_id: 'com.deft.contacts',
    collection_key: 'contacts',
    data: { name: privateValue, notes: 'must stay out of the receipt' },
    expected_manifest_digest: manifestDigest,
    idempotency_key: `rejected-${suffix}`,
  }, employeeContext('conservative'));
  const actionId = textPayload(queued).approval_id as string;
  await withClient(async (client) => {
    const action = await client.query(`SELECT * FROM agent_actions WHERE id = $1`, [actionId]);
    await syncApprovalToAttention(action.rows[0], { deliver: false });
  });
  const rejected = await rejectAction(actionId, ADMIN_ID, 'not needed');
  assert.equal(rejected.status, 'rejected');
  await withClient(async (client) => {
    const receipt = await client.query(
      `SELECT decision, decision_reason, action_name, action_params_json, result_json
       FROM action_receipts WHERE action_id = $1`,
      [actionId],
    );
    assert.equal(receipt.rows.length, 1);
    assert.equal(receipt.rows[0].decision, 'rejected');
    assert.equal(receipt.rows[0].decision_reason, 'not needed');
    assert.equal(receipt.rows[0].action_name, 'module_record_create');
    assert.deepEqual(receipt.rows[0].action_params_json.changed_fields, ['name', 'notes']);
    assert.equal('data' in receipt.rows[0].action_params_json, false);
    assert.equal(JSON.stringify(receipt.rows[0]).includes(privateValue), false);
    assert.equal(receipt.rows[0].result_json, null);
    const action = await client.query(`SELECT params FROM agent_actions WHERE id = $1`, [actionId]);
    assert.equal('idempotency_key' in action.rows[0].params, false);
    assert.equal('data' in action.rows[0].params, false);
    assert.equal(JSON.stringify(action.rows[0].params).includes(privateValue), false);
    assert.equal(action.rows[0].params.terminal_reviewer_user_id, ADMIN_ID);
    const attention = await client.query(
      `SELECT state, resolution FROM attention_items
       WHERE org_id = $1 AND source_type = 'agent_action' AND source_id = $2`,
      [ORG_ID, actionId],
    );
    assert.ok(attention.rows.length > 0);
    assert.ok(attention.rows.every((item) => item.state === 'resolved'));
    assert.ok(attention.rows.every((item) => item.resolution === 'rejected'));

    // Simulate a process loss immediately after the action/WorkIntent commit
    // but before either idempotent post-commit artifact was persisted.
    await client.query('DELETE FROM action_receipts WHERE action_id = $1', [actionId]);
    await client.query(
      `UPDATE attention_items
       SET state = 'open_seen', resolution = NULL
       WHERE org_id = $1 AND source_type = 'agent_action' AND source_id = $2`,
      [ORG_ID, actionId],
    );
  });

  const retried = await rejectAction(actionId, ADMIN_ID, 'ignored retry reason');
  assert.equal(retried.status, 'rejected');
  await withClient(async (client) => {
    const receipt = await client.query(
      `SELECT decision, decision_reason, approver_id
       FROM action_receipts WHERE action_id = $1`,
      [actionId],
    );
    assert.equal(receipt.rows.length, 1);
    assert.equal(receipt.rows[0].decision, 'rejected');
    assert.equal(receipt.rows[0].decision_reason, 'not needed');
    assert.equal(receipt.rows[0].approver_id, ADMIN_ID);
    const attention = await client.query(
      `SELECT state, resolution FROM attention_items
       WHERE org_id = $1 AND source_type = 'agent_action' AND source_id = $2`,
      [ORG_ID, actionId],
    );
    assert.ok(attention.rows.every((item) => item.state === 'resolved'));
    assert.ok(attention.rows.every((item) => item.resolution === 'rejected'));
  });
});

test('Defty module proposals without an employee approve through the signed resolver', async () => {
  const privateValue = `Defty Proposed Contact ${suffix}`;
  const actionId = randomUUID();
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO agent_actions
        (id, org_id, user_id, source, action, params, approval_tier, approval_status)
       VALUES ($1, $2, $3, 'agent_chat', 'module_record_create', $4::jsonb, 'quick', 'pending')`,
      [
        actionId,
        ORG_ID,
        ADMIN_ID,
        JSON.stringify({
          module_id: 'com.deft.contacts',
          collection_key: 'contacts',
          data: { name: privateValue, notes: 'Defty proposal private note' },
          expected_manifest_digest: manifestDigest,
          idempotency_key: `defty-proposal-${suffix}`,
        }),
      ],
    );
  });

  const approved = await approveAction(actionId, ADMIN_ID);
  assert.equal(approved.status, 'approved');
  assert.equal((approved as { result: { revision: number } }).result.revision, 1);
  await withClient(async (client) => {
    const receipt = await client.query(
      `SELECT employee_id, proposer, proposer_id, decision, action_params_json
       FROM action_receipts WHERE action_id = $1`,
      [actionId],
    );
    assert.equal(receipt.rows.length, 1);
    assert.equal(receipt.rows[0].employee_id, null);
    assert.equal(receipt.rows[0].proposer, 'defty');
    assert.equal(receipt.rows[0].proposer_id, ADMIN_ID);
    assert.equal(receipt.rows[0].decision, 'approved');
    assert.equal('data' in receipt.rows[0].action_params_json, false);
    assert.equal(JSON.stringify(receipt.rows[0]).includes(privateValue), false);
    const action = await client.query(`SELECT params FROM agent_actions WHERE id = $1`, [actionId]);
    assert.equal('idempotency_key' in action.rows[0].params, false);
    assert.equal('data' in action.rows[0].params, false);
  });
});

test('disabled modules fail preflight and never create a pending action', async () => {
  const adminActor = humanModuleActor({ orgId: ORG_ID, userId: ADMIN_ID, role: 'owner' });
  await updateModuleInstallation(adminActor, 'contacts', { enabled: false });
  const idempotencyKey = `disabled-${suffix}`;
  const result = await MODULE_MCP_WRITE_TOOLS.module_record_create!({
    caller_employee_slug: EMPLOYEE_SLUG,
    module_id: 'com.deft.contacts',
    collection_key: 'contacts',
    data: { name: `Must Not Queue ${suffix}` },
    expected_manifest_digest: manifestDigest,
    idempotency_key: idempotencyKey,
  }, employeeContext('conservative'));
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /MODULE_DISABLED/);
  await withClient(async (client) => {
    const count = await client.query(
      `SELECT count(*)::int AS count FROM agent_actions
       WHERE org_id = $1 AND params->>'idempotency_key' = $2`,
      [ORG_ID, idempotencyKey],
    );
    assert.equal(count.rows[0].count, 0);
  });
  await updateModuleInstallation(adminActor, 'contacts', { enabled: true });
});

test('transactional queue preflight cannot insert after an in-flight agent write revocation', async () => {
  const adminActor = humanModuleActor({ orgId: ORG_ID, userId: ADMIN_ID, role: 'owner' });
  const disabler = new pg.Client({ connectionString: DATABASE_URL });
  const rawKey = `queue-revoke-race-${suffix}`;
  const privateValue = `Queue Revoke Race ${suffix}`;
  let transactionOpen = false;
  let queuedWrite: Promise<ToolResult> | undefined;
  await disabler.connect();
  try {
    await disabler.query('BEGIN');
    transactionOpen = true;
    const pid = await disabler.query(`SELECT pg_backend_pid()::int AS pid`);
    const revoked = await disabler.query(
      `UPDATE module_installations
       SET agent_access = 'none', updated_at = now()
       WHERE org_id = $1 AND module_id = 'com.deft.contacts'
       RETURNING id`,
      [ORG_ID],
    );
    assert.equal(revoked.rows.length, 1);

    queuedWrite = MODULE_MCP_WRITE_TOOLS.module_record_create!({
      caller_employee_slug: EMPLOYEE_SLUG,
      module_id: 'com.deft.contacts',
      collection_key: 'contacts',
      data: { name: privateValue },
      expected_manifest_digest: manifestDigest,
      idempotency_key: rawKey,
    }, employeeContext('conservative'));
    await waitForSessionBlockedBy(pid.rows[0].pid as number);
    await disabler.query('COMMIT');
    transactionOpen = false;

    const denied = await queuedWrite;
    assert.equal(denied.isError, true);
    assert.match(denied.content[0]!.text, /MODULE_ACCESS_DENIED|agent access/i);
    await withClient(async (client) => {
      const actions = await client.query(
        `SELECT count(*)::int AS count FROM agent_actions
         WHERE org_id = $1 AND agent_employee_id = $2
           AND action = 'module_record_create'
           AND params->>'idempotency_key' = $3`,
        [ORG_ID, EMPLOYEE_ID, rawKey],
      );
      assert.equal(actions.rows[0].count, 0);
      const records = await client.query(
        `SELECT count(*)::int AS count FROM module_records
         WHERE org_id = $1 AND data->>'name' = $2`,
        [ORG_ID, privateValue],
      );
      assert.equal(records.rows[0].count, 0);
    });
  } finally {
    if (transactionOpen) await disabler.query('ROLLBACK').catch(() => undefined);
    await disabler.end();
    if (queuedWrite) await queuedWrite.catch(() => undefined);
    await updateModuleInstallation(adminActor, 'contacts', { agent_access: 'write' });
  }
});

test('transactional direct preflight cannot insert or spend budget after an in-flight write revocation', async () => {
  const adminActor = humanModuleActor({ orgId: ORG_ID, userId: ADMIN_ID, role: 'owner' });
  const disabler = new pg.Client({ connectionString: DATABASE_URL });
  const rawKey = `direct-revoke-race-${suffix}`;
  const privateValue = `Direct Revoke Race ${suffix}`;
  let transactionOpen = false;
  let directWrite: Promise<ToolResult> | undefined;
  const budgetBefore = await withClient(async (client) => {
    const state = await client.query(
      `SELECT daily_action_count FROM agent_employees WHERE id = $1`,
      [EMPLOYEE_ID],
    );
    return state.rows[0].daily_action_count as number;
  });
  await disabler.connect();
  try {
    await disabler.query('BEGIN');
    transactionOpen = true;
    const pid = await disabler.query(`SELECT pg_backend_pid()::int AS pid`);
    const revoked = await disabler.query(
      `UPDATE module_installations
       SET agent_access = 'none', updated_at = now()
       WHERE org_id = $1 AND module_id = 'com.deft.contacts'
       RETURNING id`,
      [ORG_ID],
    );
    assert.equal(revoked.rows.length, 1);

    directWrite = MODULE_MCP_WRITE_TOOLS.module_record_create!({
      caller_employee_slug: EMPLOYEE_SLUG,
      module_id: 'com.deft.contacts',
      collection_key: 'contacts',
      data: { name: privateValue },
      expected_manifest_digest: manifestDigest,
      idempotency_key: rawKey,
    }, employeeContext('standard'));
    await waitForSessionBlockedBy(pid.rows[0].pid as number);
    await disabler.query('COMMIT');
    transactionOpen = false;

    const denied = await directWrite;
    assert.equal(denied.isError, true);
    assert.match(denied.content[0]!.text, /MODULE_ACCESS_DENIED|agent access/i);
    await withClient(async (client) => {
      const actions = await client.query(
        `SELECT count(*)::int AS count FROM agent_actions
         WHERE org_id = $1 AND agent_employee_id = $2
           AND action = 'module_record_create'
           AND params->>'idempotency_key' = $3`,
        [ORG_ID, EMPLOYEE_ID, rawKey],
      );
      assert.equal(actions.rows[0].count, 0);
      const records = await client.query(
        `SELECT count(*)::int AS count FROM module_records
         WHERE org_id = $1 AND data->>'name' = $2`,
        [ORG_ID, privateValue],
      );
      assert.equal(records.rows[0].count, 0);
      const budget = await client.query(
        `SELECT daily_action_count FROM agent_employees WHERE id = $1`,
        [EMPLOYEE_ID],
      );
      assert.equal(budget.rows[0].daily_action_count, budgetBefore);
    });
  } finally {
    if (transactionOpen) await disabler.query('ROLLBACK').catch(() => undefined);
    await disabler.end();
    if (directWrite) await directWrite.catch(() => undefined);
    await updateModuleInstallation(adminActor, 'contacts', { agent_access: 'write' });
  }
});

test('a lifecycle disable that expires a direct action cannot be overwritten by its resumed result', async () => {
  const adminActor = humanModuleActor({ orgId: ORG_ID, userId: ADMIN_ID, role: 'owner' });
  const employeeBlocker = new pg.Client({ connectionString: DATABASE_URL });
  const privateValue = `Expired Direct Lifecycle ${suffix}`;
  const rawKey = `expired-direct-lifecycle-${suffix}`;
  const operationInput = {
    module_id: 'com.deft.contacts',
    collection_key: 'contacts',
    data: { name: privateValue },
    expected_manifest_digest: manifestDigest,
    idempotency_key: rawKey,
  };
  const actionId = randomUUID();
  let transactionOpen = false;
  let directWrite: Promise<ToolResult> | undefined;
  let lifecycleDisable: Promise<unknown> | undefined;
  await employeeBlocker.connect();
  try {
    // Model a process loss after the direct action claim but before its
    // ModuleService mutation. The retry resumes this approved action, then
    // blocks on the central employee-policy row lock below.
    await withClient((client) => client.query(
      `INSERT INTO agent_actions
         (id, org_id, user_id, agent_employee_id, source, action, params,
          approval_tier, approval_status, approved_at)
       VALUES ($1, $2, $3, $4, 'mcp', 'module_record_create', $5::jsonb,
               'quick', 'approved', now())`,
      [actionId, ORG_ID, EMPLOYEE_USER_ID, EMPLOYEE_ID, JSON.stringify(operationInput)],
    ));
    await employeeBlocker.query('BEGIN');
    transactionOpen = true;
    const pid = await employeeBlocker.query(`SELECT pg_backend_pid()::int AS pid`);
    await employeeBlocker.query(
      `SELECT id FROM agent_employees WHERE id = $1 FOR UPDATE`,
      [EMPLOYEE_ID],
    );

    directWrite = MODULE_MCP_WRITE_TOOLS.module_record_create!({
      caller_employee_slug: EMPLOYEE_SLUG,
      ...operationInput,
    }, employeeContext('standard'));
    await waitForSessionBlockedBy(pid.rows[0].pid as number);

    lifecycleDisable = updateModuleInstallation(adminActor, 'contacts', { enabled: false });
    await waitForActionStatus(actionId, 'expired');
    await employeeBlocker.query('COMMIT');
    transactionOpen = false;
    await lifecycleDisable;
    const denied = await directWrite;
    assert.equal(denied.isError, true);
    assert.match(denied.content[0]!.text, /disabled|expired|revoked/i);

    await withClient(async (client) => {
      const actions = await client.query(
        `SELECT id, approval_status, params, error, executed_at, result
         FROM agent_actions WHERE id = $1`,
        [actionId],
      );
      assert.equal(actions.rows.length, 1);
      assert.equal(actions.rows[0].approval_status, 'expired');
      assert.ok(actions.rows[0].executed_at);
      assert.equal(actions.rows[0].result, null);
      assert.equal('data' in actions.rows[0].params, false);
      assert.equal('idempotency_key' in actions.rows[0].params, false);
      assert.doesNotMatch(JSON.stringify(actions.rows[0]), new RegExp(`${privateValue}|${rawKey}`));

      const receipts = await client.query(
        `SELECT decision, action_params_json FROM action_receipts WHERE action_id = $1`,
        [actions.rows[0].id],
      );
      assert.equal(receipts.rows.length, 1);
      assert.equal(receipts.rows[0].decision, 'expired');
      assert.doesNotMatch(JSON.stringify(receipts.rows[0]), new RegExp(`${privateValue}|${rawKey}`));
      const mutations = await client.query(
        `SELECT count(*)::int AS count FROM module_mutation_receipts
         WHERE org_id = $1 AND agent_action_id = $2`,
        [ORG_ID, actions.rows[0].id],
      );
      assert.equal(mutations.rows[0].count, 0);
      const records = await client.query(
        `SELECT count(*)::int AS count FROM module_records
         WHERE org_id = $1 AND data->>'name' = $2`,
        [ORG_ID, privateValue],
      );
      assert.equal(records.rows[0].count, 0);
    });
  } finally {
    if (transactionOpen) await employeeBlocker.query('ROLLBACK').catch(() => undefined);
    await employeeBlocker.end();
    if (lifecycleDisable) await lifecycleDisable.catch(() => undefined);
    if (directWrite) await directWrite.catch(() => undefined);
    await updateModuleInstallation(adminActor, 'contacts', { enabled: true });
  }
});

test('removing agent write access expires and scrubs pending module approvals permanently', async () => {
  const adminActor = humanModuleActor({ orgId: ORG_ID, userId: ADMIN_ID, role: 'owner' });
  const privateValue = `Revoked Pending Contact ${suffix}`;
  const rawKey = `revoked-pending-${suffix}`;
  const queued = await MODULE_MCP_WRITE_TOOLS.module_record_create!({
    caller_employee_slug: EMPLOYEE_SLUG,
    module_id: 'com.deft.contacts',
    collection_key: 'contacts',
    data: { name: privateValue, notes: 'must be scrubbed when access is revoked' },
    expected_manifest_digest: manifestDigest,
    idempotency_key: rawKey,
  }, employeeContext('conservative'));
  const actionId = textPayload(queued).approval_id as string;

  await updateModuleInstallation(adminActor, 'contacts', { agent_access: 'read' });
  await withClient(async (client) => {
    const action = await client.query(
      `SELECT approval_status, params, error FROM agent_actions WHERE id = $1`,
      [actionId],
    );
    assert.equal(action.rows[0].approval_status, 'expired');
    assert.match(action.rows[0].error, /write access was revoked/i);
    assert.equal('data' in action.rows[0].params, false);
    assert.equal('idempotency_key' in action.rows[0].params, false);
    assert.doesNotMatch(JSON.stringify(action.rows[0]), new RegExp(`${privateValue}|${rawKey}`));
    const receipt = await client.query(
      `SELECT decision, action_params_json, decision_reason, approver_id
       FROM action_receipts WHERE action_id = $1`,
      [actionId],
    );
    assert.equal(receipt.rows.length, 1);
    assert.equal(receipt.rows[0].decision, 'expired');
    assert.equal(receipt.rows[0].approver_id, ADMIN_ID);
    assert.match(receipt.rows[0].decision_reason, /write access was revoked/i);
    assert.doesNotMatch(JSON.stringify(receipt.rows[0]), new RegExp(`${privateValue}|${rawKey}`));
    const attention = await client.query(
      `SELECT state, resolution FROM attention_items
       WHERE org_id = $1 AND source_type = 'agent_action' AND source_id = $2`,
      [ORG_ID, actionId],
    );
    assert.ok(attention.rows.every((row) => row.state === 'resolved'));
    assert.ok(attention.rows.every((row) => row.resolution === 'module_access_revoked'));
    const records = await client.query(
      `SELECT count(*)::int AS count FROM module_records
       WHERE org_id = $1 AND data->>'name' = $2`,
      [ORG_ID, privateValue],
    );
    assert.equal(records.rows[0].count, 0);
  });

  await updateModuleInstallation(adminActor, 'contacts', { agent_access: 'write' });
  await withClient(async (client) => {
    const action = await client.query(
      `SELECT approval_status FROM agent_actions WHERE id = $1`,
      [actionId],
    );
    assert.equal(action.rows[0].approval_status, 'expired');
  });
});

test('unhealthy employee tokens retain reads but cannot create actions, spend budget, or mutate modules', async () => {
  const app = new Hono();
  app.route('/api/mcp/v1', mcpServerV1Routes);
  const privateValue = `Unhealthy Denied Contact ${suffix}`;
  const rawKey = `unhealthy-denied-${suffix}`;
  const before = await withClient(async (client) => {
    const state = await client.query(
      `SELECT daily_action_count FROM agent_employees WHERE id = $1`,
      [EMPLOYEE_ID],
    );
    await client.query(
      `UPDATE agent_employees
       SET unhealthy = true, unhealthy_reason = 'health circuit test'
       WHERE id = $1 AND org_id = $2`,
      [EMPLOYEE_ID, ORG_ID],
    );
    return state.rows[0].daily_action_count as number;
  });

  try {
    const catalogResponse = await app.request('/api/mcp/v1/tools/list', {
      method: 'POST',
      headers: { Authorization: `Bearer ${employeeToken}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(catalogResponse.status, 200);

    const readResponse = await app.request('/api/mcp/v1/tools/call', {
      method: 'POST',
      headers: { Authorization: `Bearer ${employeeToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'module_list',
        arguments: { caller_employee_slug: EMPLOYEE_SLUG },
      }),
    });
    assert.equal(readResponse.status, 200);
    assert.notEqual((await readResponse.json() as { isError?: boolean }).isError, true);

    const writeArgs = {
      caller_employee_slug: EMPLOYEE_SLUG,
      module_id: 'com.deft.contacts',
      collection_key: 'contacts',
      data: { name: privateValue },
      expected_manifest_digest: manifestDigest,
      idempotency_key: rawKey,
    };
    const endpointWrite = await app.request('/api/mcp/v1/tools/call', {
      method: 'POST',
      headers: { Authorization: `Bearer ${employeeToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'module_record_create', arguments: writeArgs }),
    });
    assert.equal(endpointWrite.status, 200);
    const endpointDenied = await endpointWrite.json() as ToolResult;
    assert.equal(endpointDenied.isError, true);
    assert.match(endpointDenied.content[0]!.text, /unhealthy/i);

    const directWrite = await MODULE_MCP_WRITE_TOOLS.module_record_create!(
      writeArgs,
      employeeContext('standard'),
    );
    assert.equal(directWrite.isError, true);
    assert.match(directWrite.content[0]!.text, /unhealthy/i);

    await withClient(async (client) => {
      const state = await client.query(
        `SELECT daily_action_count FROM agent_employees WHERE id = $1`,
        [EMPLOYEE_ID],
      );
      assert.equal(state.rows[0].daily_action_count, before);
      const actions = await client.query(
        `SELECT count(*)::int AS count FROM agent_actions
         WHERE org_id = $1 AND agent_employee_id = $2
           AND (params->>'idempotency_key' = $3 OR params->'data'->>'name' = $4)
           AND created_at >= now() - interval '1 minute'`,
        [ORG_ID, EMPLOYEE_ID, rawKey, privateValue],
      );
      assert.equal(actions.rows[0].count, 0);
      const records = await client.query(
        `SELECT count(*)::int AS count FROM module_records
         WHERE org_id = $1 AND data->>'name' = $2`,
        [ORG_ID, privateValue],
      );
      assert.equal(records.rows[0].count, 0);
    });
  } finally {
    await withClient((client) => client.query(
      `UPDATE agent_employees
       SET unhealthy = false, unhealthy_reason = NULL
       WHERE id = $1 AND org_id = $2`,
      [EMPLOYEE_ID, ORG_ID],
    ));
  }
});

test('a healthy pending module action expires safely if the employee becomes unhealthy before approval', async () => {
  const privateValue = `Health Invalidated Pending ${suffix}`;
  const rawKey = `health-invalidated-${suffix}`;
  const queued = await MODULE_MCP_WRITE_TOOLS.module_record_create!({
    caller_employee_slug: EMPLOYEE_SLUG,
    module_id: 'com.deft.contacts',
    collection_key: 'contacts',
    data: { name: privateValue, notes: 'must be scrubbed after health invalidation' },
    expected_manifest_digest: manifestDigest,
    idempotency_key: rawKey,
  }, employeeContext('conservative'));
  const actionId = textPayload(queued).approval_id as string;
  const beforeBudget = await withClient(async (client) => {
    const action = await client.query(`SELECT * FROM agent_actions WHERE id = $1`, [actionId]);
    await syncApprovalToAttention(action.rows[0], { deliver: false });
    const state = await client.query(
      `SELECT daily_action_count FROM agent_employees WHERE id = $1`,
      [EMPLOYEE_ID],
    );
    await client.query(
      `UPDATE agent_employees
       SET unhealthy = true, unhealthy_reason = 'approval health invalidation'
       WHERE id = $1 AND org_id = $2`,
      [EMPLOYEE_ID, ORG_ID],
    );
    return state.rows[0].daily_action_count as number;
  });

  try {
    const approved = await approveAction(actionId, ADMIN_ID);
    assert.equal(approved.status, 'error');
    assert.match((approved as { message: string }).message, /unhealthy/i);
    await withClient(async (client) => {
      const action = await client.query(
        `SELECT approval_status, params, error FROM agent_actions WHERE id = $1`,
        [actionId],
      );
      assert.equal(action.rows[0].approval_status, 'expired');
      assert.match(action.rows[0].error, /unhealthy/i);
      assert.equal('data' in action.rows[0].params, false);
      assert.equal('idempotency_key' in action.rows[0].params, false);
      assert.match(action.rows[0].params.idempotency_digest, /^sha256:[a-f0-9]{64}$/);
      assert.match(action.rows[0].params.input_digest, /^sha256:[a-f0-9]{64}$/);
      assert.doesNotMatch(JSON.stringify(action.rows[0]), new RegExp(`${privateValue}|${rawKey}`));

      const receipt = await client.query(
        `SELECT decision, decision_reason, action_params_json
         FROM action_receipts WHERE action_id = $1`,
        [actionId],
      );
      assert.equal(receipt.rows.length, 1);
      assert.equal(receipt.rows[0].decision, 'expired');
      assert.match(receipt.rows[0].decision_reason, /unhealthy/i);
      assert.doesNotMatch(JSON.stringify(receipt.rows[0]), new RegExp(`${privateValue}|${rawKey}`));

      const attention = await client.query(
        `SELECT state, resolution FROM attention_items
         WHERE org_id = $1 AND source_type = 'agent_action' AND source_id = $2`,
        [ORG_ID, actionId],
      );
      assert.ok(attention.rows.length > 0);
      assert.ok(attention.rows.every((row) => row.state === 'resolved'));
      assert.ok(attention.rows.every((row) => row.resolution === 'employee_policy_invalidated'));

      const state = await client.query(
        `SELECT daily_action_count FROM agent_employees WHERE id = $1`,
        [EMPLOYEE_ID],
      );
      assert.equal(state.rows[0].daily_action_count, beforeBudget);
      const records = await client.query(
        `SELECT count(*)::int AS count FROM module_records
         WHERE org_id = $1 AND data->>'name' = $2`,
        [ORG_ID, privateValue],
      );
      assert.equal(records.rows[0].count, 0);
    });
  } finally {
    await withClient((client) => client.query(
      `UPDATE agent_employees
       SET unhealthy = false, unhealthy_reason = NULL
       WHERE id = $1 AND org_id = $2`,
      [EMPLOYEE_ID, ORG_ID],
    ));
  }
});

test('an approved-but-unexecuted module action with no durable mutation expires after health invalidation', async () => {
  const privateValue = `Uncommitted Approval Crash ${suffix}`;
  const rawKey = `uncommitted-health-crash-${suffix}`;
  const args = {
    caller_employee_slug: EMPLOYEE_SLUG,
    module_id: 'com.deft.contacts',
    collection_key: 'contacts',
    data: { name: privateValue },
    expected_manifest_digest: manifestDigest,
    idempotency_key: rawKey,
  };
  const queued = await MODULE_MCP_WRITE_TOOLS.module_record_create!(
    args,
    employeeContext('conservative'),
  );
  const actionId = textPayload(queued).approval_id as string;
  await withClient(async (client) => {
    const action = await client.query(`SELECT * FROM agent_actions WHERE id = $1`, [actionId]);
    await syncApprovalToAttention(action.rows[0], { deliver: false });
    await client.query(
      `UPDATE agent_actions
       SET approval_status = 'approved', approved_at = now(), approved_by_user_id = $2
       WHERE id = $1 AND approval_status = 'pending'`,
      [actionId, ADMIN_ID],
    );
    await client.query(
      `UPDATE agent_employees
       SET unhealthy = true, unhealthy_reason = 'post-claim crash policy change'
       WHERE id = $1 AND org_id = $2`,
      [EMPLOYEE_ID, ORG_ID],
    );
  });

  try {
    const result = await approveAction(actionId, ADMIN_ID);
    assert.equal(result.status, 'error');
    assert.match((result as { message: string }).message, /unhealthy/i);
    await withClient(async (client) => {
      const action = await client.query(
        `SELECT approval_status, approved_by_user_id, executed_at, error, params
         FROM agent_actions WHERE id = $1`,
        [actionId],
      );
      assert.equal(action.rows[0].approval_status, 'expired');
      assert.equal(action.rows[0].approved_by_user_id, ADMIN_ID);
      assert.ok(action.rows[0].executed_at);
      assert.match(action.rows[0].error, /unhealthy/i);
      assert.equal('data' in action.rows[0].params, false);
      assert.equal('idempotency_key' in action.rows[0].params, false);
      assert.doesNotMatch(JSON.stringify(action.rows[0]), new RegExp(`${privateValue}|${rawKey}`));

      const moduleReceipt = await client.query(
        `SELECT count(*)::int AS count FROM module_mutation_receipts
         WHERE org_id = $1 AND agent_action_id = $2`,
        [ORG_ID, actionId],
      );
      assert.equal(moduleReceipt.rows[0].count, 0);
      const receipt = await client.query(
        `SELECT decision, approver_id, action_params_json
         FROM action_receipts WHERE action_id = $1`,
        [actionId],
      );
      assert.equal(receipt.rows.length, 1);
      assert.equal(receipt.rows[0].decision, 'expired');
      assert.equal(receipt.rows[0].approver_id, ADMIN_ID);
      assert.doesNotMatch(JSON.stringify(receipt.rows[0]), new RegExp(`${privateValue}|${rawKey}`));
      const records = await client.query(
        `SELECT count(*)::int AS count FROM module_records
         WHERE org_id = $1 AND data->>'name' = $2`,
        [ORG_ID, privateValue],
      );
      assert.equal(records.rows[0].count, 0);
    });
  } finally {
    await withClient((client) => client.query(
      `UPDATE agent_employees
       SET unhealthy = false, unhealthy_reason = NULL
       WHERE id = $1 AND org_id = $2`,
      [EMPLOYEE_ID, ORG_ID],
    ));
  }
});

test('a committed module mutation is recovered after an approval crash even if health later invalidates', async () => {
  const privateValue = `Committed Approval Crash ${suffix}`;
  const rawKey = `committed-health-crash-${suffix}`;
  const args = {
    caller_employee_slug: EMPLOYEE_SLUG,
    module_id: 'com.deft.contacts',
    collection_key: 'contacts',
    data: { name: privateValue },
    expected_manifest_digest: manifestDigest,
    idempotency_key: rawKey,
  };
  const queued = await MODULE_MCP_WRITE_TOOLS.module_record_create!(
    args,
    employeeContext('conservative'),
  );
  const actionId = textPayload(queued).approval_id as string;
  await withClient((client) => client.query(
    `UPDATE agent_actions
     SET approval_status = 'approved', approved_at = now(), approved_by_user_id = $2
     WHERE id = $1 AND approval_status = 'pending'`,
    [actionId, ADMIN_ID],
  ));
  const committed = await createModuleRecord(employeeModuleActor({
    orgId: ORG_ID,
    employeeId: EMPLOYEE_ID,
    trustLevel: 'conservative',
    source: 'mcp',
    actionId,
  }), {
    module_id: args.module_id,
    collection_key: args.collection_key,
    data: args.data,
    expected_manifest_digest: args.expected_manifest_digest,
    idempotency_key: args.idempotency_key,
  });
  await withClient((client) => client.query(
    `UPDATE agent_employees
     SET unhealthy = true, unhealthy_reason = 'after durable module commit'
     WHERE id = $1 AND org_id = $2`,
    [EMPLOYEE_ID, ORG_ID],
  ));

  try {
    const recovered = await approveAction(actionId, ADMIN_ID);
    assert.equal(recovered.status, 'approved');
    assert.equal(
      (recovered as { result: { record_id: string } }).result.record_id,
      committed.mutation.record_id,
    );
    await withClient(async (client) => {
      const action = await client.query(
        `SELECT approval_status, executed_at, error, result, params
         FROM agent_actions WHERE id = $1`,
        [actionId],
      );
      assert.equal(action.rows[0].approval_status, 'approved');
      assert.ok(action.rows[0].executed_at);
      assert.equal(action.rows[0].error, null);
      assert.equal(action.rows[0].result.record_id, committed.mutation.record_id);
      assert.equal(action.rows[0].params.idempotency_key, undefined);
      assert.equal('data' in action.rows[0].params, false);
      const receipts = await client.query(
        `SELECT decision, approver_id FROM action_receipts WHERE action_id = $1`,
        [actionId],
      );
      assert.equal(receipts.rows.length, 1);
      assert.equal(receipts.rows[0].decision, 'approved');
      assert.equal(receipts.rows[0].approver_id, ADMIN_ID);
    });
  } finally {
    await withClient((client) => client.query(
      `UPDATE agent_employees
       SET unhealthy = false, unhealthy_reason = NULL
       WHERE id = $1 AND org_id = $2`,
      [EMPLOYEE_ID, ORG_ID],
    ));
  }
});

test('generic human search ids feed directly into fetch with read:modules only', async () => {
  const ctx = {
    org_id: ORG_ID,
    user_id: ADMIN_ID,
    role: 'owner' as const,
    scopes: ['read:modules'],
    principal_kind: 'human' as const,
  };
  const search = await humanSearch({ query: `Adapter Alice ${suffix}`, limit: 10 }, ctx);
  const hit = textPayload(search).find((item: any) => item.type === 'module_record');
  assert.ok(hit?.id?.startsWith('module_record:'));
  const fetched = await humanFetch({ id: hit.id }, ctx);
  assert.equal(textPayload(fetched).resource_id, hit.id);
});

test('generic approval tools cannot bypass explicit module scopes', async () => {
  const privateValue = `Scoped Approval Contact ${suffix}`;
  const actionId = randomUUID();
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO agent_actions
        (id, org_id, user_id, source, action, params, approval_tier, approval_status)
       VALUES ($1, $2, $3, 'mcp', 'module_record_create', $4::jsonb, 'quick', 'pending')`,
      [
        actionId,
        ORG_ID,
        ADMIN_ID,
        JSON.stringify({
          module_id: 'com.deft.contacts',
          collection_key: 'contacts',
          data: { name: privateValue },
          expected_manifest_digest: manifestDigest,
          idempotency_key: `scope-approval-${suffix}`,
        }),
      ],
    );
  });

  const workspaceOnly = {
    org_id: ORG_ID,
    user_id: ADMIN_ID,
    role: 'owner' as const,
    scopes: ['read:workspace', 'write:workspace'],
    principal_kind: 'human' as const,
  };
  const hiddenList = await humanApprovalList({ status: 'pending' }, workspaceOnly);
  assert.notEqual(hiddenList.isError, true);
  assert.equal(JSON.stringify(textPayload(hiddenList)).includes(actionId), false);
  assert.equal((await humanApprovalGet({ action_id: actionId }, workspaceOnly)).isError, true);
  assert.equal((await humanApprovalApprove({ action_id: actionId }, workspaceOnly)).isError, true);

  const readOnlyModules = {
    ...workspaceOnly,
    scopes: [...workspaceOnly.scopes, 'read:modules'],
  };
  const visible = await humanApprovalGet({ action_id: actionId }, readOnlyModules);
  assert.notEqual(visible.isError, true);
  assert.equal(JSON.stringify(textPayload(visible)).includes(privateValue), true);
  assert.equal((await humanApprovalApprove({ action_id: actionId }, readOnlyModules)).isError, true);

  const fullModuleScopes = {
    ...readOnlyModules,
    scopes: [...readOnlyModules.scopes, 'write:modules'],
  };
  const approved = await humanApprovalApprove({ action_id: actionId }, fullModuleScopes);
  assert.notEqual(approved.isError, true);
  assert.equal(textPayload(approved).status, 'approved');
});

test('employee catalogs retain governed writes and personal calls receive audit parity', async () => {
  const app = new Hono();
  app.route('/api/mcp/v1', mcpServerV1Routes);
  const employeeList = await app.request('/api/mcp/v1/tools/list', {
    method: 'POST',
    headers: { Authorization: `Bearer ${employeeToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(employeeList.status, 200);
  const employeeCatalog = await employeeList.json() as { tools: Array<{ name: string }> };
  assert.ok(employeeCatalog.tools.some((tool) => tool.name === 'module_record_create'));
  assert.ok(employeeCatalog.tools.some((tool) => tool.name === 'module_record_archive'));

  const humanCall = await app.request('/api/mcp/v1/tools/call', {
    method: 'POST',
    headers: { Authorization: `Bearer ${personalToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'module_list', arguments: {} }),
  });
  assert.equal(humanCall.status, 200);
  assert.notEqual((await humanCall.json() as { isError?: boolean }).isError, true);

  const privateIdempotencyKey = `personal-private-${suffix}`;
  const privateName = `Personal MCP Contact ${suffix}`;
  const humanWrite = await app.request('/api/mcp/v1/tools/call', {
    method: 'POST',
    headers: { Authorization: `Bearer ${personalToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'module_record_create',
      arguments: {
        module_id: 'com.deft.contacts',
        collection_key: 'contacts',
        data: { name: privateName, notes: 'personal MCP private note' },
        expected_manifest_digest: manifestDigest,
        idempotency_key: privateIdempotencyKey,
      },
    }),
  });
  assert.equal(humanWrite.status, 200);
  const humanWriteResult = await humanWrite.json() as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  assert.notEqual(humanWriteResult.isError, true);
  assert.equal(JSON.stringify(humanWriteResult).includes(privateName), false);
  await withClient(async (client) => {
    const audit = await client.query(
      `SELECT metadata FROM oauth_audit_events
       WHERE org_id = $1 AND user_id = $2 AND event = 'mcp_tool_call'
         AND client_id LIKE 'personal-token:%'
         AND metadata->>'tool_name' = 'module_list'
       ORDER BY created_at DESC LIMIT 1`,
      [ORG_ID, ADMIN_ID],
    );
    assert.equal(audit.rows[0]?.metadata?.tool_name, 'module_list');
    assert.equal(audit.rows[0]?.metadata?.principal_kind, 'human');

    const writeAudit = await client.query(
      `SELECT metadata FROM oauth_audit_events
       WHERE org_id = $1 AND user_id = $2 AND event = 'mcp_tool_call'
         AND client_id LIKE 'personal-token:%'
         AND metadata->>'tool_name' = 'module_record_create'
       ORDER BY created_at DESC LIMIT 1`,
      [ORG_ID, ADMIN_ID],
    );
    assert.equal(writeAudit.rows[0]?.metadata?.idempotency_key, null);
    assert.match(
      writeAudit.rows[0]?.metadata?.idempotency_digest,
      /^sha256:[a-f0-9]{64}$/,
    );
    assert.equal(JSON.stringify(writeAudit.rows[0].metadata).includes(privateIdempotencyKey), false);
    assert.equal(JSON.stringify(writeAudit.rows[0].metadata).includes(privateName), false);
  });
});
