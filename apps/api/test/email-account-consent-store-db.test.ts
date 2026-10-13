import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {sql} from 'drizzle-orm';
import {EmailMailboxCrypto} from '../src/lib/email-mailbox-crypto.js';
import {PostgresEmailAccountConsentStore,type EmailAccountConsentGuard} from '../src/lib/email-account-consent-store.js';
import {EmailAccountOwnerAuthority} from '../src/lib/email-account-owner-authority.js';
import {EmailAccountLifecycleService} from '../src/lib/email-account-lifecycle-service.js';
import {createEmailAccountLifecycleRoutes} from '../src/routes/email-account-lifecycle.js';
import {EmailAccountAuthorityRouter} from '../src/lib/email-account-authority-router.js';
import {PostgresEmailAccountAuthority} from '../src/lib/email-account-authority.js';
import type {EmailServiceLease} from '../src/lib/email-mailbox-authority.js';
import {planEmailAccountAdoption,planEmailAccountReconnect,planEmailAccountStop,planEmailAccountConsent,type EmailAccountConnectionProof} from '../src/lib/email-account-lifecycle.js';
const target='postgresql://gate_g_test@127.0.0.1:55435/email_stage34_native_82';
const safe=process.env.DATABASE_URL===target&&process.env.DEFT_TEST_DATABASE_URL===target;
test('actual PG standalone consent encrypted CAS, immutable bridge/principal and no effect-journal mutation',{skip:!safe,timeout:20000},async t=>{
 const namespace='email_consent_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:target});await admin.query(`CREATE SCHEMA "${namespace}"`);
 const pool=new pg.Pool({connectionString:target,options:`-c search_path=${namespace},public`,max:8});t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA "${namespace}" CASCADE`);await admin.end();});
 await pool.query('CREATE TABLE email_accounts(LIKE public.email_accounts INCLUDING ALL)');
 // The retained82 regression fixture predates85. Supply its additive account
 // columns locally; supported full85 migration parity is proved separately.
 await pool.query("ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS credential_source text NOT NULL DEFAULT 'retained_registry_v1'");
 await pool.query("ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS retained_resource_binding_id text GENERATED ALWAYS AS (CASE WHEN credential_source='retained_registry_v1' THEN resource_binding_id ELSE NULL END) STORED");
 for(const table of ['users','org_members','web_sessions','job_queue'])await pool.query(`CREATE TABLE ${table}(LIKE public.${table} INCLUDING ALL)`);
 await pool.query('CREATE TABLE owner_fixture(org_id text,user_id text,active boolean NOT NULL,PRIMARY KEY(org_id,user_id))');
 await pool.query('CREATE TABLE session_fixture(sid text PRIMARY KEY,org_id text,user_id text,revoked boolean NOT NULL)');
 await pool.query('CREATE TABLE preserved_effect_fixture(operation_id text PRIMARY KEY,state text,payload bytea)');
 const ddl=readFileSync(new URL('../../../packages/db/upgrades/0.3.0-preview.82-email-standalone-account-consent.sql',import.meta.url),'utf8');await pool.query(ddl);await pool.query(ddl);
 const statements:string[]=[],database=drizzle(pool,{logger:{logQuery(query){statements.push(query);}}}),uuid=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),scope={org_id:uuid(1),owner_user_id:uuid(2),account_id:'native-account'},now=Date.parse('2026-10-04T10:00:00Z');
 await pool.query('INSERT INTO owner_fixture VALUES($1,$2,true)',[scope.org_id,scope.owner_user_id]);await pool.query('INSERT INTO session_fixture VALUES($1,$2,$3,false)',['exact-sid',scope.org_id,scope.owner_user_id]);
 await pool.query('INSERT INTO users(id,name) VALUES($1,$2)',[scope.owner_user_id,'Native owner']);await pool.query('INSERT INTO org_members(id,org_id,user_id) VALUES($1,$2,$3)',[randomUUID(),scope.org_id,scope.owner_user_id]);
 await pool.query('INSERT INTO web_sessions(id,org_id,user_id,refresh_token_hash,expires_at) VALUES($1,$2,$3,$4,$5)',['actual-native-sid',scope.org_id,scope.owner_user_id,'synthetic-only',new Date(now+60000)]);
 await pool.query("INSERT INTO email_accounts(org_id,owner_user_id,account_id,provider,resource_binding_id,principal_digest,state,authority_revision,consented_at) VALUES($1,$2,$3,'gmail',$4,$5,'active',7,$6)",[scope.org_id,scope.owner_user_id,scope.account_id,uuid(6),'a'.repeat(64),new Date(now)]);
 await pool.query("INSERT INTO preserved_effect_fixture VALUES('started','started',$1),('uncertain','uncertain',$1)",[Buffer.from('Exact immutable retained MIME')]);const effects=(await pool.query('SELECT * FROM preserved_effect_fixture ORDER BY operation_id')).rows;
 const cipher=new EmailMailboxCrypto({current:()=>({key_id:'consent-key',key:Buffer.alloc(32,77)}),read:(_p,id)=>id==='consent-key'?{key_id:id,key:Buffer.alloc(32,77)}:null,keyIds:()=>['consent-key']}),store=()=>new PostgresEmailAccountConsentStore(database as never,cipher);
 let revoked=false,finalDeny=false;const phases:string[]=[];
 const guard:EmailAccountConsentGuard=async(selected,tx,phase)=>{assert.deepEqual(selected,scope);phases.push(phase);if(phase==='owner'){
  const rows=await tx.execute(sql`SELECT active FROM owner_fixture WHERE org_id=${scope.org_id} AND user_id=${scope.owner_user_id} FOR SHARE`);assert.equal(rows.rows[0]?.active,true);
 }else{const rows=await tx.execute(sql`SELECT revoked FROM session_fixture WHERE sid='exact-sid' AND org_id=${scope.org_id} AND user_id=${scope.owner_user_id} FOR SHARE`);if(rows.rows[0]?.revoked!==false||revoked||phase==='final'&&finalDeny)throw Error('EMAIL_ACCESS_DENIED');}};
 const proof:EmailAccountConnectionProof={scope,provider:'gmail',principal_digest:'a'.repeat(64),native_revision:7,consent_revision:0,credential_revision:3,health:'connected',available_capabilities:['read','modify','send'],bridge:{kind:'retained_registry_v1',module_sha256:'d'.repeat(64),pins:{org_id:scope.org_id,owner_user_id:scope.owner_user_id,installation_id:uuid(3),app_version_id:uuid(4),grant_snapshot_id:uuid(5),target_key:'email',resource_key:'inbox',resource_binding_id:uuid(6),action_key:'send',action_binding_id:uuid(7)}}};
 await t.test('adoption is explicit and encrypted; exact competing replay has one CAS winner',async()=>{
  assert.equal(await store().read(scope,guard),null);const plan=planEmailAccountAdoption(proof,['read','send'],now),results=await Promise.allSettled([store().commit(plan,guard),store().commit(plan,guard)]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.filter(x=>x.status==='rejected').length,1);
  const record=await store().read(scope,guard);assert.equal(record?.revision,1);assert.equal(record?.native_revision,8);const raw=(await pool.query('SELECT * FROM email_account_consents')).rows[0];assert.equal(JSON.stringify(raw).includes(uuid(3)),false);assert.equal(JSON.stringify(raw).includes('d'.repeat(64)),false);assert.deepEqual(phases.slice(-3),['owner','principal','final']);
  assert.equal((await pool.query('SELECT authority_revision FROM email_accounts')).rows[0].authority_revision,8);
 });
 await t.test('independent credential revision preserves consent readability; fresh reconnect CAS updates both fences',async()=>{
  await pool.query('UPDATE email_accounts SET authority_revision=9');const current=(await store().read(scope,guard))!;assert.equal(current.revision,1);assert.equal(current.native_revision,8);
  const next=planEmailAccountReconnect(current,{...proof,native_revision:9,consent_revision:1,credential_revision:4},now+1);const updated=await store().commit(next,guard);assert.equal(updated.revision,2);assert.equal(updated.native_revision,10);assert.equal(updated.credential_revision,4);await assert.rejects(store().commit(next,guard),/LIFECYCLE_CONFLICT/);
  const wrong={...next,next:{...next.next,scope:{...scope,account_id:'foreign'}}};await assert.rejects(store().commit(wrong,guard));
 });
 await t.test('final session denial rolls back both consent and native authority, and mutable bridge tampering is rejected',async()=>{
  const current=(await store().read(scope,guard))!,p={...proof,native_revision:10,consent_revision:2,credential_revision:4},next=planEmailAccountConsent(current,p,['read','modify'],now+2);finalDeny=true;await assert.rejects(store().commit(next,guard),/ACCESS_DENIED/);finalDeny=false;
  assert.equal((await store().read(scope,guard))!.revision,2);assert.equal((await pool.query('SELECT authority_revision FROM email_accounts')).rows[0].authority_revision,10);
  await assert.rejects(store().commit({...next,next:{...next.next,bridge:{...next.next.bridge,module_sha256:'e'.repeat(64)}}},guard),/LIFECYCLE_CONFLICT/);
  await assert.rejects(pool.query('UPDATE email_account_consents SET principal_digest=$1,revision=revision+1,native_revision=native_revision+1',['b'.repeat(64)]),/immutable/);
  await assert.rejects(pool.query("UPDATE email_account_consents SET capabilities='[\"read\",\"read\"]',revision=revision+1,native_revision=native_revision+1"),/capabilities_check/);
 });
 await t.test('actual native SQL authority needs no App graph, exact current owner SID and independent local draft consent',async()=>{
  const authority=()=>new PostgresEmailAccountAuthority(database as never,store(),()=>now+2),actor={user_id:scope.owner_user_id,web_session_id:'actual-native-sid',access_expires_at:now+60000};
  statements.length=0;const read=await authority().current(actor,scope,'human_read');const count=statements.length;assert.ok(count<=7,`native authority performed ${count} SQL statements`);assert.ok(statements.every(query=>!/\b(?:from|join)\s+"app_/iu.test(query)),'no App installation/version/grant/binding graph in standalone authority');console.log(JSON.stringify({standalone_authority_sql_statements:count,app_graph_statements:0}));const draft=await authority().current(actor,scope,'human_draft');assert.equal(read.resource_binding_id,retainedBridge(proof.bridge).pins.resource_binding_id);assert.equal(read.expires_at,now+60000);assert.equal(read.authority_version,draft.authority_version);await assert.rejects(authority().current(actor,scope,'human_modify'),/ACCESS_DENIED/);
  await assert.rejects(authority().current({...actor,web_session_id:'foreign-sid'},scope,'human_read'),/ACCESS_DENIED/);await assert.rejects(authority().current(actor,{...scope,account_id:'foreign'},'human_read'),/ACCESS_DENIED/);
  await pool.query("UPDATE web_sessions SET revoked_at=now() WHERE id='actual-native-sid'");await assert.rejects(authority().current(actor,scope,'human_read'),/ACCESS_DENIED/);await pool.query("UPDATE web_sessions SET revoked_at=NULL WHERE id='actual-native-sid'");
  await pool.query("UPDATE users SET kind='agent',is_agent=true");await assert.rejects(authority().current(actor,scope,'human_read'),/ACCESS_DENIED/);await pool.query("UPDATE users SET kind='human',is_agent=false");
  await pool.query('UPDATE org_members SET app_run_authorization_version=app_run_authorization_version+1');assert.notEqual((await authority().current(actor,scope,'human_read')).authority_version,read.authority_version);
 });
 await t.test('fresh native guards lock each participant once and reread caller-owned transaction changes',async()=>{
  const actor={user_id:scope.owner_user_id,web_session_id:'actual-native-sid',access_expires_at:now+60000},authority=new PostgresEmailAccountAuthority(database as never,store(),()=>now+2);
  await assert.rejects(database.transaction(async tx=>{
   statements.length=0;const before=await authority.current(actor,scope,'human_read',tx);assert.equal(statements.length,5);
   const names=statements.map(query=>/from "([^"]+)"/u.exec(query)?.[1]);assert.deepEqual(names,['users','org_members','email_accounts','email_account_consents','web_sessions']);assert.ok(statements.every(query=>query.includes('for share')));
   await tx.execute(sql`UPDATE email_accounts SET authority_revision=authority_revision+1 WHERE account_id=${scope.account_id}`);const changed=await authority.current(actor,scope,'human_read',tx);assert.notEqual(changed.authority_version,before.authority_version,'a later invocation rereads even under held transaction locks');
   await tx.execute(sql`UPDATE web_sessions SET revoked_at=now() WHERE id='actual-native-sid'`);await assert.rejects(authority.current(actor,scope,'human_read',tx),/ACCESS_DENIED/);throw Error('rollback synthetic transaction');
  }),/rollback synthetic transaction/);assert.equal((await pool.query('SELECT authority_revision FROM email_accounts WHERE account_id=$1',[scope.account_id])).rows[0].authority_revision,10);
 });
 await t.test('held SID waits freshly reject revocation and expiry; held account waits observe cancellation',async()=>{
  const actor={user_id:scope.owner_user_id,web_session_id:'actual-native-sid',access_expires_at:now+60000};
  const waitFor=async(table:string,offset:number)=>{for(let n=0;n<200;n++){if(statements.slice(offset).some(q=>q.includes('from "'+table+'"')))return;await new Promise(r=>setTimeout(r,5));}throw Error('Expected authority query not reached');};
  for(const reason of ['revoked','expired','aborted']){const blocker=await pool.connect();try{await blocker.query('BEGIN');const table=reason==='aborted'?'email_accounts':'web_sessions';
    if(table==='email_accounts')await blocker.query('SELECT account_id FROM email_accounts WHERE account_id=$1 FOR UPDATE',[scope.account_id]);else await blocker.query("SELECT id FROM web_sessions WHERE id='actual-native-sid' FOR UPDATE");
    let clock=now+2;const controller=new AbortController(),authority=new PostgresEmailAccountAuthority(database as never,store(),()=>clock),offset=statements.length,reading=authority.current(actor,scope,'human_read',undefined,controller.signal);void reading.catch(()=>{});await waitFor(table,offset);
    if(reason==='revoked')await blocker.query("UPDATE web_sessions SET revoked_at=now() WHERE id='actual-native-sid'");else if(reason==='expired')clock=now+60000;else controller.abort();
    await blocker.query('COMMIT');if(reason==='aborted')await assert.rejects(reading);else await assert.rejects(reading,/ACCESS_DENIED/);
   }finally{await blocker.query('ROLLBACK');blocker.release();await pool.query("UPDATE web_sessions SET revoked_at=NULL WHERE id='actual-native-sid'");}
  }
 });
 await t.test('password revocation user-to-member lock order cannot deadlock against native admission',async()=>{
  const blocker=await pool.connect(),actor={user_id:scope.owner_user_id,web_session_id:'actual-native-sid',access_expires_at:now+60000};
  try{await blocker.query('BEGIN');await blocker.query("SET LOCAL lock_timeout='1500ms'");await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[scope.owner_user_id]);
   const offset=statements.length,reading=new PostgresEmailAccountAuthority(database as never,store(),()=>now+2).current(actor,scope,'human_read');void reading.catch(()=>{});
   for(let n=0;n<200&&!statements.slice(offset).some(q=>q.includes('from "users"'));n++)await new Promise(r=>setTimeout(r,5));assert.ok(statements.slice(offset).some(q=>q.includes('from "users"')));assert.equal(statements.slice(offset).some(q=>q.includes('from "org_members"')),false,'native waits for user before membership');
   await blocker.query('SELECT id FROM org_members WHERE org_id=$1 AND user_id=$2 FOR UPDATE',[scope.org_id,scope.owner_user_id]);await blocker.query("UPDATE users SET kind='agent',is_agent=true WHERE id=$1",[scope.owner_user_id]);await blocker.query('COMMIT');await assert.rejects(reading,/ACCESS_DENIED/);
  }finally{await blocker.query('ROLLBACK');blocker.release();await pool.query("UPDATE users SET kind='human',is_agent=false WHERE id=$1",[scope.owner_user_id]);}
 });
 await t.test('actual standalone service uses current native consent and exact running queue lease after human logout',async()=>{
  const authority=new PostgresEmailAccountAuthority(database as never,store(),()=>now+2),jobId=randomUUID(),lock=randomUUID(),outboxId=randomUUID(),operation=randomUUID();
  // Queue timestamps are UTC timestamp-without-time-zone. Match Drizzle's
  // ISO encoding rather than node-pg's host-local Date parameter rendering.
  await pool.query("INSERT INTO job_queue(id,org_id,name,queue,status,data,locked_by,lock_token,lock_expires_at) VALUES($1,$2,'native-email-outbox','scheduled-jobs','running',$3,'fixture-worker',$4,$5)",[jobId,scope.org_id,{...scope,authority_revision:10,outbox_id:outboxId,operation_id:operation},lock,new Date(now+60000).toISOString()]);
  const lease:EmailServiceLease={job_id:jobId,lock_token:lock,job_name:'native-email-outbox',outbox_id:outboxId,operation_id:operation};await pool.query("UPDATE web_sessions SET revoked_at=now() WHERE id='actual-native-sid'");assert.equal((await authority.currentService(scope,lease)).resource_binding_id,retainedBridge(proof.bridge).pins.resource_binding_id);
  for(const wrong of [{...lease,lock_token:randomUUID()},{...lease,outbox_id:randomUUID()},{...lease,job_name:'native-email-sync'}])await assert.rejects(authority.currentService(scope,wrong as EmailServiceLease),/ACCESS_DENIED/);
  await pool.query('UPDATE job_queue SET lock_expires_at=$1 WHERE id=$2',[new Date(now).toISOString(),jobId]);await assert.rejects(authority.currentService(scope,lease),/ACCESS_DENIED/);await pool.query("UPDATE web_sessions SET revoked_at=NULL WHERE id='actual-native-sid'");
 });
 await t.test('actual owner lifecycle public service and Hono routes adopt, pause/reconnect, CAS, metadata discovery and terminal revocation',async()=>{
  const selected={...scope,account_id:'lifecycle-http'},actor={user_id:scope.owner_user_id,web_session_id:'actual-native-sid',access_expires_at:now+60000};
  await pool.query("INSERT INTO email_accounts(org_id,owner_user_id,account_id,provider,resource_binding_id,principal_digest,state,authority_revision,consented_at) VALUES($1,$2,$3,'gmail',$4,$5,'active',7,$6)",[selected.org_id,selected.owner_user_id,selected.account_id,retainedBridge(proof.bridge).pins.resource_binding_id,proof.principal_digest,new Date(now)]);
  const scheduled:{account_id:string;revision:number}[]=[],owner=new EmailAccountOwnerAuthority(database as never,store(),()=>now+5),fresh=()=>owner.inspect(actor,selected),service=new EmailAccountLifecycleService({
   snapshot:(a,s,signal)=>owner.inspect(a,s,signal),
   schedule:async(s,revision)=>{scheduled.push({account_id:s.account_id,revision});if(revision===10)throw Error('Synthetic enqueue outage; durable active row retained');},
   connection:async(_a,s,snapshot)=>({...proof,scope:s,native_revision:snapshot.account.authority_revision,consent_revision:snapshot.consent?.revision??0,identity:{primary_address:'retained@example.test',display_label:'My native account'}}),
   commit:(a,plan,signal)=>store().commit(plan,owner.guard(a,plan.next.scope,signal),signal),
   catalog:async(a,org)=>{const snapshot=await owner.inspect(a,{...selected,org_id:org}),c=snapshot.consent;return {accounts:[{account_id:selected.account_id,provider:'gmail',authority_mode:c?'standalone':'legacy',state:c?.state??'active',revision:c?.revision??0,native_revision:snapshot.account.authority_revision,primary_address:c?.identity?.primary_address??'',display_label:c?.identity?.display_label??''}],has_more:false};},
  },()=>now+5);
  const routes=createEmailAccountLifecycleRoutes({verify:async token=>{if(token!=='owner')throw Error();return {id:actor.user_id,org_id:selected.org_id,sid:actor.web_session_id,exp:actor.access_expires_at/1000};},service:async()=>service,now:()=>now+5});
  const url='/accounts/'+selected.account_id+'/lifecycle',get=()=>routes.request(url,{headers:{authorization:'Bearer owner'}}),patch=(body:unknown)=>routes.request(url,{method:'PATCH',headers:{authorization:'Bearer owner','content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await get()).headers.get('cache-control'),'no-store');assert.equal((await get()).status,200);assert.equal((await routes.request(url)).status,401);
  let result=await patch({expected_revision:0,expected_native_revision:7,operation:'adopt',capabilities:['read']});assert.equal(result.status,200);let body=await result.json();assert.equal(body.authority_mode,'standalone');assert.equal(body.revision,1);assert.equal(body.native_revision,8);
  assert.equal((await patch({expected_revision:0,expected_native_revision:7,operation:'adopt',capabilities:['read']})).status,409);
  assert.equal((await patch({expected_revision:1,expected_native_revision:8,operation:'pause',provider_draft_ref:'browser-ref'})).status,400);
  result=await patch({expected_revision:1,expected_native_revision:8,operation:'pause'});body=await result.json();assert.equal(body.state,'paused');assert.equal(body.revision,2);assert.equal(body.native_revision,9);
  await assert.rejects(new PostgresEmailAccountAuthority(database as never,store(),()=>now+5).current(actor,selected,'human_read'),/ACCESS_DENIED/);
  const catalog=await routes.request('/accounts/lifecycle',{headers:{authorization:'Bearer owner'}});assert.equal(catalog.status,200);assert.equal((await catalog.json()).accounts[0].primary_address,'retained@example.test');
  const lostAck=await get();assert.equal((await lostAck.json()).revision,2,'ack recovery is a read, not a second mutation');
  result=await patch({expected_revision:2,expected_native_revision:9,operation:'reconnect'});body=await result.json();assert.equal(body.state,'active');assert.equal(body.revision,3);assert.equal(body.native_revision,10);
  const native=new PostgresEmailAccountAuthority(database as never,store(),()=>now+5),router=new EmailAccountAuthorityRouter(database as never,{current:async()=>assert.fail('App graph must not be read after adoption')} as never,native);await router.current(actor,selected,'human_read');await assert.rejects(router.current(actor,selected,'human_modify'),/ACCESS_DENIED/);
  await pool.query("UPDATE web_sessions SET revoked_at=now() WHERE id='actual-native-sid'");assert.equal((await get()).status,403);await pool.query("UPDATE web_sessions SET revoked_at=NULL WHERE id='actual-native-sid'");
  result=await patch({expected_revision:3,expected_native_revision:10,operation:'revoke'});body=await result.json();assert.equal(body.state,'revoked');assert.equal(body.revision,4);assert.equal(body.native_revision,11);await assert.rejects(router.current(actor,selected,'human_read'),/ACCESS_DENIED/);assert.equal((await patch({expected_revision:4,expected_native_revision:11,operation:'reconnect'})).status,409);
  assert.deepEqual(scheduled,[{account_id:selected.account_id,revision:8},{account_id:selected.account_id,revision:10}],'only active consent transitions schedule sync; enqueue outage cannot undo durable consent');const snapshot=await fresh();assert.equal(snapshot.consent?.identity?.display_label,'My native account');const raw=(await pool.query('SELECT bridge_envelope FROM email_account_consents WHERE account_id=$1',[selected.account_id])).rows[0];assert.equal(JSON.stringify(raw).includes('retained@example.test'),false);
 });
 await t.test('router rejects a held legacy admission if explicit owner adoption finishes during its wait',async()=>{
  const selected={...scope,account_id:'legacy-adoption-race'},actor={user_id:scope.owner_user_id,web_session_id:'actual-native-sid',access_expires_at:now+60000};
  await pool.query("INSERT INTO email_accounts(org_id,owner_user_id,account_id,provider,resource_binding_id,principal_digest,state,authority_revision,consented_at) VALUES($1,$2,$3,'gmail',$4,$5,'active',7,$6)",[selected.org_id,selected.owner_user_id,selected.account_id,retainedBridge(proof.bridge).pins.resource_binding_id,proof.principal_digest,new Date(now)]);
  let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{enter=r;}),held=new Promise<void>(r=>{release=r;}),owner=new EmailAccountOwnerAuthority(database as never,store(),()=>now+5);
  const legacy={current:async()=>{enter();await held;return {scope:selected,resource_binding_id:retainedBridge(proof.bridge).pins.resource_binding_id,authority_version:'legacy-before-adoption',expires_at:actor.access_expires_at};}},router=new EmailAccountAuthorityRouter(database as never,legacy as never,new PostgresEmailAccountAuthority(database as never,store(),()=>now+5));
  const reading=router.current(actor,selected,'human_modify');await entered;await store().commit(planEmailAccountAdoption({...proof,scope:selected},['read'],now+5),owner.guard(actor,selected));release();await assert.rejects(reading,/ACCESS_DENIED/);await router.current(actor,selected,'human_read');await assert.rejects(router.current(actor,selected,'human_modify'),/ACCESS_DENIED/);
 });
 await t.test('disconnect/revoke retain every started/uncertain effect and revoked consent cannot reopen',async()=>{
  let current=(await store().read(scope,guard))!;const stopped=planEmailAccountStop(current,{scope,provider:'gmail',principal_digest:current.principal_digest,native_revision:10,consent_revision:2,credential_revision:4},'disconnect',now+3);current=await store().commit(stopped,guard);assert.equal(current.state,'disconnected');assert.equal((await pool.query('SELECT state FROM email_accounts WHERE account_id=$1',[scope.account_id])).rows[0].state,'disconnected');
  const removed=planEmailAccountStop(current,{scope,provider:'gmail',principal_digest:current.principal_digest,native_revision:11,consent_revision:3,credential_revision:4},'revoke',now+4);await store().commit(removed,guard);
  assert.deepEqual((await pool.query('SELECT * FROM preserved_effect_fixture ORDER BY operation_id')).rows,effects);
  await assert.rejects(pool.query("UPDATE email_account_consents SET state='active',revoked_at=NULL,revision=revision+1,native_revision=native_revision+1"),/revoked/);await assert.rejects(pool.query('DELETE FROM email_account_consents'),/retention/);
  revoked=true;await assert.rejects(store().read(scope,guard),/ACCESS_DENIED/);revoked=false;
 });
});

function retainedBridge(bridge: import('../src/lib/email-account-lifecycle.js').EmailAccountBridge){if(bridge.kind!=='retained_registry_v1')throw Error('fixture requires retained bridge');return bridge;}
