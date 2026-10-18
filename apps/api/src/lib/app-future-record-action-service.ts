import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {AppFutureRecordActionStatusSchema,type AppDataPreparedRecordAction} from '@deft/app-kit';
import type {AppRunTransaction} from './app-run-repository.js';
import type {ExperienceCaller} from './app-experience-service.js';
import type {ReviewedFutureRecordActionTicket} from './app-future-record-action-review.js';
import {currentFutureRecordActionAuthority} from './app-future-record-action-authority.js';
import {appDataDigest,appDataDenied} from './app-data-authority.js';
import {humanActionDigest} from './app-experience-human-action-contract.js';
import {PostgresFutureRecordActionStore,type FutureReleaseRow} from './app-future-record-action-store.js';
export function futureRecordActionStatus(row:FutureReleaseRow){return AppFutureRecordActionStatusSchema.parse({
 schema_version:'deft.app_future_record_action_status.v1',release_id:row.release_id,request_id:row.request_id,run_id:row.run_id,
 revision:row.revision,state:row.state,not_before:row.not_before.toISOString(),undo_until:row.undo_until.toISOString(),
 dispatch_expires_at:row.dispatch_expires_at.toISOString(),authority_expires_at:row.authority_expires_at.toISOString(),pause_reason:row.pause_reason,local_state:row.local_state,local_record:row.local_receipt?.record??null,
});}
/** Atomic with the original Run and its human approval. Browser expiry after
 * this transaction does not become a new dispatch credential. */
export async function admitFutureRecordAction(tx:AppRunTransaction,caller:ExperienceCaller,run:{id:string},
 review:ReviewedFutureRecordActionTicket,prepared:AppDataPreparedRecordAction,input:Record<string,string|number|boolean>,now:Date){
 if(!prepared.future_release||prepared.snapshot_digest!==review.prepared_digest||appDataDigest(prepared.future_release)!==appDataDigest(review.future_release)
 ||review.authority.scope.org_id!==caller.org_id||review.authority.scope.owner_user_id!==caller.user_id)throw appDataDenied();
 await currentFutureRecordActionAuthority(tx,review.authority,()=>now);
 const store=new PostgresFutureRecordActionStore(),window=review.future_release.execution_window;
 const undoUntil=new Date(now.getTime()+window.undo_delay_seconds*1000);
 const notBefore=new Date(Math.max(undoUntil.getTime(),review.future_release.schedule?Date.parse(review.future_release.schedule.instant):0));
 if(notBefore.getTime()>=Date.parse(window.dispatch_expires_at))throw appDataDenied();
 // Preview contains record values and belongs only in the trusted host UI.
 const {preview:_,input:preparedInput,...pins}=prepared,metadata={...pins,record_content_digest:preparedInput.content_digest},inputDigest=humanActionDigest(input),authorityDigest=appDataDigest(review.authority);
 await tx.execute(sql`INSERT INTO app_future_record_action_releases
  (org_id,release_id,owner_user_id,request_id,run_id,review_web_session_id,freeze_request_id,restore_request_id,reviewed_authority,authority_digest,prepared,prepared_digest,input_digest,not_before,undo_until,dispatch_expires_at,authority_expires_at,created_at,updated_at)
  VALUES(${caller.org_id},${review.release_id},${caller.user_id},${review.release_id},${run.id},${caller.sid},${randomUUID()},${randomUUID()},${JSON.stringify(review.authority)}::jsonb,${authorityDigest},${JSON.stringify(metadata)}::jsonb,${prepared.snapshot_digest},${inputDigest},${notBefore},${undoUntil},${new Date(window.dispatch_expires_at)},${new Date(review.authority.authority_expires_at)},${now},${now})
  ON CONFLICT(org_id,owner_user_id,request_id) DO NOTHING`);
 const row=await store.lock(tx,caller.org_id,run.id);
 if(!row||row.owner_user_id!==caller.user_id||row.request_id!==review.release_id||row.input_digest!==inputDigest||row.authority_digest!==authorityDigest
 ||row.prepared_digest!==prepared.snapshot_digest||appDataDigest(row.prepared)!==appDataDigest(metadata))throw appDataDenied();
 return futureRecordActionStatus(row);
}
