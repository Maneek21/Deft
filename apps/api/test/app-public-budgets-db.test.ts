import './fixtures/app-run-enabled-env.js';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { and, count, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { appCanonicalClaims, appPublicEndpoints, appPublicIngress, appRuns, agentActions, jobQueue } from '@deft/db/schema';
import { db, closeDb } from '../src/lib/db.js';
import { AppPublicClaimService, publicEndpointReviewDigest } from '../src/lib/app-public-service.js';
import { stagePublicEndpoint, activatePublicEndpoint, disablePublicEndpoint } from '../src/lib/app-public-management.js';
import { PUBLIC_APP_BUDGET_CEILINGS } from '../src/lib/app-public-budgets.js';
import { dequeueJob, QUEUE_NAMES } from '../src/lib/queues.js';
import { _processDequeuedJobForTest } from '../src/workers/index.js';
import { getAppRunRuntime, shutdownAppRunRuntime } from '../src/lib/app-run-runtime.js';
import { issueRuntimeOperatorSession, revokeRuntimeBinding } from '../src/lib/app-runtime-management.js';
import { humanModuleActor } from '../src/lib/module-service.js';
import { publicAvailabilityFixture } from './fixtures/public-availability.js';
import { createAppPublicRoutes } from '../src/routes/app-public.js';

const target=process.env.DEFT_TEST_DATABASE_URL;
const safe=!!target && target===process.env.DATABASE_URL &&
  /^postgresql:\/\/gate_g_test@127\.0\.0\.1:55435\/gate_g_20260926_c12_public_budgets_test(?:_v[0-9]+)?$/.test(target);
before(()=>{if(safe) process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED='true';});
after(async()=>{if(safe){await shutdownAppRunRuntime();await closeDb();}});
const service=new AppPublicClaimService({enabled:true});
const policy=(pending:number,daily:number)=>({schema_version:'deft.app_public_budget.v1' as const,max_pending:pending,max_confirmed_per_utc_day:daily});
const quota=(error:unknown)=>error instanceof Error && 'code' in error && error.code==='PUBLIC_BUDGET_EXCEEDED';
type Fixture=Awaited<ReturnType<typeof publicAvailabilityFixture>>;
const record=(f:Fixture,label:string)=>f.record(label,'2055-01-01T00:00:00Z');
async function endpoint(f:Fixture,budget?:ReturnType<typeof policy>){
  const staged=await stagePublicEndpoint(f.owner,{...f.endpointInput,budget_policy:budget});
  await activatePublicEndpoint(f.owner,staged.endpoint_id,{expected_review_digest:staged.review_digest,
    expected_endpoint_epoch:staged.endpoint_epoch,accept_host_policy:true});return staged;
}
async function persisted(f:Fixture){
  const [claims]=await db.select({value:count()}).from(appCanonicalClaims).where(eq(appCanonicalClaims.org_id,f.orgId));
  const [outbox]=await db.select({value:count()}).from(jobQueue).where(and(eq(jobQueue.org_id,f.orgId),eq(jobQueue.name,'app-public-ingress')));
  return {claims:claims!.value,outbox:outbox!.value};
}
async function processClaim(f:Fixture,claimId:string){
  const [claim]=await db.select().from(appCanonicalClaims).where(and(eq(appCanonicalClaims.org_id,f.orgId),eq(appCanonicalClaims.id,claimId)));assert.ok(claim);
  const job=await dequeueJob(QUEUE_NAMES.AGENT_JOBS,{orgId:f.orgId,jobName:'app-public-ingress',dataMatch:{key:'ingress_id',value:claim.ingress_id}});assert.ok(job);
  await _processDequeuedJobForTest(QUEUE_NAMES.AGENT_JOBS,job);
  const [run]=await db.select().from(appRuns).where(and(eq(appRuns.org_id,f.orgId),eq(appRuns.origin_public_ingress_id,claim.ingress_id)));assert.ok(run);
  assert.equal(run.initiating_actor_type,'app_public');assert.equal(run.initiating_actor_id,claim.ingress_id);
  assert.equal(run.execution_actor_id,f.operatorId);assert.equal(run.state,'pending_approval');
  return {claim,run};
}

test('reviewed endpoint limits count only that endpoint while replay and rollback preserve one durable charge', {skip:!safe,timeout:60_000},async()=>{
  const f=await publicAvailabilityFixture({budgetPolicy:policy(2,3)});
  const records=await Promise.all([record(f,'A'),record(f,'B'),record(f,'C'),record(f,'D')]);
  const bodies=records.slice(0,3).map(row=>f.body(row.id,row.revision));
  const attempts=await Promise.allSettled(bodies.map(body=>service.claim(f.endpoint.slug,body)));
  const winners=attempts.filter(item=>item.status==='fulfilled');const losers=attempts.filter(item=>item.status==='rejected');
  assert.equal(winners.length,2);assert.equal(losers.length,1);assert.ok(quota((losers[0] as PromiseRejectedResult).reason));
  assert.deepEqual(await persisted(f),{claims:2,outbox:2});
  const winnerIndex=attempts.findIndex(item=>item.status==='fulfilled');
  const replay=await service.claim(f.endpoint.slug,bodies[winnerIndex]!);assert.equal(replay.replayed,true);
  assert.equal(replay.claim_id,(attempts[winnerIndex] as PromiseFulfilledResult<Awaited<ReturnType<typeof service.claim>>>).value.claim_id);
  const smaller=await endpoint(f,policy(1,1));
  const independent=await service.claim(smaller.slug,f.body(records[3]!.id,records[3]!.revision));assert.equal(independent.claim_state,'confirmed');
  // All-App count already exceeded this endpoint's lower limit. Its first
  // claim still succeeds; a second claim on that same endpoint must fail.
  const extra=await record(f,'Extra');await assert.rejects(service.claim(smaller.slug,f.body(extra.id,extra.revision)),quota);
  const broken=await publicAvailabilityFixture({budgetPolicy:policy(1,1)});const brokenRecord=await record(broken,'Rollback');
  const fail=new AppPublicClaimService({enabled:true,deliver:async()=>{throw new Error('before outbox commit');}});
  await assert.rejects(fail.claim(broken.endpoint.slug,broken.body(brokenRecord.id,brokenRecord.revision)));
  assert.deepEqual(await persisted(broken),{claims:0,outbox:0});
  await service.claim(broken.endpoint.slug,broken.body(brokenRecord.id,brokenRecord.revision));
  const [stored]=await db.select().from(appPublicEndpoints).where(eq(appPublicEndpoints.id,f.endpoint.endpoint_id));assert.ok(stored);
  assert.deepEqual(stored.budget_policy,policy(2,3));
  const widened=publicEndpointReviewDigest({...stored,budget_policy:policy(3,3)});assert.notEqual(widened,stored.review_digest);
  await db.update(appPublicEndpoints).set({budget_policy:policy(3,3)}).where(eq(appPublicEndpoints.id,stored.id));
  await assert.rejects(service.claim(f.endpoint.slug,f.body(extra.id,extra.revision)));
  await assert.rejects(stagePublicEndpoint(f.owner,{...f.endpointInput,budget_policy:policy(26,100)}));
  assert.deepEqual(PUBLIC_APP_BUDGET_CEILINGS,{max_pending:25,max_confirmed_per_utc_day:100});
});

test('public pending capacity follows the real member-operated Run and retains missing or unknown outcomes until terminalization', {skip:!safe,timeout:60_000},async()=>{
  const f=await publicAvailabilityFixture({budgetPolicy:policy(1,2),memberOperator:true});
  const first=await record(f,'First');const firstBody=f.body(first.id,first.revision);
  const result=await service.claim(f.endpoint.slug,firstBody);
  const [claim]=await db.select().from(appCanonicalClaims).where(eq(appCanonicalClaims.id,result.claim_id));assert.ok(claim);
  // Controlled persisted missing-Run fault: no fake Run or provider outcome.
  await db.update(appPublicIngress).set({follow_up_state:'run_created',handled_at:new Date()}).where(eq(appPublicIngress.id,claim.ingress_id));
  const second=await record(f,'Second');await assert.rejects(service.claim(f.endpoint.slug,f.body(second.id,second.revision)),quota);
  await db.update(appPublicIngress).set({follow_up_state:'pending',handled_at:null}).where(eq(appPublicIngress.id,claim.ingress_id));
  const processed=await processClaim(f,result.claim_id);const runtime=await getAppRunRuntime();
  await assert.rejects(db.update(appRuns).set({initiating_actor_id:randomUUID()}).where(eq(appRuns.id,processed.run.id)),
    'persisted malformed public Run identity must be denied by the database guard');
  const [unchanged]=await db.select().from(appRuns).where(eq(appRuns.id,processed.run.id));assert.ok(unchanged);
  assert.equal(unchanged.initiating_actor_id,claim.ingress_id);
  await assert.rejects(service.claim(f.endpoint.slug,f.body(second.id,second.revision)),quota);
  const [approval]=await db.select().from(agentActions).where(eq(agentActions.app_run_id,processed.run.id));assert.ok(approval);
  assert.equal(approval.user_id,f.operatorId);
  assert.equal((await runtime.approvalResolver.approve(approval.id,f.ownerId)).status,'error');
  assert.equal((await runtime.approvalResolver.approve(approval.id,f.operatorId)).status,'approved');
  const member=humanModuleActor({orgId:f.orgId,userId:f.operatorId,role:'member',source:'rest'});
  const session=await issueRuntimeOperatorSession(member,f.endpointInput.runtime_binding_id);
  const auth={schema_version:'deft.app_runtime_channel.v1',session_id:session.session_id,session_token:session.session_token};
  const acquired=await runtime.runtimeChannel.claim({...auth,max_claims:1});assert.ok(acquired);assert.equal(acquired.run_id,processed.run.id);
  const identity={...auth,run_id:acquired.run_id,attempt_id:acquired.attempt_id,claim_token:acquired.claim_token,sequence:acquired.sequence};
  assert.ok(await runtime.runtimeChannel.start(identity));
  assert.ok(await runtime.runtimeChannel.complete({...identity,status:'indeterminate'}));
  assert.equal((await runtime.repository.inspect(f.orgId,processed.run.id))?.state,'unknown_outcome');
  await assert.rejects(service.claim(f.endpoint.slug,f.body(second.id,second.revision)),quota);
  await runtime.service.reconcileUnknown(f.orgId,processed.run.id,{actor_type:'human',user_id:f.operatorId},'failed');
  const next=await service.claim(f.endpoint.slug,f.body(second.id,second.revision));
  const processedNext=await processClaim(f,next.claim_id);
  await runtime.service.cancel(f.orgId,processedNext.run.id,{actor_type:'human',user_id:f.operatorId});
  const third=await record(f,'Third');await assert.rejects(service.claim(f.endpoint.slug,f.body(third.id,third.revision)),quota);
  const replay=await service.claim(f.endpoint.slug,firstBody);assert.equal(replay.claim_id,result.claim_id);
  assert.deepEqual(await persisted(f),{claims:2,outbox:2});
});

test('the host App pending ceiling spans null-policy endpoints and rotation while unrelated tenants progress beside its held mutex', {skip:!safe,timeout:60_000},async()=>{
  const f=await publicAvailabilityFixture();const second=await endpoint(f,policy(25,100));
  const records=[];for(let i=0;i<26;i++) records.push(await record(f,`Pending ${i}`));
  const accepted=[];for(let i=0;i<25;i++) accepted.push(await service.claim(i===24?second.slug:f.endpoint.slug,f.body(records[i]!.id,records[i]!.revision)));
  await assert.rejects(service.claim(second.slug,f.body(records[25]!.id,records[25]!.revision)),quota);
  const [old]=await db.select().from(appPublicEndpoints).where(eq(appPublicEndpoints.id,f.endpoint.endpoint_id));assert.ok(old);assert.equal(old.budget_policy,null);
  assert.equal(old.review_digest,publicEndpointReviewDigest({...old,budget_policy:undefined}),'NULL policy preserves existing digest bytes');
  const unrelated=await publicAvailabilityFixture({budgetPolicy:policy(1,1)});const healthy=await record(unrelated,'Healthy');
  const locker=new pg.Client({connectionString:target});await locker.connect();
  const observer=new pg.Client({connectionString:target});await observer.connect();
  try{
    await locker.query('BEGIN');await locker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`app-public-budget:${f.orgId}:${f.endpointInput.installation_id}`]);
    const blocked=service.claim(second.slug,f.body(records[25]!.id,records[25]!.revision));const rejected=assert.rejects(blocked,quota);
    let held=false;
    for(let i=0;i<25;i++){
      const waiting=await observer.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory'");
      if(waiting.rows[0].count>0){held=true;break;}await delay(10);
    }
    assert.ok(held,'actual App admission mutex waiter must be observed');
    const started=performance.now();await service.claim(unrelated.endpoint.slug,unrelated.body(healthy.id,healthy.revision));
    assert.ok(performance.now()-started<1000,'unrelated tenant admission must not wait for the held App budget mutex');
    await locker.query('COMMIT');await rejected;
  }finally{await locker.query('ROLLBACK');await locker.end();await observer.end();}
  const processed=await processClaim(f,accepted[0]!.claim_id);const runtime=await getAppRunRuntime();
  await runtime.service.cancel(f.orgId,processed.run.id,{actor_type:'human',user_id:f.operatorId});
  await disablePublicEndpoint(f.owner,f.endpoint.endpoint_id);const rotated=await endpoint(f,policy(1,100));
  await service.claim(rotated.slug,f.body(records[25]!.id,records[25]!.revision));
  const extra=await record(f,'After rotation');await assert.rejects(service.claim(second.slug,f.body(extra.id,extra.revision)),quota);
  assert.deepEqual(await persisted(f),{claims:26,outbox:26});
});

