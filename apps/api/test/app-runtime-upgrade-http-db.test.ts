import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import type { ServerType } from '@hono/node-server';
const target = 'postgresql://gate_g_test@127.0.0.1:55435/gate_g_20260926_c11_runtime_upgrade_test';
const safe = process.env.DATABASE_URL === target && process.env.DEFT_TEST_DATABASE_URL === target;
Object.assign(process.env, { DEFT_APPS_ENABLED:'true', DEFT_APP_RUNS_ENABLED:'true', DEFT_APP_RUN_APP_ORIGIN_ENABLED:'true',
 DEFT_APP_RUNTIME_CHANNEL_ENABLED:'true', DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED:'true', DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED:'true' });
const ring=(kind:string)=>({current:kind,keys:{[kind]:createHash('sha256').update(`c11-upgrade:${kind}`).digest('base64')}});
process.env.DEFT_APP_RUN_KEYRINGS=JSON.stringify({schema_version:'deft.app_run_keyring.v1',run_encryption:ring('c11-enc'),receipt_signing:ring('c11-sign'),fingerprint:ring('c11-fp')});
let server:ServerType|undefined; let base:string;
after(async()=>{ server?.closeAllConnections(); if(server)await new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));
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
async function resourceConsent(h:Awaited<ReturnType<typeof active>>){
 const runtime=await(await import('../src/lib/app-run-runtime.js')).getAppRunRuntime();const management=new(await import('../src/lib/app-resource-sync-management.js')).AppResourceSyncManagement(runtime.keys);
 const [grant]=await h.db.select().from(h.schema.appGrantSnapshots).where(h.eq(h.schema.appGrantSnapshots.id,h.activated.grant_snapshot_id));
 const request={installation_id:h.installed.id,resource_key:'inbox',operator_user_id:h.peer,expected_app_version_id:h.installed.version_id,expected_package_digest:h.installed.package_digest,
 expected_grant_snapshot_digest:grant!.snapshot_digest,expected_lifecycle_epoch:h.activated.installation.lifecycle_epoch,expected_grant_epoch:h.activated.installation.grant_epoch,
 consent_expires_at:new Date(Date.now()+60*60_000).toISOString(),limits:{max_records_per_page:100,max_page_bytes:524288,max_retained_records:100000,max_retained_bytes:1073741824,min_interval_seconds:60}};
 const review=await management.prepareConsent(h.actor,request);const consent=await management.activateConsent(h.actor,{...request,expected_review_digest:review.review_digest,accept_host_policy:true});
 const operator=(await import('../src/lib/module-service.js')).humanModuleActor({orgId:h.org,userId:h.peer,role:'member',source:'rest'});
 return {runtime,management,consent,operator};
}
async function observedWait(client:any,pid:number){for(let i=0;i<100;i++){const result=await client.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid]);if(result.rows[0].n>0)return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('real PostgreSQL row-lock wait not observed');}
for(const protocol of ['3','4','5'] as const)test(`runtime upgrade ${protocol}: live prior staging atomic supersede and exact lost-response recovery`,{skip:!safe},async()=>{
 const h=await active(protocol);const previous=await h.context();const p=await prepared(h);
 const live=await h.context();assert.deepEqual(live.body,previous.body);assert.equal(p.review.authority_carry_forward,false);
 assert.equal((await h.call(`${h.path}/context?app_version_id=${p.targetId}`)).status,409,'unchanged context v1 does not review a staged successor');
 const result=await h.call(`${h.path}/upgrade/activate`,p.input);
 assert.equal(result.status,200,JSON.stringify(result.body));
 const [prior]=await h.db.select().from(h.schema.appVersions).where(h.eq(h.schema.appVersions.id,h.installed.version_id));assert.equal(prior!.state,'superseded');
 assert.equal(result.body.installation.active_version_id,p.targetId);assert.equal(result.body.installation.lifecycle_epoch,p.request.expected_lifecycle_epoch+1);assert.equal(result.body.installation.grant_epoch,p.request.expected_grant_epoch+1);
 const recovered=await h.call(`${h.path}/upgrade/context?app_version_id=${p.targetId}`);assert.equal(recovered.status,200);assert.equal(recovered.cache,'no-store');
 assert.equal(recovered.body.review_request,null);assert.deepEqual(recovered.body.current_activation,{grant_snapshot_id:result.body.grant_snapshot_id,review_digest:p.review.review_digest});
 assert.equal((await h.call(`${h.path}/upgrade/activate`,p.input)).status,409,'retry does not reactivate');
 for(const table of [h.schema.appRuntimeBindings,h.schema.appResourceBindings,h.schema.appRuntimeSessions])assert.equal((await h.db.select({id:table.id}).from(table).where(h.eq(table.org_id,h.org))).length,0);
});
test('runtime upgrade rejects unknown query/body foreign current-member and stale review pins',{skip:!safe},async()=>{
 const h=await active();const p=await prepared(h);
 assert.equal((await h.call(`${h.path}/upgrade/context?app_version_id=${p.targetId}&app_version_id=${p.targetId}`)).status,400);
 assert.equal((await h.call(`${h.path}/upgrade/context?app_version_id=${p.targetId}&extra=1`)).status,400);
 assert.equal((await h.call(`${h.path}/upgrade/review`,{...p.request,extra:true})).status,400);
 assert.equal((await h.call(`${h.path}/upgrade/review?extra=1`,p.request)).status,400);
 assert.equal((await h.call(`${h.path}/upgrade/activate`,{...p.input,accept_host_policy:false})).status,400);
 assert.equal((await h.call(`${h.path}/upgrade/review`,{...p.request,expected_prior_package_digest:`sha256:${'1'.repeat(64)}`})).status,409);
 assert.equal((await h.call(`${h.path}/upgrade/activate`,{...p.input,expected_review_digest:`sha256:${'2'.repeat(64)}`})).status,409);
 const peer=await h.call(`${h.path}/upgrade/review`,p.request,h.memberWeb.accessToken);assert.ok([403,409].includes(peer.status));
 const foreign=await active();assert.ok([403,404,409].includes((await h.call(`${h.path}/upgrade/review`,p.request,foreign.web.accessToken)).status));
 process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED='false';process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED='false';
 try{assert.equal((await h.call(`${h.path}/upgrade/review`,p.request)).status,503);}finally{process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED='true';process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED='true';}
});
test('runtime upgrade module carry and additive schema change preserve installation records and rollback',{skip:!safe},async()=>{
 const h=await active('4',true);const module=await import('../src/lib/module-service.js');
 const [binding]=await h.db.select().from(h.schema.appModuleBindings).where(h.eq(h.schema.appModuleBindings.app_version_id,h.installed.version_id));
 const record=await module.createModuleRecord(h.actor,{module_id:h.moduleManifest.id,collection_key:'items',data:{title:'Synthetic retained record'},expected_manifest_digest:h.artifacts[0]!.digest,idempotency_key:`c11-record-${randomUUID()}`});
 const manifest={...h.moduleManifest,version:'1.1.0',collections:h.moduleManifest.collections.map(collection=>({...collection,fields:[...collection.fields,{key:'note',label:'Note',type:'text',required:false}]}))};
 const p=await prepared(h,{moduleManifest:manifest});const upgrade=await import('../src/lib/app-runtime-upgrade.js');
 for(const hook of ['failAfterModulePreparation','failBeforePointerSwap'] as const){await assert.rejects(upgrade.activateRuntimeUpgrade(h.actor,h.installed.id,p.input,{testHooks:{[hook]:true}}));
   const [current]=await h.db.select().from(h.schema.appInstallations).where(h.eq(h.schema.appInstallations.id,h.installed.id));assert.equal(current!.active_version_id,h.installed.version_id);
   assert.equal((await h.db.select().from(h.schema.appModuleBindings).where(h.eq(h.schema.appModuleBindings.app_version_id,p.targetId))).length,0);}
 const activated=await h.call(`${h.path}/upgrade/activate`,p.input);assert.equal(activated.status,200,JSON.stringify(activated.body));
 const [newBinding]=await h.db.select().from(h.schema.appModuleBindings).where(h.eq(h.schema.appModuleBindings.app_version_id,p.targetId));assert.equal(newBinding!.module_installation_id,binding!.module_installation_id);assert.notEqual(newBinding!.module_version_id,binding!.module_version_id);
 const [retained]=await h.db.select().from(h.schema.moduleRecords).where(h.eq(h.schema.moduleRecords.id,record.record!.id));assert.equal(retained!.data.title,'Synthetic retained record');
});
test('runtime upgrade counts pending approval even after supported old binding revoke',{skip:!safe},async()=>{
 const h=await active('4');const binding=await actionBinding(h);const runtime=await(await import('../src/lib/app-run-runtime.js')).getAppRunRuntime();
 const run=await runtime.service.submitReviewedRuntime({org_id:h.org,user_id:h.owner},{runtime_binding_id:binding.binding_id,idempotency_key:`c11-action-${randomUUID()}`,input:{subject:'Synthetic governed work'}});assert.equal(run.state,'pending_approval');
 await(await import('../src/lib/app-runtime-management.js')).revokeRuntimeBinding(h.actor,binding.binding_id);
 const p=await prepared(h);assert.equal(p.review.blockers.old_work.pending_approval,1);assert.equal((await h.call(`${h.path}/upgrade/activate`,p.input)).body.code,'APP_UPGRADE_BLOCKED');
 const [original]=await h.db.select().from(h.schema.appRuns).where(h.eq(h.schema.appRuns.id,run.id));assert.equal(original!.origin_app_version_id,h.installed.version_id);
});
test('runtime upgrade counts all guarded nonterminal sync states without joining live binding authority',{skip:!safe},async()=>{
 const h=await active('5');const runtime=await(await import('../src/lib/app-run-runtime.js')).getAppRunRuntime();const management=new(await import('../src/lib/app-resource-sync-management.js')).AppResourceSyncManagement(runtime.keys);
 const [grant]=await h.db.select().from(h.schema.appGrantSnapshots).where(h.eq(h.schema.appGrantSnapshots.id,h.activated.grant_snapshot_id));
 const request={installation_id:h.installed.id,resource_key:'inbox',operator_user_id:h.peer,expected_app_version_id:h.installed.version_id,expected_package_digest:h.installed.package_digest,
 expected_grant_snapshot_digest:grant!.snapshot_digest,expected_lifecycle_epoch:h.activated.installation.lifecycle_epoch,expected_grant_epoch:h.activated.installation.grant_epoch,
 consent_expires_at:new Date(Date.now()+60*60_000).toISOString(),limits:{max_records_per_page:100,max_page_bytes:524288,max_retained_records:100000,max_retained_bytes:1073741824,min_interval_seconds:60}};
 const consentReview=await management.prepareConsent(h.actor,request);const consent=await management.activateConsent(h.actor,{...request,expected_review_digest:consentReview.review_digest,accept_host_policy:true});
 const admission=await runtime.resourceSyncAdmission.admitDue({org_id:h.org,resource_binding_id:consent.binding_id});assert.equal(admission.state,'created');if(admission.state!=='created')throw Error('Expected new Run');
 const p=await prepared(h);
 // Legal synthetic state transitions exercise count completeness. They do
 // not claim provider-effect or unknown-outcome reconciliation evidence.
 for(const state of ['pending','running','waiting_external','unknown_outcome'] as const){
   if(state!=='pending')await h.db.update(h.schema.appRuns).set({state}).where(h.eq(h.schema.appRuns.id,admission.run_id));
   const checked=await refreshReview(h,p.targetId);assert.equal(checked.review.blockers.old_work[state],1);assert.equal((await h.call(`${h.path}/upgrade/activate`,checked.input)).body.code,'APP_UPGRADE_BLOCKED');
 }
 await management.revokeConsent(h.actor,consent.binding_id);const orphan=await refreshReview(h,p.targetId);assert.equal(orphan.review.blockers.old_work.unknown_outcome,1);
 assert.equal((await h.call(`${h.path}/upgrade/activate`,orphan.input)).body.code,'APP_UPGRADE_BLOCKED');
 await h.db.update(h.schema.appRuns).set({state:'failed',terminal_at:new Date()}).where(h.eq(h.schema.appRuns.id,admission.run_id));const drained=await refreshReview(h,p.targetId);
 assert.deepEqual(drained.review.blockers.old_work,{});assert.equal((await h.call(`${h.path}/upgrade/activate`,drained.input)).status,200);
});
for(const mutation of ['membership inactive','membership role','SID revoked','kind after SID wait','gate after SID wait','stage kind after SID wait'] as const)test(`runtime upgrade final web authority: ${mutation}`,{skip:!safe},async()=>{
 const h=await active('4');const p=await prepared(h);const pg=(await import('pg')).default;const client=new pg.Client({connectionString:target});await client.connect();
 const oldVersions=await h.db.select().from(h.schema.appVersions).where(h.eq(h.schema.appVersions.installation_id,h.installed.id));const oldGrants=await h.db.select().from(h.schema.appGrantSnapshots).where(h.eq(h.schema.appGrantSnapshots.app_installation_id,h.installed.id));
 const sid=JSON.parse(Buffer.from(h.web.accessToken.split('.')[1]!,'base64url').toString()).sid;const staging=mutation.startsWith('stage');const pkg=staging?await nextPackage(h,{version:'1.2.0'}):null;
 try{await client.query('BEGIN');const {rows:[backend]}=await client.query('SELECT pg_backend_pid() AS id');
  if(mutation.startsWith('membership'))await client.query('SELECT id FROM org_members WHERE org_id=$1 AND user_id=$2 FOR UPDATE',[h.org,h.owner]);
  else await client.query('SELECT id FROM web_sessions WHERE org_id=$1 AND id=$2 FOR UPDATE',[h.org,sid]);
  const response=staging?h.call(`${h.path}/upgrade/stage`,{schema_version:'deft.app_runtime_upgrade_stage.v1',package_json:pkg!.json,expected_lifecycle_epoch:p.request.expected_lifecycle_epoch}):h.call(`${h.path}/upgrade/activate`,p.input);
  await observedWait(client,backend.id);
  if(mutation==='membership inactive')await client.query('UPDATE org_members SET is_active=false WHERE org_id=$1 AND user_id=$2',[h.org,h.owner]);
  else if(mutation==='membership role')await client.query("UPDATE org_members SET role='member' WHERE org_id=$1 AND user_id=$2",[h.org,h.owner]);
  else if(mutation==='SID revoked')await client.query('UPDATE web_sessions SET revoked_at=now() WHERE org_id=$1 AND id=$2',[h.org,sid]);
  else if(mutation==='gate after SID wait'){process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED='false';process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED='false';}
  else await client.query("UPDATE users SET kind='agent' WHERE id=$1",[h.owner]);
  await client.query('COMMIT');const denied=await response;assert.ok((mutation==='gate after SID wait'?[503]:[401,403,409]).includes(denied.status),JSON.stringify(denied.body));
  const [prior]=await h.db.select().from(h.schema.appInstallations).where(h.eq(h.schema.appInstallations.id,h.installed.id));assert.equal(prior!.active_version_id,h.installed.version_id);
  assert.equal((await h.db.select().from(h.schema.auditLog).where(h.eq(h.schema.auditLog.action,'app.runtime.upgrade_activate'))).filter(row=>row.org_id===h.org).length,0);
  assert.deepEqual(await h.db.select().from(h.schema.appVersions).where(h.eq(h.schema.appVersions.installation_id,h.installed.id)),oldVersions,'failed final guard rolls back version writes');
  assert.deepEqual(await h.db.select().from(h.schema.appGrantSnapshots).where(h.eq(h.schema.appGrantSnapshots.app_installation_id,h.installed.id)),oldGrants,'failed final guard rolls back new grant');
 }finally{process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED='true';process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED='true';await client.query('ROLLBACK');await client.end();}
});
test('runtime upgrade refuses confirmed pending public outbox before any Run exists until normal worker terminalizes it',{skip:!safe},async()=>{
 const h=await active('4',true,true);const binding=await actionBinding(h);const management=await import('../src/lib/app-public-management.js');
 const endpoint=await management.stagePublicEndpoint(h.actor,{installation_id:h.installed.id,public_action_key:'reserve_item',runtime_binding_id:binding.binding_id,approver_user_id:h.owner,public_label:'Synthetic public claim',max_body_bytes:2048,
 expected_app_version_id:h.installed.version_id,expected_grant_snapshot_id:h.activated.grant_snapshot_id,expected_lifecycle_epoch:h.activated.installation.lifecycle_epoch,expected_grant_epoch:h.activated.installation.grant_epoch});
 await management.activatePublicEndpoint(h.actor,endpoint.endpoint_id,{expected_review_digest:endpoint.review_digest,expected_endpoint_epoch:endpoint.endpoint_epoch,accept_host_policy:true});
 const module=await import('../src/lib/module-service.js');const [moduleBinding]=await h.db.select().from(h.schema.appModuleBindings).where(h.eq(h.schema.appModuleBindings.app_version_id,h.installed.version_id));
 const created=await module.createModuleRecord(h.actor,{module_id:h.moduleManifest.id,collection_key:'items',data:{title:'Public synthetic item'},expected_manifest_digest:h.artifacts[0]!.digest,idempotency_key:`public-item-${randomUUID()}`});
 const shared=await import('@deft/shared');const claim=await new(await import('../src/lib/app-public-service.js')).AppPublicClaimService({enabled:true}).claim(endpoint.slug,new TextEncoder().encode(JSON.stringify({resource_ref:{schema_version:shared.RESOURCE_CONTRACT_VERSIONS.ref,provider:{kind:'module',provider_instance_id:moduleBinding!.module_installation_id},resource_type:'items',resource_id:created.record!.id},expected_revision:created.record!.revision,idempotency_key:`public-${randomUUID()}`})));
 assert.equal(claim.follow_up_state,'pending');assert.equal((await h.db.select().from(h.schema.appRuns).where(h.eq(h.schema.appRuns.org_id,h.org))).length,0);
 const p=await prepared(h);assert.equal(p.review.blockers.pending_public_followups,1);assert.equal((await h.call(`${h.path}/upgrade/activate`,p.input)).body.code,'APP_UPGRADE_BLOCKED');
 await management.disablePublicEndpoint(h.actor,endpoint.endpoint_id);
 const [job]=await h.db.select().from(h.schema.jobQueue).where(h.and(h.eq(h.schema.jobQueue.org_id,h.org),h.eq(h.schema.jobQueue.name,'app-public-ingress')));assert.ok(job);
 await(await import('../src/lib/app-public-worker-handler.js')).handleAppPublicIngress({id:job.id,name:job.name,data:job.data,attempts:job.attempts});
 const [ingress]=await h.db.select().from(h.schema.appPublicIngress).where(h.eq(h.schema.appPublicIngress.org_id,h.org));assert.equal(ingress!.follow_up_state,'unsupported');assert.equal(ingress!.follow_up_code,'ENDPOINT_REVOKED');
 const clear=await refreshReview(h,p.targetId);assert.equal(clear.review.blockers.pending_public_followups,0);assert.equal((await h.call(`${h.path}/upgrade/activate`,clear.input)).status,200);
});
test('runtime upgrade App fence observes a supported action admission committed after a real lock wait',{skip:!safe,timeout:15000},async()=>{
 const h=await active('4');const binding=await actionBinding(h);const p=await prepared(h);const runtime=await(await import('../src/lib/app-run-runtime.js')).getAppRunRuntime();
 const adminId=randomUUID();await h.db.insert(h.schema.users).values({id:adminId,name:'Upgrade admin',email:`${adminId}@example.test`});await h.db.insert(h.schema.orgMembers).values({org_id:h.org,user_id:adminId,role:'admin',is_active:true});const admin=await h.token(adminId);
 const pg=(await import('pg')).default;const monitor=new pg.Client({connectionString:target});await monitor.connect();let heldPid=0;let entered!:()=>void;let release!:()=>void;
 const enteredPromise=new Promise<void>(resolve=>{entered=resolve});const held=new Promise<void>(resolve=>{release=resolve});
 const admission=runtime.service.submitReviewedRuntime({org_id:h.org,user_id:h.owner},{runtime_binding_id:binding.binding_id,idempotency_key:`race-${randomUUID()}`,input:{subject:'Exact old work'}},async tx=>{
   for(const id of [h.owner,h.peer].sort())await tx.execute(h.sql`SELECT id FROM org_members WHERE org_id=${h.org} AND user_id=${id} FOR SHARE`);
   await tx.execute(h.sql`SELECT id FROM app_installations WHERE org_id=${h.org} AND id=${h.installed.id} FOR SHARE`);
   const rows=await tx.execute(h.sql`SELECT pg_backend_pid() AS id`);heldPid=Number(rows.rows[0]!.id);entered();await held;
 });
 try{await enteredPromise;const activating=h.call(`${h.path}/upgrade/activate`,p.input,admin.accessToken);await observedWait(monitor,heldPid);release();const run=await admission;assert.equal(run.state,'pending_approval');
  const denied=await activating;assert.ok([409].includes(denied.status),JSON.stringify(denied.body));const checked=await refreshReview(h,p.targetId);assert.equal(checked.review.blockers.old_work.pending_approval,1);
  const [prior]=await h.db.select().from(h.schema.appInstallations).where(h.eq(h.schema.appInstallations.id,h.installed.id));assert.equal(prior!.active_version_id,h.installed.version_id);
 }finally{release();await admission.catch(()=>{});await monitor.end();}
});
test('runtime upgrade refuses module removal and immutable prior ownership deletion without silently dropping data',{skip:!safe},async()=>{
 const h=await active('4',true);const pkg=await nextPackage(h,{removeModule:true});const stage=await h.call(`${h.path}/upgrade/stage`,{schema_version:'deft.app_runtime_upgrade_stage.v1',package_json:pkg.json,expected_lifecycle_epoch:h.activated.installation.lifecycle_epoch});assert.equal(stage.status,200);
 const targetId=stage.body.app_version_id;const refused=await h.call(`${h.path}/upgrade/context?app_version_id=${targetId}`);assert.equal(refused.status,409);assert.equal(refused.body.code,'APP_INVALID_PACKAGE');
 // Missing ownership cannot be created through deletion: the existing
 // append-only DB guard rejects this synthetic mutation without any bypass.
 await assert.rejects(h.db.delete(h.schema.appModuleBindings).where(h.eq(h.schema.appModuleBindings.app_version_id,h.installed.version_id)),error=>(error as any).cause?.code==='55000');
 assert.equal((await h.call(`${h.path}/upgrade/context?app_version_id=${targetId}`)).body.code,'APP_INVALID_PACKAGE');
});
test('runtime upgrade keeps cross-protocol staging and non-web purposes unsupported',{skip:!safe},async()=>{
 const h=await active('5');const manifest={...h.manifest,schema_version:'4',version:'1.1.0',compatibility:{app_protocol:'4'},runtime_requirements:h.manifest.runtime_requirements.filter(item=>item.protocol_version==='deft.app_runtime_channel.v1')};delete (manifest as any).sync_descriptors;const pkg=await h.kit.buildDeftAppPackage({manifest,artifacts:h.artifacts});const stage=await h.call(`${h.path}/upgrade/stage`,{schema_version:'deft.app_runtime_upgrade_stage.v1',package_json:pkg.json,expected_lifecycle_epoch:h.activated.installation.lifecycle_epoch});assert.equal(stage.status,409);assert.equal(stage.body.code,'APP_PROTOCOL_UNSUPPORTED');
 const p=await prepared(h);const jwt=(await import('jsonwebtoken')).default;const {env}=await import('../src/lib/env.js');const token=jwt.sign({id:h.owner,org_id:h.org,purpose:'app-developer'},env.JWT_SECRET,{algorithm:'HS256',expiresIn:'5m'});
 assert.ok([401,403].includes((await h.call(`${h.path}/upgrade/review`,p.request,token)).status));
});

