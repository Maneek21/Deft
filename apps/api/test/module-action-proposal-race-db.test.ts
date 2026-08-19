import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import pg from 'pg';

import {
  agentModuleActionClaimKey,
  agentModuleActionIdempotencyDigest,
} from '../src/lib/agent-actions.js';
import { persistAgentReplyWithActions } from '../src/lib/agent-action-proposals.js';
import { closeDb } from '../src/lib/db.js';
import {
  humanModuleActor,
  installBundledModule,
  updateModuleInstallation,
} from '../src/lib/module-service.js';

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
const ORG_ID = `module-proposal-race-org-${suffix}`;
const OWNER_ID = `module-proposal-race-owner-${suffix}`;
const AGENT_USER_ID = `module-proposal-race-agent-${suffix}`;
const SPACE_ID = `module-proposal-race-space-${suffix}`;

let manifestDigest = '';
let client: pg.Client | null = null;

const adminActor = humanModuleActor({
  orgId: ORG_ID,
  userId: OWNER_ID,
  role: 'owner',
});

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
    throw new Error(`Timed out waiting for the proposal transaction behind pid ${blockingPid}`);
  } finally {
    await observer.end();
  }
}

async function assertSecretAbsent(rawSecret: string, rawIdempotencyKey: string): Promise<void> {
  assert.ok(client);
  const surfaces = await client.query(
    `SELECT surface, hits
     FROM (
       SELECT 'agent_actions' AS surface, count(*)::int AS hits
       FROM agent_actions row_value
       WHERE org_id = $1
         AND (row_to_json(row_value)::text LIKE '%' || $2 || '%'
           OR row_to_json(row_value)::text LIKE '%' || $3 || '%')
       UNION ALL
       SELECT 'messages', count(*)::int
       FROM messages row_value
       WHERE org_id = $1
         AND (row_to_json(row_value)::text LIKE '%' || $2 || '%'
           OR row_to_json(row_value)::text LIKE '%' || $3 || '%')
       UNION ALL
       SELECT 'attention_items', count(*)::int
       FROM attention_items row_value
       WHERE org_id = $1
         AND (row_to_json(row_value)::text LIKE '%' || $2 || '%'
           OR row_to_json(row_value)::text LIKE '%' || $3 || '%')
       UNION ALL
       SELECT 'action_receipts', count(*)::int
       FROM action_receipts row_value
       WHERE org_id = $1
         AND (row_to_json(row_value)::text LIKE '%' || $2 || '%'
           OR row_to_json(row_value)::text LIKE '%' || $3 || '%')
       UNION ALL
       SELECT 'module_mutation_receipts', count(*)::int
       FROM module_mutation_receipts row_value
       WHERE org_id = $1
         AND (row_to_json(row_value)::text LIKE '%' || $2 || '%'
           OR row_to_json(row_value)::text LIKE '%' || $3 || '%')
       UNION ALL
       SELECT 'module_records', count(*)::int
       FROM module_records row_value
       WHERE org_id = $1
         AND (row_to_json(row_value)::text LIKE '%' || $2 || '%'
           OR row_to_json(row_value)::text LIKE '%' || $3 || '%')
       UNION ALL
       SELECT 'audit_log', count(*)::int
       FROM audit_log row_value
       WHERE org_id = $1
         AND (row_to_json(row_value)::text LIKE '%' || $2 || '%'
           OR row_to_json(row_value)::text LIKE '%' || $3 || '%')
     ) persisted_surfaces
     ORDER BY surface`,
    [ORG_ID, rawSecret, rawIdempotencyKey],
  );
  assert.ok(surfaces.rows.length > 0);
  assert.ok(
    surfaces.rows.every((surface) => surface.hits === 0),
    `raw proposal data leaked: ${JSON.stringify(surfaces.rows)}`,
  );
}

