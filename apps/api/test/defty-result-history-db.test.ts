import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';

import { handleAgentReply } from '../src/workers/handlers/agent-reply.js';
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

for (const type of ['public', 'group_dm']) {
  test(`${type} room pack retains authorized durable module result identities`, { skip: !canRun }, async () => {
    assert.ok(client && app);
    await client.query('UPDATE spaces SET type=$1 WHERE id=$2', [type, SPACE_ID]);
    const pending = await insertPendingCreate(null);
    assert.equal((await app.request(`/api/agent/actions/${pending.actionId}/approve`, { method: 'POST' })).status, 200);
    const stored = (await client.query(`SELECT id, metadata FROM messages WHERE org_id=$1 AND metadata->>'approval_execution_result_for_action_id'=$2`, [ORG_ID, pending.actionId])).rows[0];
    const recordId = stored.metadata.approval_execution_result.record_id;
    await client.query('UPDATE messages SET parent_id=$1 WHERE id=$2', [pending.sourceMessageId, stored.id]);
    const triggerId = randomUUID();
    await client.query('INSERT INTO messages(id,org_id,space_id,user_id,content,parent_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [triggerId,ORG_ID,SPACE_ID,OWNER_ID,'What record did you just create?',pending.sourceMessageId,new Date(Date.now()+1000)]);
    let captured: any;
    const runQuery = async (input: any) => {
      captured = input;
      return { text:'I created that record.', pendingActions:[], executedActions:[], citations:[], assistantBlocks:[], model:'stub', tokensIn:0, tokensOut:0 };
    };
    const job = {id:randomUUID(),name:'agent-reply',attempts:1,data:{orgId:ORG_ID,spaceId:SPACE_ID,userId:OWNER_ID,messageId:triggerId,parentId:pending.sourceMessageId,content:'What record did you just create?',orgName:'History test'}};
    await handleAgentReply(job, {runQuery:runQuery as any});
    assert.ok(captured);
    assert.ok(captured.untrustedContextSections.join('\n').includes(recordId), 'authorized durable result must survive room-pack replacement');
    assert.doesNotMatch(captured.untrustedContextSections.join('\n'), new RegExp(`private-${pending.marker}|private-retry`));
    await updateModuleInstallation(ownerActor, 'contacts', { enabled:false });
    captured = undefined;
    const deniedId = randomUUID();
    await client.query('INSERT INTO messages(id,org_id,space_id,user_id,content,parent_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [deniedId,ORG_ID,SPACE_ID,OWNER_ID,'What record did you just create?',pending.sourceMessageId,new Date(Date.now()+2000)]);
    await handleAgentReply({...job,data:{...job.data,messageId:deniedId}}, {runQuery:runQuery as any});
    assert.ok(captured);
    assert.equal(captured.untrustedContextSections.join('\n').includes(recordId),false,'revoking module access must remove durable identifiers');
    await updateModuleInstallation(ownerActor, 'contacts', {enabled:true});
  });
}
