import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';

import { handleAgentReply } from '../src/workers/handlers/agent-reply.js';
import { closeDb } from '../src/lib/db.js';
import {
  humanModuleActor,
  installBundledModule,
  updateModuleInstallation,
} from '../src/lib/module-service.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const TEST_DATABASE_URL = safeTestDatabaseUrl();
const canRun = Boolean(TEST_DATABASE_URL);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ORG_ID = `room-pack-result-org-${suffix}`;
const OWNER_ID = `room-pack-result-owner-${suffix}`;
const AGENT_USER_ID = `room-pack-result-agent-${suffix}`;
const SPACE_ID = `room-pack-result-space-${suffix}`;

let client: pg.Client | null = null;
let app: Hono | null = null;
let manifestDigest = '';

const ownerActor = humanModuleActor({
  orgId: ORG_ID,
  userId: OWNER_ID,
  role: 'owner',
});

async function insertPendingCreate() {
  assert.ok(client);
  const marker = suffix;
  const source = await client.query<{ id: string }>(
    `INSERT INTO messages (id, org_id, space_id, user_id, content, metadata)
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, '{}'::jsonb)
     RETURNING id`,
    [ORG_ID, SPACE_ID, AGENT_USER_ID, `Prepared contact ${marker} for approval.`],
  );
  const action = await client.query<{ id: string }>(
    `INSERT INTO agent_actions
      (id, org_id, user_id, conversation_id, message_id, source,
       action, params, approval_tier, approval_status)
     VALUES
      (gen_random_uuid()::text, $1, $2, $3, $4, 'mention',
       'module_record_create', $5::jsonb, 'quick', 'pending')
     RETURNING id`,
    [
      ORG_ID,
      OWNER_ID,
      SPACE_ID,
      source.rows[0]!.id,
      JSON.stringify({
        module_id: 'com.deft.contacts',
        collection_key: 'contacts',
        data: {
          name: `Continuation ${marker}`,
          email: `private-${marker}@example.test`,
        },
        relations: {},
        expected_manifest_digest: manifestDigest,
        idempotency_key: `private-retry-${marker}`,
      }),
    ],
  );
  return {
    actionId: action.rows[0]!.id,
    sourceMessageId: source.rows[0]!.id,
    marker,
  };
}

async function askWhatWasCreated() {
  assert.ok(client);
  const triggerId = randomUUID();
  await client.query(
    `INSERT INTO messages(id,org_id,space_id,user_id,content,parent_id,created_at)
     VALUES($1,$2,$3,$4,$5,NULL,$6)`,
    [triggerId, ORG_ID, SPACE_ID, OWNER_ID, 'What record did you just create?', new Date()],
  );
  let captured: any;
  const runQuery = async (input: any) => {
    captured = input;
    return {
      text: 'I created that record.', pendingActions: [], executedActions: [], citations: [],
      assistantBlocks: [], model: 'stub', tokensIn: 0, tokensOut: 0,
    };
  };
  const job = {
    id: randomUUID(), name: 'agent-reply', attempts: 1,
    data: {
      orgId: ORG_ID, spaceId: SPACE_ID, userId: OWNER_ID, messageId: triggerId,
      content: 'What record did you just create?', orgName: 'Room pack result history',
    },
  };
  await handleAgentReply(job, { runQuery: runQuery as any });
  assert.ok(captured, 'the reply handler must reach the runner');
  return captured;
}

before(async () => {
  if (!canRun || !TEST_DATABASE_URL) return;
  client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  await client.query(
    `INSERT INTO orgs (id, name, slug) VALUES ($1, 'Room pack result history', $2)`,
    [ORG_ID, `room-pack-result-${suffix}`],
  );
  await client.query(
    `INSERT INTO users (id, email, name, is_agent, email_verified)
     VALUES ($1, $2, 'Room Pack Owner', false, true),
            ($3, NULL, 'Room Pack Agent', true, true)`,
    [OWNER_ID, `room-pack-owner-${suffix}@test.local`, AGENT_USER_ID],
  );
  await client.query(
    `INSERT INTO org_members (id, org_id, user_id, role, is_active)
     VALUES ($1, $2, $3, 'owner', true)`,
    [`room-pack-member-${suffix}`, ORG_ID, OWNER_ID],
  );
  await client.query(
    `INSERT INTO spaces (id, org_id, name, type, created_by)
     VALUES ($1, $2, 'Room pack result history', 'public', $3)`,
    [SPACE_ID, ORG_ID, OWNER_ID],
  );
  await client.query(
    `INSERT INTO space_members (id, space_id, user_id)
     VALUES (gen_random_uuid()::text, $1, $2), (gen_random_uuid()::text, $1, $3)`,
    [SPACE_ID, OWNER_ID, AGENT_USER_ID],
  );
  const installed = await installBundledModule(ownerActor, 'contacts');
  manifestDigest = installed.manifest_digest;
  await updateModuleInstallation(ownerActor, 'contacts', { agent_access: 'write' });

  const { agentRoutes } = await import('../src/routes/agent.js');
  app = new Hono();
  app.use('*', async (context, next) => {
    context.set('user', {
      id: OWNER_ID,
      email: `room-pack-owner-${suffix}@test.local`,
      org_id: ORG_ID,
      role: 'owner',
    } as never);
    await next();
  });
  app.route('/api/agent', agentRoutes);
});

after(async () => {
  if (client) {
    await client.query('DELETE FROM attention_items WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM action_receipts WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM module_mutation_receipts WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM agent_actions WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM messages WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM module_record_relations WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM module_records WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM module_versions WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM module_installations WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM audit_log WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM space_members WHERE space_id = $1', [SPACE_ID]);
    await client.query('DELETE FROM spaces WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM org_members WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM users WHERE id = ANY($1::text[])', [[OWNER_ID, AGENT_USER_ID]]);
    await client.query('DELETE FROM orgs WHERE id = $1', [ORG_ID]);
    await client.end();
  }
  await closeDb();
});

for (const type of ['public', 'private']) {
  test(`${type} channel room pack keeps authorized durable result history for a top-level follow-up`, { skip: !canRun }, async () => {
    assert.ok(client && app);
    await client.query('UPDATE spaces SET type=$1 WHERE id=$2', [type, SPACE_ID]);
    const pending = await insertPendingCreate();
    assert.equal((await app.request(`/api/agent/actions/${pending.actionId}/approve`, { method: 'POST' })).status, 200);
    const stored = (await client.query(
      `SELECT id, parent_id, metadata FROM messages
       WHERE org_id=$1 AND metadata->>'approval_execution_result_for_action_id'=$2`,
      [ORG_ID, pending.actionId],
    )).rows[0];
    assert.equal(stored.parent_id, null, 'a top-level request produces a top-level result');
    const recordId = stored.metadata.approval_execution_result.record_id;

    const captured = await askWhatWasCreated();
    const context = captured.untrustedContextSections.join('\n');
    assert.ok(context.includes('Conversation in this channel'), 'the room pack must be used for a channel follow-up');
    assert.ok(context.includes(recordId), 'authorized durable result must reach the runner from the room pack');
    assert.doesNotMatch(context, new RegExp(`private-${pending.marker}|private-retry`));

    await updateModuleInstallation(ownerActor, 'contacts', { enabled: false });
    const denied = await askWhatWasCreated();
    assert.equal(denied.untrustedContextSections.join('\n').includes(recordId), false,
      'revoking module access must remove durable identifiers from the room pack');
    await updateModuleInstallation(ownerActor, 'contacts', { enabled: true });
  });
}
