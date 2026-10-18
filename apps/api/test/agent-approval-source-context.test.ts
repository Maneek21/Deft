import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mock, test } from 'node:test';
import pg from 'pg';
import type { ToolContext } from '../src/lib/mcp-tools/types.js';

test('approval dispatch carries canonical source context and original trust to its executor', async () => {
  const actual=await import('../src/lib/mcp-tools/writes.js'); const seen: ToolContext[]=[];
  mock.module(new URL('../src/lib/mcp-tools/writes.ts',import.meta.url).href,{namedExports:{...actual,
    executeTaskCreate:async (_args:unknown,ctx:ToolContext)=>{seen.push(ctx);return {content:[{type:'text',text:'{"created":true}'}],isError:false};},
  }});
  const {approveAction}=await import('../src/lib/agent-approval-resolver.js');
  const c=new pg.Client({connectionString:process.env.DATABASE_URL}); await c.connect();
  const org=randomUUID(),owner=randomUUID(),shadow=randomUUID(),employee=randomUUID(),room=randomUUID(),message=randomUUID(),event=randomUUID(),action=randomUUID();
  const runtimeKey='canonical-runtime-'+randomUUID();
  try {
    await c.query('INSERT INTO orgs(id,name,slug) VALUES($1,$1,$1)',[org]);
    for(const id of [owner,shadow])await c.query('INSERT INTO users(id,email,name,is_agent) VALUES($1,$1||\'@test.local\',$1,$2)',[id,id===shadow]);
    await c.query('INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,\'admin\')',[randomUUID(),org,owner]);
    await c.query(`INSERT INTO agent_employees(id,org_id,user_id,name,slug,role,system_prompt,trust_level,is_byoa,is_active,created_by)
      VALUES($1,$2,$3,'Context fixture',$1,'project_manager','Fixture','conservative',true,true,$4)`,[employee,org,shadow,owner]);
    await c.query('INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$1,\'public\',$3)',[room,org,owner]);
    await c.query('INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,\'Fixture\')',[message,org,room,owner]);
    await c.query(`INSERT INTO agent_channel_events(id,org_id,agent_employee_id,kind,source_kind,source_id,space_id,idempotency_key,payload)
      VALUES($1,$2,$3,'message.created','message',$4,$5,$1,'{}')`,[event,org,employee,message,room]);
    await c.query(`INSERT INTO agent_actions(id,org_id,user_id,agent_employee_id,source,action,params,approval_tier,approval_status,channel_event_id,runtime_request_key)
      VALUES($1,$2,$3,$4,'mcp','task_create',$5::jsonb,'quick','pending',$6,$7)`,[action,org,owner,employee,
        JSON.stringify({title:'Context fixture',channel_event_id:'model-forged-event',runtime_request_key:'model-forged-runtime'}),event,runtimeKey]);
    const result=await approveAction(action,owner); assert.equal(result.status,'approved');
    assert.equal(seen[0]?.channel_event_id,event); assert.equal(seen[0]?.runtime_request_key,runtimeKey);
    assert.equal(seen[0]?.employee_id,employee); assert.equal(seen[0]?.trust_level,'conservative');
  } finally {
    await c.query('DELETE FROM action_receipts WHERE org_id=$1',[org]);
    await c.query('DELETE FROM agent_actions WHERE org_id=$1',[org]);
    await c.query('DELETE FROM agent_channel_events WHERE org_id=$1',[org]);
    await c.query('DELETE FROM task_activity WHERE org_id=$1',[org]);
    await c.query('DELETE FROM task_comments WHERE org_id=$1',[org]);
    await c.query('DELETE FROM tasks WHERE org_id=$1',[org]);
    await c.query('DELETE FROM projects WHERE org_id=$1',[org]);
    await c.query('DELETE FROM messages WHERE org_id=$1',[org]);
    await c.query('DELETE FROM spaces WHERE org_id=$1',[org]);
    await c.query('DELETE FROM agent_employees WHERE org_id=$1',[org]);
    await c.query('DELETE FROM org_members WHERE org_id=$1',[org]);
    await c.query('DELETE FROM orgs WHERE id=$1',[org]);
    await c.query('DELETE FROM users WHERE id IN ($1,$2)',[owner,shadow]);
    await c.end(); mock.restoreAll();
  }
});
