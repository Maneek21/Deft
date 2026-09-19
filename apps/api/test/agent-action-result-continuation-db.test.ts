import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';

import { closeDb } from '../src/lib/db.js';
import {
  authorizedDurableAgentResult,
  durableAgentResultWorkerHistory,
  normalizeAgentToolHistory,
} from '../src/lib/agent-tool-history.js';
import {
  humanModuleActor,
  installBundledModule,
  updateModuleInstallation,
} from '../src/lib/module-service.js';
import { sanitizeAgentMetadataForStorage } from '../src/lib/module-agent-history.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const TEST_DATABASE_URL = safeTestDatabaseUrl();
const canRun = Boolean(TEST_DATABASE_URL);
const ciRequiresDatabase = /^(?:1|true)$/i.test(process.env.CI ?? '');
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ORG_ID = `action-result-history-org-${suffix}`;
const OWNER_ID = `action-result-history-owner-${suffix}`;
const AGENT_USER_ID = `action-result-history-agent-${suffix}`;
const SPACE_ID = `action-result-history-space-${suffix}`;

let client: pg.Client | null = null;
let app: Hono | null = null;
let manifestDigest = '';

const ownerActor = humanModuleActor({
  orgId: ORG_ID,
  userId: OWNER_ID,
  role: 'owner',
});