test('runtime upgrade settlement never waits on Run locks and retires old private authority while retaining records',{skip:!safe,timeout:15000},async()=>{
 const h=await active('5',false,false,true);const {runtime,management,consent,operator}=await resourceConsent(h);
 const admitted=await runtime.resourceSyncAdmission.admitDue({org_id:h.org,resource_binding_id:consent.binding_id});assert.equal(admitted.state,'created');
 const credential=await management.issueOperatorSession(operator,consent.binding_id);
 const identity={schema_version:'deft.app_runtime_channel.v2' as const,audience:'app_resource_sync' as const,session_id:credential.session_id,session_token:credential.session_token};
 const claim=await runtime.resourceSyncChannel.claim({...identity,max_claims:1});assert.ok(claim);
 const attempt={...identity,run_id:claim.run_id,attempt_id:claim.attempt_id,claim_token:claim.claim_token,sequence:claim.sequence};assert.ok(await runtime.resourceSyncChannel.start(attempt));
 const p=await prepared(h);const pg=(await import('pg')).default;const client=new pg.Client({connectionString:target});await client.connect();
 let settling:ReturnType<typeof runtime.resourceSyncChannel.complete>|undefined;
 try{await client.query('BEGIN');const {rows:[process]}=await client.query('SELECT pg_backend_pid() AS id');await client.query('SELECT id FROM app_runs WHERE org_id=$1 AND id=$2 FOR UPDATE',[h.org,claim.run_id]);
  settling=runtime.resourceSyncChannel.complete({...attempt,status:'returned',provider_succeeded:true,page:{schema_version:'deft.app_sync_page.v1',upserts:[{id:'synthetic-provider-id',revision:'revision-private',data:{subject:'Retained private value'}}],tombstones:[],next_cursor:null,has_more:false}});
  await observedWait(client,process.id);
  const refused=await h.call(`${h.path}/upgrade/activate`,p.input);assert.equal(refused.body.code,'APP_UPGRADE_BLOCKED','count does not acquire a held Run lock');
  await client.query('COMMIT');assert.ok(await settling);
 }finally{await client.query('ROLLBACK');await settling?.catch(()=>{});await client.end();}
 const created=await h.call(`/api/app-experiences/${h.installed.id}/main/sessions`,{});assert.equal(created.status,200,JSON.stringify(created.body));const path=`/api/app-experiences/sessions/${created.body.pin.session_id}`;
 const review=await h.call(`${path}/exposure/review`,{});assert.equal(review.status,200);assert.equal((await h.call(`${path}/exposure/accept`,{review_token:review.body.review_token,review_digest:review.body.review_digest,accept_exposure:true})).status,200);
 const list={schema_version:'deft.experience_resource_request.v1',operation:'list_summary'};
 const before=await h.call(`${path}/resources/inbox`,list);assert.equal(before.status,200);assert.equal(before.body.output.items.length,1);
 const retainedBefore=await h.db.select().from(h.schema.appResourceProjections).where(h.eq(h.schema.appResourceProjections.resource_binding_id,consent.binding_id));assert.equal(retainedBefore.length,1);
 const ready=await refreshReview(h,p.targetId);assert.deepEqual(ready.review.blockers.old_work,{});assert.equal((await h.call(`${h.path}/upgrade/activate`,ready.input)).status,200);
 assert.ok([404,409].includes((await h.call(`${path}/resources/inbox`,list)).status),'old session cannot read after the active-version swap');
 assert.equal(await runtime.resourceSyncChannel.claim({...identity,max_claims:1}),null);
 await assert.rejects(runtime.resourceSyncAdmission.admitDue({org_id:h.org,resource_binding_id:consent.binding_id}),error=>(error as any).code==='APP_ACCESS_DENIED');
 const rows=await h.db.select().from(h.schema.appResourceProjections).where(h.eq(h.schema.appResourceProjections.resource_binding_id,consent.binding_id));assert.deepEqual(rows,retainedBefore,'encrypted private record is retained exactly');
 const session=await h.call(`/api/app-experiences/${h.installed.id}/main/sessions`,{});assert.equal(session.status,200);const newPath=`/api/app-experiences/sessions/${session.body.pin.session_id}`;
 assert.equal((await h.call(`${newPath}/resources/inbox`,list)).status,404);assert.equal((await h.call(`${newPath}/exposure/review`,{})).status,404,'new version has no inferred binding consent');
 const bindings=await h.db.select().from(h.schema.appResourceBindings).where(h.and(h.eq(h.schema.appResourceBindings.org_id,h.org),h.eq(h.schema.appResourceBindings.app_version_id,p.targetId)));assert.equal(bindings.length,0);
});

