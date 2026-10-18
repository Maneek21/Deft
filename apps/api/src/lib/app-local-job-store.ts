import {sql} from 'drizzle-orm';
import {db} from './db.js';
import type {AppRunTransaction} from './app-run-repository.js';
export type LocalJobRow={org_id:string;owner_user_id:string;job_id:string;revision:number;snapshot:Record<string,unknown>;snapshot_digest:string;state:'scheduled'|'leased'|'completed'|'cancelled'|'indeterminate';due_at:Date;expires_at:Date;created_at:Date;updated_at:Date};
export type LocalJobAttempt={org_id:string;job_id:string;revision:number;attempt_id:string;lease_token_sha256:string;lease_expires_at:Date;mode:'execute'|'recover';state:'leased'|'completed'|'indeterminate';result:Record<string,unknown>|null;created_at:Date;updated_at:Date};
export type LocalJobInvocation={org_id:string;owner_user_id:string;request_id:string;web_session_id:string;access_expires_at:Date;context:Record<string,unknown>;input_pins:Record<string,unknown>;state:'inflight'|'completed'|'indeterminate';result:Record<string,unknown>|null;expires_at:Date;created_at:Date;updated_at:Date};
type Query=Pick<AppRunTransaction,'execute'>;
export async function localRows<T>(tx:Query,query:ReturnType<typeof sql>):Promise<T[]>{const result=await tx.execute(query);return result.rows as unknown as T[];}
export class PostgresLocalJobStore{
 constructor(readonly database:typeof db=db){}
 transaction<T>(work:(tx:AppRunTransaction)=>Promise<T>){return this.database.transaction(work);}
 async invocation(tx:Query,org:string,owner:string,id:string,lock=false){return (await localRows<LocalJobInvocation>(tx,sql`SELECT * FROM app_local_job_invocations WHERE org_id=${org} AND owner_user_id=${owner} AND request_id=${id} ${lock?sql`FOR UPDATE`:sql``}`))[0]??null;}
 async schedule(tx:Query,org:string,owner:string,id:string,revision:number,lock=false){return (await localRows<LocalJobRow>(tx,sql`SELECT * FROM app_local_job_schedules WHERE org_id=${org} AND owner_user_id=${owner} AND job_id=${id} AND revision=${revision} ${lock?sql`FOR UPDATE`:sql``}`))[0]??null;}
 async attempt(tx:Query,org:string,id:string,lock=false){return (await localRows<LocalJobAttempt>(tx,sql`SELECT * FROM app_local_job_attempts WHERE org_id=${org} AND attempt_id=${id} ${lock?sql`FOR UPDATE`:sql``}`))[0]??null;}
}