test('public budget charges use the actual post-lock PostgreSQL instant and preserve UTC-naive legacy fallback and anonymous 429', {skip:!safe,timeout:60_000},async()=>{
  const f=await publicAvailabilityFixture({budgetPolicy:policy(1,1)});const row=await record(f,'Charge after wait');
  const locker=new pg.Client({connectionString:target});const observer=new pg.Client({connectionString:target});
  await locker.connect();await observer.connect();let claimed:Awaited<ReturnType<typeof service.claim>>;
  try{
    await locker.query('BEGIN');await locker.query('SELECT id FROM module_records WHERE id=$1 FOR UPDATE',[row.id]);
    const pending=service.claim(f.endpoint.slug,f.body(row.id,row.revision));
    let held=false;const started=performance.now();
    for(let i=0;i<25;i++){
      const waiting=await observer.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%module_records%'");
      if(waiting.rows[0].count>0){held=true;break;}await delay(10);
    }
    assert.ok(held);await delay(Math.max(1,300-(performance.now()-started)));
    const before=await observer.query('SELECT clock_timestamp() AS now');
    await locker.query('COMMIT');claimed=await pending;
    const [stored]=await db.select().from(appCanonicalClaims).where(eq(appCanonicalClaims.id,claimed.claim_id));assert.ok(stored?.budget_reserved_at);
    const raw=await observer.query(`SELECT to_char(budget_reserved_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS instant,
      extract(epoch FROM (budget_reserved_at-created_at))*1000 AS elapsed FROM app_canonical_claims WHERE id=$1`,[claimed.claim_id]);
    assert.equal(stored.budget_reserved_at.toISOString(),raw.rows[0].instant,'production Drizzle decoder preserves the UTC-naive stored instant');
    assert.ok(stored.budget_reserved_at>=before.rows[0].now,'charge follows the actual database clock observed before releasing the held row');
    assert.ok(Number(raw.rows[0].elapsed)>=200,'transaction-start timestamp is not substituted for the charged instant');
  }finally{await locker.query('ROLLBACK');await locker.end();await observer.end();}
  const processed=await processClaim(f,claimed!.claim_id);const runtime=await getAppRunRuntime();
  await runtime.service.cancel(f.orgId,processed.run.id,{actor_type:'human',user_id:f.operatorId});
  const [prior]=await db.select().from(appCanonicalClaims).where(eq(appCanonicalClaims.id,claimed!.claim_id));assert.ok(prior);
  // Explicit legacy representation: retain original created_at, no invented
  // historical commit timestamp. Its recorded day still consumes the quota.
  await db.update(appCanonicalClaims).set({budget_reserved_at:null}).where(eq(appCanonicalClaims.id,claimed!.claim_id));
  const next=await record(f,'Denied legacy day');const routes=createAppPublicRoutes(service);
  const response=await routes.request(`/${f.endpoint.slug}/claims`,{method:'POST',headers:{'Content-Type':'application/json',
    Cookie:'access_token=forged',Authorization:'Bearer unrelated-workspace'},body:f.body(next.id,next.revision).toString('utf8')});
  assert.equal(response.status,429);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(await response.json(),{error:'Public reservation budget is exhausted',code:'PUBLIC_BUDGET_EXCEEDED'});
  const [retained]=await db.select().from(appCanonicalClaims).where(eq(appCanonicalClaims.id,claimed!.claim_id));assert.ok(retained);
  assert.equal(retained.created_at.toISOString(),prior.created_at.toISOString());assert.equal(retained.budget_reserved_at,null);
  assert.deepEqual(await persisted(f),{claims:1,outbox:1});
});

