import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { executeToolCall } from '../src/lib/agent-context.js';
import { approveAction, rejectAction } from '../src/lib/agent-approval-resolver.js';
import { mcpServerRoutes } from '../src/routes/mcp-server.js';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const org = randomUUID(), owner = randomUUID(), outsider = randomUUID(), shadow = randomUUID(), employee = randomUUID();
const room = randomUUID(), publicRoom = randomUUID(), message = randomUUID(), publicMessage = randomUUID(), event = randomUUID(), project = randomUUID();
const sourceAction = randomUUID(), eventAction = randomUUID(), publicAction = randomUUID(), unboundAction = randomUUID();
const token = 'source-authority-' + randomUUID(), slug = 'source-authority-' + employee;
const secret = 'PRIVATE-SOURCE-' + randomUUID();
const activity = (user: string) => executeToolCall('get_agent_activity', {}, org, user);
async function membership(present: boolean) {
  if (present) await client.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [randomUUID(),room,shadow]);
  else await client.query('DELETE FROM space_members WHERE space_id=$1 AND user_id=$2', [room,shadow]);
}
async function action(id: string, source: 'message'|'event'|'public'|'unbound', state = 'pending') {
  await client.query(`INSERT INTO agent_actions(id,org_id,user_id,agent_employee_id,source,action,params,approval_tier,approval_status,message_id,channel_event_id,result)
    VALUES($1,$2,$3,$4,'mcp','task_create',$5::jsonb,'quick',$6,$7,$8,$9::jsonb)`,
  [id,org,owner,employee,JSON.stringify({ title: id, project_id: project, priority: 'p2', summary: source==='public'?'PUBLIC':secret }),state,
    source==='message'?message:source==='public'?publicMessage:null,source==='event'?event:null,JSON.stringify({ marker: secret })]);
}
before(async () => {
  await client.connect();
  await client.query('INSERT INTO orgs(id,name,slug) VALUES($1,$1,$1)', [org]);
  for (const [id,isAgent] of [[owner,false],[outsider,false],[shadow,true]] as const) {
    await client.query('INSERT INTO users(id,email,name,is_agent) VALUES($1,$1||\'@test.local\',$1,$2)', [id,isAgent]);
    await client.query('INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,\'admin\')', [randomUUID(),org,id]);
  }
  await client.query(`INSERT INTO agent_employees(id,org_id,user_id,name,slug,role,system_prompt,trust_level,is_byoa,is_active,created_by)
    VALUES($1,$2,$3,'Source guard fixture',$4,'project_manager','Fixture','conservative',true,true,$5)`, [employee,org,shadow,slug,owner]);
  await client.query('INSERT INTO projects(id,org_id,name,prefix,lead_id) VALUES($1,$2,\'Source guard fixture\',\'SGF\',$3)', [project,org,owner]);
  for (const [id,type] of [[room,'private'],[publicRoom,'public']]) await client.query('INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$1,$3,$4)', [id,org,type,owner]);
  for (const user of [owner,shadow]) await client.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(),room,user]);
  for (const [id,space] of [[message,room],[publicMessage,publicRoom]]) await client.query('INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,$5)', [id,org,space,owner,space===room?secret:'PUBLIC']);
  await client.query(`INSERT INTO agent_channel_events(id,org_id,agent_employee_id,kind,source_kind,source_id,space_id,idempotency_key,payload)
    VALUES($1,$2,$3,'message.created','message',$4,$5,$1,$6::jsonb)`, [event,org,employee,message,room,JSON.stringify({content:secret})]);
  await action(sourceAction,'message','approved'); await action(eventAction,'event','approved');
  await action(publicAction,'public'); await action(unboundAction,'unbound');
  await client.query(`INSERT INTO api_keys(id,org_id,agent_employee_id,name,key_hash,key_prefix,permissions,created_by)
    VALUES($1,$2,$3,'Source guard fixture',$4,$5,ARRAY['read','write'],$6)`, [randomUUID(),org,employee,await bcrypt.hash(token,4),token.slice(0,12),owner]);
});
after(async () => {
  for (const table of ['action_receipts','agent_channel_delivery_attempts','agent_actions','agent_channel_events','notifications','job_queue','task_activity','task_comments','tasks','projects','api_keys','messages']) {
    await client.query(`DELETE FROM ${table} WHERE org_id=$1`,[org]);
  }
  await client.query('DELETE FROM space_members WHERE space_id IN ($1,$2)',[room,publicRoom]);
  await client.query('DELETE FROM spaces WHERE org_id=$1',[org]);
  await client.query('DELETE FROM agent_employees WHERE org_id=$1',[org]);
  await client.query('DELETE FROM org_members WHERE org_id=$1',[org]);
  await client.query('DELETE FROM orgs WHERE id=$1',[org]);
  await client.query('DELETE FROM users WHERE id IN ($1,$2,$3)',[owner,outsider,shadow]);
  await client.end();
});

