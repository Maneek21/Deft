import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {securityTestDatabaseIsSafe} from './fixtures/security-test-database.js';

const local = process.env.DATABASE_URL === process.env.DEFT_TEST_DATABASE_URL
  && process.env.DATABASE_URL === 'postgresql://catchup_test:catchup_local_fixture@127.0.0.1:55440/deft_catchup_20261020';

test('bounded resource catch-up uses ordinary admission, leases, settlement and quotas',
  {skip: !local && !securityTestDatabaseIsSafe(), timeout:120_000}, async t => {
  process.env.DEFT_APPS_ENABLED='true';
  process.env.DEFT_APP_RUNS_ENABLED='true';
  process.env.DEFT_APP_RUN_APP_ORIGIN_ENABLED='true';
  process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED='true';
  const key=(p:string)=>createHash('sha256').update('resource-catchup:'+p).digest('base64');
  process.env.DEFT_APP_RUN_KEYRINGS=JSON.stringify({schema_version:'deft.app_run_keyring.v1',
    run_encryption:{current:'enc',keys:{enc:key('enc')}},receipt_signing:{current:'sig',keys:{sig:key('sig')}},
    fingerprint:{current:'fp',keys:{fp:key('fp')}}});
  const [{db,closeDb},schema,{eq,and},fixture,keyrings,repositories,secretsModule,inputsModule,
    syncModule,admissionModule,runnerModule,providerModule,queueModule,storeModule,receiptModule,channelModule] = await Promise.all([
    import('../src/lib/db.js'),import('@deft/db/schema'),import('drizzle-orm'),import('./fixtures/resource-sync-v5.js'),
    import('../src/lib/app-run-keyrings.js'),import('../src/lib/app-run-repository.js'),import('../src/lib/app-run-secrets.js'),
    import('../src/lib/app-run-secret-repository.js'),import('../src/lib/app-resource-sync-secrets.js'),
    import('../src/lib/app-resource-sync-admission.js'),import('../src/lib/app-run-attempt-runner.js'),
    import('../src/lib/app-run-provider-executor.js'),import('../src/lib/app-run-scheduler.js'),
    import('../src/lib/app-resource-sync-store.js'),import('../src/lib/app-run-receipts.js'),import('../src/lib/app-resource-sync-channel.js'),
  ]);
  const keys=keyrings.parseEnvironmentAppRunKeyrings(process.env.DEFT_APP_RUN_KEYRINGS);
  let now=new Date();const clock=()=>new Date(now);
  const repository=new repositories.PostgresAppRunRepository(),secrets=new secretsModule.AppRunSecretService(keys);
  const inputs=new inputsModule.AppRunSecretRepository(secrets),syncSecrets=new syncModule.AppResourceSyncSecretService(keys);
  const runner=new runnerModule.AppRunAttemptRunner(repository,inputs,secrets,new providerModule.PinnedMcpAppRunProviderExecutor(),
    undefined,clock,60_000,20_000,new receiptModule.PostgresAppRunReceiptWriter(secrets,inputs),undefined,
    queueModule.postgresAppRunAttemptQueue,new storeModule.AppResourceSyncStore(syncSecrets,inputs));
  const admission=new admissionModule.AppResourceSyncAdmissionService(repository,inputs,secrets,syncSecrets,runner,clock,()=>true);
  const channel=new channelModule.AppResourceSyncChannel(runner);
  const make=async(max_retained_records=100)=>{
    const f=await fixture.createReviewedResourceSyncFixture({keys,clock,descriptor:{schema_version:'deft.app_sync_descriptor.v1',
      key:'records',runtime_requirement_key:'provider',resource_type:'record',requested_visibility:'user_private',label_field:'label',
      record_schema:{type:'object',properties:{label:{type:'string',maxLength:100}},required:['label'],additionalProperties:false}},
      limits:{max_records_per_page:1,max_retained_records,min_interval_seconds:900}});
    const target={org_id:f.org_id,resource_binding_id:f.binding_id};
    const issued=await f.management.issueOperatorSession(f.operator_actor,f.binding_id);
    const base={schema_version:'deft.app_runtime_channel.v2' as const,audience:'app_resource_sync' as const,
      session_id:issued.session_id,session_token:issued.session_token};
    const start=async()=>{
      const claim=await channel.claim({...base,max_claims:1});assert.ok(claim);
      const attempt={...base,run_id:claim.run_id,attempt_id:claim.attempt_id,claim_token:claim.claim_token,sequence:claim.sequence};
      const started=await channel.start(attempt);assert.ok(started);return {attempt,started};
    };
    const checkpoint=async()=>(await db.select().from(schema.appSyncCheckpoints).where(eq(schema.appSyncCheckpoints.id,f.checkpoint_id)))[0]!;
    const count=async()=>(await db.select({id:schema.appRuns.id}).from(schema.appRuns).where(eq(schema.appRuns.org_id,f.org_id))).length;
    return {...f,target,start,checkpoint,count};
  };
  const page=(has_more:boolean,id:string|null=null)=>({schema_version:'deft.app_sync_page.v1' as const,
    upserts:id?[{id,revision:'1',data:{label:id}}]:[],tombstones:[],next_cursor:'cursor-'+now.getTime(),has_more});
  try {
    await t.test('more pages continue until complete; duplicate admissions converge; complete returns to normal cadence',async()=>{
      const f=await make();assert.equal((await admission.admitDue(f.target)).state,'created');
      for(const more of [true,true,false]){
        const {attempt}=await f.start();assert.ok(await channel.complete({...attempt,status:'returned',provider_succeeded:true,page:page(more)}));
        assert.equal((await admission.admitDue(f.target)).state,'not_due','bounded delay prevents a tight loop');
        now=new Date(now.getTime()+61_000);
        const next=await Promise.all([admission.admitDue(f.target),admission.admitDue(f.target)]);
        assert.deepEqual(next.map(v=>v.state).sort(),more?['created','existing']:['not_due','not_due']);
      }
      assert.equal(await f.count(),3);assert.equal((await f.checkpoint()).cursor_sequence,3);
      const receipts=await db.select().from(schema.appRunReceipts).where(and(eq(schema.appRunReceipts.org_id,f.org_id),
        eq(schema.appRunReceipts.receipt_kind,'attempt_terminal')));
      assert.deepEqual(receipts.map(r=>r.envelope.facts.coverage).sort(),['complete','partial','partial']);
      now=new Date(now.getTime()+900_000);assert.equal((await admission.admitDue(f.target)).state,'created');
    });
    await t.test('provider errors and unknown results stop the chain even after the normal interval',async()=>{
      for(const unknown of [false,true]){
        const f=await make();await admission.admitDue(f.target);
        const {attempt}=await f.start();
        assert.ok(await channel.complete({...attempt,...(unknown?{status:'not_attempted' as const,error_code:'APP_RUN_PROVIDER_UNAVAILABLE' as const}:
          {status:'returned' as const,provider_succeeded:false as const,error_code:'APP_RUN_PROVIDER_ERROR' as const})}));
        for(const advance of [61_000,900_000]){now=new Date(now.getTime()+advance);
          assert.equal((await admission.admitDue(f.target)).state,'blocked');}
        assert.equal(await f.count(),1);assert.equal((await f.checkpoint()).cursor_sequence,0);
      }
    });
    await t.test('retained record quota rolls back the page and cannot spawn a duplicate continuation',async()=>{
      const f=await make(1);await admission.admitDue(f.target);
      let active=await f.start();assert.ok(await channel.complete({...active.attempt,status:'returned',provider_succeeded:true,page:page(true,'one')}));
      now=new Date(now.getTime()+61_000);assert.equal((await admission.admitDue(f.target)).state,'created');
      active=await f.start();await assert.rejects(channel.complete({...active.attempt,status:'returned',provider_succeeded:true,page:page(true,'two')}));
      const cp=await f.checkpoint();assert.equal(cp.cursor_sequence,1);assert.equal(cp.retained_record_count,1);
      assert.equal((await admission.admitDue(f.target)).state,'existing');assert.equal(await f.count(),2);
      now=new Date(now.getTime()+61_000);await runner.recoverStale();
      assert.equal((await admission.admitDue(f.target)).state,'blocked');assert.equal(await f.count(),2);
    });
  } finally {keys.destroy();await closeDb();}
});
