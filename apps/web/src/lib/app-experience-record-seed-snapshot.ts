import {AppDataRecordSchema,type AppDataResult} from '../../../../packages/app-kit/src/app-data';
import type {ExperienceRecordFormNode} from '../components/apps/experience-record-form';
/** Opt-in framing stays outside App-owned initial values and saved content. */
export function recordSeedSnapshotValue(node:ExperienceRecordFormNode):Record<string,unknown>|null{
 const seed=node.seed?.value;if(seed?.schema_version!=='deft.record_seed_snapshot_seed.v1')return null;
 if(Object.keys(seed).length!==2||!seed.value||typeof seed.value!=='object'||Array.isArray(seed.value))throw Error('Seed snapshot nomination changed');
 return seed.value as Record<string,unknown>;
}
export function recordSeedSnapshotResult(result:AppDataResult,node:ExperienceRecordFormNode,accountId:string){
 const raw=result.record_seed_value;if(!raw||raw.schema_version!=='deft.record_seed_snapshot.v1'||Object.keys(raw).length!==6||raw.record_id!==node.record_id||raw.account_ref!==accountId
  ||!Object.hasOwn(raw,'record')||!Object.hasOwn(raw,'value')||(raw.record===null)===(raw.value===null))throw Error('Seed snapshot unavailable');
 const expiresAt=typeof raw.expires_at==='string'?Date.parse(raw.expires_at):NaN;if(!Number.isFinite(expiresAt)||expiresAt<=Date.now())throw Error('Seed snapshot proof ended');
 if(raw.record!==null){const record=AppDataRecordSchema.parse(raw.record);if(record.store_key!==node.store_key||record.record_id!==node.record_id)throw Error('Seed snapshot record changed');return {record,value:null,expiresAt};}
 if(!raw.value||typeof raw.value!=='object'||Array.isArray(raw.value))throw Error('Seed snapshot value unavailable');
 return {record:null,value:raw.value as Record<string,unknown>,expiresAt};
}