test('activity uses the current human source audience even for an org admin', async () => {
  const allowed = await activity(owner), denied = await activity(outsider);
  assert.ok(JSON.stringify(allowed).includes(sourceAction)); assert.ok(JSON.stringify(allowed).includes(eventAction));
  assert.ok(!JSON.stringify(denied).includes(sourceAction)); assert.ok(!JSON.stringify(denied).includes(eventAction));
  assert.ok(JSON.stringify(denied).includes(publicAction)); assert.ok(JSON.stringify(denied).includes(unboundAction));
});
test('archived source rooms disappear from stored action activity', async () => {
  await client.query('UPDATE spaces SET is_archived=true WHERE id=$1',[room]);
  try { const result=await activity(owner); assert.ok(!JSON.stringify(result).includes(sourceAction)); assert.ok(!JSON.stringify(result).includes(eventAction)); }
  finally { await client.query('UPDATE spaces SET is_archived=false WHERE id=$1',[room]); }
});
test('legacy action status cannot replay a source-bound result after membership removal', async () => {
  for (const id of [sourceAction,eventAction]) {
    const request=()=>mcpServerRoutes.request('/actions/'+id+'/status',{headers:{authorization:'Bearer '+token}});
    assert.equal((await request()).status,200);
    await membership(false);
    try { const response=await request(); assert.equal(response.status,404); assert.ok(!(await response.text()).includes(secret)); }
    finally { await membership(true); }
  }
});
test('revocation before approval prevents a source-bound task and terminal-result replay', async () => {
  const pending=randomUUID(); await action(pending,'event'); await membership(false);
  try {
    const denied=await approveAction(pending,owner); assert.equal(denied.status,'error');
    assert.equal((await client.query('SELECT id FROM tasks WHERE org_id=$1 AND title=$2',[org,pending])).rows.length,0);
    assert.equal((await client.query('SELECT approval_status FROM agent_actions WHERE id=$1',[pending])).rows[0].approval_status,'pending');
    const replay=await approveAction(eventAction,owner); assert.equal(replay.status,'error'); assert.ok(!JSON.stringify(replay).includes(secret));
  } finally { await membership(true); }
});
test('a direct known action ID does not disclose private terminal results to an unrelated human admin', async () => {
  for (const id of [sourceAction,eventAction]) {
    const approval=await approveAction(id,outsider); assert.equal(approval.status,'error'); assert.ok(!JSON.stringify(approval).includes(secret));
    const rejection=await rejectAction(id,outsider); assert.equal(rejection.status,'error'); assert.ok(!JSON.stringify(rejection).includes(secret));
    const allowed=await approveAction(id,owner); assert.equal(allowed.status,'approved'); assert.ok(JSON.stringify(allowed).includes(secret));
  }
});
test('unbound manual proposals retain destination authority and do not pretend to carry source provenance', async () => {
  const pending=randomUUID(); await action(pending,'unbound'); await membership(false);
  try {
    const result=await approveAction(pending,owner); assert.equal(result.status,'approved');
    assert.equal((await client.query('SELECT id FROM tasks WHERE org_id=$1 AND title=$2',[org,pending])).rows.length,1);
    const row=(await client.query('SELECT channel_event_id,message_id FROM agent_actions WHERE id=$1',[pending])).rows[0];
    assert.equal(row.channel_event_id,null); assert.equal(row.message_id,null);
  } finally { await membership(true); }
});
test('ordinary hidden Defty actions retain their established assistant-message source contract', async () => {
  const defty=randomUUID(), pending=randomUUID();
  await client.query(`INSERT INTO agent_employees(id,org_id,user_id,name,slug,role,system_prompt,trust_level,runtime_kind,is_byoa,is_active,is_deleted,created_by)
    VALUES($1,$2,$3,'Defty','defty-system','project_manager','Fixture','conservative','defty_system',false,true,true,$4)`,[defty,org,shadow,owner]);
  await client.query(`INSERT INTO agent_actions(id,org_id,user_id,agent_employee_id,source,action,params,approval_tier,approval_status,message_id)
    VALUES($1,$2,$3,$4,'auto_execute','task_create',$5::jsonb,'quick','pending',$6)`,
    [pending,org,owner,defty,JSON.stringify({title:pending,project_id:project,priority:'p2'}),'assistant-'+randomUUID()]);
  assert.ok(JSON.stringify(await activity(owner)).includes(pending));
  const result=await approveAction(pending,owner); assert.equal(result.status,'approved');
  assert.equal((await client.query('SELECT id FROM tasks WHERE org_id=$1 AND title=$2',[org,pending])).rows.length,1);
});
