import {z} from 'zod';
import {AppDataConnectionSchema,AppDataRecordSchema,type AppDataResult,type AppDataOperationInput,type RecordStoreDeclaration} from '@deft/app-kit/core';
import {AppError} from './app-errors.js';
import type {CurrentAppDataAuthority} from './app-data-authority.js';
import {appDataRecordSourcesWithinStore} from './app-data-file-copy-guards.js';
const value=z.record(z.string(),z.unknown());
const digest=z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const expected=z.strictObject({account_ref:AppDataConnectionSchema.shape.account_ref,target_key:z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u),data_policy_digest:digest,consent_id:z.uuid(),consent_digest:digest});
const requestSchema=z.strictObject({schema_version:z.literal('deft.record_seed_snapshot_request.v1'),record_id:z.uuid(),expected,value});
const resultSchema=z.strictObject({schema_version:z.literal('deft.record_seed_snapshot.v1'),record_id:z.uuid(),account_ref:AppDataConnectionSchema.shape.account_ref,record:AppDataRecordSchema.nullable(),value:value.nullable()});
const invalid=()=>new AppError('Invalid App data result','APP_ACTION_INVALID',400);
/** The opt-in compound read has exactly the record-read consent requirement. */
export function appDataSeedSnapshotRequest(operation:AppDataOperationInput){
 if(operation.operation!=='connection_metadata'||operation.input.seed?.operation_key!=='record_seed_snapshot')return null;
 const seed=operation.input.seed,parsed=requestSchema.safeParse(seed.value);
 if(!parsed.success||seed.destination_store_key!==operation.input.store_key)throw invalid();return parsed.data;
}
/** Opaque metadata may carry a full row only under the usual source/size/file fences. */
export function assertAppDataSeedSnapshotResult(operation:AppDataOperationInput,result:AppDataResult|undefined,resourceKey:string,store:RecordStoreDeclaration,accountId:string){
 const request=appDataSeedSnapshotRequest(operation);if(!request)return;
 const parsed=resultSchema.safeParse(result?.record_seed_value);if(!parsed.success)throw invalid();const snapshot=parsed.data;
 if(result?.outcome!=='completed'||snapshot.record_id!==request.record_id||snapshot.account_ref!==accountId||(snapshot.record===null)===(snapshot.value===null))throw invalid();
 if(snapshot.record){const row=snapshot.record;if(row.store_key!==store.key||row.record_id!==request.record_id||!appDataRecordSourcesWithinStore(row,resourceKey,store)
  ||Buffer.byteLength(JSON.stringify(row.value))>store.max_record_bytes||row.files.length>store.max_files
  ||row.files.some(file=>file.size_bytes>store.max_file_bytes)||row.files.reduce((sum,file)=>sum+file.size_bytes,0)>store.max_total_file_bytes)throw invalid();}
 else if(Buffer.byteLength(JSON.stringify(snapshot.value))>store.max_record_bytes)throw invalid();
}

/** Fresh entry authority must match every pre-storage public account/store pin. */
export function assertAppDataSeedSnapshotPins(operation:AppDataOperationInput,current:CurrentAppDataAuthority){
 const request=appDataSeedSnapshotRequest(operation);if(!request)return;const pins=request.expected;
 if(pins.account_ref!==current.connection.account_ref||pins.target_key!==current.scope.target_key||pins.data_policy_digest!==current.data_policy_digest
  ||!current.consent||pins.consent_id!==current.consent.consent_id||pins.consent_digest!==current.consent.consent_digest)throw invalid();
}
/** Seal the recovery lease with final Host authority, never a Runtime claim. */
export function sealAppDataSeedSnapshotExpiry(operation:AppDataOperationInput,result:AppDataResult|undefined,currentExpiry:number,invocationExpiry:number){
 if(!appDataSeedSnapshotRequest(operation))return;const expiry=Math.min(currentExpiry,invocationExpiry);
 if(!result?.record_seed_value||!Number.isFinite(expiry)||expiry<=Date.now())throw invalid();
 result.record_seed_value={...result.record_seed_value,expires_at:new Date(expiry).toISOString()};
}
