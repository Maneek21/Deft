import {isDeepStrictEqual} from 'node:util';
import type {ResourceObservationSnapshot} from '../../../../packages/app-kit/src/resource-observation.js';
import type {AppConnectionSessionRecord} from './app-connection-session-service.js';

/** Project immutable observation consent through acknowledged, same-authority repair receipts. */
export function effectiveObservationRepair(snapshot:ResourceObservationSnapshot,records:AppConnectionSessionRecord[],runId?:string){
 let connection={...snapshot.connection};
 for(const record of records){
  const repair=record.credential_repair;
  if(!repair||!repair.reservation_closed||!isDeepStrictEqual(record.scope,snapshot.scope)
   ||repair.source.session_id!==connection.session_id||repair.source.account_ref!==connection.account_ref
   ||repair.source.runtime_session_ref!==connection.runtime_session_ref)continue;
  if(runId&&repair.historical_attempts.some(attempt=>attempt.run_id===runId))throw new Error('Historical observation attempt is fenced');
  if(!repair.review||connection.expected_custody_generation!==null&&repair.review.custody_generation!==connection.expected_custody_generation)continue;
  if(repair.receipt&&record.state==='connected'&&record.account?.account_ref===connection.account_ref&&record.runtime_session_ref
   &&repair.receipt.custody_generation===repair.review.custody_generation+1){
   connection={...connection,session_id:record.session_id,runtime_session_ref:record.runtime_session_ref,
    expected_custody_generation:repair.receipt.custody_generation,receipt_digest:repair.receipt.receipt_digest};
  }else if(repair.closure&&(repair.closure.reason==='provider_denied'||repair.closure.reason==='callback_expired'||repair.closure.reason==='exchange_abandoned')
   &&repair.closure.custody_generation===repair.review.custody_generation+1){
   connection={...connection,expected_custody_generation:repair.closure.custody_generation,receipt_digest:repair.closure.receipt_digest};
  }
 }
 return {...snapshot,connection};
}
