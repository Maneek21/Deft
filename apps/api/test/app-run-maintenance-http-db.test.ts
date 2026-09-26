import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerType } from '@hono/node-server';
const target = process.env.DATABASE_URL ?? '';
const safe = /^postgresql:\/\/gate_g_test@127\.0\.0\.1:55435\/gate_g_20260926_c12_runtime_maintenance_test(?:_v[0-9]+)?$/.test(target)
 && process.env.DEFT_TEST_DATABASE_URL === target;
Object.assign(process.env, { DEFT_APPS_ENABLED:'true', DEFT_APP_RUNS_ENABLED:'true', DEFT_APP_RUN_APP_ORIGIN_ENABLED:'true',
 DEFT_APP_PUBLIC_INGRESS_ENABLED:'true', DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED:'true', DEFT_APP_RUNTIME_CHANNEL_ENABLED:'true', DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED:'true', DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED:'true' });
const ring=(kind:string)=>({current:kind,keys:{[kind]:createHash('sha256').update(`c12-maintenance:${kind}`).digest('base64')}});
process.env.DEFT_APP_RUN_KEYRINGS=JSON.stringify({schema_version:'deft.app_run_keyring.v1',run_encryption:ring('c11-enc'),receipt_signing:ring('c11-sign'),fingerprint:ring('c11-fp')});
let server:ServerType|undefined; let base:string;
const children = new Set<ChildProcess>();
const effectLedgers = new WeakMap<ChildProcess,string>();
const sweepers: Array<{stop():Promise<void>}> = [];
after(async()=>{ server?.closeAllConnections(); if(server)await new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));
 for(const child of children) if(child.exitCode===null && !child.killed) child.kill('SIGKILL');
 await Promise.all(sweepers.map(s=>s.stop()));
 if(safe){await(await import('../src/lib/app-run-runtime.js')).shutdownAppRunRuntime();await(await import('../src/lib/db.js')).closeDb();}});
async function httpApp(){ const [{Hono},{authMiddleware},{appRoutes},{appRuntimeReviewRoutes}]=await Promise.all([import('hono'),import('../src/middleware/auth.js'),import('../src/routes/apps.js'),import('../src/routes/app-runtime-review.js')]);
 const app=new Hono();app.use('/api/*',authMiddleware);app.route('/api/apps',appRoutes);app.route('/api/app-runtime-review',appRuntimeReviewRoutes);app.route('/api/app-experiences',(await import('../src/routes/app-experiences.js')).appExperienceRoutes);return{app};}
