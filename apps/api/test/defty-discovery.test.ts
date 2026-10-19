import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { executeToolCall } from '../src/lib/agent-context.js';
import { AGENT_TOOLS } from '../src/lib/agent-tools.js';
import { dashboardRoutes } from '../src/routes/dashboard.js';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
const org = randomUUID(), otherOrg = randomUUID(), actor = randomUUID(), noah = randomUUID(), duplicate = randomUUID(), outsider = randomUUID(), inactive = randomUUID();
const project = randomUUID(), foreignProject = randomUUID(), publicRoom = randomUUID(), privateRoom = randomUUID(), deniedRoom = randomUUID(), sameRoom = randomUUID();
const task = randomUUID(), msg = randomUUID(), privateMsg = randomUUID(), deniedMsg = randomUUID();
const rejected = randomUUID(), failed = randomUUID(), expired = randomUUID();
const call = (tool: string, params: Record<string, unknown> = {}) => executeToolCall(tool, params, org, actor);
before(async () => {
  process.env.DEFT_NATIVE_MENTIONS_ENABLED = 'false';
  await c.connect();
  await c.query(`INSERT INTO orgs (id,name,slug) VALUES ($1,'Discovery','discovery-'||$1),($2,'Other','other-'||$2)`, [org,otherOrg]);
  for (const [id,name] of [[actor,'Maya Rao'],[noah,'Noah Chen'],[duplicate,'Noah Chan'],[outsider,'External Member'],[inactive,'Inactive Member']]) {
    await c.query(`INSERT INTO users(id,email,name) VALUES($1,$1||'@test.local',$2)`,[id,name]);
    await c.query(`INSERT INTO org_members(id,org_id,user_id,role,is_active) VALUES(gen_random_uuid()::text,$1,$2,'member',$3)`,[id===outsider?otherOrg:org,id,id!==inactive]);
  }
  await c.query(`INSERT INTO projects(id,org_id,name,prefix,lead_id) VALUES($1,$2,'Northstar Launch','NST',$3)`,[project,org,actor]);
  await c.query(`INSERT INTO projects(id,org_id,name,prefix,lead_id) VALUES($1,$2,'External Project','EXT',$3)`,[foreignProject,otherOrg,outsider]);
  await c.query(`INSERT INTO tasks(id,org_id,project_id,number,title,description,created_by,assignee_id) VALUES($1,$2,$3,1,'Review import sample','Pilot team has twelve participants',$4,$5)`,[task,org,project,actor,noah]);
  for (const [id,name,type] of [[publicRoom,'Northstar public','public'],[privateRoom,'Northstar coordination','private'],[deniedRoom,'Finance confidential','private'],[sameRoom,'Northstar coordination extra','public']]) {
    await c.query(`INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$3,$4,$5)`,[id,org,name,type,actor]);
  }
  await c.query(`INSERT INTO space_members(id,space_id,user_id) VALUES(gen_random_uuid()::text,$1,$2)`,[privateRoom,actor]);
  for(const [id,room,text] of [[msg,publicRoom,'Public kickoff scheduled'],[privateMsg,privateRoom,'Technical review on Friday'],[deniedMsg,deniedRoom,'PRIVATE FINANCE SECRET']]) {
    await c.query(`INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,$5)`,[id,org,room,actor,text]);
  }
  for(const [id,status,date] of [[rejected,'rejected',null],[failed,'approved',new Date()],[expired,'expired',new Date()]]) {
    await c.query(`INSERT INTO agent_actions(id,org_id,action,params,approval_tier,approval_status,error,executed_at,user_id) VALUES($1,$2,'create_task','{}','quick',$3,'Controlled reason',$4,$5)`,[id,org,status,date,actor]);
  }
});
after(async () => {
  await c.query(`DELETE FROM agent_actions WHERE org_id=$1`,[org]);
  await c.query(`DELETE FROM tasks WHERE org_id=$1`,[org]);
  await c.query(`DELETE FROM messages WHERE org_id=$1`,[org]);
  await c.query(`DELETE FROM space_members WHERE user_id=$1`,[actor]);
  await c.query(`DELETE FROM spaces WHERE org_id=$1`,[org]);
  await c.query(`DELETE FROM projects WHERE org_id=ANY($1::text[])`,[[org,otherOrg]]);
  await c.query(`DELETE FROM org_members WHERE org_id=ANY($1::text[])`,[[org,otherOrg]]);
  await c.query(`DELETE FROM orgs WHERE id=ANY($1::text[])`,[[org,otherOrg]]);
  await c.query(`DELETE FROM users WHERE id=ANY($1::text[])`,[[actor,noah,duplicate,outsider,inactive]]);
  await c.end();
});
test('ordinary member discovery works with rich mentions disabled and returns ambiguity', async () => {
  assert.ok(AGENT_TOOLS.some(t=>t.name==='search_members'));
  const found=await call('search_members',{query:'Noah Chen'});
  assert.equal(found.result.member.id,noah);
  const ambiguous=await call('search_members',{query:'Noah'});
  assert.equal(ambiguous.result.code,'MEMBER_AMBIGUOUS'); assert.equal(ambiguous.result.matches.length,2);
  await c.query('UPDATE users SET name=$1 WHERE id=$2',['Noah Chen',duplicate]);
  assert.equal((await call('search_members',{query:'Noah Chen'})).result.code,'MEMBER_AMBIGUOUS');
  await c.query('UPDATE users SET name=$1 WHERE id=$2',['Noah Chan',duplicate]);
  for(const query of [outsider,'External Member','Inactive Member']) assert.equal((await call('search_members',{query})).result.code,'MEMBER_NOT_FOUND');
});
test('room discovery lists public and joined private rooms, excluding inaccessible private rooms',async()=>{
  const found=await call('list_spaces');
  assert.ok(found.result.some((r:any)=>r.id===privateRoom)); assert.ok(found.result.some((r:any)=>r.id===publicRoom));
  assert.ok(!JSON.stringify(found).includes(deniedRoom)); assert.ok(!JSON.stringify(found).includes('Finance confidential'));
});
test('latest room messages require a resolved allowed room and carry citations',async()=>{
  const found=await call('search_messages',{space_id:privateRoom});
  assert.equal(found.result[0].id,privateMsg); assert.equal(found.citations[0].id,privateMsg);
  const denied=await call('search_messages',{space_id:deniedRoom});
  assert.equal(denied.result.code,'SPACE_NOT_FOUND'); assert.ok(!JSON.stringify(denied).includes('PRIVATE FINANCE SECRET'));
  assert.equal((await call('search_messages',{})).result.code,'QUERY_OR_SPACE_REQUIRED');
});
test('room names resolve exact matches before partial and reject ambiguous matches',async()=>{
  const exact=await call('search_messages',{space_name:'Northstar coordination'});
  assert.equal(exact.result[0].id,privateMsg);
  assert.equal((await call('search_messages',{space_name:'Northstar'})).result.code,'SPACE_AMBIGUOUS');
});
test('project name and description queries discover task sources without UUID coaching',async()=>{
  for(const query of ['Northstar Launch','twelve participants']){
    const found=await call('search_tasks',{query}); assert.ok(found.result.some((r:any)=>r.id===task)); assert.ok(found.citations.some(r=>r.id===task));
  }
});
test('unresolved or ambiguous structural filters never broaden task results',async()=>{
  assert.equal((await call('search_tasks',{assignee_name:'External Member'})).result.code,'MEMBER_NOT_FOUND');
  assert.equal((await call('search_tasks',{assignee_name:'Noah'})).result.code,'MEMBER_AMBIGUOUS');
  for(const project_name of ['Nonexistent Project','External Project']) assert.equal((await call('search_tasks',{project_name})).result.code,'PROJECT_NOT_FOUND');
});
test('dashboard excludes rejected and expired decisions while retaining real execution failures',async()=>{
  const app=new Hono(); app.use('*',async(c,next)=>{c.set('user',{id:actor,org_id:org,role:'member'} as any);await next();}); app.route('/api/dashboard',dashboardRoutes);
  const response=await app.request('/api/dashboard'); assert.equal(response.status,200);
  const body:any=await response.json(); const errors=body.attention.filter((x:any)=>x.kind==='agent_error');
  assert.ok(errors.some((x:any)=>x.action_id===failed)); assert.ok(!errors.some((x:any)=>x.action_id===rejected||x.action_id===expired));
});
