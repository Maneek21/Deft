import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import pg from 'pg';
import { persistAgentReplyWithActions } from '../src/lib/agent-action-proposals.js';
import { loadPendingDeftyDraft } from '../src/lib/defty-pending-action.js';
import { closeDb } from '../src/lib/db.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const orgId = randomUUID(), ownerId = randomUUID(), agentId = randomUUID(), spaceId = randomUUID();
let client: pg.Client | undefined;

before(async () => {
  if (!url) return;
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  await client.connect();
  await client.query('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [orgId, 'Pending resolution', `pending-${orgId}`]);
  await client.query('INSERT INTO users(id,email,name,is_agent) VALUES($1,$2,$3,false),($4,NULL,$5,true)', [ownerId, `${ownerId}@example.test`, 'Pending Owner', agentId, 'Defty']);
  await client.query('INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,\'owner\')', [randomUUID(), orgId, ownerId]);
  await client.query('INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$3,\'public\',$4)', [spaceId, orgId, 'Pending room', ownerId]);
  await client.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), spaceId, ownerId]);
});

after(async () => {
  if (client) {
    await client.query('DELETE FROM attention_items WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM agent_actions WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM messages WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM space_members WHERE space_id=$1', [spaceId]);
    await client.query('DELETE FROM spaces WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM org_members WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM orgs WHERE id=$1', [orgId]);
    await client.query('DELETE FROM users WHERE id=ANY($1::text[])', [[ownerId, agentId]]);
    await client.end();
  }
  await closeDb();
});

