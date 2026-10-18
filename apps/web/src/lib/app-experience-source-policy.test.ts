import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeExperienceExposureReview,normalizeExperienceExposureStatus} from './app-experience-session';
import {createExperienceLease} from './app-experience-lease';
import {reviewedSourcePolicy} from './app-experience-source-policy';
import {parseSourceView,readSourceBinary} from './app-experience-source-view';
const digest='sha256:'+'a'.repeat(64),artifact='sha256:'+'b'.repeat(64),expires=new Date(Date.now()+60000).toISOString();
const raw={review_token:'controlled-review-token',review_digest:digest,snapshot:{schema_version:'deft.experience_resource_exposure.v2',destination:'verified_installed_experience_worker',app_name:'Controlled app',app_version:'2.6',owner_label:'Controlled owner',experience_label:'Inbox',artifact_digest:artifact,expires_at:expires,review_expires_at:expires,resources:[{resource_key:'inbox',label:'Controlled account',resource_type:'mail',allowed_operations:['list_summary','read_one','search'],allowed_fields:['subject'],content_policy:{document:{max_characters:16384,formats:['plain','html']},source:{media_type:'message/rfc822',filename:'message.eml',max_bytes:8388608}}}]}};
const review=normalizeExperienceExposureReview(raw),scope=normalizeExperienceExposureStatus({exposure_id:'controlled-exposure',exposure_epoch:1,review_digest:digest,expires_at:expires,active:true});
const session={artifact_digest:artifact,resource_keys:['inbox']};
test('source policy comes from the actual normalized current review, not exposure resources',()=>{
 assert.equal('resources' in scope,false);
 assert.equal(reviewedSourcePolicy(review,scope,session,'inbox',()=>true)?.source?.max_bytes,8388608);
 assert.equal(reviewedSourcePolicy(review,scope,session,'inbox',()=>true)?.document.max_characters,16384);
});
test('changed digest, artifact, foreign resource and retired lifetime never confer source policy',()=>{
 assert.equal(reviewedSourcePolicy({...review,review_digest:'sha256:'+'c'.repeat(64)},scope,session,'inbox',()=>true),undefined);
 assert.equal(reviewedSourcePolicy(review,scope,{...session,artifact_digest:'sha256:'+'c'.repeat(64)},'inbox',()=>true),undefined);
 assert.equal(reviewedSourcePolicy(review,scope,session,'other_account',()=>true),undefined);
 assert.equal(reviewedSourcePolicy(review,scope,session,'inbox',()=>false),undefined);
 assert.equal(reviewedSourcePolicy({...review,snapshot:{...review.snapshot,expires_at:new Date(Date.now()-1).toISOString()}},scope,session,'inbox',()=>true),undefined);
 assert.equal(reviewedSourcePolicy(review,{...scope,expires_at:new Date(Date.now()-1).toISOString()},session,'inbox',()=>true),undefined);
});
test('source output arrays and absent binary streams fail closed under actual source-view helpers',async()=>{
 const envelope={exposure_id:scope.exposure_id,exposure_epoch:1,expires_at:expires};
 assert.deepEqual(parseSourceView({...envelope,files:[]},scope).files,[]);
 assert.throws(()=>parseSourceView({...envelope,files:{}},scope));
 assert.throws(()=>parseSourceView({...envelope,exposure_id:'foreign',files:[]},scope));
 await assert.rejects(()=>readSourceBinary(new Response(null,{headers:{'x-deft-exposure-id':scope.exposure_id,'x-deft-exposure-epoch':'1','x-content-type-options':'nosniff','content-disposition':'attachment;','content-length':'0','content-type':'application/octet-stream'}}),scope,()=>true));
});

test('fresh authenticated lease authorizes source policy after captured expiry, without accepting changed pins',async()=>{
 const captured={...scope,expires_at:new Date(Date.now()-1000).toISOString()};
 const renewed={...scope,expires_at:new Date(Date.now()+60000).toISOString()};
 const lease=createExperienceLease({initial:{session_expires_at:captured.expires_at,exposure:captured},current:()=>true,
  refresh:async()=>({session_expires_at:renewed.expires_at,exposure:renewed})});
 assert.equal(await lease.ensure(true),true);
 assert.equal(reviewedSourcePolicy(review,captured,session,'inbox',()=>lease.valid(),lease.value.exposure)?.source?.max_bytes,8388608);
 for(const patch of [{exposure_id:'rotated'},{exposure_epoch:2},{review_digest:'sha256:'+'c'.repeat(64)},{expires_at:captured.expires_at}])
  assert.equal(reviewedSourcePolicy(review,captured,session,'inbox',()=>true,{...lease.value.exposure,...patch}),undefined);
 assert.equal(captured.expires_at<renewed.expires_at,true,'The captured snapshot is not mutated or extended');
 lease.dispose();assert.equal(reviewedSourcePolicy(review,captured,session,'inbox',()=>lease.valid(),lease.value.exposure),undefined);
});
