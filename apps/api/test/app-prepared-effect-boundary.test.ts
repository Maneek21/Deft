import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {canonicalAppPreparedEffectJson} from '@deft/app-kit';
import {verifiedPreparedRecordAction,verifiedRetainedPreparedRecordAction} from '../src/lib/app-data-prepared-effect.js';
import {verifiedInspectionReceipt} from '../src/lib/app-run-inspection-receipt.js';

const hash='sha256:'+'a'.repeat(64);
function fixture(){
 const binding=randomUUID(),account='workspace_7';
 const store={supplemental_effects:[{key:'audit_copy',action_key:'publish',version:'example.audit.v1',details_schema:{type:'object' as const,additionalProperties:false as const,properties:{destination:{type:'string' as const,maxLength:128}},required:['destination']}}]};
 const effect={schema_version:'deft.app_prepared_effect.v1',effect_key:'audit_copy',version:'example.audit.v1',account_ref:account,
  custody_generation:3,action_binding_id:binding,content_digest:hash,content_bytes:12,details:{destination:'review_archive'},plan_digest:hash};
 effect.plan_digest='sha256:'+createHash('sha256').update(canonicalAppPreparedEffectJson(effect)).digest('hex');
 const prepared={schema_version:'deft.app_prepared_record_action.v1',snapshot_id:randomUUID(),snapshot_digest:hash,record_id:randomUUID(),revision:1,
  action_key:'publish',preview:{title:'A document'},expires_at:new Date(Date.now()+60000).toISOString(),supplemental_effect:effect,
  input:{account_ref:account,effect_version:effect.version,effect_key:effect.effect_key,effect_plan_digest:effect.plan_digest,
   effect_content_digest:effect.content_digest,effect_custody_generation:effect.custody_generation}};
 const original={run_id:randomUUID(),attempt_id:randomUUID(),runtime_binding_id:binding,action_key:'publish',original_input:{...prepared.input,prepared_digest:hash}};
 const receipt={schema_version:'deft.app_prepared_effect_receipt.v1',operation_id:original.run_id,run_id:original.run_id,attempt_id:original.attempt_id,
  effect_key:effect.effect_key,version:effect.version,account_ref:account,custody_generation:3,action_binding_id:binding,snapshot_digest:hash,
  plan_digest:effect.plan_digest,content_digest:hash,primary_outcome:'accepted',effect_outcome:'unknown',automatic_retry:false};
 return {store,prepared,binding,original,receipt};
}

test('a nonmail app can prepare and inspect its declared supplemental effect',()=>{
 const f=fixture();assert.equal(verifiedPreparedRecordAction(f.prepared,f.binding,f.store).supplemental_effect?.effect_key,'audit_copy');
 const {preview,...retained}=f.prepared;void preview;
 assert.equal(verifiedRetainedPreparedRecordAction(retained,f.binding,f.store).snapshot_id,f.prepared.snapshot_id);
 assert.deepEqual(verifiedInspectionReceipt(f.receipt,f.original,f.store),{operation_id:f.original.run_id,primary_outcome:'accepted',effect_outcome:'unknown',inspection_available:true});
 assert.equal(verifiedInspectionReceipt({...f.receipt,effect_outcome:'completed'},f.original,f.store).inspection_available,false);
});

test('preparation rejects undeclared effects, undeclared details and changed account/content/custody/binding',()=>{
 const f=fixture();assert.throws(()=>verifiedPreparedRecordAction(f.prepared,f.binding,{}));
 assert.throws(()=>verifiedPreparedRecordAction(f.prepared,randomUUID(),f.store));
 for(const field of ['account_ref','effect_content_digest','effect_plan_digest','effect_custody_generation']){
  const p=structuredClone(f.prepared);(p.input as Record<string,unknown>)[field]=field==='effect_custody_generation'?4:'changed';
  assert.throws(()=>verifiedPreparedRecordAction(p,f.binding,f.store));
 }
 const p=structuredClone(f.prepared);p.supplemental_effect.details.destination='altered';
 assert.throws(()=>verifiedPreparedRecordAction(p,f.binding,f.store));
 // Even a resealed, internally consistent effect cannot add an unreviewed field.
 const extra={...f.prepared.supplemental_effect,details:{destination:'review_archive',extra:'unreviewed'}};
 extra.plan_digest='sha256:'+createHash('sha256').update(canonicalAppPreparedEffectJson(extra)).digest('hex');
 assert.throws(()=>verifiedPreparedRecordAction({...f.prepared,supplemental_effect:extra,input:{...f.prepared.input,effect_plan_digest:extra.plan_digest}},f.binding,f.store));
 assert.throws(()=>verifiedRetainedPreparedRecordAction(f.prepared,f.binding,f.store));
});

test('inspection cannot attach another action, account, attempt, plan or uncertain primary result',()=>{
 const f=fixture();
 for(const field of ['operation_id','run_id','attempt_id','action_binding_id','account_ref','effect_key','version','snapshot_digest','plan_digest','content_digest','custody_generation','primary_outcome']){
  const value=field.endsWith('_id')?randomUUID():field.endsWith('_digest')?'sha256:'+'b'.repeat(64):field==='custody_generation'?4:field==='primary_outcome'?'unknown':'other';
  assert.throws(()=>verifiedInspectionReceipt({...f.receipt,[field]:value},f.original,f.store),field);
 }
 assert.throws(()=>verifiedInspectionReceipt(f.receipt,f.original,{}));
 assert.throws(()=>verifiedInspectionReceipt(f.receipt,{...f.original,action_key:'delete'},f.store));
});
