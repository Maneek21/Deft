import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import type { AppRunTransaction } from '../src/lib/app-run-repository.js';
import type { ServerType } from '@hono/node-server';
import { createReviewedResourceSyncFixture } from './fixtures/resource-sync-v5.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = (() => {
  if (!target || target !== process.env.DATABASE_URL) return false;
  try { const u = new URL(target); return ['postgres:', 'postgresql:'].includes(u.protocol)
    && u.username === 'gate_g_test' && !u.password && u.hostname === '127.0.0.1' && u.port === '55435'
    && /^\/gate_g_20260926_c13_private_search_test(?:_v[0-9]+)?$/.test(u.pathname)
    && !u.search && !u.hash; } catch { return false; }
})();
process.env.DEFT_APPS_ENABLED = 'true';
process.env.DEFT_APP_RUNS_ENABLED = 'true';
process.env.DEFT_APP_RUN_APP_ORIGIN_ENABLED = 'true';
process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'true';
// This HTTP profile shares its disposable DB/key material with management HTTP.
const ring = (purpose: string) => ({ current: purpose,
  keys: { [purpose]: createHash('sha256').update(`native-reference:${purpose}`).digest('base64') } });
process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
  run_encryption: ring('mgmt-enc'), receipt_signing: ring('mgmt-sign'), fingerprint: ring('mgmt-fp') });
after(async () => {
  await (await import('../src/lib/app-run-runtime.js')).shutdownAppRunRuntime();
  await (await import('../src/lib/db.js')).closeDb();
});

async function harness(shortConsentMs?: number, large = false) {
  const [{ db }, schema, drizzle, webSessions, runtimeModule, privateRoutes, channelRoutes,
    managementRoutes, hono, serverModule] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'),
    import('../src/lib/web-sessions.js'), import('../src/lib/app-run-runtime.js'),
    import('../src/routes/app-resource-private-read.js'), import('../src/routes/app-resource-sync-channel.js'),
    import('../src/routes/app-resource-sync-management.js'), import('hono'), import('@hono/node-server'),
  ]);
  const runtime = await runtimeModule.getAppRunRuntime();
  const fixture = await createReviewedResourceSyncFixture({ keys: runtime.keys, clock: () => new Date(),
    ...(large ? { descriptor: { schema_version:'deft.app_sync_descriptor.v1' as const,key:'inbox',runtime_requirement_key:'provider',resource_type:'email_message',requested_visibility:'user_private' as const,label_field:'subject',record_schema:{type:'object' as const,properties:{subject:{type:'string' as const,maxLength:200},...Object.fromEntries(Array.from({length:31},(_,i)=>[`field_${i}`,{type:'string' as const,maxLength:16384}]))},required:['subject'],additionalProperties:false as const}} } : {}) });
  const token = async (id: string, orgId = fixture.org_id) => {
    const [user] = await db.select().from(schema.users).where(drizzle.eq(schema.users.id, id));
    return webSessions.createWebSession({ id, org_id: orgId, email: user!.email });
  };
  const owner = await token(fixture.owner_user_id);
  const operator = await token(fixture.operator_user_id);
  const app = new hono.Hono();
  app.route('/read', privateRoutes.appResourcePrivateReadRoutes);
  app.route('/sync', channelRoutes.appResourceSyncChannelRoutes);
  app.route('/manage', managementRoutes.appResourceSyncManagementRoutes);
  let server!: ServerType;
  const base = await new Promise<string>(resolve => {
    server = serverModule.serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
      info => resolve(`http://127.0.0.1:${info.port}`));
  });
  const call = async (path: string, auth = `Bearer ${owner.accessToken}`, method = 'GET', value?: unknown) => {
    const response = await fetch(`${base}${path}`, { method,
      headers: { ...(auth ? { Authorization: auth } : {}),
        ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    if (path.startsWith('/read/')) assert.equal(response.headers.get('pragma'), 'no-cache');
    return { status: response.status, body: await response.json() as any };
  };
  let bindingId = fixture.binding_id;
  let expiresAt = fixture.consent_request.consent_expires_at;
  if (shortConsentMs) {
    await fixture.management.revokeConsent(fixture.owner_actor, fixture.binding_id);
    const request = { ...fixture.consent_request, consent_expires_at: new Date(Date.now() + shortConsentMs).toISOString() };
    const review = await fixture.management.prepareConsent(fixture.owner_actor, request);
    const activated = await fixture.management.activateConsent(fixture.owner_actor, { ...request,
      expected_review_digest: review.review_digest, accept_host_policy: true });
    bindingId = activated.binding_id;
    expiresAt = request.consent_expires_at;
  }
  const issued = await call(`/manage/bindings/${bindingId}/sessions`, `Bearer ${operator.accessToken}`, 'POST');
  assert.equal(issued.status, 201);
  const session = issued.body.session;
  const admitted = await runtime.resourceSyncAdmission.admitDue({ org_id: fixture.org_id, resource_binding_id: bindingId });
  assert.equal(admitted.state, 'created');
  const identity = { schema_version: 'deft.app_runtime_channel.v2', audience: 'app_resource_sync', session_id: session.session_id };
  const runtimeAuth = `AppRuntime ${session.session_token}`;
  const claimed = await call('/sync/claim', runtimeAuth, 'POST', { ...identity, max_claims: 1 });
  assert.equal(claimed.status, 200);
  const claim = claimed.body.claim;
  assert.ok(claim);
  const attempt = { ...identity, run_id: claim.run_id, attempt_id: claim.attempt_id,
    claim_token: claim.claim_token, sequence: claim.sequence };
  assert.equal((await call('/sync/start', runtimeAuth, 'POST', attempt)).status, 200);
  const completed = await call('/sync/result', runtimeAuth, 'POST', { ...attempt,
    status: 'returned', provider_succeeded: true, page: { schema_version: 'deft.app_sync_page.v1',
      upserts: Array.from({ length: large ? 1 : 100 }, (_, i) => ({ id: `provider-private-${i}`, revision: `r${i}`,
        data: { subject: `Private HTTP record ${String(i).padStart(3,'0')} END`, ...(large ? Object.fromEntries(Array.from({length:31},(_,j)=>[`field_${j}`,'x'.repeat(16384)])) : {}) } })), tombstones: [],
      next_cursor: 'provider-private-cursor', has_more: false } });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.accepted, true);
  const marker = `private-http-${fixture.org_id}`;
  const originalTransaction = runtime.repository.transaction.bind(runtime.repository);
  runtime.repository.transaction = <T>(work: (tx: AppRunTransaction) => Promise<T>) => originalTransaction(async tx => {
    await tx.execute(drizzle.sql`SELECT set_config('application_name', ${marker}, true)`);
    return work(tx);
  });
  return { db, schema, ...drizzle, ...fixture, binding_id: bindingId, expires_at: expiresAt, marker,
    owner, operator, runtime, webSessions, call, token, runtimeAuth, runtime_session: session,
    close: () => { runtime.repository.transaction = originalTransaction;
      return new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); } };
}