test('supported public worker revocation terminalizes unsupported ingress and frees pending capacity without refunding daily charges', {skip:!safe,timeout:60_000},async()=>{
  const f=await publicAvailabilityFixture({budgetPolicy:policy(1,2)});
  const first=await record(f,'Unsupported first');const claim=await service.claim(f.endpoint.slug,f.body(first.id,first.revision));
  await revokeRuntimeBinding(f.owner,f.endpointInput.runtime_binding_id);
  async function terminalize(claimId:string){
    const [stored]=await db.select().from(appCanonicalClaims).where(eq(appCanonicalClaims.id,claimId));assert.ok(stored);
    const job=await dequeueJob(QUEUE_NAMES.AGENT_JOBS,{orgId:f.orgId,jobName:'app-public-ingress',dataMatch:{key:'ingress_id',value:stored.ingress_id}});assert.ok(job);
    await _processDequeuedJobForTest(QUEUE_NAMES.AGENT_JOBS,job);
    const [ingress]=await db.select().from(appPublicIngress).where(eq(appPublicIngress.id,stored.ingress_id));assert.ok(ingress);
    assert.equal(ingress.follow_up_state,'unsupported');assert.ok(ingress.handled_at);
    assert.ok(['APP_HANDLER_UNAVAILABLE','ENDPOINT_REVOKED'].includes(ingress.follow_up_code!));
    const [runs]=await db.select({value:count()}).from(appRuns).where(eq(appRuns.origin_public_ingress_id,stored.ingress_id));assert.equal(runs!.value,0);
  }
  await terminalize(claim.claim_id);
  const second=await record(f,'Unsupported second');const next=await service.claim(f.endpoint.slug,f.body(second.id,second.revision));
  await terminalize(next.claim_id);
  const third=await record(f,'Daily remains charged');await assert.rejects(service.claim(f.endpoint.slug,f.body(third.id,third.revision)),quota);
  assert.deepEqual(await persisted(f),{claims:2,outbox:2});
});

