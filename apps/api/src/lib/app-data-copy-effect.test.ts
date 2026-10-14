import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {AppCompoundSendReceiptSchema,canonicalAppDataJson} from '@deft/app-kit';
import {verifiedPreparedRecordAction,verifiedRetainedPreparedRecordAction} from './app-data-prepared-effect.js';

const hash='sha256:'+'a'.repeat(64);
function sample(){
  const account=randomUUID(),binding=randomUUID();
  const unsigned={schema_version:'deft.app_prepared_copy_effect.v1',effect_key:'sent_copy',account_ref:account,custody_generation:4,
    action_binding_id:binding,content_digest:hash,content_bytes:123,message_id:'<controlled@example.test>',mode:'append_exact',
    destination:{mailbox:'Sent',uidvalidity:'7'}};
  const plan_digest='sha256:'+createHash('sha256').update(canonicalAppDataJson(unsigned)).digest('hex');
  const prepared={schema_version:'deft.app_prepared_record_action.v1',snapshot_id:randomUUID(),snapshot_digest:hash,
    record_id:randomUUID(),revision:2,action_key:'send_message',preview:{},expires_at:new Date(Date.now()+60000).toISOString(),
    input:{account_ref:account,mime_digest:hash,sent_copy_version:unsigned.schema_version,sent_copy_mode:unsigned.mode,sent_copy_plan_digest:plan_digest},
    copy_effect:{...unsigned,plan_digest}};
  return {prepared,binding};
}
test('legacy prepared records remain valid without a copy declaration',()=>{
  const {prepared}=sample();const {copy_effect,...legacy}=prepared;void copy_effect;
  legacy.input={account_ref:prepared.input.account_ref,mime_digest:hash} as typeof legacy.input;
  assert.equal(verifiedPreparedRecordAction(legacy).copy_effect,undefined);
});
test('sealed copy declaration pairs account, exact MIME, current binding and canonical destination',()=>{
  const {prepared,binding}=sample();assert.equal(verifiedPreparedRecordAction(prepared,binding).copy_effect?.destination?.mailbox,'Sent');
  assert.throws(()=>verifiedPreparedRecordAction(prepared,randomUUID()));
  for(const field of ['account_ref','mime_digest'] as const){const altered=structuredClone(prepared);(altered.input as Record<string,string>)[field]=field==='account_ref'?randomUUID():'sha256:'+'b'.repeat(64);assert.throws(()=>verifiedPreparedRecordAction(altered,binding));}
  for(const alter of [(p:typeof prepared)=>{p.copy_effect.destination.mailbox='Archive';},(p:typeof prepared)=>{p.copy_effect.destination.uidvalidity='8';},(p:typeof prepared)=>{p.copy_effect.custody_generation++;},(p:typeof prepared)=>{p.copy_effect.message_id='<other@example.test>';}]){
    const altered=structuredClone(prepared);alter(altered);assert.throws(()=>verifiedPreparedRecordAction(altered,binding));
  }
});
test('retained invocation validates sealed copy metadata without retaining the private preview',()=>{
 const {prepared,binding}=sample();const {preview,...retained}=prepared;void preview;
 assert.equal(verifiedRetainedPreparedRecordAction(retained,binding).copy_effect?.plan_digest,prepared.copy_effect.plan_digest);
 assert.throws(()=>verifiedRetainedPreparedRecordAction(prepared,binding));
 assert.throws(()=>verifiedRetainedPreparedRecordAction(retained,randomUUID()));
 const {copy_effect,...missing}=retained;void copy_effect;assert.throws(()=>verifiedRetainedPreparedRecordAction(missing,binding));
 const legacy={...missing,input:{account_ref:prepared.input.account_ref,mime_digest:hash}};
 assert.equal(verifiedRetainedPreparedRecordAction(legacy,binding).copy_effect,undefined);
});

test('missing, partial and mismatched copy input pins cannot be reviewed',()=>{
  const {prepared}=sample();
  for(const field of ['sent_copy_version','sent_copy_mode','sent_copy_plan_digest']){const altered=structuredClone(prepared);delete (altered.input as Record<string,unknown>)[field];assert.throws(()=>verifiedPreparedRecordAction(altered));}
  const {copy_effect,...without}=prepared;void copy_effect;assert.throws(()=>verifiedPreparedRecordAction(without));
  const altered=structuredClone(prepared);altered.input.sent_copy_mode='server_managed';assert.throws(()=>verifiedPreparedRecordAction(altered));
});
test('transport uncertainty cannot claim any Sent copy effect happened',()=>{
  const receipt={schema_version:'deft.app_compound_send_receipt.v1',operation_id:randomUUID(),run_id:randomUUID(),attempt_id:randomUUID(),
    account_ref:randomUUID(),custody_generation:2,snapshot_digest:hash,copy_plan_digest:hash,content_digest:hash,
    transport_outcome:'unknown',copy_outcome:'not_attempted',automatic_retry:false};
  assert.ok(AppCompoundSendReceiptSchema.safeParse(receipt).success);
  for(const copy_outcome of ['server_managed','copied','failed','unknown'])assert.equal(AppCompoundSendReceiptSchema.safeParse({...receipt,copy_outcome}).success,false);
  assert.equal(AppCompoundSendReceiptSchema.safeParse({...receipt,transport_outcome:'accepted',copy_outcome:'unknown'}).success,true);
});
