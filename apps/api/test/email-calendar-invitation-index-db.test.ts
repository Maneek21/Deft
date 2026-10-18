import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
const target='postgresql://gate_g_test@127.0.0.1:55435/email_stage34_chat_90_fresh';
const safe=process.env.DATABASE_URL===target&&process.env.DEFT_TEST_DATABASE_URL===target;
test('actual source90 API index Calendar mount requires real owner SID and rejects caller ICS before provider I/O',{skip:!safe,timeout:180000},async t=>{
 Object.assign(process.env,{NODE_ENV:'test',DEFT_NATIVE_EMAIL_ENABLED:'true',DEFT_APPS_ENABLED:'true',DEFT_APP_RUNS_ENABLED:'true',JWT_SECRET:'synthetic-calendar-mounted-access-only',JWT_REFRESH_SECRET:'synthetic-calendar-mounted-refresh-only'});
 process.env.DEFT_APP_RUN_KEYRINGS=JSON.stringify({schema_version:'deft.app_run_keyring.v1',...Object.fromEntries(['run_encryption','receipt_signing','fingerprint'].map(purpose=>[purpose,{current:'calendar-mounted-'+purpose,keys:{['calendar-mounted-'+purpose]:createHash('sha256').update('calendar-index-fixture:'+purpose).digest('base64')}}]))});
 const [{db,closeDb},schema,sessions,{eq}]=await Promise.all([import('../src/lib/db.js'),import('@deft/db/schema'),import('../src/lib/web-sessions.js'),import('drizzle-orm')]);
 const org=randomUUID(),owner=randomUUID();await db.insert(schema.orgs).values({id:org,name:'Calendar mount fixture',slug:'calendar-'+org});await db.insert(schema.users).values({id:owner,name:'Calendar fixture owner',email:owner+'@example.test'});await db.insert(schema.orgMembers).values({org_id:org,user_id:owner,role:'owner'});
 t.after(async()=>{try{await db.delete(schema.orgMembers).where(eq(schema.orgMembers.org_id,org));await db.delete(schema.users).where(eq(schema.users.id,owner));await db.delete(schema.orgs).where(eq(schema.orgs.id,org));}finally{await closeDb();}});
 const pair=await sessions.createWebSession({id:owner,org_id:org,email:owner+'@example.test'}),priorFetch=globalThis.fetch;let providerCalls=0;
 globalThis.fetch=(async()=>{providerCalls++;throw Error('unexpected provider I/O');}) as typeof fetch;t.after(()=>{globalThis.fetch=priorFetch;});
 const {app}=await import('../src/index.js'),base='/api/email/accounts/fixture-account',logical='mail_'+'e'.repeat(64);
 for(const [path,method]of [[base+'/messages/'+logical+'/invitations','GET'],[base+'/invitations/requests/'+randomUUID(),'GET'],[base+'/invitations/apply','POST']])assert.equal((await app.request(path!,{method:method!})).status,401);
 const headers={Authorization:'Bearer '+pair.accessToken,'Content-Type':'application/json'};
 for(const body of ['{bad',JSON.stringify({request_id:randomUUID(),preview_token:'caller-forged',destination_id:'deft_personal',action:{kind:'rsvp',response:'accepted',send_response:true},ics_text:'BEGIN:VCALENDAR',recipients:['attacker@example.test']})]){
  const response=await app.request(base+'/invitations/apply',{method:'POST',headers,body});assert.equal(response.status,400);assert.equal(response.headers.get('cache-control'),'no-store');
 }
 assert.equal(providerCalls,0);
});
