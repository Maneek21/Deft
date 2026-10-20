import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
function disposable(){try{const raw=process.env.DEFT_E2_TEST_DATABASE_URL;if(!raw||raw!==process.env.DATABASE_URL)return false;
 const u=new URL(raw);return ['postgres:','postgresql:'].includes(u.protocol)&&u.hostname==='127.0.0.1'&&u.port==='33954'
  &&u.username==='e2_connection_test'&&u.pathname==='/e3_reattach_process_20261010'&&!u.search&&!u.hash;}catch{return false;}}

// Applies candidate SQL only inside the transaction. Every synthetic write and
// DDL change is rolled back; existing fixture and completed history stay intact.
test('Postgres upgrade CAS seals Begin against pending effects and permanently fences the old source',
 {skip:!disposable(),timeout:60000},async t=>{
 const [{db,closeDb},s,{sql,eq},storeModule,serviceModule,fenceModule]=await Promise.all([
  import('../src/lib/db.js'),import('@deft/db/schema'),import('drizzle-orm'),import('../src/lib/app-connection-session-store.js'),
  import('../src/lib/app-connection-session-service.js'),import('../src/lib/app-connection-upgrade-fence.js')]);
 t.after(closeDb);
 assert.equal((await db.execute(sql`SELECT current_database() AS name`)).rows[0]?.name,'e3_reattach_process_20261010');
 const rollback=Symbol('rollback fixture');let checks=0;
 await assert.rejects(db.transaction(async tx=>{
  await tx.execute(sql.raw(await readFile(new URL('../../../packages/db/upgrades/0.3.0-preview.99-app-connection-upgrade.sql',import.meta.url),'utf8')));
  // Source fences query form carriers. Install only that dependency and the
  // candidate closure functions inside this same rollback-only transaction.
  for(const file of ['0.3.0-preview.101-app-connection-forms.sql','0.3.0-preview.108-app-connection-upgrade-expiry.sql','0.3.0-preview.128-app-upgrade-callback-recovery.sql'])
   await tx.execute(sql.raw(await readFile(new URL('../../../packages/db/upgrades/'+file,import.meta.url),'utf8')));
  const [row]=await tx.select().from(s.appConnectionSessions).where(sql`${s.appConnectionSessions.record}->>'state'='connected'`)
   .orderBy(sql`${s.appConnectionSessions.created_at} DESC`).limit(1);assert.ok(row);
  const source=serviceModule.AppConnectionSessionRecordSchema.parse(row.record),before=structuredClone(source);
  const caller={org_id:row.org_id,user_id:row.owner_user_id,sid:row.web_session_id,access_expires_at:Date.now()+900000};
  const store=new storeModule.PostgresAppConnectionSessionStore(tx as unknown as typeof db,caller),hash='sha256:'+'a'.repeat(64);
  const now=new Date().toISOString(),expiry=new Date(Math.min(Date.now()-1000,Date.parse(source.scope.consent_expires_at))).toISOString();
  const {action_consent:_,reattachment:__,upgrade:___,action_consents:____,...base}=source;
  let record=serviceModule.AppConnectionSessionRecordSchema.parse({...base,session_id:randomUUID(),revision:0,state:'starting',account:null,
   callback_consumed:false,callback_state_hash:'b'.repeat(64),callback_expires_at:expiry,runtime_session_ref:null,created_at:now,updated_at:now,
   action_consents:[],upgrade:{schema_version:'deft.app_connection_upgrade.v1',source:{session_id:source.session_id,session_revision:source.revision,
    scope:source.scope,runtime_session_ref:source.runtime_session_ref,account_ref:source.account!.account_ref},transport_digest:hash,
    review_expires_at:expiry,begin_consumed:false,review:null,receipt:null}});
  assert.equal(await store.create(record),true);checks++;
  const locator={org_id:caller.org_id,owner_user_id:caller.user_id,session_id:record.session_id};
  async function write(change:Partial<typeof record>){const next={...record,...change,revision:record.revision+1,updated_at:new Date().toISOString()};
   const saved=await store.compareAndSet(locator,record.revision,next);if(saved)record=serviceModule.AppConnectionSessionRecordSchema.parse(next);return saved;}
  assert.equal(await write({state:'upgrade_reviewed',upgrade:{...record.upgrade!,review:{account:source.account!,custody_generation:2,custody_digest:hash,digest:hash}}}),true);
  assert.equal(await fenceModule.appConnectionUpgradeSourceIsAvailable(tx,{org_id:caller.org_id,session_id:source.session_id}),true);checks+=2;
  const [binding]=await tx.select().from(s.appResourceBindings).where(eq(s.appResourceBindings.id,source.scope.resource_binding_id));assert.ok(binding);
  const beginChange={state:'upgrade_starting' as const,callback_state_hash:'c'.repeat(64),upgrade:{...record.upgrade!,begin_consumed:true}};
  for(const state of ['pending','unknown_outcome'] as const){const savepoint=Symbol(state);
   await assert.rejects(tx.transaction(async effectTx=>{
    const id=randomUUID(),created=new Date(),expires=new Date(Date.now()+3600000),fingerprint=(name:string)=>'hmac-sha256:'+createHash('sha256').update(id+name).digest('hex');
    await effectTx.insert(s.appRuns).values({id,org_id:caller.org_id,contract_version:'deft.app_run.v1',origin_kind:'app',
     initiating_actor_type:'system',initiating_actor_id:binding!.id,execution_actor_type:'system',execution_actor_id:binding!.id,
     provider_kind:'app_runtime',provider_instance_id:binding!.provider_instance_id,operation_name:binding!.operation_name,provider_snapshot_id:binding!.provider_snapshot_id,
     origin_app_installation_id:source.scope.installation_id,origin_app_version_id:binding!.app_version_id,origin_app_grant_snapshot_id:binding!.grant_snapshot_id,
     origin_resource_binding_id:binding!.id,state,risk_class:binding!.risk_class,review_requirement:binding!.review_requirement,review_scope:'reviewed_resource_sync',
     retry_class:binding!.retry_class,retention_class:'standard',idempotency_key_version:'synthetic',idempotency_fingerprint:fingerprint('id'),
     input_fingerprint_key_version:'synthetic',input_fingerprint:fingerprint('input'),authorization_snapshot:{synthetic:true},safe_preview:{synthetic:true},root_run_id:id,
     input_expires_at:expires,result_expires_at:expires,idempotency_expires_at:expires,attempt_limit:1,execution_release_kind:'policy_satisfied',execution_released_at:created,
     ...(state==='unknown_outcome'?{unknown_outcome_at:created}:{})});
    const guarded=new storeModule.PostgresAppConnectionSessionStore(effectTx as unknown as typeof db,caller);
    assert.equal(await guarded.compareAndSet(locator,record.revision,{...record,...beginChange,revision:record.revision+1}),false);
    assert.equal((await guarded.read(locator))!.upgrade!.begin_consumed,false);checks+=2;
    const started={...record,...beginChange,revision:record.revision+1},checking={...started,state:'upgrade_checking' as const,revision:started.revision+1};
    for(const seeded of [started,checking])await effectTx.update(s.appConnectionSessions).set({revision:seeded.revision,record:seeded}).where(eq(s.appConnectionSessions.session_id,record.session_id));
    assert.equal(await guarded.compareAndSet(locator,checking.revision,{...checking,revision:checking.revision+1,state:'not_connected',
     upgrade:{...checking.upgrade,closure:{reason:'callback_expired',custody_generation:3,receipt_digest:hash}}}),false);checks++;throw savepoint;
   }),error=>error===savepoint);
  }
  assert.equal(await write(beginChange),true);checks++;
  assert.equal(await fenceModule.appConnectionUpgradeSourceIsAvailable(tx,{org_id:caller.org_id,session_id:source.session_id}),false);
  assert.equal(await fenceModule.appConnectionUpgradeSourceIsAvailable(tx,{org_id:caller.org_id,resource_binding_id:source.scope.resource_binding_id}),false);checks+=2;
  assert.equal(await store.compareAndSet(locator,record.revision,{...record,revision:record.revision+1,upgrade:{...record.upgrade!,begin_consumed:false}}),false);checks++;
  assert.equal(await write({state:'awaiting_callback',runtime_session_ref:'synthetic_upgrade'}),true);
  for(const hostConsumed of [false,true]){
  const closureSavepoint=Symbol('closure proof');
  await assert.rejects(tx.transaction(async closureTx=>{
   const guarded=new storeModule.PostgresAppConnectionSessionStore(closureTx as unknown as typeof db,caller);
   let pending=record;
   if(hostConsumed){pending={...record,state:'connecting',callback_consumed:true,revision:record.revision+1};assert.equal(await guarded.compareAndSet(locator,record.revision,pending),true);checks++;}
   const checking={...pending,state:'upgrade_checking' as const,revision:pending.revision+1};
   assert.equal(await guarded.compareAndSet(locator,pending.revision,checking),true);checks++;
   const closed={...checking,revision:checking.revision+1,state:'not_connected' as const,upgrade:{...checking.upgrade,closure:{reason:'callback_expired' as const,custody_generation:3,receipt_digest:hash}}};
   const sourceChanged=Symbol('source changed');await assert.rejects(closureTx.transaction(async changedTx=>{
    await changedTx.update(s.appConnectionSessions).set({revision:source.revision+1,record:{...source,revision:source.revision+1}}).where(eq(s.appConnectionSessions.session_id,source.session_id));
    const changedStore=new storeModule.PostgresAppConnectionSessionStore(changedTx as unknown as typeof db,caller);
    assert.equal(await changedStore.compareAndSet(locator,checking.revision,closed),false);checks++;throw sourceChanged;
   }),error=>error===sourceChanged);
   assert.equal(await guarded.compareAndSet(locator,checking.revision,closed),true);checks++;
   assert.equal(await guarded.compareAndSet(locator,checking.revision,{...checking,revision:checking.revision+1,state:'connecting',callback_consumed:true}),false);checks++;
   assert.equal(await guarded.compareAndSet(locator,closed.revision,{...closed,revision:closed.revision+1,upgrade:{...closed.upgrade,closure:undefined}}),false);checks++;
   assert.equal(await fenceModule.appConnectionUpgradeSourceIsAvailable(closureTx,{org_id:caller.org_id,session_id:source.session_id}),true);checks++;
   assert.deepEqual(await guarded.read({org_id:caller.org_id,owner_user_id:caller.user_id,session_id:source.session_id}),before);checks++;
   throw closureSavepoint;
  }),error=>error===closureSavepoint);
  }
  assert.equal(await write({state:'connecting',callback_consumed:true}),true);
  assert.equal(await write({state:'connected',account:source.account,upgrade:{...record.upgrade!,receipt:{custody_generation:3,receipt_digest:hash}}}),true);checks+=3;
  assert.equal(await fenceModule.appConnectionUpgradeSourceIsAvailable(tx,{org_id:caller.org_id,resource_binding_id:source.scope.resource_binding_id}),true);
  assert.equal(await fenceModule.appConnectionUpgradeSourceIsAvailable(tx,{org_id:caller.org_id,session_id:source.session_id}),false);checks+=2;
  assert.equal(await write({state:'disconnected',account:null}),true);
  assert.equal(await fenceModule.appConnectionUpgradeSourceIsAvailable(tx,{org_id:caller.org_id,session_id:source.session_id}),false);
  assert.deepEqual(await store.read({org_id:caller.org_id,owner_user_id:caller.user_id,session_id:source.session_id}),before);checks+=3;
  throw rollback;
 }),error=>error===rollback);
 console.log('# synthetic upgrade PostgreSQL checks '+JSON.stringify({checks,transaction:'rolled_back',provider_requests:0}));
});
