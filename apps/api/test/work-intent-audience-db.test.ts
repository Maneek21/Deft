import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';
import { closeDb } from '../src/lib/db.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const orgId = randomUUID();
const otherOrgId = randomUUID();
const ids = { owner: randomUUID(), admin: randomUUID(), source: randomUUID(), peer: randomUUID(), other: randomUUID(), approver: randomUUID(), guest: randomUUID() };
const roles: Record<string, 'owner' | 'admin' | 'member' | 'guest'> = {
  [ids.owner]: 'owner', [ids.admin]: 'admin', [ids.source]: 'member', [ids.peer]: 'member',
  [ids.other]: 'member', [ids.approver]: 'member', [ids.guest]: 'guest',
};
const spaceId = randomUUID();
const messageId = randomUUID();
const agentUserId = randomUUID();
const employeeId = randomUUID();
let deftyEmployeeId = '';
let client: pg.Client | undefined;
const unavailable = url ? '' : 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
let seeded = false;
let routes: Hono;

async function request(viewerId: string, path: string, tenantId = orgId) {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('user', { id: viewerId, org_id: tenantId, email: viewerId + '@example.test', role: roles[viewerId] } as any);
    await next();
  });
  hono.route('/api/work-intents', routes);
  return hono.request('/api/work-intents' + path);
}

before(async () => {
  if (unavailable) return;
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  // A configured test database that cannot be reached fails the suite instead of skipping it.
  await client.connect();
  await client.query('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [orgId, 'Intent audience', 'intent-audience-' + orgId]);
  for (const [name, id] of Object.entries(ids)) {
    await client.query("INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,$3,'human',false)", [id, id + '@example.test', name]);
    await client.query('INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,$4)', [randomUUID(), orgId, id, roles[id]]);
  }
  deftyEmployeeId = (await (await import('../src/lib/ensure-defty-membership.js')).ensureDeftyEmployee(orgId)).employeeId;
  await client.query("INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,'Agent','agent',true)", [agentUserId, agentUserId + '@example.test']);
  await client.query("INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,'member')", [randomUUID(), orgId, agentUserId]);
  await client.query(`INSERT INTO agent_employees(id,org_id,user_id,name,slug,role,system_prompt,expertise_description,trust_level,is_active,is_byoa,runtime_kind,wake_mode,certification_status,created_by)
    VALUES($1,$2,$3,'Agent',$4,'custom','Test.','Test.','conservative',true,true,'custom_mcp','manual','token_issued',$5)`,
  [employeeId, orgId, agentUserId, 'agent-' + employeeId.slice(0, 8), ids.owner]);
  await client.query("INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,'Intent source','private',$3)", [spaceId, orgId, ids.source]);
  for (const user of [...Object.values(ids).filter((id) => id !== ids.other), agentUserId]) {
    await client.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), spaceId, user]);
  }
  await client.query("INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,'Source message')", [messageId, orgId, spaceId, ids.source]);
  await client.query('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [otherOrgId, 'Other intent org', 'other-intent-' + otherOrgId]);
  await client.query("INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,'owner')", [randomUUID(), otherOrgId, ids.owner]);
  routes = (await import('../src/routes/work-intents.js')).workIntentRoutes;
  await client.query(`INSERT INTO space_members(id,space_id,user_id)
    SELECT $1,$2,user_id FROM agent_employees WHERE id=$3`, [randomUUID(), spaceId, deftyEmployeeId]);
  seeded = true;
});

after(async () => {
  if (seeded && client) {
    for (const table of ['wiki_citations', 'wiki_links', 'wiki_ops_log', 'wiki_pages', 'work_intents', 'message_observations', 'agent_action_approvers', 'agent_actions']) {
      await client.query('DELETE FROM ' + table + ' WHERE org_id=$1', [orgId]);
    }
    await client.query('DELETE FROM messages WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM space_members WHERE space_id=$1', [spaceId]);
    await client.query('DELETE FROM spaces WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM agent_employees WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM org_members WHERE org_id=ANY($1::text[])', [[orgId, otherOrgId]]);
    await client.query('DELETE FROM orgs WHERE id=ANY($1::text[])', [[orgId, otherOrgId]]);
    await client.query('DELETE FROM users WHERE id=ANY($1::text[])', [[...Object.values(ids), agentUserId]]);
  }
  await client?.end().catch(() => undefined);
  await closeDb();
});

