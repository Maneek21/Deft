import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';
import { persistAgentReplyWithActions } from '../src/lib/agent-action-proposals.js';
import { closeDb } from '../src/lib/db.js';

test('malformed CRM update and valid wiki proposal report the single persisted proposal and omitted branch', async t => {
  const database = safeTestDatabaseUrl(); assert.ok(database);
  const client = new pg.Client({ connectionString: database }); await client.connect();
  const org = randomUUID(), owner = randomUUID(), agent = randomUUID(), space = randomUUID();
  t.after(async () => {
    for (const table of ['attention_items', 'notifications', 'job_queue', 'agent_actions', 'messages', 'tasks', 'projects', 'spaces', 'org_members']) await client.query(`DELETE FROM ${table} WHERE org_id=$1`, [org]);
    await client.query('DELETE FROM users WHERE id=ANY($1::text[])', [[owner, agent]]);
    await client.query('DELETE FROM orgs WHERE id=$1', [org]); await client.end(); await closeDb();
  });
  await client.query('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [org, 'Ordinary proposal outcomes', 'proposal-' + org]);
  await client.query('INSERT INTO users(id,email,name,is_agent,email_verified) VALUES($1,$2,$3,false,true),($4,NULL,$5,true,true)', [owner, 'proposal-' + owner + '@test.local', 'Proposal owner', agent, 'Proposal agent']);
  await client.query("INSERT INTO org_members(id,org_id,user_id,role,is_active) VALUES($1,$2,$3,'owner',true)", [randomUUID(),org,owner]);
  await client.query("INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,'Proposal room','public',$3)", [space,org,owner]);
  const malformed = { action: 'module_record_update', source: 'action_compiler', params: { record_id: randomUUID(), changed_fields: ['role'], expected_revision: 1, expected_manifest_digest: 'sha256:dummy_digest_for_validation' } };
  const wiki = { action: 'wiki_write', source: 'action_compiler', params: { title: 'Reviewed publication note', type: 'decision', content: 'Original durable facts.\n\nReviewed ownership sentence.' } };
  const persisted = await persistAgentReplyWithActions({ orgId: org, userId: owner, agentUserId: agent, spaceId: space,
    content: 'I drafted 2 related changes for approval.', metadata: { agent_blocks: [{ type: 'text', text: 'I drafted 2 related changes for approval.' }], action_graph: { actions: [{ tool: 'module_record_update' }, { tool: 'wiki_write' }] } }, pendingActions: [malformed,wiki] });
  assert.equal(persisted.actions.length, 1); assert.equal(persisted.actions[0]!.action, 'wiki_write');
  assert.match(persisted.message.content, /1 proposal for review/);
  assert.match(persisted.message.content, /Not prepared: module record update/);
  assert.doesNotMatch(persisted.message.content, /drafted 2/);
  const readback = await client.query('SELECT content,metadata FROM messages WHERE id=$1', [persisted.message.id]);
  assert.equal(readback.rows[0].content, persisted.message.content);
  assert.deepEqual(readback.rows[0].metadata.rejected_module_actions, ['module_record_update']);
  assert.equal(readback.rows[0].metadata.pending_actions.length, 1);
  assert.equal(readback.rows[0].metadata.agent_blocks[0].text, readback.rows[0].content);
  const { resolvePendingActionTargets } = await import('../src/workers/handlers/agent-reply.js');
  const rawWiki = { ...wiki, params: { ...wiki.params, content: '[existing content retained]\n\nReviewed ownership sentence.' } };
  const resolved = await resolvePendingActionTargets(org, owner, space, [malformed,rawWiki], 'Update the CRM role and append the reviewed ownership sentence to the existing wiki page.');
  assert.equal(resolved.actions.length, 1); assert.equal(resolved.actions[0]!.action, 'module_record_update');
  assert.match(resolved.warnings.join(' '), /placeholder/);
  const rejected = await persistAgentReplyWithActions({ orgId: org, userId: owner, agentUserId: agent, spaceId: space,
    content: 'I drafted 2 related changes for approval.', metadata: { action_graph: { actions: [{ tool: 'module_record_update' }, { tool: 'wiki_write' }] }, proposal_preparation_warnings: resolved.warnings }, pendingActions: resolved.actions });
  assert.equal(rejected.actions.length, 0);
  assert.match(rejected.message.content, /could not prepare any approval proposals/);
  assert.match(rejected.message.content, /module record update, wiki write/);
  assert.match(rejected.message.content, /placeholder/);
  const final = await client.query('SELECT count(*)::int AS count FROM agent_actions WHERE message_id=$1', [rejected.message.id]);
  assert.equal(final.rows[0].count, 0);
  const project = randomUUID(), task = randomUUID();
  await client.query("INSERT INTO projects(id,org_id,name,prefix,lead_id) VALUES($1,$2,'Existing normal prefix','LN2619',$3)", [project,org,owner]);
  await client.query("INSERT INTO tasks(id,org_id,project_id,number,title,created_by,status,priority) VALUES($1,$2,$3,9,'Exact dependency target',$4,'backlog','p2')", [task,org,project,owner]);
  const { resolveTaskIdentifier } = await import('../src/lib/agent-actions.js');
  assert.equal(await resolveTaskIdentifier('LN2619-9', org), task);
  assert.equal(await resolveTaskIdentifier('Exact dependency target', org), null);


});
