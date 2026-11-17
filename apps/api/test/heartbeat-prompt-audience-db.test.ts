import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import pg from 'pg';
import { closeDb } from '../src/lib/db.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

// The heartbeat prompt is stored on a pending heartbeat_tick action and read
// later by the employee's runtime (and by people browsing agent activity), so
// it must not copy chat text, and it lists only rooms the employee can read.
const url = safeTestDatabaseUrl();
const unavailable = url ? '' : 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
const orgId = randomUUID();
const owner = randomUUID();
const shadow = randomUUID();
const employeeId = randomUUID();
const privateRoom = randomUUID();
const archivedPublic = randomUUID();
const privateMessage = randomUUID();
const archivedMessage = randomUUID();
let client: pg.Client | undefined;
let seeded = false;

before(async () => {
  if (unavailable) return;
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  await client.connect();
  await client.query('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [orgId, 'Heartbeat audience', 'heartbeat-audience-' + orgId]);
  await client.query("INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,'Owner','human',false)", [owner, owner + '@example.test']);
  await client.query("INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,'Shadow','agent',true)", [shadow, shadow + '@example.test']);
  await client.query("INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,'owner'),($4,$2,$5,'member')", [randomUUID(), orgId, owner, randomUUID(), shadow]);
  await client.query("INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,'hb-private','private',$3)", [privateRoom, orgId, owner]);
  await client.query("INSERT INTO spaces(id,org_id,name,type,created_by,is_archived) VALUES($1,$2,'hb-archived','public',$3,true)", [archivedPublic, orgId, owner]);
  await client.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3),($4,$5,$3)', [randomUUID(), privateRoom, owner, randomUUID(), archivedPublic]);
  await client.query("INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,'CANARY-HEARTBEAT-PRIVATE')", [privateMessage, orgId, privateRoom, owner]);
  await client.query("INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,'CANARY-HEARTBEAT-ARCHIVED')", [archivedMessage, orgId, archivedPublic, owner]);
  await client.query(`INSERT INTO agent_employees(id,org_id,user_id,name,slug,role,system_prompt,trust_level,is_byoa,is_active,heartbeat_enabled,space_ids,created_by)
    VALUES($1,$2,$3,'Heartbeat fixture',$4,'project_manager','Fixture','conservative',true,true,false,$5::text[],$6)`,
  [employeeId, orgId, shadow, 'hb-' + employeeId.slice(0, 8), [privateRoom, archivedPublic], owner]);
  seeded = true;
});

after(async () => {
  if (seeded && client) {
    await client.query('DELETE FROM agent_actions WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM agent_employees WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM messages WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM space_members WHERE space_id=ANY($1::text[])', [[privateRoom, archivedPublic]]);
    await client.query('DELETE FROM spaces WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM org_members WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM orgs WHERE id=$1', [orgId]);
    await client.query('DELETE FROM users WHERE id=ANY($1::text[])', [[owner, shadow]]);
  }
  await client?.end().catch(() => undefined);
  await closeDb();
});

test('heartbeat prompt names only messages the employee can read, and never copies their text', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { buildHeartbeatPrompt } = await import('../src/lib/heartbeat-prompt.js');
  const outside = await buildHeartbeatPrompt(employeeId);
  for (const value of [privateMessage, archivedMessage, 'CANARY-HEARTBEAT-PRIVATE', 'CANARY-HEARTBEAT-ARCHIVED']) {
    assert.ok(!outside.prompt.includes(value), value + ' must not appear for rooms the employee cannot read');
  }
  await client!.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), privateRoom, shadow]);
  const member = await buildHeartbeatPrompt(employeeId);
  assert.ok(member.prompt.includes(privateMessage), 'a member room is still listed by message id');
  assert.ok(!member.prompt.includes('CANARY-HEARTBEAT-PRIVATE'), 'the stored prompt carries no chat text');
  assert.ok(!member.prompt.includes(archivedMessage), 'archived public needs membership');
});

test('older heartbeat ticks lose their copied chat text, even when the heartbeat is now off', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { scrubLegacyHeartbeatTicks, SCRUBBED_HEARTBEAT_PROMPT, HEARTBEAT_PROMPT_FORMAT } = await import('../src/lib/heartbeat-tick-scrub.js');
  const tick = async (status: string, params: Record<string, unknown>) => {
    const id = randomUUID();
    await client!.query(`INSERT INTO agent_actions(id,org_id,user_id,agent_employee_id,source,action,params,approval_tier,approval_status)
      VALUES($1,$2,$3,$4,'heartbeat','heartbeat_tick',$5::jsonb,'auto',$6)`, [id, orgId, shadow, employeeId, JSON.stringify(params), status]);
    return id;
  };
  const oldPrompt = ['HEARTBEAT CHECK', '## Recent messages in your spaces', '- [Owner in room] CANARY-OLD-TICK-TEXT'].join(String.fromCharCode(10));
  const pending = await tick('pending', { heartbeat_prompt: oldPrompt, due_at: '2026-11-01T00:00:00.000Z' });
  const expired = await tick('expired', { heartbeat_prompt: oldPrompt });
  const current = await tick('pending', { heartbeat_prompt: 'current prompt', heartbeat_prompt_format: HEARTBEAT_PROMPT_FORMAT });

  assert.ok(await scrubLegacyHeartbeatTicks({ batchSize: 1 }) >= 2, 'small batches still reach every older tick');
  const { rows } = await client!.query('SELECT id, approval_status, params FROM agent_actions WHERE org_id=$1', [orgId]);
  const byId = new Map(rows.map((row: any) => [row.id, row]));
  for (const id of [pending, expired]) {
    assert.equal(byId.get(id).params.heartbeat_prompt, SCRUBBED_HEARTBEAT_PROMPT, 'the prompt key stays a string for older readers');
    assert.ok(!JSON.stringify(byId.get(id).params).includes('CANARY-OLD-TICK-TEXT'));
  }
  assert.equal(byId.get(pending).approval_status, 'pending', 'status is left alone');
  assert.equal(byId.get(pending).params.due_at, '2026-11-01T00:00:00.000Z', 'other params are kept');
  assert.equal(byId.get(current).params.heartbeat_prompt, 'current prompt', 'a current-format tick is untouched');
  assert.equal(await scrubLegacyHeartbeatTicks(), 0, 'a second run changes nothing');
});
