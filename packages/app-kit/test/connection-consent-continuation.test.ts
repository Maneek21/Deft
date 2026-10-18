import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import * as c from '../src/connection-session-consent-continuation.js';
const uuid = () => randomUUID(), digest = (char: string) => 'sha256:'+char.repeat(64);
const oldExpiry='2026-10-11T01:00:00Z',newExpiry='2026-10-11T02:00:00Z',reviewExpiry='2026-10-11T01:58:00Z',ioExpiry='2026-10-11T01:55:00Z';
const originalScope={org_id:uuid(),owner_user_id:uuid(),installation_id:uuid(),app_version_id:uuid(),grant_snapshot_id:uuid(),package_digest:digest('a'),grant_snapshot_digest:digest('b'),lifecycle_epoch:6,grant_epoch:6,target_key:'e2_gmail_sender',resource_key:'inbox',resource_binding_id:uuid(),runtime_registration_id:uuid(),operator_user_id:uuid(),runtime_epoch:1,profile_digest:digest('c'),consent_expires_at:oldExpiry};
const originalActions=['draft_mirror','send_message'].map((action_key,index)=>{const id=uuid();return {action_binding_id:id,action_key,authority_epoch:1,consent_id:id,consent_digest:digest(String(index+1)),expires_at:oldExpiry};});
const source={session_id:uuid(),session_revision:7,scope:originalScope,runtime_session_ref:'original_runtime_session_ref',account_ref:'gmail_controlled_sender',action_consents:originalActions};
const fixture=()=>({schema_version:c.APP_CONNECTION_CONSENT_CONTINUATION_VERSION,session_id:uuid(),scope:{...originalScope,consent_expires_at:newExpiry},source:structuredClone(source),action_consents:originalActions.map(v=>({...v,consent_digest:digest('d'),expires_at:newExpiry})),transport_digest:digest('e'),review_expires_at:reviewExpiry,expires_at:ioExpiry,operation:'prepare' as const});
const eligibility={account:{account_ref:source.account_ref,label:'Synthetic controlled sender'},custody_generation:9,custody_digest:digest('f')};
const review={...eligibility,digest:digest('9')};
const activate=()=>({...fixture(),operation:'activate' as const,review});
const sha=(value:unknown)=>'sha256:'+createHash('sha256').update(c.canonicalConnectionConsentContinuationJson(value)).digest('hex');
const rejects=(request:unknown)=>assert.equal(c.AppConnectionConsentContinuationRuntimeRequestSchema.safeParse(request).success,false);