test('runtime upgrade refuses active inbound dependency metadata until supported dependent disable',{skip:!safe},async()=>{
 const h=await active('4');const apps=await import('../src/lib/app-service.js');const reviews=await import('../src/lib/app-runtime-review.js');const grants=await import('../src/lib/app-grant-service.js');
 const manifest={...h.manifest,id:`${h.manifest.id}consumer`};const pkg=await h.kit.buildDeftAppPackage({manifest,artifacts:[]});const staged=await apps.stageAppPackage(h.actor,pkg.json);
 const context=await reviews.getRuntimeAppReviewContext(h.actor,staged.id,staged.version_id);assert.ok(context.review_request);const review=await reviews.prepareRuntimeAppReview(h.actor,staged.id,context.review_request!);const consumer=await reviews.activateRuntimeApp(h.actor,staged.id,{...context.review_request!,expected_review_digest:review.review_digest,accept_host_policy:true});
 const [version]=await h.db.select().from(h.schema.appVersions).where(h.eq(h.schema.appVersions.id,h.installed.version_id));
 const canonical={lock_version:'deft.app_dependency_lock.v1',dependency_key:'provider',required_app_id:h.manifest.id,required_version:version!.version,dependency_installation_id:h.installed.id,dependency_version_id:version!.id,dependency_manifest_digest:version!.manifest_digest,dependency_package_digest:version!.package_digest,dependency_lifecycle_epoch:h.activated.installation.lifecycle_epoch,ownership:'preexisting'};
 // Synthetic exact pinned metadata uses normal FK/digest/append-only guards;
 // this does not claim a connected-v1 dependency authoring journey.
 await h.db.insert(h.schema.appDependencyLocks).values({org_id:h.org,app_installation_id:staged.id,app_version_id:staged.version_id,grant_snapshot_id:consumer.grant_snapshot_id,dependency_key:'provider',required_app_id:h.manifest.id,required_version:version!.version,dependency_installation_id:h.installed.id,dependency_version_id:version!.id,dependency_manifest_digest:version!.manifest_digest,dependency_package_digest:version!.package_digest,dependency_lifecycle_epoch:h.activated.installation.lifecycle_epoch,ownership:'preexisting',canonical_lock:canonical,lock_digest:grants.digestAppGrantValue(canonical)});
 const p=await prepared(h);assert.equal(p.review.blockers.active_dependents,1);assert.equal((await h.call(`${h.path}/upgrade/activate`,p.input)).body.code,'APP_UPGRADE_BLOCKED');
 await apps.disableAppInstallation(h.actor,staged.id,consumer.installation.lifecycle_epoch);const ready=await refreshReview(h,p.targetId);assert.equal(ready.review.blockers.active_dependents,0);assert.equal((await h.call(`${h.path}/upgrade/activate`,ready.input)).status,200);
});

