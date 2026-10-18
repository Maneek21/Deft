import {discloseRecordMirrorRead} from './app-record-mirror-read-deadline.js';
import {readRecordMirrorRuntimeStatus} from './app-record-mirror-unstarted.js';
import {assertPreparedRecordCleanupSource} from './app-prepared-record-action-receipt.js';
import {z} from 'zod';
import {sql} from 'drizzle-orm';
import {AppConnectionSessionScopeSchema,AppPreparedMirrorInputSchema} from '@deft/app-kit';
import {db} from './db.js';
import {getAppConnectionSessionRegistry} from './app-connection-session-registry.js';
import {appDataDenied,appDataDigest} from './app-data-authority.js';
import {PostgresRecordMirrorStore} from './app-record-mirror-store.js';
import {currentRecordMirrorAuthority,currentRecordMirrorReadAuthority,ReviewedRecordMirrorAuthoritySchema} from './app-record-mirror-authority.js';
import {submitRecordMirrorRun} from './app-record-mirror-submit.js';
const id=z.string().uuid(),key=z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u);
const base={scope:AppConnectionSessionScopeSchema};
const request=z.discriminatedUnion('operation',[
 z.strictObject({...base,operation:z.literal('poll'),store_key:key,mirror_key:key}),
 z.strictObject({...base,operation:z.literal('check'),receipt_id:id}),
 z.strictObject({...base,operation:z.literal('submit'),request_id:id,input:AppPreparedMirrorInputSchema}),
 z.strictObject({...base,operation:z.literal('status'),receipt_id:id,request_id:id}),
 z.strictObject({...base,operation:z.literal('cleanup_source'),receipt_id:id,input:AppPreparedMirrorInputSchema}),
]);
/** Runtime credentials locate an exact scope. Only a durable human-reviewed
 * receipt supplies recurring provider authority; no browser SID is fabricated. */
export async function appRecordMirrorRuntime(raw:unknown,authorization:string|undefined,clock=()=>new Date()){
 const input=request.parse(raw),registry=await getAppConnectionSessionRegistry();registry.authenticate(input.scope,authorization);
 return db.transaction(async tx=>{
  const store=new PostgresRecordMirrorStore();
  if(input.operation==='poll'){
   const result=await tx.execute(sql`SELECT receipt_id FROM app_record_mirror_authorities WHERE org_id=${input.scope.org_id} AND owner_user_id=${input.scope.owner_user_id} AND installation_id=${input.scope.installation_id} AND app_version_id=${input.scope.app_version_id} AND grant_snapshot_id=${input.scope.grant_snapshot_id} AND runtime_registration_id=${input.scope.runtime_registration_id} AND resource_binding_id=${input.scope.resource_binding_id} AND store_key=${input.store_key} AND mirror_key=${input.mirror_key} AND state='enabled' AND expires_at>clock_timestamp() ORDER BY created_at DESC LIMIT 32`);
   const receipts=[];
   for(const candidate of result.rows){if(typeof candidate.receipt_id!=='string')throw appDataDenied();const row=await store.read(tx,input.scope.org_id,input.scope.owner_user_id,candidate.receipt_id);if(!row)continue;try{const pins=await currentRecordMirrorAuthority(tx,row.reviewed_authority);if(appDataDigest(pins.scope)!==appDataDigest(input.scope))continue;receipts.push({receipt_id:row.receipt_id,revision:row.revision,policy_digest:row.policy_digest,store_key:row.store_key,account_ref:row.account_ref,expires_at:row.expires_at.toISOString(),attempts_remaining:await store.remaining(tx,row,new Date()),connection:pins.connection,policy:pins.policy});}catch{/* A stale or revoked receipt supplies no work. */}}
   return {receipts};
  }
  const receipt=input.operation==='submit'?input.input.mirror_receipt_id:input.receipt_id,row=await store.read(tx,input.scope.org_id,input.scope.owner_user_id,receipt);
  if(!row||appDataDigest(ReviewedRecordMirrorAuthoritySchema.parse(row.reviewed_authority).scope)!==appDataDigest(input.scope))throw appDataDenied();
  if(input.operation==='status'){
   const readable=await currentRecordMirrorReadAuthority(tx,row.reviewed_authority,clock);
   return discloseRecordMirrorRead(readable,async()=>{
   return readRecordMirrorRuntimeStatus(tx,input.scope.org_id,receipt,input.request_id);
   },clock);
  }
  if(input.operation==='submit')return submitRecordMirrorRun(tx,input.scope,input.request_id,input.input,clock);
  if(row.state!=='enabled'||row.expires_at<=new Date())throw appDataDenied();const pins=await currentRecordMirrorAuthority(tx,row.reviewed_authority);
  if(row.authority_digest!==appDataDigest(pins))throw appDataDenied();
  if(input.operation==='cleanup_source'){if(input.input.mirror_receipt_id!==row.receipt_id||input.input.mirror_receipt_revision!==row.revision||input.input.mirror_policy_digest!==row.policy_digest||input.input.record_store_key!==row.store_key)throw appDataDenied();try{await assertPreparedRecordCleanupSource(tx,pins,input.input);return {eligible:true};}catch{return {eligible:false};}}
  return {receipt_id:row.receipt_id,revision:row.revision,policy_digest:row.policy_digest,expires_at:row.expires_at.toISOString(),account_ref:row.account_ref};
 });
}