test('the host App daily ceiling retains 100 real confirmations across endpoint rotation and terminal Runs without refunds', {skip:!safe,timeout:120_000},async()=>{
  const f=await publicAvailabilityFixture();const runtime=await getAppRunRuntime();let current=f.endpoint;
  const replayBodies=[];const claimIds=[];
  for(let i=0;i<100;i++){
    if(i===90){await disablePublicEndpoint(f.owner,current.endpoint_id);current=await endpoint(f,policy(25,100));}
    const row=await record(f,`Daily ${i}`);const body=f.body(row.id,row.revision);replayBodies.push({slug:current.slug,body});
    const claimed=await service.claim(current.slug,body);claimIds.push(claimed.claim_id);
    const processed=await processClaim(f,claimed.claim_id);
    await runtime.service.cancel(f.orgId,processed.run.id,{actor_type:'human',user_id:f.operatorId});
  }
  const overflow=await record(f,'Daily101');await assert.rejects(service.claim(current.slug,f.body(overflow.id,overflow.revision)),quota);
  const replay=await service.claim(current.slug,replayBodies[99]!.body);assert.equal(replay.claim_id,claimIds[99]);assert.equal(replay.replayed,true);
  assert.deepEqual(await persisted(f),{claims:100,outbox:100});
  const [reserved]=await db.select({value:count()}).from(appCanonicalClaims).where(and(eq(appCanonicalClaims.org_id,f.orgId),sql`${appCanonicalClaims.budget_reserved_at} IS NOT NULL`));assert.equal(reserved!.value,100);
  const [runCount]=await db.select({value:count()}).from(appRuns).where(eq(appRuns.org_id,f.orgId));assert.equal(runCount!.value,100);
});
