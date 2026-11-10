import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import pg from 'pg';
import { closeDb } from '../src/lib/db.js';
import { handleAgentReply } from '../src/workers/handlers/agent-reply.js';
import {
  humanModuleActor,
  installBundledModule,
  updateModuleInstallation,
  createModuleRecord,
} from '../src/lib/module-service.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const orgId = randomUUID(), ownerId = randomUUID();
let client: pg.Client | undefined;
let unavailable: string | undefined;
let ready = false;
let manifestDigest = '';
let lakeviewDealId = '';
let lakeviewRevision = 1;
const suffix = randomUUID();
const result = (text: string, pendingActions: any[] = []) => ({ text, pendingActions, executedActions: [], citations: [], assistantBlocks: [], model: 'stub', tokensIn: 0, tokensOut: 0 });

before(async () => {
  if (!url) return;
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try { await client.connect(); } catch (error) { unavailable = String(error); return; }
  await client.query('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [orgId, 'CRM Multi', `crm-multi-${suffix}`]);
  await client.query('INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,$3,\'human\',false)', [ownerId, `${ownerId}@example.test`, 'Owner']);
  await client.query('INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,\'owner\')', [randomUUID(), orgId, ownerId]);
  const admin = humanModuleActor({ orgId, userId: ownerId, role: 'owner' });
  const installation = await installBundledModule(admin, 'contacts');
  manifestDigest = installation.manifest_digest;
  await updateModuleInstallation(admin, 'contacts', { agent_access: 'write' });
  const deal = await createModuleRecord(admin, {
    module_id: 'com.deft.contacts',
    collection_key: 'deals',
    data: { name: 'Lakeview', stage: 'lead', value: 5000, currency: 'usd' },
    expected_manifest_digest: manifestDigest,
    idempotency_key: randomUUID(),
  });
  lakeviewDealId = deal.record!.id;
  lakeviewRevision = deal.record!.revision;
  ready = true;
});

after(async () => {
  if (ready && client) {
    await client.query('DELETE FROM attention_items WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM action_receipts WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM module_mutation_receipts WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM agent_actions WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM messages WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM module_record_relations WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM module_records WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM module_versions WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM module_installations WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM audit_log WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id=$1)', [orgId]);
    await client.query('DELETE FROM spaces WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM org_members WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM orgs WHERE id=$1', [orgId]);
    await client.query('DELETE FROM users WHERE id=$1', [ownerId]);
  }
  await client?.end().catch(() => undefined);
  await closeDb();
});

async function space() {
  const id = randomUUID();
  await client!.query('INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$3,\'public\',$4)', [id, orgId, `room-${id}`, ownerId]);
  await client!.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), id, ownerId]);
  return id;
}
async function message(spaceId: string, content: string) {
  const id = randomUUID();
  await client!.query('INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,$5)', [id, orgId, spaceId, ownerId, content]);
  return id;
}
function job(spaceId: string, messageId: string, content: string) {
  return { id: randomUUID(), name: 'agent-reply', attempts: 1, data: { orgId, spaceId, messageId, parentId: undefined, userId: ownerId, orgName: 'CRM Multi', content } };
}
async function runTurn(content: string) {
  const spaceId = await space();
  const triggerId = await message(spaceId, content);
  const events: any[] = [];
  const pendingActions = [
    { action: 'module_record_update', params: { record_id: lakeviewDealId, expected_revision: lakeviewRevision, expected_manifest_digest: manifestDigest, patch: { stage: 'negotiation' } }, approval_tier: 'quick' },
    { action: 'module_record_create', params: { module_id: 'com.deft.contacts', collection_key: 'activities', expected_manifest_digest: manifestDigest, data: { subject: 'Note about the double-booking.', kind: 'note' } }, approval_tier: 'quick' },
  ];
  await handleAgentReply(job(spaceId, triggerId, content), {
    io: { to() { return { emit(event: string, payload: unknown) { events.push({ event, payload }); } }; } },
    runQuery: (async () => result('Drafted two CRM changes for your approval.', pendingActions)) as any,
    compileDraft: (async () => null) as any,
  } as any);
  const replies = await client!.query('SELECT content FROM messages WHERE space_id=$1 AND user_id<>$2 ORDER BY created_at', [spaceId, ownerId]);
  return { spaceId, replies, events };
}

test('two CRM writes in one message persist two pending approval actions', { skip: !url }, async (t) => {
  if (!ready) { t.skip(unavailable); return; }
  const { spaceId, replies } = await runTurn('@Defty Move Lakeview to Negotiation and add a note about the double-booking.');
  const actions = await client!.query('SELECT action, approval_status FROM agent_actions WHERE org_id=$1 AND conversation_id=$2 ORDER BY action', [orgId, spaceId]);
  assert.equal(actions.rows.length, 2, JSON.stringify(actions.rows));
  assert.deepEqual(actions.rows.map((r) => r.action).sort(), ['module_record_create', 'module_record_update']);
  assert.ok(actions.rows.every((r) => r.approval_status === 'pending'));
  const replyText = replies.rows.map((r) => r.content).join('\n');
  assert.doesNotMatch(replyText, /could not create a valid approval card/i);
  assert.doesNotMatch(replyText, /needs idempotency key/i);
});

test('module writes without a model-supplied idempotency key still persist', { skip: !url }, async (t) => {
  if (!ready) { t.skip(unavailable); return; }
  const spaceId = await space();
  const content = '@Defty Move Lakeview to Negotiation and add a note about the double-booking.';
  const triggerId = await message(spaceId, content);
  // Deliberately omit idempotency_key — the runner passes model output through
  // un-normalised, so a model juggling two actions may forget the key.
  const pendingActions = [
    { action: 'module_record_update', params: { record_id: lakeviewDealId, expected_revision: lakeviewRevision, expected_manifest_digest: manifestDigest, patch: { stage: 'negotiation' } }, approval_tier: 'quick' },
    { action: 'module_record_create', params: { module_id: 'com.deft.contacts', collection_key: 'activities', expected_manifest_digest: manifestDigest, data: { subject: 'Note about the double-booking.', kind: 'note' } }, approval_tier: 'quick' },
  ];
  await handleAgentReply(job(spaceId, triggerId, content), {
    io: { to() { return { emit() {} }; } },
    runQuery: (async () => result('Drafted two CRM changes for your approval.', pendingActions)) as any,
    compileDraft: (async () => null) as any,
  } as any);
  const actions = await client!.query('SELECT action, approval_status FROM agent_actions WHERE org_id=$1 AND conversation_id=$2 ORDER BY action', [orgId, spaceId]);
  assert.equal(actions.rows.length, 2, JSON.stringify(actions.rows));
  assert.deepEqual(actions.rows.map((r) => r.action).sort(), ['module_record_create', 'module_record_update']);
  const replies = await client!.query('SELECT content FROM messages WHERE space_id=$1 AND user_id<>$2', [spaceId, ownerId]);
  const replyText = replies.rows.map((r) => r.content).join('\n');
  assert.doesNotMatch(replyText, /needs idempotency key/i);
});