test('proposal creation resolves every clarification for its original request and cannot revive an older draft', { skip: !url }, async () => {
  const requestId = randomUUID(), firstQuestionId = randomUUID(), secondQuestionId = randomUUID();
  const unrelatedRequestId = randomUUID(), unrelatedQuestionId = randomUUID();
  const now = Date.now();
  for (const [id, parentId, time] of [[requestId, null, now - 20000], [unrelatedRequestId, null, now - 19000]] as const) {
    await client!.query('INSERT INTO messages(id,org_id,space_id,user_id,content,parent_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, orgId, spaceId, ownerId, 'Make a task', parentId, new Date(time)]);
  }
  for (const [id, originalId, question, time] of [
    [firstQuestionId, requestId, 'Which project?', now - 15000],
    [secondQuestionId, requestId, 'Which owner?', now - 10000],
    [unrelatedQuestionId, unrelatedRequestId, 'Which project?', now - 5000],
  ] as const) {
    const metadata = { defty_pending: { kind: 'action_draft', request_message_id: originalId, request_text: 'Make a task', question,
      created_at: new Date(time).toISOString(), draft: { actions: [{ action: 'create_task', params: { title: 'Write rollback script' } }] } } };
    await client!.query('INSERT INTO messages(id,org_id,space_id,user_id,content,parent_id,created_at,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [id, orgId, spaceId, agentId, question, originalId, new Date(time), metadata]);
  }
  const saved = await persistAgentReplyWithActions({
    orgId, spaceId, userId: ownerId, agentUserId: agentId, parentId: requestId,
    content: 'Drafted for approval.', metadata: {}, resolvePendingMessageId: secondQuestionId,
    pendingActions: [{ action: 'create_task', params: { title: 'Write rollback script', project_name: 'Deft v1', source_message_id: requestId }, approval_tier: 'quick' }],
  });
  assert.equal(saved.actions.length, 1);
  const rows = (await client!.query('SELECT id,metadata FROM messages WHERE id=ANY($1::text[])', [[firstQuestionId, secondQuestionId, unrelatedQuestionId]])).rows;
  for (const id of [firstQuestionId, secondQuestionId]) {
    assert.ok(rows.find(row => row.id === id)?.metadata.defty_pending_resolved_at, `${id} remains active`);
  }
  assert.equal(rows.find(row => row.id === unrelatedQuestionId)?.metadata.defty_pending_resolved_at, undefined);
  const loaded = await loadPendingDeftyDraft({ orgId, spaceId, threadParentId: requestId,
    triggerMessageId: randomUUID(), requesterId: ownerId, agentUserId: agentId, triggerCreatedAt: new Date(now + 1000) });
  assert.equal(loaded, null, 'a subsequent thanks must not reload the older clarification');
});

test('a reply that produces no proposal retires every clarification for its request', { skip: !url }, async () => {
  const requestId = randomUUID(), firstQuestionId = randomUUID(), secondQuestionId = randomUUID();
  const now = Date.now();
  await client!.query('INSERT INTO messages(id,org_id,space_id,user_id,content,created_at) VALUES($1,$2,$3,$4,$5,$6)', [requestId, orgId, spaceId, ownerId, 'Make a task', new Date(now - 20000)]);
  for (const [id, time] of [[firstQuestionId, now - 15000], [secondQuestionId, now - 10000]] as const) {
    const metadata = { defty_pending: { kind: 'action_draft', request_message_id: requestId,
      request_text: 'Make a task', question: 'Which project?',
      created_at: new Date(time).toISOString(), draft: { actions: [] } } };
    await client!.query('INSERT INTO messages(id,org_id,space_id,user_id,content,parent_id,created_at,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [id, orgId, spaceId, agentId, 'Which project?', requestId, new Date(time), metadata]);
  }
  const saved = await persistAgentReplyWithActions({
    orgId, spaceId, userId: ownerId, agentUserId: agentId, parentId: requestId,
    content: 'No problem, I will not create it.', metadata: {}, resolvePendingMessageId: secondQuestionId, pendingActions: [],
  });
  assert.equal(saved.actions.length, 0);
  const rows = (await client!.query('SELECT id,metadata FROM messages WHERE id=ANY($1::text[])', [[firstQuestionId, secondQuestionId]])).rows;
  for (const id of [firstQuestionId, secondQuestionId]) {
    assert.ok(rows.find(row => row.id === id)?.metadata.defty_pending_resolved_at, `${id} remains active after the request was cancelled`);
  }
  const loaded = await loadPendingDeftyDraft({ orgId, spaceId, threadParentId: requestId,
    triggerMessageId: randomUUID(), requesterId: ownerId, agentUserId: agentId, triggerCreatedAt: new Date(now + 1000) });
  assert.equal(loaded, null);
});

test('a duplicate-only proposal resolves every clarification for its original request', { skip: !url }, async () => {
  const requestId = randomUUID(), firstQuestionId = randomUUID(), secondQuestionId = randomUUID();
  const now = Date.now();
  await client!.query('INSERT INTO messages(id,org_id,space_id,user_id,content,created_at) VALUES($1,$2,$3,$4,$5,$6)', [requestId, orgId, spaceId, ownerId, 'Create a release checklist task', new Date(now - 20000)]);
  for (const [id, time] of [[firstQuestionId, now - 15000], [secondQuestionId, now - 10000]] as const) {
    const metadata = { defty_pending: { kind: 'action_draft', request_message_id: requestId,
      request_text: 'Create a release checklist task', question: 'Which project?',
      created_at: new Date(time).toISOString(), draft: { actions: [] } } };
    await client!.query('INSERT INTO messages(id,org_id,space_id,user_id,content,parent_id,created_at,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [id, orgId, spaceId, agentId, 'Which project?', requestId, new Date(time), metadata]);
  }
  const idempotencyKey = `pending-duplicate-${requestId}`;
  const action = { action: 'create_task', approval_tier: 'quick' as const, idempotency_key: idempotencyKey,
    params: { title: 'Prepare release checklist', project_name: 'Deft v1', source_message_id: requestId, idempotency_key: idempotencyKey } };
  const input = { orgId, spaceId, userId: ownerId, agentUserId: agentId, parentId: requestId,
    content: 'Drafted for approval.', metadata: {}, pendingActions: [action] };
  const initial = await persistAgentReplyWithActions(input);
  assert.equal(initial.actions.length, 1);
  const duplicate = await persistAgentReplyWithActions({ ...input, resolvePendingMessageId: secondQuestionId });
  assert.equal(duplicate.actions.length, 0, 'this must exercise the duplicate-only branch');
  assert.equal(duplicate.duplicates.length, 1);
  const rows = (await client!.query('SELECT id,metadata FROM messages WHERE id=ANY($1::text[])', [[firstQuestionId, secondQuestionId]])).rows;
  for (const id of [firstQuestionId, secondQuestionId]) {
    assert.ok(rows.find(row => row.id === id)?.metadata.defty_pending_resolved_at, `${id} remains active after the duplicate proposal was recognized`);
  }
});