async function insertIntent(options: { noSource?: boolean; employee?: string | null; requester?: string; terminal?: boolean; noAction?: boolean } = {}) {
  const id = randomUUID();
  const actionId = randomUUID();
  const requester = options.requester ?? ids.source;
  const employee = options.employee === undefined ? deftyEmployeeId : options.employee;
  await client!.query(`INSERT INTO work_intents(id,org_id,space_id,source_message_id,source_user_id,agent_employee_id,kind,status,title,summary,proposed_params,dedupe_key,failure_reason,metadata,converted_action_id)
    VALUES($1,$2,$3,$4,$5,$6,'task_candidate','failed','CANARY-TITLE','CANARY-SUMMARY',$7,$8,'CANARY-FAILURE',$9,$10)`,
  [id, orgId, options.noSource ? null : spaceId, options.noSource ? null : messageId, requester, employee,
    JSON.stringify({ title: 'CANARY-PARAMS' }), 'intent:' + id, JSON.stringify({ converted_wiki_title: 'CANARY-RESULT' }), options.terminal ? actionId : null]);
  if (!options.noAction) {
    await client!.query(`INSERT INTO agent_actions(id,org_id,user_id,agent_employee_id,message_id,action,params,approval_tier,approval_status,source)
      VALUES($1,$2,$3,$4,$5,'create_task',$6,'quick','pending','defty_capture')`,
    [actionId, orgId, employee === employeeId ? agentUserId : requester, employee, options.noSource ? null : messageId,
      JSON.stringify({ work_intent_id: id, source_user_id: requester })]);
    for (const approver of [ids.approver, ids.guest]) {
      await client!.query('INSERT INTO agent_action_approvers(id,org_id,action_id,user_id) VALUES($1,$2,$3,$4)', [randomUUID(), orgId, actionId, approver]);
    }
  }
  return id;
}

test('batch capture refuses publication when a secondary evidence message was deleted during classification', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { queueDeftyKnowledgeCapture } = await import('../src/lib/defty-capture.js');
  const secondary = randomUUID();
  await client!.query("INSERT INTO messages(id,org_id,space_id,user_id,content,is_deleted) VALUES($1,$2,$3,$4,'CANARY-SECONDARY-DELETED',true)", [secondary, orgId, spaceId, ids.peer]);
  const result = await queueDeftyKnowledgeCapture({ orgId, sourceUserId: ids.source, spaceId, messageId,
    content: 'CANARY-SECONDARY-DELETED', title: 'Deleted secondary evidence', wikiType: 'decision', captureKind: 'decision_candidate',
    autoApprove: true, metadata: { batch_capture: true, batch_message_ids: [messageId, secondary],
      batch_message_previews: [{ message_id: messageId, preview: 'Source message' }, { message_id: secondary, preview: 'CANARY-SECONDARY-DELETED' }] },
  });
  assert.equal(result.queued, false, JSON.stringify(result));
  const rows = await client!.query("SELECT id FROM agent_actions WHERE org_id=$1 AND params::text LIKE '%CANARY-SECONDARY-DELETED%'", [orgId]);
  assert.equal(rows.rowCount, 0, 'the copied text must not reach proposals or auto-approval');
});

