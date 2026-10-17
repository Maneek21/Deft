import {sql} from 'drizzle-orm';
import type {AppRunTransaction} from './app-run-repository.js';
export type FutureReleaseState='pending_local_commit'|'queued'|'paused'|'dispatching'|'accepted'|'unknown'|'cancelled'|'expired';
export type FutureReleaseRow={org_id:string;owner_user_id:string;release_id:string;request_id:string;run_id:string;
 revision:number;state:FutureReleaseState;reviewed_authority:Record<string,unknown>;authority_digest:string;
 prepared:Record<string,unknown>;prepared_digest:string;input_digest:string;not_before:Date;undo_until:Date;
 dispatch_expires_at:Date;authority_expires_at:Date;dispatch_attempt_id:string|null;dispatch_started_at:Date|null;
 dispatch_lifetime_expires_at:Date|null;local_state:'pending'|'committed'|'restore_pending'|'restored'|'conflict';freeze_request_id:string;restore_request_id:string;local_receipt:Record<string,unknown>|null;pause_reason:'authority_changed'|'missed_time'|'runtime_unavailable'|'local_conflict'|null;};
type Query=Pick<AppRunTransaction,'execute'>;
export function decodeFutureReleaseRow(value:unknown):FutureReleaseRow { const row={...(value as FutureReleaseRow)}; for(const key of ['not_before','undo_until','dispatch_expires_at','authority_expires_at','dispatch_started_at','dispatch_lifetime_expires_at'] as const){ const raw=row[key]; if(raw!==null){ const date=raw instanceof Date?raw:new Date(raw); if(!Number.isFinite(date.getTime()))throw Error('APP_FUTURE_RELEASE_INVALID_DATE'); row[key]=date; } } return row; }
async function rows<T>(tx:Query,query:ReturnType<typeof sql>):Promise<T[]>{return (await tx.execute(query)).rows.map(decodeFutureReleaseRow) as unknown as T[];}
/** Every mutation first locks the Run, then its release. Dispatch and cancel
 * share this ordering and may never manufacture a second dispatch identity. */
export class PostgresFutureRecordActionStore{
 async read(tx:Query,org:string,owner:string,request:string){return (await rows<FutureReleaseRow>(tx,sql`SELECT * FROM app_future_record_action_releases WHERE org_id=${org} AND owner_user_id=${owner} AND request_id=${request}`))[0]??null;}
 async lock(tx:Query,org:string,run:string){
  await tx.execute(sql`SELECT id FROM app_runs WHERE org_id=${org} AND id=${run} FOR UPDATE`);
  return (await rows<FutureReleaseRow>(tx,sql`SELECT * FROM app_future_record_action_releases WHERE org_id=${org} AND run_id=${run} FOR UPDATE`))[0]??null;
 }
 async cancelLocked(tx:Query,row:FutureReleaseRow,request:string,expectedRevision:number,cancelRequest:string,now:Date){
  if(row.request_id!==request||row.revision!==expectedRevision)throw Error('APP_FUTURE_RELEASE_CONFLICT');
  if(row.dispatch_attempt_id!==null||!['pending_local_commit','queued','paused','expired'].includes(row.state))return {cancelled:false as const,state:row.state};
  const updated=await rows<FutureReleaseRow>(tx,sql`UPDATE app_future_record_action_releases SET state='cancelled',local_state='restore_pending',revision=revision+1,pause_reason=NULL,cancel_request_id=${cancelRequest},cancelled_at=${now},updated_at=${now} WHERE org_id=${row.org_id} AND release_id=${row.release_id} AND revision=${expectedRevision} AND dispatch_attempt_id IS NULL AND state IN ('pending_local_commit','queued','paused','expired') RETURNING *`);
  if(!updated[0])throw Error('APP_FUTURE_RELEASE_CONFLICT');
  return {cancelled:true as const,row:updated[0]};
 }
 async dispatchLocked(tx:Query,row:FutureReleaseRow,attempt:string,lifetimeSeconds:number,now:Date){
  if(row.state!=='queued'||row.local_state!=='committed'||now<row.not_before||now>=row.dispatch_expires_at||!Number.isInteger(lifetimeSeconds)||lifetimeSeconds<1||lifetimeSeconds>300)return null;
  const lifetime=new Date(Math.min(now.getTime()+lifetimeSeconds*1000,row.dispatch_expires_at.getTime(),row.authority_expires_at.getTime()));
  return (await rows<FutureReleaseRow>(tx,sql`UPDATE app_future_record_action_releases SET state='dispatching',revision=revision+1,dispatch_attempt_id=${attempt},dispatch_started_at=${now},dispatch_lifetime_expires_at=${lifetime},updated_at=${now} WHERE org_id=${row.org_id} AND release_id=${row.release_id} AND revision=${row.revision} AND state='queued' RETURNING *`))[0]??null;
 }
 async pauseOrExpireLocked(tx:Query,row:FutureReleaseRow,reason:FutureReleaseRow['pause_reason'],now:Date){
  const expired=now>=row.dispatch_expires_at;
  if(!['pending_local_commit','queued','paused'].includes(row.state)||row.state==='paused'&&!expired)return null;
  return (await rows<FutureReleaseRow>(tx,sql`UPDATE app_future_record_action_releases SET state=${expired?'expired':'paused'},revision=revision+1,pause_reason=${expired?null:reason},updated_at=${now} WHERE org_id=${row.org_id} AND release_id=${row.release_id} AND revision=${row.revision} AND state IN ('pending_local_commit','queued','paused') RETURNING *`))[0]??null;
 }
 async settleLocked(tx:Query,row:FutureReleaseRow,attempt:string,state:'accepted'|'unknown',now:Date){
  if(row.state!=='dispatching'||row.dispatch_attempt_id!==attempt)return null;
  return (await rows<FutureReleaseRow>(tx,sql`UPDATE app_future_record_action_releases SET state=${state},revision=revision+1,updated_at=${now} WHERE org_id=${row.org_id} AND release_id=${row.release_id} AND revision=${row.revision} AND state='dispatching' AND dispatch_attempt_id=${attempt} RETURNING *`))[0]??null;
 }
}
