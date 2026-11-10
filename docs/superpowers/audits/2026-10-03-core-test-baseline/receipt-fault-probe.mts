import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
const root='C:/Users/Osheen Pradhan/.codex/worktrees/core-baseline-tests-20261003/Deft Main Repo';
process.chdir('C:/tmp/deft-core-baseline-20261003');
const require=createRequire(root+'/apps/api/package.json');
const pg=require('pg');const bcrypt=require('bcryptjs');
assert.equal(new URL(process.env.DATABASE_URL!).pathname,'/deft_files_apps_baseline_test');
const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();
const load=(p:string)=>import(pathToFileURL(root+'/'+p).href);
const {app}=await load('apps/api/src/index.ts');const {closeDb}=await load('apps/api/src/lib/db.ts');
const {verifyReceipt}=await load('apps/api/src/lib/receipts.ts');
const org=randomUUID(),user=randomUUID(),space=randomUUID(),normal=randomUUID(),fault=randomUUID();
const email='receipt-probe-'+user+'@example.test',password=randomUUID();
await c.query('INSERT INTO orgs(id,name,slug)VALUES($1,$2,$3)',[org,'Receipt fault probe','receipt-probe-'+org]);
await c.query('INSERT INTO users(id,name,email,password_hash,email_verified)VALUES($1,$2,$3,$4,true)',[user,'Receipt probe owner',email,await bcrypt.hash(password,4)]);
await c.query('INSERT INTO org_members(id,org_id,user_id,role)VALUES($1,$2,$3,$4)',[randomUUID(),org,user,'owner']);
await c.query('INSERT INTO spaces(id,org_id,name,type,created_by)VALUES($1,$2,$3,$4,$5)',[space,org,'receipt-probe-'+space,'public',user]);
await c.query('INSERT INTO space_members(id,space_id,user_id)VALUES($1,$2,$3)',[randomUUID(),space,user]);
const login=await app.request('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});assert.equal(login.status,200);
const token=(await login.json()).accessToken;assert.ok(token);
async function execute(id:string,label:string){
 const content='receipt-probe-'+label+'-'+id;
 await c.query('INSERT INTO agent_actions(id,org_id,user_id,source,action,params,approval_tier)VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)',[id,org,user,'defty_capture','post_message',JSON.stringify({space_id:space,content}),'full']);
 const response=await app.request('/api/agent/actions/'+id+'/approve',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}'});
 const body=await response.json();
 const action=(await c.query('SELECT approval_status,executed_at IS NOT NULL AS executed,error FROM agent_actions WHERE id=$1',[id])).rows[0];
 const messageCount=Number((await c.query('SELECT count(*) FROM messages WHERE org_id=$1 AND space_id=$2 AND content=$3',[org,space,content])).rows[0].count);
 const receipts=(await c.query('SELECT * FROM action_receipts WHERE action_id=$1',[id])).rows;
 return {http_status:response.status,response_status:body.status,action,message_count:messageCount,receipt_count:receipts.length,receipts_verified:await Promise.all(receipts.map((r:any)=>verifyReceipt(r)))};
}
const result:any={normal:await execute(normal,'normal')};
assert.equal(result.normal.http_status,200);assert.equal(result.normal.message_count,1);assert.ok(result.normal.receipt_count>0);assert.ok(result.normal.receipts_verified.every(Boolean));
let triggerCreated=false;
try{
 await c.query("CREATE FUNCTION deft_receipt_probe_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action_id = TG_ARGV[0] THEN RAISE EXCEPTION 'synthetic probe receipt persistence failure'; END IF; RETURN NEW; END $$");
 await c.query(`CREATE TRIGGER deft_receipt_probe_fail BEFORE INSERT ON action_receipts FOR EACH ROW EXECUTE FUNCTION deft_receipt_probe_fail('${fault}')`);triggerCreated=true;
 result.fault=await execute(fault,'fault');
}finally{
 if(triggerCreated)await c.query('DROP TRIGGER deft_receipt_probe_fail ON action_receipts');
 await c.query('DROP FUNCTION IF EXISTS deft_receipt_probe_fail()');
 result.trigger_remaining=Number((await c.query("SELECT count(*) FROM pg_trigger WHERE tgname='deft_receipt_probe_fail'")).rows[0].count);
 await writeFile('C:/tmp/deft-core-baseline-20261003/receipt-fault-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 await closeDb();await c.end();
}