test('pending batch action and work-intent reads and approval follow every evidence message', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { queueDeftyKnowledgeCapture } = await import('../src/lib/defty-capture.js');
  const { approveAction } = await import('../src/lib/agent-approval-resolver.js');
  const { visibleCaptureActionSql } = await import('../src/lib/agent-action-visibility.js');
  const { db } = await import('../src/lib/db.js');
  const { agentActions } = await import('@deft/db/schema');
  const { and, eq } = await import('drizzle-orm');
  const secondary = randomUUID();
  await client!.query("INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,'CANARY-SECONDARY-PENDING')", [secondary, orgId, spaceId, ids.peer]);
  const result = await queueDeftyKnowledgeCapture({ orgId, sourceUserId: ids.source, spaceId, messageId,
    content: 'CANARY-SECONDARY-PENDING', title: 'Live secondary evidence', wikiType: 'fact', captureKind: 'note_candidate', autoApprove: false,
    metadata: { batch_capture: true, batch_message_ids: [messageId, secondary], batch_message_previews: [{ message_id: secondary, preview: 'CANARY-SECONDARY-PENDING' }] },
  });
  assert.equal(result.queued, true, JSON.stringify(result));
  const { rows: [intent] } = await client!.query("SELECT id FROM work_intents WHERE org_id=$1 AND proposed_params->'metadata'->'batch_message_ids' ? $2", [orgId, secondary]);
  assert.equal((await request(ids.source, '/' + intent.id)).status, 200);
  await client!.query('UPDATE messages SET is_deleted=true WHERE id=$1', [secondary]);
  assert.equal((await request(ids.source, '/' + intent.id)).status, 404, 'intent must not expose retained secondary evidence');
  assert.equal((await db.select({ id: agentActions.id }).from(agentActions).where(and(eq(agentActions.id, result.actionId!), visibleCaptureActionSql({ id: ids.source, org_id: orgId })))).length, 0);
  // Legacy payloads can name a contributor only in their preview array.
  await client!.query("UPDATE agent_actions SET params=jsonb_set(params,'{metadata}',(params->'metadata')-'batch_message_ids') WHERE id=$1", [result.actionId]);
  await client!.query("UPDATE work_intents SET metadata=metadata-'batch_message_ids', proposed_params=jsonb_set(proposed_params,'{metadata}',(proposed_params->'metadata')-'batch_message_ids') WHERE id=$1", [intent.id]);
  assert.equal((await request(ids.source, '/' + intent.id)).status, 404, 'legacy preview-only evidence must stay source-gated');
  assert.equal((await db.select({ id: agentActions.id }).from(agentActions).where(and(eq(agentActions.id, result.actionId!), visibleCaptureActionSql({ id: ids.source, org_id: orgId })))).length, 0);
  const { rows: [defty] } = await client!.query('SELECT user_id FROM agent_employees WHERE id=$1', [deftyEmployeeId]);
  assert.equal((await approveAction(result.actionId!, defty.user_id, { internal: true })).status, 'error', 'auto-approval must not bypass evidence deletion');
});

test("Defty's get_agent_activity hides a capture once a secondary evidence message is deleted", async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { queueDeftyKnowledgeCapture } = await import('../src/lib/defty-capture.js');
  const { executeToolCall } = await import('../src/lib/agent-context.js');
  const anchor = randomUUID();
  const secondary = randomUUID();
  await client!.query("INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,'Activity anchor')", [anchor, orgId, spaceId, ids.source]);
  await client!.query("INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,'CANARY-ACTIVITY-SECONDARY')", [secondary, orgId, spaceId, ids.peer]);
  const result = await queueDeftyKnowledgeCapture({ orgId, sourceUserId: ids.source, spaceId, messageId: anchor,
    content: 'CANARY-ACTIVITY-SECONDARY', title: 'Activity secondary evidence', wikiType: 'fact', captureKind: 'note_candidate', autoApprove: false,
    metadata: { batch_capture: true, batch_message_ids: [anchor, secondary], batch_message_previews: [{ message_id: secondary, preview: 'CANARY-ACTIVITY-SECONDARY' }] },
  });
  assert.equal(result.queued, true, JSON.stringify(result));
  const activity = async () => (await executeToolCall('get_agent_activity', { limit: 100 }, orgId, ids.owner)).result.actions as Array<{ id: string }>;
  assert.ok((await activity()).some((action) => action.id === result.actionId), 'the live capture is listed');
  await client!.query('UPDATE messages SET is_deleted=true WHERE id=$1', [secondary]);
  const after = await activity();
  assert.ok(!after.some((action) => action.id === result.actionId), 'the capture must leave the activity list');
  assert.ok(!JSON.stringify(after).includes('CANARY-ACTIVITY-SECONDARY'), 'no deleted evidence text reaches the model');
});