test('actual closed schema accepts explicit same-binding expiry extension and retains opaque account identity',()=>{
 const request=fixture(),before=JSON.stringify(request.source);const parsed=c.AppConnectionConsentContinuationRuntimeRequestSchema.parse(request);
 assert.equal(parsed.source.account_ref,'gmail_controlled_sender');assert.equal(parsed.scope.resource_binding_id,parsed.source.scope.resource_binding_id);assert.equal(JSON.stringify(parsed.source),before);
 assert.deepEqual(c.AppConnectionConsentContinuationAuthorityResultSchema.parse({...request,allowed:true}),{...request,allowed:true});
});
test('every original scope identity/epoch/package pin rejects a changed value',()=>{
 for(const key of Object.keys(originalScope).filter(k=>k!=='consent_expires_at')){const value=fixture();const old=value.scope[key as keyof typeof value.scope];(value.scope as Record<string,unknown>)[key]=typeof old==='number'?old+1:typeof old==='string'&&old.startsWith('sha256:')?digest('7'):typeof old==='string'&&old.includes('-')?uuid():'changed';rejects(value);}
});
test('purposes cannot be added removed renamed rebound reordered or advanced',()=>{
 for(const key of ['action_binding_id','action_key','authority_epoch','consent_id']){const value=fixture();(value.action_consents[0] as Record<string,unknown>)[key]=key==='authority_epoch'?2:key==='action_key'?'changed':uuid();rejects(value);}
 const fewer=fixture();fewer.action_consents.pop();rejects(fewer);const reordered=fixture();reordered.action_consents.reverse();rejects(reordered);
 const more=fixture();more.action_consents.push({...more.action_consents[1]!,action_key:'star',action_binding_id:uuid(),consent_id:uuid()});rejects(more);
});
test('strictly later source/target/action expiry and bounded review/io deadlines are mandatory',()=>{
 for(const expiry of [oldExpiry,'2026-10-11T00:59:00Z']){const value=fixture();value.scope.consent_expires_at=expiry;rejects(value);}
 const oldAction=fixture();oldAction.source.action_consents[0]!.expires_at=newExpiry;rejects(oldAction);
 const sameAction=fixture();sameAction.action_consents[0]!.expires_at=oldExpiry;rejects(sameAction);
 const unbounded=fixture();unbounded.action_consents[0]!.expires_at='2026-10-11T02:01:00Z';rejects(unbounded);
 const lateReview=fixture();lateReview.review_expires_at='2026-10-11T02:01:00Z';rejects(lateReview);
 const lateIO=fixture();lateIO.expires_at='2026-10-11T01:59:00Z';rejects(lateIO);
});
test('fresh reviewed authority permits activate after historical source expiry; exact status recovers after review expiry',()=>{
 const value=activate();assert.equal(c.AppConnectionConsentContinuationRuntimeRequestSchema.safeParse(value).success,true);
 value.expires_at='2026-10-11T01:59:00Z';rejects(value);
 const status={...value,operation:'status' as const};assert.equal(c.AppConnectionConsentContinuationRuntimeRequestSchema.safeParse(status).success,true);
 status.expires_at='2026-10-11T02:01:00Z';rejects(status);
});
test('old session ID and OAuth/provider/callback fields are rejected before execution',()=>{
 const same=fixture();same.session_id=source.session_id;rejects(same);
 for(const field of ['callback','callback_state','authorization_url','credentials','code','runtime_session_ref'])rejects({...fixture(),[field]:'unexpected'});
 rejects({...fixture(),review});rejects({...activate(),review:{...review,account:{...review.account,account_ref:'changed'}}});
});
test('canonical review/receipt pins are operation-independent and include exact source/target/purpose metadata',()=>{
 const value=fixture(),eligible=c.appConnectionConsentContinuationReviewValue(value,eligibility),stored={...eligibility,digest:sha(eligible)};
 const next={...value,operation:'activate' as const,review:stored};assert.deepEqual(c.appConnectionConsentContinuationPins(value),c.appConnectionConsentContinuationPins(next));
 const receipt=c.appConnectionConsentContinuationReceiptValue(next,stored,'new_runtime_ref');
 assert.equal(sha(receipt),sha(Object.fromEntries(Object.entries(receipt).reverse())));
 const changed={...next,action_consents:next.action_consents.map(v=>({...v,consent_digest:digest('8')}))};assert.notEqual(sha(c.appConnectionConsentContinuationReviewValue(changed,eligibility)),sha(eligible));
 assert.throws(()=>c.appConnectionConsentContinuationReceiptValue(next,{...stored,digest:digest('0')},'new_runtime_ref'));
 assert.throws(()=>c.appConnectionConsentContinuationReceiptValue(next,stored,source.runtime_session_ref));
 assert.throws(()=>c.appConnectionConsentContinuationReviewValue(value,{...eligibility,account:{...eligibility.account,account_ref:'foreign'}}));
});
test('connected result requires same custody generation/account and a new original session ref',()=>{
 const request=activate(),result={schema_version:c.APP_CONNECTION_CONSENT_CONTINUATION_VERSION,session_id:request.session_id,state:'connected' as const,account:eligibility.account,custody_generation:9,runtime_session_ref:'new_runtime_ref',receipt_digest:digest('6')};
 assert.deepEqual(c.validateAppConnectionConsentContinuationResult(request,result),result);
 for(const change of [{session_id:uuid()},{account:{...eligibility.account,account_ref:'other'}},{custody_generation:10},{runtime_session_ref:source.runtime_session_ref}])assert.throws(()=>c.validateAppConnectionConsentContinuationResult(request,{...result,...change}));
 assert.throws(()=>c.validateAppConnectionConsentContinuationResult({...request,operation:'prepare',review:undefined},result));
 const response={schema_version:c.APP_CONNECTION_CONSENT_CONTINUATION_VERSION,session_id:request.session_id,state:'eligible' as const,...eligibility};assert.throws(()=>c.validateAppConnectionConsentContinuationResult(request,response));
});
test('status eligibility must match stored custody pin and uncertain status cannot request provider work',()=>{
 const request={...activate(),operation:'status' as const},result={schema_version:c.APP_CONNECTION_CONSENT_CONTINUATION_VERSION,session_id:'',state:'eligible' as const,...eligibility};result.session_id=request.session_id;
 assert.deepEqual(c.validateAppConnectionConsentContinuationResult(request,result),result);
 assert.throws(()=>c.validateAppConnectionConsentContinuationResult(request,{...result,custody_digest:digest('0')}));
 assert.deepEqual(c.validateAppConnectionConsentContinuationResult(request,{schema_version:request.schema_version,session_id:request.session_id,state:'indeterminate'}),{schema_version:request.schema_version,session_id:request.session_id,state:'indeterminate'});
});
test('shared deterministic golden wire vector pins review and same-generation receipt',()=>{
 const value=fixture(),fixed=(index:number)=>'00000000-0000-4000-8000-'+String(index).padStart(12,'0');
 let index=1;for(const key of ['org_id','owner_user_id','installation_id','app_version_id','grant_snapshot_id','resource_binding_id','runtime_registration_id','operator_user_id']){(value.source.scope as Record<string,unknown>)[key]=fixed(index++);(value.scope as Record<string,unknown>)[key]=value.source.scope[key as keyof typeof value.source.scope];}
 value.source.session_id=fixed(20);value.session_id=fixed(21);
 value.source.action_consents.forEach((action,i)=>{action.action_binding_id=fixed(30+i);action.consent_id=action.action_binding_id;value.action_consents[i]!.action_binding_id=action.action_binding_id;value.action_consents[i]!.consent_id=action.consent_id;});
 const review_value=c.appConnectionConsentContinuationReviewValue(value,eligibility),stored_review={...eligibility,digest:sha(review_value)},request={...value,operation:'activate' as const,review:stored_review};
 const receipt_value=c.appConnectionConsentContinuationReceiptValue(request,stored_review,'new_runtime_ref');
 const vector={prepare:value,eligibility,review_value,review_digest:stored_review.digest,activate:request,receipt_value,receipt_digest:sha(receipt_value),connected:{schema_version:value.schema_version,session_id:value.session_id,state:'connected',account:eligibility.account,custody_generation:eligibility.custody_generation,runtime_session_ref:'new_runtime_ref',receipt_digest:sha(receipt_value)}};
 assert.deepEqual(c.validateAppConnectionConsentContinuationResult(request,vector.connected),vector.connected);
 if(process.env.CONSENT_CONTINUATION_VECTOR_FILE)writeFileSync(process.env.CONSENT_CONTINUATION_VECTOR_FILE,JSON.stringify(vector,null,2)+'\n');
});
