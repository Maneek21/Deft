import { runtimeSecurityPackage } from './fixtures/runtime-security-package.js';
import test from 'node:test';import assert from 'node:assert/strict';import{randomUUID,createHash}from'node:crypto';
const targetUrl=new URL(process.env.DEFT_TEST_DATABASE_URL??'postgres://invalid/invalid');
const safe=process.env.DATABASE_URL===process.env.DEFT_TEST_DATABASE_URL&&targetUrl.hostname==='127.0.0.1'&&['55437','55438'].includes(targetUrl.port)&&targetUrl.pathname==='/deft_live_wiki_concurrency_test';
assert.ok(safe,'Requires exact authorized reused isolated ordinary test DB tunnel');

test('ordinary named Runtime setup pins the selected owner target without issuing credentials',{skip:!safe,timeout:60_000},async t=>{
 Object.assign(process.env,{DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED:'true',DEFT_APP_PRIVATE_SHARING_ENABLED:'true',DEFT_APP_PRIVATE_MCP_ENABLED:'true',DEFT_APPS_ENABLED:'true',DEFT_APP_RUNS_ENABLED:'true',DEFT_APP_RUN_APP_ORIGIN_ENABLED:'true',DEFT_APP_ATTACHMENT_BROKER_ENABLED:'true',DEFT_APP_RUNTIME_CHANNEL_ENABLED:'true',DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED:'true',DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED:'true'});
 const ring=(purpose:string)=>({current:purpose,keys:{[purpose]:createHash('sha256').update('runtime-setup:'+purpose).digest('base64')}});process.env.DEFT_APP_RUN_KEYRINGS=JSON.stringify({schema_version:'deft.app_run_keyring.v1',run_encryption:ring('enc'),receipt_signing:ring('sign'),fingerprint:ring('fp')});
 const [{app},{db,closeDb},s,orm,web]=await Promise.all([import('../src/index.js'),import('../src/lib/db.js'),import('@deft/db/schema'),import('drizzle-orm'),import('../src/lib/web-sessions.js')]);
 const org=randomUUID(),owner=randomUUID(),member=randomUUID(),suffix=randomUUID();
 await db.insert(s.orgs).values({id:org,name:'Synthetic Runtime setup',slug:'runtime-setup-'+suffix});await db.insert(s.users).values([{id:owner,name:'Owner',email:`owner-${suffix}@example.test`},{id:member,name:'Member',email:`member-${suffix}@example.test`}]);await db.insert(s.orgMembers).values([{id:randomUUID(),org_id:org,user_id:owner,role:'owner',is_active:true},{id:randomUUID(),org_id:org,user_id:member,role:'member',is_active:true}]);
 const ownerSession=await web.createWebSession({id:owner,org_id:org,email:`owner-${suffix}@example.test`}),memberSession=await web.createWebSession({id:member,org_id:org,email:`member-${suffix}@example.test`});
 async function response(path:string,method='GET',body?:unknown,token=ownerSession.accessToken){return app.request('http://localhost'+path,{method,headers:{authorization:`Bearer ${token}`,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});}
 async function call(path:string,method='GET',body?:unknown){const r=await response(path,method,body);const value=await r.json() as any;assert(r.ok,`${path} HTTP ${r.status} ${value.code??''} ${value.error??''}`);return value;}
 try{
  const packed=(await runtimeSecurityPackage()).json;
  const {app:installed}=await call('/api/apps/blob/composition/stage','POST',packed);
  const initial=await call(`/api/apps/blob/composition/${installed.id}/context?app_version_id=${installed.version_id}`);const {review}=await call(`/api/apps/blob/composition/${installed.id}/review`,'POST',initial.review_request);
  await call(`/api/apps/blob/composition/${installed.id}/activate`,'POST',{...initial.review_request,expected_review_digest:review.review_digest,accept_host_policy:true});
  const path=`/api/apps/blob/composition/${installed.id}/runtime/context?app_version_id=${installed.version_id}`;
  await t.test('read-only setup returns bounded self-operator pins with no credentials or bindings created',async()=>{
   const context=await call(path);assert.equal(context.actions.length,3);assert.equal(context.operator_user_id,owner);assert.equal(context.policy.review_scope,'per_invocation');assert(context.actions.every((a:any)=>a.binding===null&&a.review_request.operator_user_id===owner));assert(!JSON.stringify(context).includes('session_token'));const rows=await db.select().from(s.appRuntimeBindings).where(orm.eq(s.appRuntimeBindings.org_id,org));assert.equal(rows.length,0);
  });
  await t.test('named current owner target is catalogued and exact normal review activates only that target',async()=>{
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
  });
  await t.test('ordinary visible capture activity retains an accessible exact source link',async()=>{
   const space=randomUUID(),message=randomUUID(),action=randomUUID();await db.insert(s.spaces).values({id:space,org_id:org,name:'Ordinary visible source',type:'public',created_by:owner});await db.insert(s.spaceMembers).values({id:randomUUID(),space_id:space,user_id:owner});await db.insert(s.messages).values({id:message,org_id:org,space_id:space,user_id:owner,content:'Synthetic ordinary source'});await db.insert(s.agentActions).values({id:action,org_id:org,user_id:owner,source:'defty_capture',action:'wiki_create',params:{source_space_id:space,source_message_id:message},approval_tier:'quick',approval_status:'approved',executed_at:new Date(),error:'Synthetic fixture outcome'});
   const dashboard=await call('/api/dashboard'),alert=dashboard.attention.find((row:any)=>row.action_id===action);assert.ok(alert);assert.equal(alert.href,`/chat?space=${space}&message=${message}`);
  });
 }finally{await closeDb();}
});