async function readIntent(viewer: string, id: string, visible: boolean, detail: boolean) {
  const response = await request(viewer, detail ? '/' + id : '?limit=100');
  assert.equal(response.status, detail && !visible ? 404 : 200, await response.clone().text());
  const body = await response.json() as { intent?: Record<string, unknown>; intents?: Array<Record<string, unknown>> };
  const row = detail ? body.intent : body.intents?.find((intent) => intent.id === id);
  assert.equal(Boolean(row), visible, `${roles[viewer]} ${detail ? "detail" : "list"}`);
  return row;
}

test('intent action fields follow the Defty requester and owner/admin audience', async (t) => {
  if (unavailable) return t.skip(unavailable);
  for (const options of [{}, { employee: null }, { terminal: true }]) {
    const id = await insertIntent(options);
    for (const viewer of Object.values(ids)) {
      for (const detail of [false, true]) {
        const row = await readIntent(viewer, id, viewer !== ids.other, detail);
        if (!row) continue;
        // An approver assignment naming a member who is not a reviewer of the action opens nothing.
        const privileged = [ids.owner, ids.admin, ids.source].includes(viewer);
        for (const canary of ['CANARY-TITLE', 'CANARY-SUMMARY', 'CANARY-PARAMS', 'CANARY-FAILURE', 'CANARY-RESULT']) {
          assert.equal(JSON.stringify(row).includes(canary), privileged, roles[viewer] + ' ' + canary);
        }
        assert.equal(row.kind, 'task_candidate');
        assert.equal(row.status, 'failed');
        assert.ok(row.created_at);
        assert.ok(row.updated_at);
      }
    }
  }
  const own = await insertIntent({ requester: ids.guest });
  assert.ok(JSON.stringify(await readIntent(ids.guest, own, true, true)).includes('CANARY-PARAMS'));
  const noAction = await insertIntent({ noAction: true });
  assert.equal(JSON.stringify(await readIntent(ids.source, noAction, true, true)).includes('CANARY'), false);
});

test('intent action fields come only from the Defty capture action the intent links to', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const id = await insertIntent({ noAction: true });
  const claimId = randomUUID();
  // An employee action that names the intent and the reader in its own params.
  await client!.query(`INSERT INTO agent_actions(id,org_id,user_id,agent_employee_id,action,params,approval_tier,approval_status,source)
    VALUES($1,$2,$3,$4,'task_create',$5,'quick','pending','mcp')`,
  [claimId, orgId, agentUserId, employeeId, JSON.stringify({ work_intent_id: id, source_user_id: ids.peer })]);
  const fieldsFor = async (viewer: string) => {
    for (const detail of [false, true]) {
      const row = await readIntent(viewer, id, true, detail);
      assert.equal(JSON.stringify(row).includes('CANARY'), false, `${roles[viewer]} ${detail ? 'detail' : 'list'}`);
    }
  };
  await fieldsFor(ids.peer);
  await client!.query('UPDATE work_intents SET converted_action_id=$1 WHERE id=$2 AND org_id=$3', [claimId, id, orgId]);
  await fieldsFor(ids.peer);
  await fieldsFor(ids.owner);
});

