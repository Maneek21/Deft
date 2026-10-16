import './fixtures/app-run-enabled-env.js';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { writeFile, rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import { appCanonicalClaims, appRuns, agentActions } from '@deft/db/schema';
import { db, closeDb } from '../src/lib/db.js';
import { AppPublicClaimService } from '../src/lib/app-public-service.js';
import { getAppRunRuntime, shutdownAppRunRuntime } from '../src/lib/app-run-runtime.js';
import { issueRuntimeOperatorSession } from '../src/lib/app-runtime-management.js';
import { dequeueJob, QUEUE_NAMES } from '../src/lib/queues.js';
import { _processDequeuedJobForTest } from '../src/workers/index.js';
import { publicAvailabilityFixture } from './fixtures/public-availability.js';

const target=process.env.DEFT_TEST_DATABASE_URL;
const clockFile=process.env.DEFT_PUBLIC_BUDGET_CLOCK_FILE;
const realNow=(globalThis as typeof globalThis & {__deftPublicBudgetRealNow?:()=>number}).__deftPublicBudgetRealNow;
const safe=!!target && target===process.env.DATABASE_URL &&
  /^postgresql:\/\/gate_g_test@127\.0\.0\.1:55436\/gate_g_20260926_c12_public_midnight_test(?:_v[0-9]+)?$/.test(target)
  && clockFile==='C:/tmp/deft-c12-public-budget-clock/private-clock.rc' && !!realNow;
before(()=>{if(safe)process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED='true';});
after(async()=>{if(safe){await shutdownAppRunRuntime();await closeDb();await writeFile(clockFile!,'+0','ascii');}});

async function position(iso:string){
  assert.ok(safe && realNow && clockFile);
  await writeFile(`${clockFile}.next`,`+${((Date.parse(iso)-realNow())/1000).toFixed(3)}`,'ascii');
  await rename(`${clockFile}.next`,clockFile);await delay(1200);
}
async function verifyPoolClocks(){
  const clients=await Promise.all(Array.from({length:db.$client.totalCount},()=>db.$client.connect()));
  try{
    const refreshStarted=performance.now();let clocks;
    do{
      clocks=await Promise.all(clients.map(async client=>(await client.query(
        'SELECT pg_backend_pid() AS pid,extract(epoch FROM clock_timestamp())*1000 AS clock_ms')).rows[0]));
      if(clocks.every(row=>Math.abs(Number(row.clock_ms)-Date.now())<1500))break;
      console.log('PRIVATE_CLOCK_REFRESH',JSON.stringify({clocks,js_now:Date.now()}));
      await delay(50);
    }while(performance.now()-refreshStarted<3000);
    assert.equal(new Set(clocks.map(row=>row.pid)).size,clients.length);
    for(const row of clocks)assert.ok(Math.abs(Number(row.clock_ms)-Date.now())<1500,'isolated backend clock offset is stale');
    return clocks;
  }finally{for(const client of clients)client.release();}
}

test('public reservation charges cross actual PostgreSQL UTC midnight after a held record while the old-day governed Run remains running',
  {skip:!safe,timeout:60_000},async context=>{
  await position('2055-09-26T23:50:00Z');
  const f=await publicAvailabilityFixture({budgetPolicy:{schema_version:'deft.app_public_budget.v1',max_pending:2,max_confirmed_per_utc_day:1}});
  const service=new AppPublicClaimService({enabled:true});const runtime=await getAppRunRuntime();
  const oldRecord=await f.record('Old day','2056-01-01T00:00:00Z');const newRecord=await f.record('Next day','2056-01-01T00:00:00Z');
  const oldBody=f.body(oldRecord.id,oldRecord.revision);const newBody=f.body(newRecord.id,newRecord.revision);
  const old=await service.claim(f.endpoint.slug,oldBody);
  await assert.rejects(service.claim(f.endpoint.slug,newBody),
    error=>error instanceof Error && 'code' in error && error.code==='PUBLIC_BUDGET_EXCEEDED');
  const [oldClaim]=await db.select().from(appCanonicalClaims).where(eq(appCanonicalClaims.id,old.claim_id));assert.ok(oldClaim);
  const job=await dequeueJob(QUEUE_NAMES.AGENT_JOBS,{orgId:f.orgId,jobName:'app-public-ingress',dataMatch:{key:'ingress_id',value:oldClaim.ingress_id}});assert.ok(job);
  await _processDequeuedJobForTest(QUEUE_NAMES.AGENT_JOBS,job);
  const [oldRun]=await db.select().from(appRuns).where(and(eq(appRuns.org_id,f.orgId),eq(appRuns.origin_public_ingress_id,oldClaim.ingress_id)));assert.ok(oldRun);
  const [approval]=await db.select().from(agentActions).where(eq(agentActions.app_run_id,oldRun.id));assert.ok(approval);
  // Position only private process clocks before any production Runtime lease.
  // From here through the held admission, PostgreSQL midnight ticks naturally.
  await position('2055-09-26T23:59:50Z');const clocks=await verifyPoolClocks();
  assert.equal((await runtime.approvalResolver.approve(approval.id,f.operatorId)).status,'approved');
  const session=await issueRuntimeOperatorSession(f.owner,f.endpointInput.runtime_binding_id);
  const auth={schema_version:'deft.app_runtime_channel.v1',session_id:session.session_id,session_token:session.session_token};
  const acquired=await runtime.runtimeChannel.claim({...auth,max_claims:1});assert.ok(acquired);assert.equal(acquired.run_id,oldRun.id);
  const runtimeIdentity={...auth,run_id:acquired.run_id,attempt_id:acquired.attempt_id,claim_token:acquired.claim_token,sequence:acquired.sequence};
  assert.ok(await runtime.runtimeChannel.start(runtimeIdentity));
  const locker=new pg.Client({connectionString:target});const observer=new pg.Client({connectionString:target});
  await locker.connect();await observer.connect();
  let pending:Promise<Awaited<ReturnType<typeof service.claim>>>|undefined;
  try{
    await locker.query('BEGIN');await locker.query('SELECT id FROM module_records WHERE id=$1 FOR UPDATE',[newRecord.id]);
    const boundary=Date.parse('2055-09-27T00:00:00Z');const tickStarted=performance.now();let before:any;
    while(performance.now()-tickStarted<10_000){
      context.signal.throwIfAborted();before=(await observer.query('SELECT now()::text AS tx_now,clock_timestamp()::text AS sql_clock,extract(epoch FROM clock_timestamp())*1000 AS ms')).rows[0];
      if(Number(before.ms)>=boundary-350)break;await delay(10);
    }
    assert.ok(Number(before.ms)<boundary,'new admission must begin before actual PostgreSQL midnight');
    pending=service.claim(f.endpoint.slug,newBody);
    let held=false;
    for(let i=0;i<25;i++){
      const waiting=await observer.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%module_records%'");
      if(waiting.rows[0].count>0){held=true;break;}await delay(5);
    }
    assert.ok(held,'actual post-admission record lock must span the SQL day boundary');
    let fresh:any;
    while(performance.now()-tickStarted<10_000){
      context.signal.throwIfAborted();fresh=(await observer.query('SELECT now()::text AS tx_now,clock_timestamp()::text AS sql_clock,extract(epoch FROM clock_timestamp())*1000 AS ms')).rows[0];
      if(Number(fresh.ms)>=boundary+30)break;await delay(10);
    }
    assert.ok(Number(fresh.ms)>=boundary);
    const retained=(await locker.query('SELECT now()::text AS tx_now,clock_timestamp()::text AS sql_clock')).rows[0];
    assert.ok(retained.tx_now.startsWith('2055-09-26'));assert.ok(retained.sql_clock.startsWith('2055-09-27'));
    await locker.query('COMMIT');const next=await pending;pending=undefined;
    const [nextClaim]=await db.select().from(appCanonicalClaims).where(eq(appCanonicalClaims.id,next.claim_id));assert.ok(nextClaim?.budget_reserved_at);
    assert.ok(nextClaim.created_at.toISOString().startsWith('2055-09-26'));
    assert.ok(nextClaim.budget_reserved_at.toISOString().startsWith('2055-09-27'));
    const raw=(await observer.query(`SELECT to_char(budget_reserved_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS charged FROM app_canonical_claims WHERE id=$1`,[next.claim_id])).rows[0];
    assert.equal(nextClaim.budget_reserved_at.toISOString(),raw.charged,'production timestamp decoder preserves the actual UTC charge');
    const days=(await observer.query('SELECT budget_reserved_at::date::text AS day,count(*)::int AS count FROM app_canonical_claims WHERE org_id=$1 GROUP BY budget_reserved_at::date ORDER BY day',[f.orgId])).rows;
    assert.deepEqual(days,[{day:'2055-09-26',count:1},{day:'2055-09-27',count:1}]);
    assert.equal((await runtime.repository.inspect(f.orgId,oldRun.id))?.state,'running');
    const nextJob=await dequeueJob(QUEUE_NAMES.AGENT_JOBS,{orgId:f.orgId,jobName:'app-public-ingress',dataMatch:{key:'ingress_id',value:nextClaim.ingress_id}});assert.ok(nextJob);
    await _processDequeuedJobForTest(QUEUE_NAMES.AGENT_JOBS,nextJob);
    const [newRun]=await db.select().from(appRuns).where(eq(appRuns.origin_public_ingress_id,nextClaim.ingress_id));assert.ok(newRun);assert.notEqual(newRun.id,oldRun.id);
    const replay=await service.claim(f.endpoint.slug,newBody);assert.equal(replay.claim_id,next.claim_id);assert.equal(replay.replayed,true);
    assert.equal((await service.claim(f.endpoint.slug,oldBody)).claim_id,old.claim_id,'old-day replay keeps its reservation after the new day begins');
    console.log('PUBLIC_POSTGRES_MIDNIGHT',JSON.stringify({before,fresh,retained,days,old_run_id:oldRun.id,new_run_id:newRun.id,
      charged:raw.charged,js_now:new Date().toISOString(),raw_real_now:new Date(realNow!()).toISOString(),
      monotonic_elapsed_ms:performance.now()-tickStarted,lease_backend_clocks:clocks,scope:'actual isolated PostgreSQL/JS clocks; governed Runtime start, no provider effect claimed'}));
  }finally{
    await locker.query('ROLLBACK');if(pending)await pending.catch(()=>{});await locker.end();await observer.end();
    await runtime.runtimeChannel.complete({...runtimeIdentity,status:'indeterminate'});
    await writeFile(clockFile!,'+0','ascii');
  }
});
