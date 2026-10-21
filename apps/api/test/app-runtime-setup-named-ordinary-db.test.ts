import { runtimeSecurityPackage } from './fixtures/runtime-security-package.js';
import test from 'node:test';import assert from 'node:assert/strict';import{randomUUID,createHash}from'node:crypto';
import { processTestDatabaseUrl } from './fixtures/safe-test-database-target.js';
const safe=Boolean(processTestDatabaseUrl());
assert.ok(safe,'Requires a disposable test database shared by the test and runtime clients');

test('ordinary named Runtime setup pins the selected owner target without issuing credentials',{skip:!safe,timeout:180_000},async t=>{
 Object.assign(process.env,{DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED:'true',DEFT_APP_PRIVATE_SHARING_ENABLED:'true',DEFT_APP_PRIVATE_MCP_ENABLED:'true',DEFT_APPS_ENABLED:'true',DEFT_APP_RUNS_ENABLED:'true',DEFT_APP_RUN_APP_ORIGIN_ENABLED:'true',DEFT_APP_ATTACHMENT_BROKER_ENABLED:'true',DEFT_APP_RUNTIME_CHANNEL_ENABLED:'true',DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED:'true',DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED:'true'});
 const ring=(purpose:string)=>({current:purpose,keys:{[purpose]:createHash('sha256').update('runtime-setup:'+purpose).digest('base64')}});process.env.DEFT_APP_RUN_KEYRINGS=JSON.stringify({schema_version:'deft.app_run_keyring.v1',run_encryption:ring('enc'),receipt_signing:ring('sign'),fingerprint:ring('fp')});
 const [{app},{db,closeDb},s,orm,web]=await Promise.all([import('../src/index.js'),import('../src/lib/db.js'),import('@deft/db/schema'),import('drizzle-orm'),import('../src/lib/web-sessions.js')]);
 const org=randomUUID(),owner=randomUUID(),member=randomUUID(),suffix=randomUUID();
 await db.insert(s.orgs).values({id:org,name:'Synthetic Runtime setup',slug:'runtime-setup-'+suffix});await db.insert(s.users).values([{id:owner,name:'Owner',email:`owner-${suffix}@example.test`},{id:member,name:'Member',email:`member-${suffix}@example.test`}]);await db.insert(s.orgMembers).values([{id:randomUUID(),org_id:org,user_id:owner,role:'owner',is_active:true},{id:randomUUID(),org_id:org,user_id:member,role:'member',is_active:true}]);
 const ownerSession=await web.createWebSession({id:owner,org_id:org,email:`owner-${suffix}@example.test`}),memberSession=await web.createWebSession({id:member,org_id:org,email:`member-${suffix}@example.test`});
 async function response(path:string,method='GET',body?:unknown,token=ownerSession.accessToken){return app.request('http://localhost'+path,{method,headers:{authorization:`Bearer ${token}`,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});}
 async function call(path:string,method='GET',body?:unknown){const r=await response(path,method,body);const value=await r.json() as any;assert(r.ok,`${path} HTTP ${r.status} ${value.code??''} ${value.error??''}`);return value;}
 try{
  const {buildDeftAppPackage}=await import('@deft/app-kit');
  const fixture=JSON.parse((await runtimeSecurityPackage()).json);
  Object.assign(fixture.manifest.sync_descriptors[0].record_schema.properties,{
   source_record_id:{type:'string',maxLength:36},source_content_digest:{type:'string',maxLength:71},
   source_observed_at:{type:'string',maxLength:40},logical_message_id:{type:'string',maxLength:200},
  });
  fixture.manifest.sync_descriptors[0].record_schema.required.push('source_record_id','source_content_digest','source_observed_at','logical_message_id');
  fixture.manifest.owner_connections=[{key:'mailbox',resource_key:'inbox',action_keys:['archive_message','reply_message','send_message'],
   max_consent_seconds:86400,provider_profile_key:'synthetic_mail',runtime_requirement_key:'sync_provider'}];
  fixture.manifest.record_stores=[{schema_version:'deft.app_record_store.v1',key:'drafts',resource_key:'inbox',runtime_requirement_key:'sync_provider',
   max_record_bytes:16384,max_files:0,max_file_bytes:1024,max_total_file_bytes:1024,
   resource_content:{max_presentation_bytes:16384,max_source_bytes:16384,max_file_bytes:1024,max_image_bytes:1024},
   source_projection:{sync_descriptor_key:'inbox',record_id_field:'source_record_id',content_digest_field:'source_content_digest',
    observed_at_field:'source_observed_at',projection_identity_field:'logical_message_id',navigation_entry_key:'main'}}];
  const packed=(await buildDeftAppPackage({manifest:fixture.manifest,artifacts:fixture.artifacts})).json;
  const {app:installed}=await call('/api/apps/blob/composition/stage','POST',packed);
  const initial=await call(`/api/apps/blob/composition/${installed.id}/context?app_version_id=${installed.version_id}`);const {review}=await call(`/api/apps/blob/composition/${installed.id}/review`,'POST',initial.review_request);
  await call(`/api/apps/blob/composition/${installed.id}/activate`,'POST',{...initial.review_request,expected_review_digest:review.review_digest,accept_host_policy:true});
  const path=`/api/apps/blob/composition/${installed.id}/runtime/context?app_version_id=${installed.version_id}`;
  await t.test('read-only setup returns bounded self-operator pins with no credentials or bindings created',async()=>{
   const context=await call(path);assert.equal(context.actions.length,3);assert.equal(context.operator_user_id,owner);assert.equal(context.policy.review_scope,'per_invocation');assert(context.actions.every((a:any)=>a.binding===null&&a.review_request.operator_user_id===owner));assert(!JSON.stringify(context).includes('session_token'));const rows=await db.select().from(s.appRuntimeBindings).where(orm.eq(s.appRuntimeBindings.org_id,org));assert.equal(rows.length,0);
  });
  await t.test('read-only target checks coexist with background readers and report exclusive contention accurately',async()=>{
   const {default:pg}=await import('pg');const peer=new pg.Client({connectionString:processTestDatabaseUrl()!});await peer.connect();
   const targetsPath=`/api/apps/blob/composition/${installed.id}/runtime/targets?app_version_id=${installed.version_id}`;
   try{
    // Background account/sync authority holds this same shared membership lock.
    // Metadata must preserve revocation fencing without asking for a write lock.
    await peer.query('BEGIN');await peer.query('SELECT id FROM org_members WHERE org_id=$1 AND user_id=$2 FOR SHARE',[org,owner]);
    assert.equal((await call(targetsPath)).app_version_id,installed.version_id);
    await peer.query('ROLLBACK');await peer.query('BEGIN');await peer.query('SELECT id FROM org_members WHERE org_id=$1 AND user_id=$2 FOR UPDATE',[org,owner]);
    const blocked=await response(targetsPath);assert.equal(blocked.status,503);assert.equal(blocked.headers.get('retry-after'),'1');
    assert.deepEqual(await blocked.json(),{error:'App access is busy. Please try again.',code:'APP_EXPERIENCE_BUSY',retryable:true,details:{reason:'deadline'}});
   }finally{await peer.query('ROLLBACK');await peer.end();}
   await db.update(s.orgMembers).set({is_active:false}).where(orm.and(orm.eq(s.orgMembers.org_id,org),orm.eq(s.orgMembers.user_id,owner)));
   try{assert.ok([401,403].includes((await response(targetsPath)).status));}
   finally{await db.update(s.orgMembers).set({is_active:true}).where(orm.and(orm.eq(s.orgMembers.org_id,org),orm.eq(s.orgMembers.user_id,owner)));}
  });
  await t.test('named current owner target is catalogued and exact normal review activates only that target',async nested=>{
   // Fixture creation uses the same normal management service; unrelated retained
   // disposable-DB key versions are not part of this Runtime metadata test.
   const {AppResourceSyncManagement}=await import('../src/lib/app-resource-sync-management.js');
   const {parseEnvironmentAppRunKeyrings}=await import('../src/lib/app-run-keyrings.js');
   const {resourceSyncWebAuthority}=await import('../src/lib/app-resource-sync-web-authority.js');
   const {actor,guard}=await resourceSyncWebAuthority('Bearer '+ownerSession.accessToken);
   const management=new AppResourceSyncManagement(parseEnvironmentAppRunKeyrings(process.env.DEFT_APP_RUN_KEYRINGS),()=>new Date(),'attachment_v3');
   const setup=await management.setupContext(actor,{installation_id:installed.id,operator_user_id:owner},guard);
   const input={...setup.descriptors[0].consent_request,target_key:'named_mailbox'};
   const resourceReview=await management.prepareConsent(actor,input,guard);
   const resource=await management.activateConsent(actor,{...input,expected_review_digest:resourceReview.review_digest,accept_host_policy:true},guard);
   const catalog=await call(`/api/apps/blob/composition/${installed.id}/runtime/targets?app_version_id=${installed.version_id}`);
   assert.deepEqual(catalog.targets,[{resource_binding_id:resource.binding_id,target_key:'named_mailbox',resource_key:'inbox'}]);
   const selectedPath=path+'&owner_resource_binding_id='+resource.binding_id;
   const context=await call(selectedPath);assert.equal(context.target.resource_binding_id,resource.binding_id);
   const request=context.actions[1].review_request;assert.equal(request.owner_resource_binding_id,resource.binding_id);
   const {review:actionReview}=await call('/api/apps/blob/composition/runtime/reviews/prepare','POST',request);
   assert.equal(actionReview.owner_resource_binding_id,resource.binding_id);
   const before=await db.select().from(s.appRuntimeSessions).where(orm.eq(s.appRuntimeSessions.org_id,org));
   const {binding}=await call('/api/apps/blob/composition/runtime/bindings/activate','POST',{...request,expected_review_digest:actionReview.review_digest,accept_host_policy:true});
   const ready=await call(selectedPath),action=ready.actions.find((row:any)=>row.key===request.action_key);
   assert.equal(action.binding.id,binding.binding_id);assert.equal(action.binding.can_issue_session,false);
   assert.equal(action.review_request.owner_resource_binding_id,resource.binding_id);
   const primary=await call(path);assert.equal(primary.target,undefined);assert(primary.actions.every((row:any)=>row.review_request.owner_resource_binding_id===undefined));
   const after=await db.select().from(s.appRuntimeSessions).where(orm.eq(s.appRuntimeSessions.org_id,org));assert.equal(after.length,before.length);
   await nested.test('actual Knowledge delivery, technical renewal and account-target reads coexist',async()=>{
    const [{createAppIntegrationCaptureRuntime},{runtimeRenewalPersistentPrincipal},{loadLiveAttachmentSyncBindingAuthority},runtimeAuthority,
     {appIntegrationCapturePolicies:policies},{RetryLaterJobError}]=await Promise.all([
     import('../src/lib/app-integration-capture-runtime.js'),import('../src/lib/app-runtime-renewal.js'),import('../src/lib/app-attachment-sync-authority.js'),
     import('../src/lib/app-runtime-authority.js'),import('../../../packages/db/src/app-integration-capture-schema.js'),import('../src/lib/queues.js')]);
    const {web_session}=await resourceSyncWebAuthority('Bearer '+ownerSession.accessToken);
    const session=await runtimeAuthority.issueAppRuntimeSession({org_id:org,operator_user_id:owner,runtime_binding_id:binding.binding_id,guard,
     technical_renewal:{requested_until:new Date(Date.now()+300_000),sid:web_session.sid,role:'owner'}});
    assert.ok(session?.renewable_until);
    const policyId=randomUUID(),jobId=randomUUID(),lockToken=randomUUID(),account='synthetic-private-account';
    await db.update(s.orgs).set({ai_config:{ollama_url:'http://127.0.0.1:1'}}).where(orm.eq(s.orgs.id,org));
    await db.insert(policies).values({id:policyId,org_id:org,owner_user_id:owner,installation_id:installed.id,account_ref:account,store_key:'drafts',revision:1,enabled:true,
     history_since:new Date(Date.now()-86400_000),input:{enabled:true,destination:{scope:'user',space_id:null},history_days:30,include_bulk:false,excluded_senders:[],excluded_folders:[]}});
    await db.insert(s.jobQueue).values({id:jobId,org_id:org,queue:'scheduled-jobs',name:'app-integration-knowledge',status:'running',
     lock_token:lockToken,lock_expires_at:new Date(Date.now()+60_000),data:{policy_id:policyId,policy_revision:1}});
    let acquired!:()=>void,release!:()=>void;
    const holding=new Promise<void>(resolve=>{acquired=resolve;}),resume=new Promise<void>(resolve=>{release=resolve;});
    const keys=parseEnvironmentAppRunKeyrings(process.env.DEFT_APP_RUN_KEYRINGS);
    // Use the real worker, queue/policy lease fences, publication reader and
    // live binding/principal readers. Only the Runtime account boundary is
    // synthetic. Pausing its local authority read makes the old 250ms conflict
    // deterministic without contacting a provider or invoking any action.
    const knowledge=createAppIntegrationCaptureRuntime({transaction:fn=>db.transaction(fn),keys,gateway:{
     async currentAccount(caller,target,purpose,transaction){
      assert.equal(purpose,'knowledge_capture');assert.equal(caller.kind,'capture_policy');assert.equal(target.account_ref,account);
      const read=async(tx:Parameters<typeof loadLiveAttachmentSyncBindingAuthority>[0])=>{
       const live=await loadLiveAttachmentSyncBindingAuthority(tx,{org_id:org,resource_binding_id:resource.binding_id,clock:()=>new Date()});
       assert.ok(live);assert.equal(await runtimeRenewalPersistentPrincipal(tx,{org_id:org,operator_user_id:owner,role:'owner'}),true);
       acquired();await resume;
       return {resource_binding_id:resource.binding_id,resource_key:'inbox',identity:'synthetic-current-account',expires_at:Date.now()+30_000};
      };return transaction?read(transaction):db.transaction(read);
     },async mint(){throw Error('idle Knowledge delivery must not invoke Runtime');},async dispatch(){throw Error('idle Knowledge delivery must not invoke Runtime');},
    }});
    const work=knowledge.run({id:jobId,name:'app-integration-knowledge',data:{policy_id:policyId,policy_revision:1},lockToken,
     orgId:org,signal:new AbortController().signal} as Parameters<typeof knowledge.run>[0]);
    const observed=work.then(()=>({error:null}),error=>({error}));
    try{
     await Promise.race([holding,observed.then(result=>{throw result.error??Error('Knowledge delivery returned before its account read');})]);
     const [catalog,renewed]=await Promise.all([
      call(`/api/apps/blob/composition/${installed.id}/runtime/targets?app_version_id=${installed.version_id}`),
      runtimeAuthority.renewAppRuntimeSession({session_id:session.session_id,session_token:session.session_token,expected_expires_at:session.expires_at.toISOString()}),
     ]);
     assert.equal(catalog.targets[0].resource_binding_id,resource.binding_id);assert.equal(renewed?.session_id,session.session_id);
     assert.equal(renewed?.renewable_until,session.renewable_until.toISOString(),'technical renewal never extends finite consent');
    }finally{release();const result=await observed;keys.destroy();assert.ok(result.error instanceof RetryLaterJobError);assert.equal(result.error.message,'App Knowledge idle');}
    await db.update(s.orgMembers).set({role:'admin'}).where(orm.and(orm.eq(s.orgMembers.org_id,org),orm.eq(s.orgMembers.user_id,owner)));
    try{assert.equal(await runtimeAuthority.renewAppRuntimeSession({session_id:session.session_id,session_token:session.session_token,expected_expires_at:session.expires_at.toISOString()}),null);}
    finally{await db.update(s.orgMembers).set({role:'owner'}).where(orm.and(orm.eq(s.orgMembers.org_id,org),orm.eq(s.orgMembers.user_id,owner)));}
   });
  });
  await t.test('ordinary visible capture activity retains an accessible exact source link',async()=>{
   const space=randomUUID(),message=randomUUID(),action=randomUUID();await db.insert(s.spaces).values({id:space,org_id:org,name:'Ordinary visible source',type:'public',created_by:owner});await db.insert(s.spaceMembers).values({id:randomUUID(),space_id:space,user_id:owner});await db.insert(s.messages).values({id:message,org_id:org,space_id:space,user_id:owner,content:'Synthetic ordinary source'});await db.insert(s.agentActions).values({id:action,org_id:org,user_id:owner,source:'defty_capture',action:'wiki_create',params:{source_space_id:space,source_message_id:message},approval_tier:'quick',approval_status:'approved',executed_at:new Date(),error:'Synthetic fixture outcome'});
   const dashboard=await call('/api/dashboard'),alert=dashboard.attention.find((row:any)=>row.action_id===action);assert.ok(alert);assert.equal(alert.href,`/chat?space=${space}&message=${message}`);
  });
 }finally{await closeDb();}
});