async function insertPendingCreate(toolUseId: string | null) {
  assert.ok(client);
  const marker = `${toolUseId ?? 'compiler'}-${suffix}`;
  const source = await client.query<{ id: string }>(
    `INSERT INTO messages (id, org_id, space_id, user_id, content, metadata)
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5::jsonb)
     RETURNING id`,
    [
      ORG_ID,
      SPACE_ID,
      AGENT_USER_ID,
      `Prepared ${marker} for approval.`,
      JSON.stringify(toolUseId ? {
        hidden: true,
        agent_blocks: [{
          type: 'tool_use',
          id: toolUseId,
          name: 'module_record_create',
          input: {
            module_id: 'com.deft.contacts',
            collection_key: 'contacts',
            changed_fields: ['email', 'name'],
          },
        }],
      } : {}),
    ],
  );
  const action = await client.query<{ id: string }>(
    `INSERT INTO agent_actions
      (id, org_id, user_id, conversation_id, message_id, tool_use_id, source,
       action, params, approval_tier, approval_status)
     VALUES
      (gen_random_uuid()::text, $1, $2, $3, $4, $5, 'mention',
       'module_record_create', $6::jsonb, 'quick', 'pending')
     RETURNING id`,
    [
      ORG_ID,
      OWNER_ID,
      SPACE_ID,
      source.rows[0]!.id,
      toolUseId,
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
  return { actionId: action.rows[0]!.id, sourceMessageId: source.rows[0]!.id, marker };
}

before(async () => {
  if (!canRun || !TEST_DATABASE_URL) return;
  client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  await client.query(
    `INSERT INTO orgs (id, name, slug) VALUES ($1, 'Action result history', $2)`,
    [ORG_ID, `action-result-history-${suffix}`],
  );
  await client.query(
    `INSERT INTO users (id, email, name, is_agent, email_verified)
     VALUES ($1, $2, 'Action Result Owner', false, true),
            ($3, NULL, 'Action Result Agent', true, true)`,
    [OWNER_ID, `action-result-owner-${suffix}@test.local`, AGENT_USER_ID],
  );
  await client.query(
    `INSERT INTO org_members (id, org_id, user_id, role, is_active)
     VALUES ($1, $2, $3, 'owner', true)`,
    [`action-result-member-${suffix}`, ORG_ID, OWNER_ID],
  );
  await client.query(
    `INSERT INTO spaces (id, org_id, name, type, created_by)
     VALUES ($1, $2, 'Action result history', 'agent_conversation', $3)`,
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
      email: `action-result-owner-${suffix}@test.local`,
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

test(
  'approved Module writes become one authorized durable result for native and worker continuation',
  { skip: !canRun && !ciRequiresDatabase },
  async () => {
    assert.ok(
      canRun && TEST_DATABASE_URL && client && app,
      'CI must provide matching DEFT_TEST_DATABASE_URL and runtime DATABASE_URL for a disposable PostgreSQL database',
    );

    const compiler = await insertPendingCreate(null);
    const approved = await app.request(`/api/agent/actions/${compiler.actionId}/approve`, { method: 'POST' });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json() as { status: string }).status, 'approved');
    assert.equal((await app.request(`/api/agent/actions/${compiler.actionId}/approve`, { method: 'POST' })).status, 200);

    let compilerHistory = await client.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM messages
       WHERE org_id = $1 AND space_id = $2
         AND metadata->>'approval_execution_result_for_action_id' = $3`,
      [ORG_ID, SPACE_ID, compiler.actionId],
    );
    assert.equal(compilerHistory.rowCount, 1, 'repeated approval must not duplicate continuation facts');

    await client.query(
      `DELETE FROM messages
       WHERE org_id = $1 AND space_id = $2
         AND metadata->>'approval_execution_result_for_action_id' = $3`,
      [ORG_ID, SPACE_ID, compiler.actionId],
    );
    assert.equal(
      (await app.request(`/api/agent/actions/${compiler.actionId}/approve`, { method: 'POST' })).status,
      200,
    );
    compilerHistory = await client.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM messages
       WHERE org_id = $1 AND space_id = $2
         AND metadata->>'approval_execution_result_for_action_id' = $3`,
      [ORG_ID, SPACE_ID, compiler.actionId],
    );
    assert.equal(
      compilerHistory.rowCount,
      1,
      'an idempotent approval retry must repair missing result context from the terminal action row',
    );
    const compilerMetadata = compilerHistory.rows[0]!.metadata;
    const authorizedCompilerResult = await authorizedDurableAgentResult({
      actor: ownerActor,
      orgId: ORG_ID,
      conversationId: SPACE_ID,
      metadata: compilerMetadata,
    });
    assert.equal(authorizedCompilerResult?.operation, 'module_record_create');
    assert.match(authorizedCompilerResult?.resource_id ?? '', /^module_record:/);
    const workerHistory = durableAgentResultWorkerHistory(compilerMetadata);
    assert.match(workerHistory ?? '', new RegExp(authorizedCompilerResult!.record_id));
    assert.match(workerHistory ?? '', /check the latest record revision/i);
    assert.doesNotMatch(JSON.stringify(compilerMetadata), new RegExp(`private-${compiler.marker}|private-retry`));

    assert.equal(await authorizedDurableAgentResult({
      actor: ownerActor,
      orgId: ORG_ID,
      conversationId: SPACE_ID,
      metadata: {
        ...compilerMetadata,
        approval_execution_result_for_action_id: randomUUID(),
      },
    }), null, 'caller-supplied metadata cannot manufacture a completion fact');

    const toolUseId = `module-create-${suffix}`;
    const linked = await insertPendingCreate(toolUseId);
    assert.equal((await app.request(`/api/agent/actions/${linked.actionId}/approve`, { method: 'POST' })).status, 200);
    const linkedRows = await client.query<{
      source_blocks: unknown[];
      result_metadata: Record<string, unknown>;
    }>(
      `SELECT source.metadata->'agent_blocks' AS source_blocks,
              result.metadata AS result_metadata
       FROM messages source
       JOIN messages result ON result.org_id = source.org_id AND result.space_id = source.space_id
       WHERE source.id = $1
         AND result.metadata->>'approval_execution_result_for_action_id' = $2`,
      [linked.sourceMessageId, linked.actionId],
    );
    assert.equal(linkedRows.rowCount, 1);
    const authorizedLinkedResult = await authorizedDurableAgentResult({
      actor: ownerActor,
      orgId: ORG_ID,
      conversationId: SPACE_ID,
      metadata: linkedRows.rows[0]!.result_metadata,
    });
    assert.ok(authorizedLinkedResult);
    const toolNames = new Map<string, string>();
    const rehydratedSource = sanitizeAgentMetadataForStorage(
      { agent_blocks: linkedRows.rows[0]!.source_blocks },
      toolNames,
    ).agent_blocks;
    const rehydratedResult = sanitizeAgentMetadataForStorage(
      linkedRows.rows[0]!.result_metadata,
      toolNames,
      authorizedLinkedResult,
    ).agent_blocks;
    const normalized = normalizeAgentToolHistory([
      { role: 'assistant', content: rehydratedSource as never },
      { role: 'user', content: rehydratedResult as never },
    ]);
    assert.equal(normalized.length, 2);
    const resultBlocks = normalized[1]!.content as Array<Record<string, unknown>>;
    assert.equal(resultBlocks[0]?.type, 'tool_result');
    assert.equal(resultBlocks[0]?.tool_use_id, toolUseId);
    assert.equal(JSON.parse(String(resultBlocks[0]?.content)).operation, 'module_record_create');
    assert.doesNotMatch(JSON.stringify(resultBlocks), new RegExp(`private-${linked.marker}|private-retry`));

    await updateModuleInstallation(ownerActor, 'contacts', { enabled: false });
    assert.equal(await authorizedDurableAgentResult({
      actor: ownerActor,
      orgId: ORG_ID,
      conversationId: SPACE_ID,
      metadata: compilerMetadata,
    }), null, 'disabled Module state must remove historical identifiers from model context');
  },
);
