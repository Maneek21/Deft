import {and,eq} from 'drizzle-orm';
import {isDeepStrictEqual} from 'node:util';
import {appConnectionSessions} from '../../../../packages/db/src/app-connection-session-schema.js';
import {db} from './db.js';
import {AppError} from './app-errors.js';
import {AppConnectionSessionRecordSchema,type AppConnectionSessionRecord} from './app-connection-session-service.js';

const denied=()=>new AppError('App data access ended','APP_ACCESS_DENIED',403);
/** Only acknowledged credential repair carries an existing grant. The original
 * consent snapshot/digest stays immutable; every caller still proves current
 * binding, owner, policy and consent state independently. */
export async function appDataConsentConnections(current:AppConnectionSessionRecord){
 // Without a repair there are no lineage rows to lock/read. Retain the same
 // connected-account checks and avoid a transaction with no statements.
 if(!current.credential_repair){
  if(current.state!=='connected'||!current.account||!current.runtime_session_ref)throw denied();
  return [current];
 }
 return db.transaction(async tx=>{
  const connections:AppConnectionSessionRecord[]=[];let record=current;
  for(;;){
   if(connections.some(item=>item.session_id===record.session_id)||record.state!=='connected'||!record.account||!record.runtime_session_ref)throw denied();
   connections.push(record);
   const repair=record.credential_repair;if(!repair)break;
   const [row]=await tx.select().from(appConnectionSessions).where(and(eq(appConnectionSessions.org_id,current.scope.org_id),
    eq(appConnectionSessions.owner_user_id,current.scope.owner_user_id),eq(appConnectionSessions.session_id,repair.source.session_id))).for('share');
   if(!row)throw denied();const source=AppConnectionSessionRecordSchema.parse(row.record);
   assertAppDataConsentRepairSource(current,record,source);
   record=source;
  }
  return connections;
 });
}

/** Exact historical identity only; this does not grant current read authority. */
export function assertAppDataConsentRepairSource(current:AppConnectionSessionRecord,record:AppConnectionSessionRecord,source:AppConnectionSessionRecord){
 const repair=record.credential_repair;
 if(!repair||record.state!=='connected'||source.state!=='connected'||!record.account||!source.account
  ||!repair.reservation_closed||!repair.receipt||!repair.review||!repair.begin_consumed||!record.callback_consumed
  ||repair.receipt.custody_generation!==repair.review.custody_generation+1
  ||source.session_id!==repair.source.session_id||source.revision!==repair.source.session_revision
  ||!source.runtime_session_ref||source.runtime_session_ref!==repair.source.runtime_session_ref
  ||source.account.account_ref!==repair.source.account_ref||source.account.account_ref!==record.account.account_ref
  ||!isDeepStrictEqual(source.scope,current.scope)||!isDeepStrictEqual(source.scope,repair.source.scope)
  ||!isDeepStrictEqual(record.scope,current.scope)||!isDeepStrictEqual(source.profile,current.profile)
  ||!isDeepStrictEqual(record.profile,current.profile)||!isDeepStrictEqual(source.action_consents,current.action_consents)
  ||!isDeepStrictEqual(record.action_consents,current.action_consents))throw denied();
}