test('the intent own action link takes precedence over a capture action that names the intent', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const id = await insertIntent({ noAction: true });
  const linked = randomUUID();
  const naming = randomUUID();
  // The linked capture action is the requester's private Defty action; another capture action names the intent for the peer.
  await client!.query(`INSERT INTO agent_actions(id,org_id,user_id,agent_employee_id,message_id,action,params,approval_tier,approval_status,source)
    VALUES($1,$2,$3,$4,$5,'create_task',$6,'quick','approved','defty_capture'),
          ($7,$2,$3,$4,$5,'create_task',$8,'quick','pending','defty_capture')`,
  [linked, orgId, ids.source, deftyEmployeeId, messageId, JSON.stringify({ work_intent_id: id, source_user_id: ids.source }),
    naming, JSON.stringify({ work_intent_id: id, source_user_id: ids.peer })]);
  await client!.query('UPDATE work_intents SET converted_action_id=$1 WHERE id=$2 AND org_id=$3', [linked, id, orgId]);
  for (const detail of [false, true]) {
    assert.equal(JSON.stringify(await readIntent(ids.peer, id, true, detail)).includes('CANARY'), false, 'peer');
    assert.equal(JSON.stringify(await readIntent(ids.source, id, true, detail)).includes('CANARY-PARAMS'), true, 'requester');
  }
});

test('source-less intents belong to the recorded requester and owners or admins', async (t) => {
  if (unavailable) return t.skip(unavailable);
  for (const requester of [ids.source, ids.guest]) {
    const id = await insertIntent({ noSource: true, requester });
    for (const viewer of Object.values(ids)) {
      for (const detail of [false, true]) {
        await readIntent(viewer, id, [ids.owner, ids.admin, requester].includes(viewer), detail);
      }
    }
  }
});

test('BYOA intent reads recheck the employee source authority', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const id = await insertIntent({ employee: employeeId });
  for (const viewer of [ids.owner, ids.admin, ids.source, ids.peer, ids.guest]) {
    assert.ok(JSON.stringify(await readIntent(viewer, id, true, true)).includes('CANARY-PARAMS'), roles[viewer]);
  }
  await readIntent(ids.other, id, false, true);
  await client!.query('DELETE FROM space_members WHERE space_id=$1 AND user_id=$2', [spaceId, agentUserId]);
  for (const viewer of Object.values(ids)) {
    for (const detail of [false, true]) await readIntent(viewer, id, false, detail);
  }
  await client!.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), spaceId, agentUserId]);
  await client!.query('UPDATE agent_employees SET is_active=false WHERE id=$1', [employeeId]);
  await readIntent(ids.source, id, false, true);
  await client!.query('UPDATE agent_employees SET is_active=true WHERE id=$1', [employeeId]);
});

test('observation classification follows the source and diagnostic errors follow the admin audience', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const id = randomUUID();
  await client!.query(`INSERT INTO message_observations(id,org_id,message_id,space_id,user_id,classifier_result,last_error)
    VALUES($1,$2,$3,$4,$5,'{"intent":"CANARY-CLASSIFICATION"}','CANARY-DIAGNOSTIC')`, [id, orgId, messageId, spaceId, ids.source]);
  for (const viewer of Object.values(ids)) {
    const response = await request(viewer, '/observations');
    assert.equal(response.status, 200);
    const { observations } = await response.json() as { observations: Array<Record<string, unknown>> };
    const row = observations.find((observation) => observation.id === id);
    assert.equal(Boolean(row), viewer !== ids.other);
    if (!row) continue;
    assert.ok(JSON.stringify(row).includes('CANARY-CLASSIFICATION'));
    assert.equal(JSON.stringify(row).includes('CANARY-DIAGNOSTIC'), [ids.owner, ids.admin].includes(viewer));
  }
  await client!.query('UPDATE messages SET is_deleted=true WHERE id=$1', [messageId]);
  const response = await request(ids.source, '/observations');
  assert.deepEqual(((await response.json()) as { observations: unknown[] }).observations, []);
});

test('work intent and observation reads stay within the current org', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const id = await insertIntent({ noSource: true });
  assert.equal((await request(ids.owner, '/' + id, otherOrgId)).status, 404);
  const list = await request(ids.owner, '?limit=100', otherOrgId);
  assert.equal(list.status, 200);
  assert.deepEqual(((await list.json()) as { intents: unknown[] }).intents, []);
  const observations = await request(ids.owner, '/observations', otherOrgId);
  assert.equal(observations.status, 200);
  assert.deepEqual(((await observations.json()) as { observations: unknown[] }).observations, []);
});
