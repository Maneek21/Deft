import test from 'node:test';
import assert from 'node:assert/strict';
import {attachmentUpgradeInspectionTarget,attachmentUpgradeStageRequest,attachmentUpgradeTargets,createAttachmentUpgradeFlow,attachmentUpgradeReviewDigest,attachmentUpgradeBlocked,type AttachmentUpgradeIdentity,type AttachmentUpgradeTarget} from './app-attachment-upgrade';
const id='11111111-1111-4111-8111-111111111111',prior='22222222-2222-4222-8222-222222222222',targetId='33333333-3333-4333-8333-333333333333',org='44444444-4444-4444-8444-444444444444',owner='55555555-5555-4555-8555-555555555555',grant='66666666-6666-4666-8666-666666666666',hash='sha256:'+'a'.repeat(64),oldHash='sha256:'+'b'.repeat(64);
export const identity:AttachmentUpgradeIdentity={installation_id:id,app_id:'io.example.synthetic',prior_version_id:prior,prior_package_digest:oldHash,lifecycle_epoch:4,grant_epoch:5,org_id:org,owner_user_id:owner,session_scope:'own-SID'};
export const target:AttachmentUpgradeTarget={version_id:targetId,package_digest:hash,version:'2.0.0'};
const request={schema_version:'deft.app_attachment_upgrade_review_request.v1',pending_work_policy:'drain_before_activation',prior_app_version_id:prior,expected_prior_package_digest:oldHash,expected_prior_grant_snapshot_digest:oldHash,app_version_id:targetId,expected_package_digest:hash,expected_requested_snapshot_digest:hash,expected_lifecycle_epoch:4,expected_grant_epoch:5};
export async function reviewValue(old_work:Record<string,number>={}){const value={schema_version:'deft.app_attachment_upgrade_review.v1',organization_id:org,installation_id:id,pending_work_policy:'drain_before_activation',request,prior_authority:{package_digest:oldHash,old_access:'Read'},target_authority:{package_digest:hash,new_access:'Read'},modules:[],blockers:{old_work,active_dependents:0,pending_public_followups:0},fresh_runtime_binding_review_required:true,fresh_resource_binding_consent_required:true,private_state_adoption_required:true,authority_carry_forward:false};return {...value,review_digest:await attachmentUpgradeReviewDigest(value)};}
async function fixture(options:{lost?:boolean;blocked?:Record<string,number>;mutateContext?:(value:any)=>unknown;mutateReview?:(value:any)=>unknown;storeFails?:boolean}={}){
 let live=true,activated=false,journal:unknown=null;const calls:{path:string;init:RequestInit}[]=[],abort=new AbortController(),review=await reviewValue(options.blocked);
 const call=async(path:string,init:RequestInit)=>{calls.push({path,init});if(path.includes('/context?')){const value={schema_version:'deft.app_attachment_upgrade_context.v1',installation_id:id,app_version_id:targetId,protocol_version:'7',review_request:activated?null:request,current_activation:activated?{grant_snapshot_id:grant,review_digest:review.review_digest}:null};return options.mutateContext?options.mutateContext(value):value;}
  if(path.endsWith('/review')){assert.deepEqual(JSON.parse(String(init.body)),request);return {review:options.mutateReview?options.mutateReview(review):review};}
  assert.ok(path.endsWith('/activate'));assert.deepEqual(JSON.parse(String(init.body)),{...request,expected_review_digest:review.review_digest,accept_host_policy:true});activated=true;if(options.lost)throw Error('Lost reply');return {schema_version:'deft.app_attachment_upgrade_activation.v1'};};
 const setup=()=>createAttachmentUpgradeFlow({identity,current:()=>live,signal:abort.signal,call,load:()=>journal,store:value=>{if(options.storeFails)throw Error('Storage denied');journal=structuredClone(value);}});
 return {flow:setup(),setup,calls,review,journal:()=>journal,revoke:()=>{live=false;},abort,setJournal:(value:unknown)=>{journal=value;}};
}
test('Add/build existing active protocol7 uses exact public upgrade stage envelope, not initial install',()=>{
 const app={id,app_id:identity.app_id,state:'active',active_version_id:prior,lifecycle_epoch:4,manifest:{schema_version:'7'}} as any,inspection={manifest:{schema_version:'7',id:identity.app_id}} as any;
 assert.deepEqual(attachmentUpgradeStageRequest('byte exact package',inspection,app),{path:`/api/apps/blob/composition/${id}/upgrade/stage`,body:{schema_version:'deft.app_attachment_upgrade_stage.v1',package_json:'byte exact package',expected_lifecycle_epoch:4}});
 for(const change of [{...app,state:'disabled'},{...app,active_version_id:null},{...app,app_id:'other.app'}])assert.throws(()=>attachmentUpgradeStageRequest('package',inspection,change));
});
test('public grants discovers staged protocol7 target only after exact installation/epochs validation',()=>{
 const raw={grants:{installation:{id,app_id:identity.app_id,state:'active',active_version_id:prior,lifecycle_epoch:4,grant_epoch:5},versions:[{id:targetId,version:'2.0.0',protocol_version:'7',state:'staged',package_digest:hash},{id:prior,version:'1.0.0',protocol_version:'7',state:'active',package_digest:oldHash}]}};
 assert.deepEqual(attachmentUpgradeTargets(raw,identity),[target]);assert.throws(()=>attachmentUpgradeTargets({...raw,grants:{...raw.grants,installation:{...raw.grants.installation,grant_epoch:6}}},identity));
});
test('exact review plus explicit activate uses existing route, separate policy and read-only completion lookup',async()=>{
 const f=await fixture();assert.equal(f.calls.length,0);const review=await f.flow.prepare(target);assert.equal(attachmentUpgradeBlocked(review),false);assert.equal(f.calls.filter(c=>c.path.endsWith('/activate')).length,0);assert.equal(await f.flow.activate(target),true);assert.equal(f.calls.filter(c=>c.path.endsWith('/activate')).length,1);assert.equal(f.journal(),null);
});
test('all old work, dependents and followups disable activation without clearing or cancelling anything',async()=>{
 for(const state of ['pending','pending_approval','running','waiting_external','unknown_outcome']){const f=await fixture({blocked:{[state]:1}});const review=await f.flow.prepare(target);assert.equal(attachmentUpgradeBlocked(review),true);await assert.rejects(f.flow.activate(target));assert.equal(f.calls.some(c=>c.path.endsWith('/activate')),false);}
 for(const field of ['active_dependents','pending_public_followups'] as const){const review=await reviewValue();review.blockers[field]=1;assert.equal(attachmentUpgradeBlocked(review as any),true);}
});
test('wrong scope, target, prior, package or review digest fails before activation',async()=>{
 for(const field of ['installation_id','app_version_id','prior_app_version_id','expected_lifecycle_epoch'] as const){const f=await fixture({mutateContext:value=>field==='installation_id'?{...value,installation_id:owner}:field==='app_version_id'?{...value,app_version_id:owner}:{...value,review_request:{...value.review_request,[field]:field==='expected_lifecycle_epoch'?9:owner}}});await assert.rejects(f.flow.prepare(target));assert.equal(f.calls.some(c=>c.path.endsWith('/review')),false);}
 for(const change of ['digest','owner','carry','authority'] as const){const f=await fixture({mutateReview:review=>change==='digest'?{...review,review_digest:oldHash}:change==='owner'?{...review,organization_id:owner}:change==='carry'?{...review,authority_carry_forward:true}:{...review,target_authority:{...review.target_authority,secret_new_scope:'changed'}}});await assert.rejects(f.flow.prepare(target));assert.equal(f.calls.some(c=>c.path.endsWith('/activate')),false);}
});
test('lost activation response persists metadata and remount resolves status without repeating activation',async()=>{
 const f=await fixture({lost:true});await f.flow.prepare(target);assert.equal(await f.flow.activate(target),false);assert.ok(f.journal());await assert.rejects(f.flow.activate(target));await assert.rejects(f.flow.prepare(target));const recovered=f.setup();assert.equal(await recovered.status(),true);assert.equal(f.calls.filter(c=>c.path.endsWith('/activate')).length,1);assert.equal(f.journal(),null);
});
test('journal storage failure/current session change prevent dispatch, foreign recovery cannot nominate authority',async()=>{
 const fail=await fixture({storeFails:true});await fail.flow.prepare(target);await assert.rejects(fail.flow.activate(target),/Nothing was activated/);assert.equal(fail.calls.some(c=>c.path.endsWith('/activate')),false);
 const stale=await fixture();await stale.flow.prepare(target);stale.revoke();await assert.rejects(stale.flow.activate(target));assert.equal(stale.calls.some(c=>c.path.endsWith('/activate')),false);
 const foreign=await fixture({lost:true});await foreign.flow.prepare(target);await foreign.flow.activate(target);foreign.setJournal({...foreign.journal() as object,session_scope:'foreign SID'});assert.throws(foreign.setup,/another session/);
});
test('ambiguous activation with still-unactivated context stays fenced, status never replays',async()=>{
 const f=await fixture({lost:true,mutateContext:value=>({...value,review_request:request,current_activation:null})});await f.flow.prepare(target);assert.equal(await f.flow.activate(target),false);assert.equal(await f.flow.status(),false);assert.equal(f.flow.pending,true);await assert.rejects(f.flow.prepare(target));assert.equal(f.calls.filter(c=>c.path.endsWith('/activate')).length,1);
});

test('default Add/build inspection selects only the same active protocol7 installation; first install stays separate',()=>{
 const inspection={manifest:{schema_version:'7',id:identity.app_id}} as any,app={id,app_id:identity.app_id,state:'active',manifest:{schema_version:'7'}} as any;
 assert.equal(attachmentUpgradeInspectionTarget(inspection,[app],null),app);assert.equal(attachmentUpgradeInspectionTarget(inspection,[],null),null);assert.equal(attachmentUpgradeInspectionTarget({...inspection,manifest:{...inspection.manifest,id:'new.app'}},[app],null),null);
 assert.throws(()=>attachmentUpgradeInspectionTarget(inspection,[app,{...app,id:owner}],null),/ambiguous/u);assert.throws(()=>attachmentUpgradeInspectionTarget(inspection,[],{...app,app_id:'foreign.app'}),/exact App/u);
});