async function waitForLock(h: Awaited<ReturnType<typeof harness>>, table: string) {
  for (let i = 0; i < 250; i++) {
    const result = await h.db.execute(h.sql<{ waiting: number }>`SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname=current_database() AND pid <> pg_backend_pid() AND wait_event_type='Lock'
        AND application_name = ${h.marker}
        AND query LIKE ${`%${table}%`}`);
    if (result.rows[0]!.waiting > 0) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`actual HTTP request did not wait on ${table}`);
}


async function addPage(h: Awaited<ReturnType<typeof harness>>, offset=0) {
    const [{AppRunSecretService},{AppResourceSyncSecretService},{AppRunAttemptRunner},
      {PinnedMcpAppRunProviderExecutor},{PostgresAppRunReceiptWriter},queue,
      {AppResourceSyncStore},{AppResourceSyncAdmissionService},{AppResourceSyncChannel}]=await Promise.all([
      import('../src/lib/app-run-secrets.js'),import('../src/lib/app-resource-sync-secrets.js'),
      import('../src/lib/app-run-attempt-runner.js'),import('../src/lib/app-run-provider-executor.js'),
      import('../src/lib/app-run-receipts.js'),import('../src/lib/app-run-scheduler.js'),
      import('../src/lib/app-resource-sync-store.js'),import('../src/lib/app-resource-sync-admission.js'),
      import('../src/lib/app-resource-sync-channel.js')]);
    const checkedAt=new Date(Date.now()+61_000*(offset+1));const clock=()=>new Date(checkedAt);
    const secrets=new AppRunSecretService(h.runtime.keys),syncSecrets=new AppResourceSyncSecretService(h.runtime.keys);
    const writer=new PostgresAppRunReceiptWriter(secrets,h.runtime.secretRepository);
    const runner=new AppRunAttemptRunner(h.runtime.repository,h.runtime.secretRepository,secrets,
      new PinnedMcpAppRunProviderExecutor(),undefined,clock,60_000,20_000,writer,undefined,
      queue.postgresAppRunAttemptQueue,new AppResourceSyncStore(syncSecrets,h.runtime.secretRepository));
    const admission=new AppResourceSyncAdmissionService(h.runtime.repository,h.runtime.secretRepository,secrets,syncSecrets,runner,clock,()=>true);
    assert.equal((await admission.admitDue({org_id:h.org_id,resource_binding_id:h.binding_id})).state,'created');
    const channel=new AppResourceSyncChannel(runner);
    const base={schema_version:'deft.app_runtime_channel.v2' as const,audience:'app_resource_sync' as const,
      session_id:h.runtime_session.session_id,session_token:h.runtime_session.session_token};
    const claim=await channel.claim({...base,max_claims:1});assert.ok(claim);
    const attempt={...base,run_id:claim.run_id,attempt_id:claim.attempt_id,claim_token:claim.claim_token,sequence:claim.sequence};
    assert.ok(await channel.start(attempt));
    assert.ok(await channel.complete({...attempt,status:'returned',provider_succeeded:true,page:{schema_version:'deft.app_sync_page.v1',upserts:Array.from({length:Object.keys(h.descriptor.record_schema.properties).length>1?1:5},(_,i)=>({id:`provider-private-${100+offset*5+i}`,revision:`r${100+offset*5+i}`,data:{subject:`Private HTTP record ${100+offset*5+i} END`,...Object.fromEntries(Object.keys(h.descriptor.record_schema.properties).filter(k=>k!=='subject').map(k=>[k,'x'.repeat(16384)]))}})),tombstones:[],next_cursor:null,has_more:false}}));

}
const request = (query: string, cursor?: string) => ({ query, field_keys: ['subject'], ...(cursor ? { cursor } : {}) });
test('owner search exhausts beyond100records without treating an empty first scan as complete', { skip: !safe }, async () => {
 const h=await harness();try{
  await addPage(h);
  const scope=await h.call(`/read/bindings/${h.binding_id}/search-scope`);assert.equal(scope.status,200);
  assert.deepEqual(scope.body.field_keys,['subject']);assert.deepEqual(Object.keys(scope.body).sort(),['consent_expires_at','field_keys','label_field']);
  const rows=await h.db.select({id:h.schema.appResourceProjections.id}).from(h.schema.appResourceProjections)
   .where(h.eq(h.schema.appResourceProjections.resource_binding_id,h.binding_id)).orderBy(h.asc(h.schema.appResourceProjections.id));
  assert.equal(rows.length,105);const last=await h.call(`/read/bindings/${h.binding_id}/records/${rows.at(-1)!.id}`);
  const path=`/read/bindings/${h.binding_id}/search`;
  const first=await h.call(path,undefined,'POST',request(last.body.item.label));assert.equal(first.status,200);
  assert.equal(first.body.items.length,0);assert.equal(first.body.scan.records_scanned,100);assert.equal(first.body.scan.complete,false);assert.ok(first.body.next_cursor);
  const second=await h.call(path,undefined,'POST',request(last.body.item.label,first.body.next_cursor));assert.equal(second.status,200);
  assert.equal(second.body.scan.records_scanned,5);assert.equal(second.body.scan.complete,true);assert.equal(second.body.next_cursor,null);assert.equal(second.body.items.length,1);
  assert.equal(second.body.items[0].ref.resource_id,rows.at(-1)!.id);assert.equal(second.body.freshness,'unknown');
  let cursor,scanned=0;const ids:string[]=[];do{const p=await h.call(path,undefined,'POST',request('Private HTTP record',cursor));assert.equal(p.status,200);
   scanned+=p.body.scan.records_scanned;ids.push(...p.body.items.map((x:any)=>x.ref.resource_id));cursor=p.body.next_cursor;
   assert.equal(p.body.scan.complete,cursor===null);assert.ok(p.body.items.length<=25);
  }while(cursor);assert.equal(scanned,105);assert.equal(ids.length,105);assert.equal(new Set(ids).size,105);
  assert.equal((await h.call(second.body.items[0].href.replace('/app-resources/','/read/references/'))).status,200);
 }finally{await h.close();}
});
test('search cursor is purpose scoped to exactquery fields owner SID consent and coherent checkpoint', { skip: !safe }, async()=>{
 const h=await harness();try{const path=`/read/bindings/${h.binding_id}/search`;const p=await h.call(path,undefined,'POST',request('Private HTTP record'));assert.equal(p.status,200);
  const token=p.body.next_cursor;assert.ok(token);const decoded=JSON.parse(Buffer.from(token.split('.')[0],'base64url').toString());
  assert.deepEqual(Object.keys(decoded).sort(),['after','checkpoint_scope','expires_at','identity_scope','key_version','query_fields_scope','version']);
  assert.ok(!JSON.stringify(decoded).includes(h.binding_id));assert.ok(!JSON.stringify(decoded).includes(h.org_id));assert.ok(!JSON.stringify(decoded).includes('Private HTTP'));
  const next=await h.call(path,undefined,'POST',request('Private HTTP record',token));assert.equal(next.status,200);
  assert.equal(JSON.parse(Buffer.from(next.body.next_cursor.split('.')[0],'base64url').toString()).expires_at,decoded.expires_at);
  assert.equal((await h.call(path,undefined,'POST',request('other',token))).status,404);
  assert.equal((await h.call(path,undefined,'POST',{query:'Private HTTP record',field_keys:['subject','subject'],cursor:token})).status,400);
  assert.equal((await h.call(path,undefined,'POST',{query:'Private HTTP record',field_keys:['undeclared']})).status,400);
  assert.equal((await h.call(path,undefined,'POST',{...request('Private HTTP record'),unknown:true})).status,400);
  assert.equal((await h.call(path+'?x=1&x=2',undefined,'POST',request('x'))).status,400);
  assert.equal((await h.call(path,undefined,'POST',request('Private HTTP record',token.slice(0,-1)+'!'))).status,404);
  const replacement=await h.token(h.owner_user_id);assert.equal((await h.call(path,`Bearer ${replacement.accessToken}`,'POST',request('Private HTTP record',token))).status,404);
  assert.equal((await h.call(path,`Bearer ${h.operator.accessToken}`,'POST',request('Private HTTP record'))).status,404);
  const oldPage=await h.call(`/read/bindings/${h.binding_id}/records?limit=2`);assert.equal((await h.call(path,undefined,'POST',request('Private HTTP record',oldPage.body.next_cursor))).status,404);
  await addPage(h);assert.equal((await h.call(path,undefined,'POST',request('Private HTTP record',token))).status,409);
  await h.management.revokeConsent(h.owner_actor,h.binding_id);assert.equal((await h.call(path,undefined,'POST',request('Private HTTP record'))).status,404);
  assert.equal((await h.call(`/read/bindings/${h.binding_id}/search-scope`)).status,404);
 }finally{await h.close();}
});
test('search final owner authority denies gate withdrawal after actual SID wait and settles lock timeout', {skip:!safe},async()=>{
 const h=await harness();try{const sid=JSON.parse(Buffer.from(h.owner.accessToken.split('.')[1]!, 'base64url').toString()).sid;
  let locked!:()=>void,release!:()=>void;const acquired=new Promise<void>(r=>locked=r),hold=new Promise<void>(r=>release=r);
  const blocker=h.db.transaction(async tx=>{await tx.execute(h.sql`SELECT id FROM web_sessions WHERE id=${sid} FOR UPDATE`);locked();await hold;});await acquired;
  const pending=h.call(`/read/bindings/${h.binding_id}/search`,undefined,'POST',request('Private HTTP record'));
  for(let i=0;i<100;i++){const r=await h.db.execute(h.sql<{n:number}>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND application_name='deft-experience-exposure' AND wait_event_type='Lock' AND query LIKE '%web_sessions%'`);if(r.rows[0]!.n>0)break;await new Promise(r=>setTimeout(r,5));if(i===99)assert.fail('search did not actually wait on SID');}
  process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED='false';release();await blocker;
  assert.equal((await pending).status,404);process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED='true';
  let locked2!:()=>void,release2!:()=>void;const acquired2=new Promise<void>(r=>locked2=r),hold2=new Promise<void>(r=>release2=r);
  const blocker2=h.db.transaction(async tx=>{await tx.execute(h.sql`SELECT id FROM web_sessions WHERE id=${sid} FOR UPDATE`);locked2();await hold2;});await acquired2;
  const start=Date.now();const timed=await h.call(`/read/bindings/${h.binding_id}/search`,undefined,'POST',request('Private HTTP record'));assert.equal(timed.status,500);assert.ok(Date.now()-start<2000);release2();await blocker2;
  assert.equal((await h.call(`/read/bindings/${h.binding_id}/search`,undefined,'POST',request('Private HTTP record'))).status,200);
 }finally{process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED='true';await h.close();}
});
test('search encrypted byte preflight advances contiguous rows without skips across1MiB', {skip:!safe},async()=>{
 const h=await harness(undefined,true);try{await addPage(h);await addPage(h,1);
  const sizes=await h.db.select({bytes:h.schema.appResourceProjections.body_bytes}).from(h.schema.appResourceProjections).where(h.eq(h.schema.appResourceProjections.resource_binding_id,h.binding_id));
  assert.equal(sizes.length,3);assert.ok(sizes.reduce((n,r)=>n+r.bytes,0)>1048576);
  const path=`/read/bindings/${h.binding_id}/search`;const first=await h.call(path,undefined,'POST',request('Private HTTP record'));
  assert.equal(first.status,200);assert.equal(first.body.scan.records_scanned,2);assert.equal(first.body.items.length,2);assert.ok(first.body.next_cursor);assert.equal(first.body.scan.complete,false);
  const second=await h.call(path,undefined,'POST',request('Private HTTP record',first.body.next_cursor));assert.equal(second.status,200);
  assert.equal(second.body.scan.records_scanned,1);assert.equal(second.body.items.length,1);assert.equal(second.body.scan.complete,true);
  assert.equal(new Set([...first.body.items,...second.body.items].map((x:any)=>x.ref.resource_id)).size,3);
 }finally{await h.close();}
});
test('search aborted while waiting settles rollback and expired signedcursor never refreshes', {skip:!safe},async()=>{
 const h=await harness();try{const [{AppResourcePrivateReadService},{privateSearchDatabase},{resourceSyncWebAuthority},cursor]=await Promise.all([
  import('../src/lib/app-resource-private-read.js'),import('../src/lib/app-resource-private-search-db.js'),import('../src/lib/app-resource-sync-web-authority.js'),import('../src/lib/app-resource-private-search-cursor.js')]);
  const auth=await resourceSyncWebAuthority(`Bearer ${h.owner.accessToken}`),controller=new AbortController(),database=privateSearchDatabase();
  const service=new AppResourcePrivateReadService(h.runtime.keys,()=>new Date(),{transaction:work=>database.transaction(work,controller.signal)},auth.guard);
  let lock!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>lock=r),hold=new Promise<void>(r=>release=r);
  const blocker=h.db.transaction(async tx=>{await tx.execute(h.sql`SELECT id FROM web_sessions WHERE id=${auth.web_session.sid} FOR UPDATE`);lock();await hold;});await ready;
  const pending=service.searchOwnerPrivateResources({kind:'human',org_id:h.org_id,user_id:h.owner_user_id},{resource_binding_id:h.binding_id,...request('Private HTTP record')},auth.web_session.sid,controller.signal);
  for(let i=0;i<100;i++){const r=await h.db.execute(h.sql<{n:number}>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND application_name='deft-experience-exposure' AND wait_event_type='Lock' AND query LIKE '%web_sessions%'`);if(r.rows[0]!.n>0)break;await new Promise(r=>setTimeout(r,5));if(i===99)assert.fail('actual search abort SID wait missing');}
  const rejected=assert.rejects(pending,{name:'AbortError'});controller.abort();release();await blocker;await rejected;
  const active=await h.db.execute(h.sql<{n:number}>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND application_name='deft-experience-exposure' AND state='idle in transaction'`);assert.equal(active.rows[0]!.n,0);
  const path=`/read/bindings/${h.binding_id}/search`,p=await h.call(path,undefined,'POST',request('Private HTTP record'));assert.equal(p.status,200);
  const opened=cursor.openPrivateSearchCursor(h.runtime.keys,p.body.next_cursor);
  const expired=cursor.sealPrivateSearchCursor(h.runtime.keys,{after:opened.after,identity_scope:opened.identity_scope,checkpoint_scope:opened.checkpoint_scope,query_fields_scope:opened.query_fields_scope,expires_at:Date.now()-1});
  assert.equal((await h.call(path,undefined,'POST',request('Private HTTP record',expired))).status,404);
 }finally{await h.close();}
});
test('search scope and snippets remain exactowner only across org agent credentials and retired SID wait', {skip:!safe},async()=>{
 const h=await harness();let release=()=>{};try{const path=`/read/bindings/${h.binding_id}/search`;
  for(const auth of['',h.runtimeAuth,`Bearer ${h.owner.refreshToken}`])assert.equal((await h.call(path,auth,'POST',request('Private'))).status,401);
  const agentId=randomUUID();await h.db.insert(h.schema.users).values({id:agentId,name:'Search agent',email:`${agentId}@example.test`,kind:'agent',is_agent:true});
  await h.db.insert(h.schema.orgMembers).values({org_id:h.org_id,user_id:agentId,role:'member',is_active:true});const agent=await h.token(agentId);
  assert.equal((await h.call(path,`Bearer ${agent.accessToken}`,'POST',request('Private'))).status,403);
  const foreign=randomUUID();await h.db.insert(h.schema.orgs).values({id:foreign,name:'Search foreign',slug:foreign});await h.db.insert(h.schema.orgMembers).values({org_id:foreign,user_id:h.owner_user_id,role:'owner',is_active:true});const other=await h.token(h.owner_user_id,foreign);
  assert.equal((await h.call(path,`Bearer ${other.accessToken}`,'POST',request('Private'))).status,404);
  const sid=JSON.parse(Buffer.from(h.owner.accessToken.split('.')[1]!,'base64url').toString()).sid;
  let lock!:()=>void;const ready=new Promise<void>(r=>lock=r),hold=new Promise<void>(r=>release=r);
  const blocker=h.db.transaction(async tx=>{await tx.execute(h.sql`SELECT id FROM web_sessions WHERE id=${sid} FOR UPDATE`);lock();await hold;await tx.update(h.schema.webSessions).set({revoked_at:new Date()}).where(h.eq(h.schema.webSessions.id,sid));});await ready;
  const pending=h.call(path,undefined,'POST',request('Private'));
  for(let i=0;i<100;i++){const r=await h.db.execute(h.sql<{n:number}>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND application_name='deft-experience-exposure' AND wait_event_type='Lock' AND query LIKE '%web_sessions%'`);if(r.rows[0]!.n>0)break;await new Promise(r=>setTimeout(r,5));if(i===99)assert.fail('retirement did not wait on exactSID');}
  release();await blocker;const denied=await pending;assert.equal(denied.status,401);assert.deepEqual(Object.keys(denied.body).sort(),['code','error']);
 }finally{release();await h.close();}
});
test('bounded exposure search factory closes a dropped established BEGIN response at deadline', {skip:!safe,timeout:5000},async()=>{
 const net=await import('node:net');let connection:import('node:net').Socket|undefined,ready=false,closed=false;
  const completed=(command:string)=>{const text=Buffer.from(command+'\0'),size=Buffer.alloc(4);size.writeInt32BE(text.length+4);return Buffer.concat([Buffer.from('C'),size,text,Buffer.from([90,0,0,0,5,73])]);};let drain=false;
 const fake=net.createServer(socket=>{connection=socket;socket.on('close',()=>closed=true);socket.once('data',()=>{socket.write(Buffer.from([82,0,0,0,8,0,0,0,0,90,0,0,0,5,73]));ready=true;socket.on('data',data=>{if(data[0]===88)socket.end();else if(drain)socket.write(completed('ROLLBACK'));});});});
 await new Promise<void>(r=>fake.listen(0,'127.0.0.1',r));const port=(fake.address() as import('node:net').AddressInfo).port;
 const {createExperienceExposureDatabase}=await import('../src/lib/app-experience-exposure-db.js');const database=createExperienceExposureDatabase(`postgresql://synthetic@127.0.0.1:${port}/synthetic`);
 let settled=false;const pending=database.transaction(async()=>1,undefined,performance.now()+150).catch(()=>{settled=true;});
 try{await new Promise(r=>setTimeout(r,450));assert.ok(ready);assert.equal(settled,true,'dropped established response must settle by operation deadline');assert.equal(closed,true,'socket must be discarded');}
 finally{drain=true;if(!settled)connection?.write(completed('BEGIN'));await pending;await database.close();connection?.destroy();await new Promise<void>(r=>fake.close(()=>r()));}
});
