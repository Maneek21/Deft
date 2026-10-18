import { runtimeSecurityPackage } from './fixtures/runtime-security-package.js';
import test from 'node:test';import assert from 'node:assert/strict';import{randomUUID,createHash}from'node:crypto';
import { securityTestDatabaseIsSafe } from './fixtures/security-test-database.js';
const safe=securityTestDatabaseIsSafe();

test('Runtime setup metadata preserves normal exact review and explicit operator credential issuance',{skip:!safe,timeout:60_000},async t=>{
 Object.assign(process.env,{DEFT_APPS_ENABLED:'true',DEFT_APP_RUNS_ENABLED:'true',DEFT_APP_RUN_APP_ORIGIN_ENABLED:'true',DEFT_APP_ATTACHMENT_BROKER_ENABLED:'true',DEFT_APP_RUNTIME_CHANNEL_ENABLED:'true',DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED:'true',DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED:'true'});
 const ring=(purpose:string)=>({current:purpose,keys:{[purpose]:createHash('sha256').update('runtime-setup:'+purpose).digest('base64')}});process.env.DEFT_APP_RUN_KEYRINGS=JSON.stringify({schema_version:'deft.app_run_keyring.v1',run_encryption:ring('enc'),receipt_signing:ring('sign'),fingerprint:ring('fp')});
 const [{app},{db,closeDb},s,orm,web]=await Promise.all([import('../src/index.js'),import('../src/lib/db.js'),import('@deft/db/schema'),import('drizzle-orm'),import('../src/lib/web-sessions.js')]);
 const org=randomUUID(),owner=randomUUID(),member=randomUUID(),suffix=randomUUID();
 await db.insert(s.orgs).values({id:org,name:'Synthetic Runtime setup',slug:'runtime-setup-'+suffix});await db.insert(s.users).values([{id:owner,name:'Owner',email:`owner-${suffix}@example.test`},{id:member,name:'Member',email:`member-${suffix}@example.test`}]);await db.insert(s.orgMembers).values([{id:randomUUID(),org_id:org,user_id:owner,role:'owner',is_active:true},{id:randomUUID(),org_id:org,user_id:member,role:'member',is_active:true}]);
 const ownerSession=await web.createWebSession({id:owner,org_id:org,email:`owner-${suffix}@example.test`}),memberSession=await web.createWebSession({id:member,org_id:org,email:`member-${suffix}@example.test`});
 async function response(path:string,method='GET',body?:unknown,token=ownerSession.accessToken){return app.request('http://localhost'+path,{method,headers:{authorization:`Bearer ${token}`,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});}
 async function call(path:string,method='GET',body?:unknown){const r=await response(path,method,body);assert(r.ok,`${path} HTTP ${r.status}`);return r.json() as Promise<any>;}
 try{
  const packed=(await runtimeSecurityPackage()).json;
  const {app:installed}=await call('/api/apps/blob/composition/stage','POST',packed);
  const initial=await call(`/api/apps/blob/composition/${installed.id}/context?app_version_id=${installed.version_id}`);const {review}=await call(`/api/apps/blob/composition/${installed.id}/review`,'POST',initial.review_request);
  await call(`/api/apps/blob/composition/${installed.id}/activate`,'POST',{...initial.review_request,expected_review_digest:review.review_digest,accept_host_policy:true});
  const path=`/api/apps/blob/composition/${installed.id}/runtime/context?app_version_id=${installed.version_id}`;
  await t.test('read-only setup returns bounded self-operator pins with no credentials or bindings created',async()=>{
   const context=await call(path);assert.equal(context.actions.length,3);assert.equal(context.operator_user_id,owner);assert.equal(context.policy.review_scope,'per_invocation');assert(context.actions.every((a:any)=>a.binding===null&&a.review_request.operator_user_id===owner));assert(!JSON.stringify(context).includes('session_token'));const rows=await db.select().from(s.appRuntimeBindings).where(orm.eq(s.appRuntimeBindings.org_id,org));assert.equal(rows.length,0);
  });
  await t.test('exact review and activation remain separate from explicit credential issuance',async()=>{
   const context=await call(path),request=context.actions[0].review_request;const {review:bindingReview}=await call('/api/apps/blob/composition/runtime/reviews/prepare','POST',request);
   const {binding}=await call('/api/apps/blob/composition/runtime/bindings/activate','POST',{...request,expected_review_digest:bindingReview.review_digest,accept_host_policy:true});
   const ready=await call(path);const action=ready.actions.find((a:any)=>a.key===request.action_key);assert.equal(action.binding.id,binding.binding_id);assert.equal(action.binding.can_issue_session,true);
   const sessions=await db.select().from(s.appRuntimeSessions).where(orm.eq(s.appRuntimeSessions.org_id,org));assert.equal(sessions.length,0);
   const {session}=await call(`/api/apps/blob/composition/runtime/bindings/${binding.binding_id}/sessions`,'POST',{});assert.equal(typeof session.session_token,'string');assert(Date.parse(session.expires_at)>Date.now());const after=await call(path);assert(!JSON.stringify(after).includes(session.session_token));
  });
  await t.test('ordinary member, query widening and stale App authority cannot expose setup metadata',async()=>{
   assert.equal((await response(path,'GET',undefined,memberSession.accessToken)).status,403);
   assert.equal((await response(path+'&unknown=1')).status,400);assert.equal((await response(path+'&app_version_id='+installed.version_id)).status,400);
   const before=await call(path);await call(`/api/apps/${installed.id}/disable`,'POST',{expected_lifecycle_epoch:before.lifecycle_epoch});assert.equal((await response(path)).status,409);
  });
 }finally{await closeDb();}
});