async function assertLifecycleChangeWins(input: {
  label: string;
  lifecycleChange: { enabled: false } | { agent_access: 'read' };
}) {
  assert.ok(TEST_DATABASE_URL && client);
  const blocker = new pg.Client({ connectionString: TEST_DATABASE_URL });
  const rawSecret = `raw-${input.label}-secret-${suffix}`;
  const rawIdempotencyKey = `raw-${input.label}-key-${suffix}`;
  const proposalParams = {
    module_id: 'com.deft.contacts',
    collection_key: 'contacts',
    data: {
      name: `Boundary ${input.label} ${suffix}`,
      notes: rawSecret,
    },
    expected_manifest_digest: manifestDigest,
    idempotency_key: rawIdempotencyKey,
  };
  const digest = await agentModuleActionIdempotencyDigest(
    'module_record_create',
    proposalParams,
    ORG_ID,
    OWNER_ID,
  );
  assert.ok(digest);
  const claimKey = agentModuleActionClaimKey(ORG_ID, 'module_record_create', digest);

  let blockerTransactionOpen = false;
  let persistence: ReturnType<typeof persistAgentReplyWithActions> | undefined;
  await blocker.connect();
  try {
    await blocker.query('BEGIN');
    blockerTransactionOpen = true;
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [claimKey]);
    const blockerPid = await blocker.query('SELECT pg_backend_pid()::int AS pid');

    persistence = persistAgentReplyWithActions({
      orgId: ORG_ID,
      spaceId: SPACE_ID,
      userId: OWNER_ID,
      agentUserId: AGENT_USER_ID,
      content: `The ${input.label} module proposal was not persisted.`,
      metadata: {
        source: 'module-proposal-race-test',
        pending_actions: [{ action: 'module_record_create', params: proposalParams }],
        action_graph: {
          actions: [{
            id: `proposal-${input.label}`,
            tool: 'module_record_create',
            params: proposalParams,
          }],
        },
      },
      pendingActions: [{
        action: 'module_record_create',
        params: proposalParams,
        approval_tier: 'quick',
        source: 'agent_chat',
      }],
    });

    // This proves the initial preflight passed and the proposal reached the
    // transaction boundary, where it is deliberately paused before the
    // installation-row FOR UPDATE preflight.
    await waitForSessionBlockedBy(blockerPid.rows[0].pid as number);

    const changed = await updateModuleInstallation(adminActor, 'contacts', input.lifecycleChange);
    if ('enabled' in input.lifecycleChange) assert.equal(changed.enabled, false);
    else assert.equal(changed.agent_access, 'read');

    await blocker.query('COMMIT');
    blockerTransactionOpen = false;

    const persisted = await persistence;
    assert.deepEqual(persisted.actions, []);
    assert.deepEqual(persisted.duplicates, []);
    assert.deepEqual(
      (persisted.message.metadata as Record<string, unknown>).rejected_module_actions,
      ['module_record_create'],
    );
    assert.equal(
      (persisted.message.metadata as Record<string, unknown>).pending_actions,
      undefined,
    );
    assert.equal(JSON.stringify(persisted.message).includes(rawSecret), false);
    assert.equal(JSON.stringify(persisted.message).includes(rawIdempotencyKey), false);

    const durable = await client.query(
      `SELECT
         (SELECT count(*)::int FROM agent_actions
          WHERE org_id = $1 AND action = 'module_record_create') AS actions,
         (SELECT count(*)::int FROM module_records
          WHERE org_id = $1 AND data->>'name' = $2) AS records,
         (SELECT count(*)::int FROM messages
          WHERE id = $3 AND org_id = $1
            AND metadata->'rejected_module_actions' @> '["module_record_create"]'::jsonb) AS rejection_messages`,
      [ORG_ID, proposalParams.data.name, persisted.message.id],
    );
    assert.deepEqual(durable.rows[0], {
      actions: 0,
      records: 0,
      rejection_messages: 1,
    });
    await assertSecretAbsent(rawSecret, rawIdempotencyKey);
  } finally {
    if (blockerTransactionOpen) await blocker.query('ROLLBACK').catch(() => undefined);
    await blocker.end();
    if (persistence) await persistence.catch(() => undefined);
    await updateModuleInstallation(adminActor, 'contacts', {
      enabled: true,
      agent_access: 'write',
    }).catch(() => undefined);
  }
}

before(async () => {
  if (!canRun || !TEST_DATABASE_URL) return;
  client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  await client.query(
    `INSERT INTO orgs (id, name, slug)
     VALUES ($1, 'Module proposal race', $2)`,
    [ORG_ID, `module-proposal-race-${suffix}`],
  );
  await client.query(
    `INSERT INTO users (id, email, name, is_agent, email_verified)
     VALUES ($1, $2, 'Module Proposal Owner', false, true),
            ($3, NULL, 'Defty Proposal Agent', true, true)`,
    [OWNER_ID, `module-proposal-owner-${suffix}@test.local`, AGENT_USER_ID],
  );
  await client.query(
    `INSERT INTO org_members (id, org_id, user_id, role, is_active)
     VALUES ($1, $2, $3, 'owner', true)`,
    [`module-proposal-race-member-${suffix}`, ORG_ID, OWNER_ID],
  );
  await client.query(
    `INSERT INTO spaces (id, org_id, name, type, created_by)
     VALUES ($1, $2, 'Module proposal race', 'public', $3)`,
    [SPACE_ID, ORG_ID, OWNER_ID],
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
    await client.query('DELETE FROM spaces WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM org_members WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM users WHERE id = ANY($1::text[])', [[OWNER_ID, AGENT_USER_ID]]);
    await client.query('DELETE FROM orgs WHERE id = $1', [ORG_ID]);
    await client.end();
  }
  await closeDb();
});

test(
  'transaction-bound reply preflight rejects after concurrent module disable wins',
  { skip: !canRun && !ciRequiresDatabase },
  async () => {
    assert.ok(
      canRun && TEST_DATABASE_URL,
      'CI must provide a DEFT_TEST_DATABASE_URL (or DATABASE_URL) whose database name contains test, ci, or acceptance',
    );
    await assertLifecycleChangeWins({ label: 'disable', lifecycleChange: { enabled: false } });
  },
);

test(
  'transaction-bound reply preflight rejects after concurrent module write revoke wins',
  { skip: !canRun && !ciRequiresDatabase },
  async () => {
    assert.ok(
      canRun && TEST_DATABASE_URL,
      'CI must provide a DEFT_TEST_DATABASE_URL (or DATABASE_URL) whose database name contains test, ci, or acceptance',
    );
    await assertLifecycleChangeWins({ label: 'write-revoke', lifecycleChange: { agent_access: 'read' } });
  },
);
