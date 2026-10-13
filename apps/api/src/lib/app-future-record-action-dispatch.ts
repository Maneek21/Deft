import {sql} from 'drizzle-orm';
import type {AppRunTransaction,AppRunSafeView} from './app-run-repository.js';
import {PostgresFutureRecordActionStore,decodeFutureReleaseRow,type FutureReleaseRow} from './app-future-record-action-store.js';
import {currentFutureRecordActionAuthority,ReviewedFutureRecordActionAuthoritySchema} from './app-future-record-action-authority.js';
export async function optionalFutureRecordAction(tx:AppRunTransaction,org:string,run:string){
 const present=await tx.execute(sql<{present:boolean}>`SELECT to_regclass('app_future_record_action_releases') IS NOT NULL AS present`);
 if(!present.rows[0]?.present)return null;
 const result=await tx.execute(sql`SELECT * FROM app_future_record_action_releases WHERE org_id=${org} AND run_id=${run}`);
 return result.rows[0]?decodeFutureReleaseRow(result.rows[0]):null;
}
/** Caller already owns the Run lock. Only a committed local freeze can
 * nominate an attempt; the due-time fence applies even to a direct claim. */
export async function futureRecordActionGate(tx:AppRunTransaction,run:AppRunSafeView,stage:'prepare'|'claim'|'dispatch',now:Date,attempt?:string){
 const optional=await optionalFutureRecordAction(tx,run.org_id,run.id);if(!optional)return true;
 const store=new PostgresFutureRecordActionStore(),row=(await store.lock(tx,run.org_id,run.id))!;
 if(row.state!=='queued'||row.local_state!=='committed'||run.cancel_requested_at)return false;
 if(now>=row.dispatch_expires_at){await store.pauseOrExpireLocked(tx,row,null,now);return false;}
 try{await currentFutureRecordActionAuthority(tx,row.reviewed_authority,()=>now);}
 catch{await store.pauseOrExpireLocked(tx,row,'authority_changed',now);return false;}
 if(stage==='prepare')return true;
 if(now<row.not_before)return false;
 const future=(row.prepared.future_release as {schedule:{missed_policy:string}|null});
 if(future.schedule?.missed_policy==='pause_if_late'&&now.getTime()>row.not_before.getTime()+300000){await store.pauseOrExpireLocked(tx,row,'missed_time',now);return false;}
 if(stage==='claim')return true;
 if(!attempt)return false;
 const pins=ReviewedFutureRecordActionAuthoritySchema.parse(row.reviewed_authority);
 return Boolean(await store.dispatchLocked(tx,row,attempt,pins.policy.max_dispatch_lifetime_seconds,now));
}
export async function settleFutureRecordAction(tx:AppRunTransaction,run:AppRunSafeView,attempt:string,now:Date){
 if(!['succeeded','failed','cancelled','expired','unknown_outcome'].includes(run.state))return;
 const optional=await optionalFutureRecordAction(tx,run.org_id,run.id);if(!optional||optional.state!=='dispatching')return;
 const store=new PostgresFutureRecordActionStore(),row=(await store.lock(tx,run.org_id,run.id))!;
 await store.settleLocked(tx,row,attempt,run.state==='succeeded'?'accepted':'unknown',now);
}