async function fixture(protocol: '3' | '4' | '5' = '5', mixed = false, withModule = false, publicMapping = false, experience = false) {
  const [{ app }, { db }, schema, drizzle, kit, sessions, serverModule] = await Promise.all([
    httpApp(), import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'),
    import('@deft/app-kit'), import('../src/lib/web-sessions.js'), import('@hono/node-server'),
  ]);
  if (!server) base = await new Promise<string>(resolve => {
    server = serverModule.serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, info => resolve(`http://127.0.0.1:${info.port}`));
  });
  const org = randomUUID(); const owner = randomUUID(); const peer = randomUUID();
  const suffix = randomUUID().replaceAll('-', '');
  await db.insert(schema.orgs).values({ id: org, name: 'Activation HTTP', slug: `activation-${suffix}` });
  await db.insert(schema.users).values([{ id: owner, name: 'Owner', email: `${owner}@example.test` },
    { id: peer, name: 'Member', email: `${peer}@example.test` }]);
  await db.insert(schema.orgMembers).values([{ org_id: org, user_id: owner, role: 'owner', is_active: true },
    { org_id: org, user_id: peer, role: 'member', is_active: true }]);
  const token = (id = owner, orgId = org) => sessions.createWebSession({ id, org_id: orgId, email: `${id}@example.test` });
  const web = await token(); const memberWeb = await token(peer);
  const call = async (path: string, value?: unknown, auth = web.accessToken) => {
    const response = await fetch(`${base}${path}`, { method: value === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${auth}`, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    return { status: response.status, body: await response.json() as any,
      cache: response.headers.get('cache-control') };
  };
  const shape = { type: 'object' as const, properties: { subject: { type: 'string' as const, maxLength: 200 } },
    required: ['subject'], additionalProperties: false as const };
  const actions = protocol !== '5' || mixed;
  const moduleManifest = { schema_version: '1', id: `community.example.items.a${suffix}`, slug: `items-${suffix}`,
    version: '1.0.0', name: 'Items', collections: [{ key: 'items', name: 'Items', singular_name: 'Item',
      fields: [{ key: 'title', label: 'Title', type: 'text', required: true }],
      views: [{ key: 'all', name: 'All', type: 'table', fields: ['title'] }],
      search: { title_field: 'title', subtitle_fields: [], fields: ['title'] } }],
    navigation: { default_collection: 'items', default_view: 'all' } };
  const moduleArtifacts = withModule ? [await kit.prepareModuleArtifact({ path: 'modules/items/deft.module.json', manifest: moduleManifest })] : [];
  const experienceArtifact=experience?await kit.prepareDeftExperienceArtifact('experiences/main.json',{schema_version:'deft.experience_bundle.v1',worker_source:'self.onmessage=()=>{};',entry_view:'main',resource_keys:['inbox'],action_keys:[]}):null;
  const artifacts=[...moduleArtifacts,...(experienceArtifact?[experienceArtifact]:[])];
  const manifest = { schema_version: protocol, id: `community.example.activation.a${suffix}`, version: '1.0.0',
    name: 'Activation fixture', license: 'AGPL-3.0-only', compatibility: { app_protocol: protocol },
    runtime_requirements: [
      ...(protocol === '5' ? [{ key: 'sync', protocol_version: 'deft.app_runtime_channel.v2' }] : []),
      ...(actions ? [{ key: 'actions', protocol_version: 'deft.app_runtime_channel.v1' }] : []),
    ],
    private_capabilities: actions ? [{ key: 'message', version: '1', input_schema: shape, output_schema: shape }] : [],
    runtime_actions: actions ? [{ key: 'send_message', label: 'Send message', capability_key: 'message', runtime_requirement_key: 'actions' }] : [],
    modules: moduleArtifacts.map(artifact => ({ module_id: moduleManifest.id,
      version: '1.0.0', manifest_path: artifact.path, manifest_digest: artifact.digest })),
    navigation: [],
    ...(protocol !== '3' ? { experiences: experienceArtifact?[{key:'main',label:'Saved records',artifact_path:experienceArtifact.path,artifact_digest:experienceArtifact.digest,bridge_version:'deft.experience_bridge.v1',renderer_version:'deft.trusted_renderer.v1'}]:[], public_actions: publicMapping ? [{key:'reserve_item',action_key:'send_message',module_id:moduleManifest.id,collection_key:'items',input_mapping:{subject:'claim.resource_id'}}] : [] } : {}),
    ...(protocol === '5' ? { sync_descriptors: [{ schema_version: 'deft.app_sync_descriptor.v1', key: 'inbox',
      runtime_requirement_key: 'sync', resource_type: 'email_message', requested_visibility: 'user_private',
      record_schema: shape, label_field: 'subject' }] } : {}),
  };
  const pkg = await kit.buildDeftAppPackage({ manifest, artifacts });
  const staged = await call('/api/apps/stage', JSON.parse(pkg.json));
  assert.equal(staged.status, 201, JSON.stringify(staged.body));
  const installed = staged.body.app;
  const path = `/api/app-runtime-review/${installed.id}`;
  const context = () => call(`${path}/context?app_version_id=${installed.version_id}`);
  return { db, schema, ...drizzle, sessions, kit, manifest, artifacts, moduleManifest, org, owner, peer, web, memberWeb, token, call, installed, path, context };
}

type Harness=Awaited<ReturnType<typeof fixture>>;
async function active(protocol:'3'|'4'|'5'='5', withModule=false, publicMapping=false,experience=false){
 const h=await fixture(protocol,protocol==='5',withModule,publicMapping,experience);const context=await h.context();assert.equal(context.status,200);
 const input=context.body.review_request;const review=await h.call(`${h.path}/review`,input);assert.equal(review.status,200);
 const activated=await h.call(`${h.path}/activate`,{...input,expected_review_digest:review.body.review_digest,accept_host_policy:true});assert.equal(activated.status,200);
 return {...h,actor:(await import('../src/lib/module-service.js')).humanModuleActor({orgId:h.org,userId:h.owner,role:'owner',source:'rest'}),activated:activated.body};
}
async function nextPackage(h:Harness,options:{moduleManifest?:any;removeModule?:boolean;protocol?:'3'|'4'|'5';version?:string}={}){
 const artifacts=options.removeModule?[]:options.moduleManifest?[await h.kit.prepareModuleArtifact({path:h.artifacts[0]!.path,manifest:options.moduleManifest})]:h.artifacts;
 const modules=options.removeModule?[]:options.moduleManifest?[{module_id:options.moduleManifest.id,version:options.moduleManifest.version,manifest_path:artifacts[0]!.path,manifest_digest:artifacts[0]!.digest}]:h.manifest.modules;
 const manifest={...h.manifest,version:options.version??'1.1.0',modules,...(options.protocol?{schema_version:options.protocol,compatibility:{app_protocol:options.protocol},...(options.protocol==='5'?{sync_descriptors:[]}:{})}:{})};
 return h.kit.buildDeftAppPackage({manifest,artifacts});
}
async function prepared(h:Harness,options:Parameters<typeof nextPackage>[1]={}){
 const pkg=await nextPackage(h,options);const current=await h.context();assert.equal(current.status,200);
 const [app]=await h.db.select().from(h.schema.appInstallations).where(h.eq(h.schema.appInstallations.id,h.installed.id));
 const staged=await h.call(`${h.path}/upgrade/stage`,{schema_version:'deft.app_runtime_upgrade_stage.v1',package_json:pkg.json,expected_lifecycle_epoch:app!.lifecycle_epoch});assert.equal(staged.status,200,JSON.stringify(staged.body));
 const targetId=staged.body.app_version_id;
 const context=await h.call(`${h.path}/upgrade/context?app_version_id=${targetId}`);assert.equal(context.status,200,JSON.stringify(context.body));
 const request=context.body.review_request;const review=await h.call(`${h.path}/upgrade/review`,request);assert.equal(review.status,200,JSON.stringify(review.body));
 return {targetId,request,review:review.body,input:{...request,expected_review_digest:review.body.review_digest,accept_host_policy:true}};
}
async function actionBinding(h:Awaited<ReturnType<typeof active>>){
 const management=await import('../src/lib/app-runtime-management.js');const [grant]=await h.db.select().from(h.schema.appGrantSnapshots).where(h.eq(h.schema.appGrantSnapshots.id,h.activated.grant_snapshot_id));
 const request={installation_id:h.installed.id,action_key:'send_message',operator_user_id:h.peer,expected_app_version_id:h.installed.version_id,
 expected_package_digest:h.installed.package_digest,expected_grant_snapshot_digest:grant!.snapshot_digest,
 expected_lifecycle_epoch:h.activated.installation.lifecycle_epoch,expected_grant_epoch:h.activated.installation.grant_epoch};
 const review=await management.prepareRuntimeBindingReview(h.actor,request);return management.activateRuntimeBinding(h.actor,{...request,expected_review_digest:review.review_digest,accept_host_policy:true});
}
async function refreshReview(h:Harness,targetId:string){const c=await h.call(`${h.path}/upgrade/context?app_version_id=${targetId}`);assert.equal(c.status,200,JSON.stringify(c.body));const request=c.body.review_request;
 const r=await h.call(`${h.path}/upgrade/review`,request);assert.equal(r.status,200);return {review:r.body,input:{...request,expected_review_digest:r.body.review_digest,accept_host_policy:true}};}
async function resourceConsent(h:Awaited<ReturnType<typeof active>>,expiryMs=60*60_000){
 const runtime=await(await import('../src/lib/app-run-runtime.js')).getAppRunRuntime();const management=new(await import('../src/lib/app-resource-sync-management.js')).AppResourceSyncManagement(runtime.keys);
 const [grant]=await h.db.select().from(h.schema.appGrantSnapshots).where(h.eq(h.schema.appGrantSnapshots.id,h.activated.grant_snapshot_id));
 const request={installation_id:h.installed.id,resource_key:'inbox',operator_user_id:h.peer,expected_app_version_id:h.installed.version_id,expected_package_digest:h.installed.package_digest,
 expected_grant_snapshot_digest:grant!.snapshot_digest,expected_lifecycle_epoch:h.activated.installation.lifecycle_epoch,expected_grant_epoch:h.activated.installation.grant_epoch,
 consent_expires_at:new Date(Date.now()+expiryMs).toISOString(),limits:{max_records_per_page:100,max_page_bytes:524288,max_retained_records:100000,max_retained_bytes:1073741824,min_interval_seconds:60}};
 const review=await management.prepareConsent(h.actor,request);const consent=await management.activateConsent(h.actor,{...request,expected_review_digest:review.review_digest,accept_host_policy:true});
 const operator=(await import('../src/lib/module-service.js')).humanModuleActor({orgId:h.org,userId:h.peer,role:'member',source:'rest'});
 return {runtime,management,consent,operator};
}
async function observedWait(client:any,pid:number){for(let i=0;i<600;i++){await client.query('SELECT pg_stat_clear_snapshot()');const result=await client.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid]);if(result.rows[0].n>0)return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('real PostgreSQL row-lock wait not observed');}

async function eventually(check:()=>Promise<boolean>, timeout=15_000) {
 const deadline=Date.now()+timeout; while(Date.now()<deadline){if(await check())return;await new Promise(r=>setTimeout(r,40));}assert.fail('bounded state observation timed out');
}
function childProcess(databaseUrl=target,overrides:Record<string,string>={}) {
 const child=fork(fileURLToPath(new URL('./fixtures/app-run-maintenance-child.ts',import.meta.url)),[],{
  execArgv:['--import','tsx'],stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,DATABASE_URL:databaseUrl,
   DEFT_JOB_LEASE_MS:'10000',DEFT_WORKER_POLL_INTERVAL_MS:'100',DEFT_APP_RESOURCE_SYNC_SCHEDULER_ENABLED:'false',...overrides}});
 children.add(child);return child;
}
async function command(child:ChildProcess,message:any,expected:string) {
 if(message.mode==='provider'&&message.started){const directory=join(process.env.DEFT_TEST_EVIDENCE_DIR??join(tmpdir(),'deft-c12-maintenance'),'provider-ledgers');await mkdir(directory,{recursive:true});message={...message,ledgerPath:join(directory,`${randomUUID()}.jsonl`)};effectLedgers.set(child,message.ledgerPath);}
 return new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{child.off('message',receive);reject(Error(`Child ${expected} timed out`));},20_000);
  const receive=(value:any)=>{if(value?.failed||value?.[expected]){clearTimeout(timer);child.off('message',receive);value.failed?reject(Error(`Child operation failed: ${value.code??'unknown'}`)):resolve(value);}};
  child.on('message',receive);child.send(message);
 });
}
async function crash(child:ChildProcess){if(child.exitCode!==null)return;await new Promise<void>(resolve=>{child.once('exit',()=>resolve());child.kill('SIGKILL');});children.delete(child);}
async function workerStop(child:ChildProcess){await command(child,{mode:'stop'},'stopped');await eventually(async()=>child.exitCode!==null);children.delete(child);}
async function rawClient(){const pg=(await import('pg')).default;const client=new pg.Client({connectionString:target});await client.connect();return client;}
async function waitLease(h:Harness,runId:string,expiredInput=false){await eventually(async()=>{const host=new Date().toISOString();const result=await h.db.execute(h.sql`SELECT a.lease_expires_at<=(clock_timestamp() AT TIME ZONE 'UTC') AND a.lease_expires_at<=${host}::timestamp AS lease, r.input_expires_at<=(clock_timestamp() AT TIME ZONE 'UTC') AND r.input_expires_at<=${host}::timestamp AS input FROM app_runs r JOIN app_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id WHERE r.org_id=${h.org} AND r.id=${runId}`);return result.rows.some(row=>row.lease===true&&(!expiredInput||row.input===true));},20_000);}
async function humanRun(h:Awaited<ReturnType<typeof active>>,bindingId:string,approve=false){
 const runtime=await(await import('../src/lib/app-run-runtime.js')).getAppRunRuntime();
 const run=await runtime.service.submitReviewedRuntime({org_id:h.org,user_id:h.owner},{runtime_binding_id:bindingId,idempotency_key:`c12-${randomUUID()}`,input:{subject:'Synthetic maintenance work'}});
 if(approve){const [approval]=await h.db.select().from(h.schema.agentActions).where(h.and(h.eq(h.schema.agentActions.org_id,h.org),h.eq(h.schema.agentActions.app_run_id,run.id)));assert.equal((await runtime.approvalResolver.approve(approval!.id,h.owner)).status,'approved');}
 return {run,runtime};
}
async function humanIdentity(h:Awaited<ReturnType<typeof active>>,bindingId:string){const operator=(await import('../src/lib/module-service.js')).humanModuleActor({orgId:h.org,userId:h.peer,role:'member',source:'rest'});
 const credential=await(await import('../src/lib/app-runtime-management.js')).issueRuntimeOperatorSession(operator,bindingId);
 return {schema_version:'deft.app_runtime_channel.v1',session_id:credential.session_id,session_token:credential.session_token};}
async function syncRun(h:Awaited<ReturnType<typeof active>>,expiryMs?:number){const context=await resourceConsent(h,expiryMs);const admitted=await context.runtime.resourceSyncAdmission.admitDue({org_id:h.org,resource_binding_id:context.consent.binding_id});assert.equal(admitted.state,'created');if(admitted.state!=='created')throw Error('Expected admission');
 const credential=await context.management.issueOperatorSession(context.operator,context.consent.binding_id);
 return {...context,runId:admitted.run_id,identity:{schema_version:'deft.app_runtime_channel.v2',audience:'app_resource_sync',session_id:credential.session_id,session_token:credential.session_token}};}
async function state(h:Harness,runId:string){const [run]=await h.db.select().from(h.schema.appRuns).where(h.and(h.eq(h.schema.appRuns.org_id,h.org),h.eq(h.schema.appRuns.id,runId)));return run!;}
async function approveUpgrade(h:Harness,targetId:string){const fresh=await refreshReview(h,targetId);assert.deepEqual(fresh.review.blockers.old_work,{});assert.equal((await h.call(`${h.path}/upgrade/activate`,fresh.input)).status,200);return fresh;}

test('maintenance bounds twenty items, observes contention, continues and advances keyset fairly',{skip:!safe,timeout:90_000},async()=>{
 const h=await active('4');const binding=await actionBinding(h);const runs=[];for(let i=0;i<22;i++)runs.push((await humanRun(h,binding.binding_id)).run);
 const runtime=await(await import('../src/lib/app-run-runtime.js')).getAppRunRuntime();const [approval]=await h.db.select().from(h.schema.agentActions).where(h.eq(h.schema.agentActions.app_run_id,runs[0]!.id));assert.equal((await runtime.approvalResolver.approve(approval!.id,h.owner)).status,'approved');
 const provider=childProcess();await command(provider,{mode:'provider',identity:await humanIdentity(h,binding.binding_id),started:false,leaseMs:60_000},'ready');
 console.info('[maintenance cap proof] future claim prepared');
 const {AppRunMaintenance}=await import('../src/lib/app-run-maintenance.js');const live=new AppRunMaintenance(()=>true,()=>new Date(),target);sweepers.push(live);
 assert.deepEqual(await live.run('recovery'),{state:'completed',inspected:0,changed:0,failed:0},'future live claim is not even selected');assert.deepEqual(await live.run('retention'),{state:'completed',inspected:0,changed:0,failed:0},'future private input is not even selected');await live.stop();await crash(provider);
 console.info('[maintenance cap proof] future candidate exclusions verified');
 const p=await prepared(h);assert.equal(p.review.blockers.old_work.pending_approval,22);assert.equal(p.review.blockers.old_work.pending,undefined);
 console.info('[maintenance cap proof] upgrade blocker review prepared');
 const future=new Date(Math.max(...runs.map(r=>r.input_expires_at!.getTime()))+1);
 const maintenance=new AppRunMaintenance(()=>true,()=>future,target);sweepers.push(maintenance);
 const first=runs.map(r=>r.id).sort()[0]!;const client=await rawClient();try{await client.query('BEGIN');await client.query('SELECT id FROM app_runs WHERE org_id=$1 AND id=$2 FOR UPDATE',[h.org,first]);const {rows:[backend]}=await client.query('SELECT pg_backend_pid() AS id');
  const started=Date.now();const pass=maintenance.run('retention');await observedWait(client,backend.id);assert.equal((await maintenance.run('retention')).state,'busy');
  console.info('[maintenance cap proof] actual lock wait observed');
  const result=await pass;assert.deepEqual(result,{state:'completed',inspected:20,changed:19,failed:1});assert.ok(Date.now()-started<10_500);
  assert.deepEqual(await maintenance.run('retention'),{state:'completed',inspected:2,changed:2,failed:0});assert.equal((await state(h,first)).state,'pending_approval');
  await client.query('COMMIT');assert.equal((await maintenance.run('retention')).changed,1);assert.equal((await maintenance.run('recovery')).changed,1);
 }finally{await client.query('ROLLBACK');await client.end();await maintenance.stop();}
 await approveUpgrade(h,p.targetId);assert.equal((await state(h,first)).origin_app_version_id,h.installed.version_id);
 const off=new AppRunMaintenance(()=>false,()=>new Date(),'postgresql://invalid@127.0.0.1:1/invalid');assert.equal((await off.run('recovery')).state,'disabled');await off.stop();
});

test('maintenance shutdown aborts held item within bounded lock wait and later host resumes',{skip:!safe,timeout:20_000},async()=>{
 const h=await active('4');const binding=await actionBinding(h);const {run}=await humanRun(h,binding.binding_id);const future=new Date(run.input_expires_at!.getTime()+1);const {AppRunMaintenance}=await import('../src/lib/app-run-maintenance.js');
 const maintenance=new AppRunMaintenance(()=>true,()=>future,target);sweepers.push(maintenance);const client=await rawClient();try{await client.query('BEGIN');await client.query('SELECT id FROM app_runs WHERE org_id=$1 AND id=$2 FOR UPDATE',[h.org,run.id]);const {rows:[backend]}=await client.query('SELECT pg_backend_pid() AS id');
 const pass=maintenance.run('retention');await observedWait(client,backend.id);const started=Date.now();await maintenance.stop();await pass;assert.ok(Date.now()-started<750);assert.equal((await state(h,run.id)).state,'pending_approval');await client.query('COMMIT');
 const resumed=new AppRunMaintenance(()=>true,()=>future,target);sweepers.push(resumed);assert.equal((await resumed.run('retention')).changed,1);await resumed.stop();
 }finally{await client.query('ROLLBACK');await client.end();}
});

test('upgrade explicit drain policy is strict and reviewed without promising automatic progress',{skip:!safe},async()=>{
 const h=await active('4');const p=await prepared(h);assert.equal(p.request.pending_work_policy,'drain_before_activation');assert.equal(p.review.pending_work_policy,'drain_before_activation');
 const {pending_work_policy,...missing}=p.request;assert.equal((await h.call(`${h.path}/upgrade/review`,missing)).status,400);assert.equal((await h.call(`${h.path}/upgrade/review`,{...p.request,pending_work_policy:'cancel_old_work'})).status,400);
 assert.equal((await h.call(`${h.path}/upgrade/activate`,p.input)).status,200);const recovery=await h.call(`${h.path}/upgrade/context?app_version_id=${p.targetId}`);assert.equal(recovery.status,200);assert.equal(recovery.body.current_activation.review_digest,p.review.review_digest);
 const [audit]=await h.db.select().from(h.schema.auditLog).where(h.and(h.eq(h.schema.auditLog.org_id,h.org),h.eq(h.schema.auditLog.action,'app.runtime.upgrade_activate')));assert.equal((audit!.metadata as any).pending_work_policy,'drain_before_activation');
});

test('separate provider crash after sync start becomes unknown with no effect retry and still blocks upgrade',{skip:!safe,timeout:30_000},async()=>{
 const h=await active('5');const sync=await syncRun(h);const p=await prepared(h);const provider=childProcess();const claimed=await command(provider,{mode:'provider',identity:sync.identity,started:true},'ready');assert.equal(claimed.run_id,sync.runId);assert.equal(claimed.released,true);assert.equal(claimed.effect_recorded,true);await crash(provider);await waitLease(h,sync.runId);
 const recovery=childProcess(target,{DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED:'false',DEFT_APP_RUNTIME_CHANNEL_ENABLED:'false'});await command(recovery,{mode:'maintenance',kind:'recovery'},'committed');await crash(recovery);
 const run=await state(h,sync.runId);assert.equal(run.state,'unknown_outcome');assert.equal(run.origin_app_version_id,h.installed.version_id);
 const attempts=await h.db.select().from(h.schema.appRunAttempts).where(h.eq(h.schema.appRunAttempts.run_id,sync.runId));assert.equal(attempts.length,1);assert.equal(attempts[0]!.state,'unknown_outcome');
 assert.deepEqual((await readFile(effectLedgers.get(provider)!,'utf8')).trim().split('\n').map(line=>JSON.parse(line)),[{run_id:sync.runId,effect:'synthetic_provider_effect'}],'crash after real synthetic effect must not repeat it');
 const receipts=await sync.runtime.receiptReader.readVerified(h.org,sync.runId);assert.ok(receipts.some(r=>r.receipt_kind==='attempt_terminal'));
 const refreshed=await refreshReview(h,p.targetId);assert.equal(refreshed.review.blockers.old_work.unknown_outcome,1);assert.equal((await h.call(`${h.path}/upgrade/activate`,refreshed.input)).body.code,'APP_UPGRADE_BLOCKED');
});

test('normal worker recovers expired unstarted sync claim without released input and permits fresh upgrade',{skip:!safe,timeout:60_000},async()=>{
 // The outer fixture includes two cold-process preparations and shutdown;
 // the Run TTL and production maintenance pass remain ten seconds each.
 const h=await active('5');const provider=childProcess();const worker=childProcess();await command(provider,{mode:'warm'},'warmed');await command(worker,{mode:'warm'},'warmed');console.info('[unstarted expiry proof] processes warm before Run admission');
 const sync=await syncRun(h,10_000);const p=await prepared(h);const claimed=await command(provider,{mode:'provider',identity:sync.identity,started:false},'ready');assert.equal(claimed.released,false);await crash(provider);console.info('[unstarted expiry proof] claim abandoned without input release');await waitLease(h,sync.runId,true);console.info('[unstarted expiry proof] real lease and input expiry observed');
 try{await command(worker,{mode:'worker'},'ready');await eventually(async()=>{const [attempt]=await h.db.select().from(h.schema.appRunAttempts).where(h.eq(h.schema.appRunAttempts.run_id,sync.runId));return attempt?.state==='failed';},15_000);console.info('[unstarted expiry proof] normal worker settled abandoned claim');
 assert.equal((await state(h,sync.runId)).state,'expired');const attempts=await h.db.select().from(h.schema.appRunAttempts).where(h.eq(h.schema.appRunAttempts.run_id,sync.runId));assert.equal(attempts.length,1);assert.equal(attempts[0]!.provider_call_started_at,null);
 assert.equal(await sync.runtime.attemptRunner.recoverRun(h.org,sync.runId),0);const receipts=await sync.runtime.receiptReader.readVerified(h.org,sync.runId);assert.ok(receipts.some(r=>r.receipt_kind==='attempt_terminal'));await approveUpgrade(h,p.targetId);
 }finally{await workerStop(worker);console.info('[unstarted expiry proof] normal worker stopped');}
});

test('normal worker retention expires unclaimed old sync work under retained original pins',{skip:!safe,timeout:25_000},async()=>{
 const h=await active('5');const sync=await syncRun(h,3_000);const p=await prepared(h);await eventually(async()=>{const result=await h.db.execute(h.sql`SELECT input_expires_at<=clock_timestamp() AS expired FROM app_runs WHERE org_id=${h.org} AND id=${sync.runId}`);return result.rows[0]?.expired===true;});
 const worker=childProcess();try{await command(worker,{mode:'worker'},'ready');await eventually(async()=>(await state(h,sync.runId)).state==='expired');const run=await state(h,sync.runId);assert.equal(run.origin_app_version_id,h.installed.version_id);assert.ok(run.input_purged_at);await approveUpgrade(h,p.targetId);
 }finally{await workerStop(worker);}
});

test('atomic recovered Attention survives maintenance crash and retry projects current reconciled state',{skip:!safe,timeout:40_000},async()=>{
 const h=await active('4');const binding=await actionBinding(h);const {run,runtime}=await humanRun(h,binding.binding_id,true);const identity=await humanIdentity(h,binding.binding_id);const p=await prepared(h);
 const provider=childProcess();await command(provider,{mode:'provider',identity,started:true},'ready');await crash(provider);await waitLease(h,run.id);
 const recovery=childProcess();await command(recovery,{mode:'maintenance',kind:'recovery'},'committed');await crash(recovery);assert.equal((await state(h,run.id)).state,'unknown_outcome');
 const jobs=()=>h.db.select().from(h.schema.jobQueue).where(h.and(h.eq(h.schema.jobQueue.org_id,h.org),h.eq(h.schema.jobQueue.name,'app-run-attention')));assert.equal((await jobs()).length,1);assert.deepEqual((await jobs())[0]!.data,{orgId:h.org,runId:run.id});
 const alerts=()=>h.db.select().from(h.schema.attentionItems).where(h.and(h.eq(h.schema.attentionItems.org_id,h.org),h.eq(h.schema.attentionItems.source_type,'app_run'),h.eq(h.schema.attentionItems.source_id,run.id)));assert.equal((await alerts()).length,0);
 const client=await rawClient();const limited=new URL(target);limited.searchParams.set('options','-c statement_timeout=100');const worker=childProcess(limited.toString());try{await client.query('BEGIN');await client.query('LOCK TABLE attention_items IN ACCESS EXCLUSIVE MODE');await command(worker,{mode:'worker'},'ready');
 await eventually(async()=>{const [job]=await jobs();return job!.attempts>=1&&job!.status==='pending';});await client.query('COMMIT');
 assert.equal((await runtime.service.reconcileUnknown(h.org,run.id,{actor_type:'human',user_id:h.owner},'failed')).state,'failed');
 await eventually(async()=>(await jobs())[0]!.status==='completed');assert.ok((await jobs())[0]!.attempts>=2);assert.equal((await jobs()).length,1);
 const items=await alerts();assert.ok(items.length>0);assert.ok(items.every(item=>item.dedupe_key===`app-run:reconciled:${run.id}`));await approveUpgrade(h,p.targetId);
 const receipts=await runtime.receiptReader.readVerified(h.org,run.id);assert.ok(receipts.some(r=>r.receipt_kind==='reconciliation'));
 }finally{await client.query('ROLLBACK');await client.end();await workerStop(worker);}
});

test('maintenance bounds a dropped established PostgreSQL response and discards its socket',{skip:!safe,timeout:10_000},async()=>{
 const net=await import('node:net');let connection:any;let ready=false;let closed=false;
 const fake=net.createServer(socket=>{connection=socket;socket.on('close',()=>{closed=true;});socket.once('data',()=>{
  const authenticated=Buffer.from([82,0,0,0,8,0,0,0,0,90,0,0,0,5,73]);socket.write(authenticated);ready=true;
  // Accept startup, then deliberately lose the BEGIN response.
 });});await new Promise<void>(resolve=>fake.listen(0,'127.0.0.1',resolve));
 const port=(fake.address() as import('node:net').AddressInfo).port;const {createAppRunMaintenanceDatabase}=await import('../src/lib/app-run-maintenance-db.js');
 const database=createAppRunMaintenanceDatabase(`postgresql://synthetic@127.0.0.1:${port}/synthetic`);const started=Date.now();
 try{await assert.rejects(database.transaction(async()=>1,new AbortController().signal,performance.now()+10_000));assert.ok(ready);await eventually(async()=>closed,1_000);assert.ok(Date.now()-started<3_000);}
 finally{await database.close();connection?.destroy();await new Promise<void>(resolve=>fake.close(()=>resolve()));}
});

test('production default-off maintenance does not parse malformed keyrings or initialize runtime',{skip:!safe,timeout:15_000},async()=>{
 const child=childProcess(target,{DEFT_APP_RUNS_ENABLED:'false',DEFT_APP_RUN_APP_ORIGIN_ENABLED:'false',DEFT_APP_RUN_LEGACY_MCP_CUTOVER_ENABLED:'false',DEFT_APP_AUTOMATIONS_ENABLED:'false',DEFT_APP_RUN_KEYRINGS:'deliberately malformed'});
 try{await command(child,{mode:'maintenance',kind:'recovery'},'committed');}finally{await crash(child);}
});

test('coincident recovery and retention retain bounded eventual service for both modes',{skip:!safe,timeout:30_000},async()=>{
 const h=await active('4');const provider=childProcess();await command(provider,{mode:'warm'},'warmed');const binding=await actionBinding(h);const {run,runtime}=await humanRun(h,binding.binding_id,true);const identity=await humanIdentity(h,binding.binding_id);await command(provider,{mode:'provider',identity,started:true},'ready');await crash(provider);await waitLease(h,run.id);
 const pending=(await humanRun(h,binding.binding_id)).run;const future=new Date(pending.input_expires_at!.getTime()+1);const {AppRunMaintenance}=await import('../src/lib/app-run-maintenance.js');const maintenance=new AppRunMaintenance(()=>true,()=>future,target);sweepers.push(maintenance);
 const client=await rawClient();try{await client.query('BEGIN');await client.query('SELECT id FROM app_runs WHERE org_id=$1 AND id=$2 FOR UPDATE',[h.org,run.id]);const {rows:[backend]}=await client.query('SELECT pg_backend_pid() AS id');
 const pass=maintenance.run('recovery');await observedWait(client,backend.id);assert.equal((await maintenance.run('retention')).state,'busy');await client.query('COMMIT');await pass;
 await eventually(async()=>(await state(h,pending.id)).state==='expired');assert.equal((await state(h,run.id)).state,'unknown_outcome');
 const [approval]=await h.db.select().from(h.schema.agentActions).where(h.eq(h.schema.agentActions.app_run_id,pending.id));assert.equal(approval!.approval_status,'pending','retention does not fabricate an approver');
 assert.equal((await runtime.approvalResolver.approve(approval!.id,h.owner)).status,'error');const [closed]=await h.db.select().from(h.schema.agentActions).where(h.eq(h.schema.agentActions.id,approval!.id));assert.equal(closed!.approval_status,'expired');
 }finally{await client.query('ROLLBACK');await client.end();await maintenance.stop();}
});

test('bounded recovery isolates immutable receipt conflict and continues later Run',{skip:!safe,timeout:35_000},async()=>{
 const h=await active('4');const binding=await actionBinding(h);const first=await humanRun(h,binding.binding_id,true);const second=await humanRun(h,binding.binding_id,true);const identity=await humanIdentity(h,binding.binding_id);
 for(let i=0;i<2;i++){const provider=childProcess();await command(provider,{mode:'provider',identity,started:true},'ready');await crash(provider);}await waitLease(h,first.run.id);await waitLease(h,second.run.id);
 const poison=[first.run.id,second.run.id].sort()[0]!;const clean=[first.run.id,second.run.id].find(id=>id!==poison)!;const current=await first.runtime.repository.inspect(h.org,poison);assert.ok(current);
 const [attempt]=await h.db.select().from(h.schema.appRunAttempts).where(h.eq(h.schema.appRunAttempts.run_id,poison));
 const {PostgresAppRunReceiptWriter}=await import('../src/lib/app-run-receipts.js');const {AppRunSecretService}=await import('../src/lib/app-run-secrets.js');const writer=new PostgresAppRunReceiptWriter(new AppRunSecretService(first.runtime.keys),first.runtime.secretRepository);
 // Trusted synthetic immutable-ledger conflict uses the normal signed writer,
 // not disabled guards or a provider-reachable tamper bypass.
 await h.db.transaction(tx=>writer.write(tx,{receipt_key:`attempt-terminal:${attempt!.id}`,receipt_kind:'attempt_terminal',run:current,attempt_id:attempt!.id,facts:{fixture_conflict:true},occurred_at:new Date()}));
 const {AppRunMaintenance}=await import('../src/lib/app-run-maintenance.js');const maintenance=new AppRunMaintenance(()=>true,()=>new Date(),target);sweepers.push(maintenance);const result=await maintenance.run('recovery');assert.equal(result.failed,1);assert.ok(result.changed>=1);
 assert.equal((await state(h,poison)).state,'running');assert.equal((await state(h,clean)).state,'unknown_outcome');assert.equal((await h.db.select().from(h.schema.appRunAttempts).where(h.eq(h.schema.appRunAttempts.run_id,poison)))[0]!.state,'provider_call_started');await maintenance.stop();
});

test('Attention projection Run fence orders real concurrent reconciliation without resurrecting unknown',{skip:!safe,timeout:35_000},async()=>{
 const h=await active('4');const binding=await actionBinding(h);const {run,runtime}=await humanRun(h,binding.binding_id,true);const identity=await humanIdentity(h,binding.binding_id);const provider=childProcess();await command(provider,{mode:'provider',identity,started:true},'ready');await crash(provider);await waitLease(h,run.id);
 const recovery=childProcess();await command(recovery,{mode:'maintenance',kind:'recovery'},'committed');await crash(recovery);
 const [job]=await h.db.select().from(h.schema.jobQueue).where(h.and(h.eq(h.schema.jobQueue.org_id,h.org),h.eq(h.schema.jobQueue.name,'app-run-attention')));assert.ok(job);
 const handler=(await import('../src/lib/app-run-maintenance-attention.js')).handleAppRunAttention;const client=await rawClient();const observer=await rawClient();let projection:Promise<void>|undefined;let reconciliation:ReturnType<typeof runtime.service.reconcileUnknown>|undefined;
 await assert.rejects(handler({id:job.id,name:job.name,data:{...job.data,orgId:randomUUID()},attempts:job.attempts}),/Invalid App Run Attention queue identity/);
 try{await client.query('BEGIN');await client.query('LOCK TABLE attention_items IN ACCESS EXCLUSIVE MODE');const {rows:[backend]}=await client.query('SELECT pg_backend_pid() AS id');
 projection=handler({id:job.id,name:job.name,data:job.data,attempts:job.attempts});await observedWait(observer,backend.id);
 reconciliation=runtime.service.reconcileUnknown(h.org,run.id,{actor_type:'human',user_id:h.owner},'failed');
 await eventually(async()=>{const result=await observer.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%app_runs%' AND cardinality(pg_blocking_pids(pid))>0");return result.rows[0].n>0;},2_000);
 await client.query('COMMIT');await projection;assert.equal((await reconciliation).state,'failed');
 const items=await h.db.select().from(h.schema.attentionItems).where(h.and(h.eq(h.schema.attentionItems.org_id,h.org),h.eq(h.schema.attentionItems.source_type,'app_run'),h.eq(h.schema.attentionItems.source_id,run.id)));
 assert.ok(items.some(item=>item.dedupe_key===`app-run:unknown_outcome:${run.id}`&&item.state==='resolved'));assert.ok(items.some(item=>item.dedupe_key===`app-run:reconciled:${run.id}`));
 await handler({id:job.id,name:job.name,data:job.data,attempts:job.attempts});const after=await h.db.select().from(h.schema.attentionItems).where(h.and(h.eq(h.schema.attentionItems.org_id,h.org),h.eq(h.schema.attentionItems.source_type,'app_run'),h.eq(h.schema.attentionItems.source_id,run.id)));assert.deepEqual(after.map(r=>[r.id,r.event_count,r.state]),items.map(r=>[r.id,r.event_count,r.state]));
 }finally{await client.query('ROLLBACK');await projection?.catch(()=>{});await reconciliation?.catch(()=>{});await client.end();await observer.end();}
});

test('accepted public outbox continues under original version then fresh reviewed upgrade retains artifacts',{skip:!safe,timeout:20_000},async()=>{
 const h=await active('4',true,true);const binding=await actionBinding(h);const management=await import('../src/lib/app-public-management.js');const modules=await import('../src/lib/module-service.js');
 const stage=await management.stagePublicEndpoint(h.actor,{installation_id:h.installed.id,public_action_key:'reserve_item',runtime_binding_id:binding.binding_id,approver_user_id:h.owner,public_label:'Synthetic claim',max_body_bytes:1024,expected_app_version_id:h.installed.version_id,expected_grant_snapshot_id:h.activated.grant_snapshot_id,expected_lifecycle_epoch:h.activated.installation.lifecycle_epoch,expected_grant_epoch:h.activated.installation.grant_epoch});
 await management.activatePublicEndpoint(h.actor,stage.endpoint_id,{expected_review_digest:stage.review_digest,expected_endpoint_epoch:stage.endpoint_epoch,accept_host_policy:true});
 const module=await modules.getModuleInstallation(h.actor,{moduleId:h.moduleManifest.id});const record=await modules.createModuleRecord(h.actor,{module_id:module.module_id,collection_key:'items',data:{title:'Retained old resource'},relations:{},expected_manifest_digest:module.manifest_digest,idempotency_key:`c12-record-${randomUUID()}`});assert.ok(record.record);
 const service=new(await import('../src/lib/app-public-service.js')).AppPublicClaimService({enabled:true});const claim=await service.claim(stage.slug,new TextEncoder().encode(JSON.stringify({resource_ref:{schema_version:'deft.resource_ref.v1',provider:{kind:'module',provider_instance_id:module.id},resource_type:'items',resource_id:record.record.id},expected_revision:record.record.revision,idempotency_key:`c12-public-${randomUUID()}`})));
 const [canonical]=await h.db.select().from(h.schema.appCanonicalClaims).where(h.eq(h.schema.appCanonicalClaims.id,claim.claim_id));const p=await prepared(h);assert.equal(p.review.blockers.pending_public_followups,1);assert.equal((await h.call(`${h.path}/upgrade/activate`,p.input)).body.code,'APP_UPGRADE_BLOCKED');
 const queues=await import('../src/lib/queues.js');const job=await queues.dequeueJob(queues.QUEUE_NAMES.AGENT_JOBS,{orgId:h.org,jobName:'app-public-ingress',dataMatch:{key:'ingress_id',value:canonical!.ingress_id}});assert.ok(job);const handler=(await import('../src/lib/app-public-worker-handler.js')).handleAppPublicIngress;await handler({id:job.id,name:job.name,data:job.data,attempts:job.attempts});
 const [run]=await h.db.select().from(h.schema.appRuns).where(h.eq(h.schema.appRuns.origin_public_ingress_id,canonical!.ingress_id));assert.ok(run);const runtime=await(await import('../src/lib/app-run-runtime.js')).getAppRunRuntime();const [approval]=await h.db.select().from(h.schema.agentActions).where(h.eq(h.schema.agentActions.app_run_id,run.id));assert.equal((await runtime.approvalResolver.approve(approval!.id,h.owner)).status,'approved');
 const identity=await humanIdentity(h,binding.binding_id);const claimed=await runtime.runtimeChannel.claim({...identity,max_claims:1});assert.ok(claimed);const attempt={...identity,run_id:claimed.run_id,attempt_id:claimed.attempt_id,claim_token:claimed.claim_token,sequence:claimed.sequence};assert.ok(await runtime.runtimeChannel.start(attempt));assert.ok(await runtime.runtimeChannel.complete({...attempt,status:'returned',provider_succeeded:true,output:{subject:'Synthetic effect completed'}}));assert.equal((await state(h,run.id)).state,'succeeded');
 const [oldVersion]=await h.db.select().from(h.schema.appVersions).where(h.eq(h.schema.appVersions.id,h.installed.version_id));await approveUpgrade(h,p.targetId);const [retained]=await h.db.select().from(h.schema.appVersions).where(h.eq(h.schema.appVersions.id,h.installed.version_id));assert.equal(retained!.package_json,oldVersion!.package_json);assert.equal((await state(h,run.id)).origin_app_version_id,h.installed.version_id);assert.ok((await runtime.receiptReader.readVerified(h.org,run.id)).some(r=>r.receipt_kind==='attempt_terminal'));assert.equal((await h.db.select().from(h.schema.moduleRecords).where(h.eq(h.schema.moduleRecords.id,record.record.id))).length,1);
});

test('concurrent normal and delayed reconciliation projection cannot resolve its own update',{skip:!safe,timeout:35_000},async()=>{
 const h=await active('4');const binding=await actionBinding(h);const {run,runtime}=await humanRun(h,binding.binding_id,true);const identity=await humanIdentity(h,binding.binding_id);const provider=childProcess();await command(provider,{mode:'provider',identity,started:true},'ready');await crash(provider);await waitLease(h,run.id);
 const recovery=childProcess();await command(recovery,{mode:'maintenance',kind:'recovery'},'committed');await crash(recovery);
 const [job]=await h.db.select().from(h.schema.jobQueue).where(h.and(h.eq(h.schema.jobQueue.org_id,h.org),h.eq(h.schema.jobQueue.name,'app-run-attention')));assert.ok(job);
 const handler=(await import('../src/lib/app-run-maintenance-attention.js')).handleAppRunAttention;const client=await rawClient();const observer=await rawClient();let reconciliation:ReturnType<typeof runtime.service.reconcileUnknown>|undefined;let projection:Promise<void>|undefined;
 try{await client.query('BEGIN');await client.query('LOCK TABLE attention_items IN ACCESS EXCLUSIVE MODE');const {rows:[backend]}=await client.query('SELECT pg_backend_pid() AS id');
 reconciliation=runtime.service.reconcileUnknown(h.org,run.id,{actor_type:'human',user_id:h.owner},'failed');await eventually(async()=>(await state(h,run.id)).state==='failed');await observedWait(observer,backend.id);
 projection=handler({id:job.id,name:job.name,data:job.data,attempts:job.attempts});
 await eventually(async()=>{await observer.query('SELECT pg_stat_clear_snapshot()');const result=await observer.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[backend.id]);return result.rows[0].n>=2;},3_000);
 await client.query('COMMIT');await Promise.all([reconciliation,projection]);
 const [item]=await h.db.select().from(h.schema.attentionItems).where(h.and(h.eq(h.schema.attentionItems.org_id,h.org),h.eq(h.schema.attentionItems.dedupe_key,`app-run:reconciled:${run.id}`)));assert.ok(item);assert.equal(item.state,'open_unseen');
 const events=await h.db.select().from(h.schema.attentionEvents).where(h.and(h.eq(h.schema.attentionEvents.org_id,h.org),h.eq(h.schema.attentionEvents.source_event_id,`app-run:${run.id}:reconciled`),h.eq(h.schema.attentionEvents.event_type,'source_event')));assert.equal(events.length,1);
 await handler({id:job.id,name:job.name,data:job.data,attempts:job.attempts});const [repeated]=await h.db.select().from(h.schema.attentionItems).where(h.eq(h.schema.attentionItems.id,item.id));assert.equal(repeated!.state,'open_unseen');assert.equal(repeated!.event_count,item.event_count);
 }finally{await client.query('ROLLBACK');await reconciliation?.catch(()=>{});await projection?.catch(()=>{});await client.end();await observer.end();}
});