test('runtime upgrade unchanged Module carry preserves exact identity and nonadditive change rolls back',{skip:!safe},async()=>{
 const h=await active('4',true);const [old]=await h.db.select().from(h.schema.appModuleBindings).where(h.eq(h.schema.appModuleBindings.app_version_id,h.installed.version_id));const p=await prepared(h);assert.equal(p.review.modules[0].mode,'carry');assert.equal((await h.call(`${h.path}/upgrade/activate`,p.input)).status,200);
 const [carried]=await h.db.select().from(h.schema.appModuleBindings).where(h.eq(h.schema.appModuleBindings.app_version_id,p.targetId));assert.equal(carried!.module_installation_id,old!.module_installation_id);assert.equal(carried!.module_version_id,old!.module_version_id);
 const other=await active('4',true);const destructive={...other.moduleManifest,version:'1.1.0',collections:other.moduleManifest.collections.map(collection=>({...collection,fields:collection.fields.map(field=>({...field,type:'number'})),search:{title_field:'title',subtitle_fields:[],fields:['title']}}))};
 const plan=await prepared(other,{moduleManifest:destructive});const denied=await other.call(`${other.path}/upgrade/activate`,plan.input);assert.equal(denied.status,409,JSON.stringify(denied.body));
 const [current]=await other.db.select().from(other.schema.appInstallations).where(other.eq(other.schema.appInstallations.id,other.installed.id));assert.equal(current!.active_version_id,other.installed.version_id);assert.equal((await other.db.select().from(other.schema.appModuleBindings).where(other.eq(other.schema.appModuleBindings.app_version_id,plan.targetId))).length,0);
});
