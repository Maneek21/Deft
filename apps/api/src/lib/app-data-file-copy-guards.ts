import type {AppDataOperationInput,AppDataRecord,RecordStoreDeclaration} from '@deft/app-kit/core';
/** Nested source nominations must stay inside the reviewed store resource. */
export function appDataSourceWithinStore(operation:AppDataOperationInput,resourceKey:string,store:RecordStoreDeclaration){
 if(operation.operation==='file_copy')return !!store.resource_content&&operation.input.source.resource_key===resourceKey;
 if(operation.operation==='record_create'&&operation.input.source_refs?.length)return !!store.resource_content&&operation.input.source_refs.every(ref=>ref.resource_key===resourceKey);
 return true;
}
export function appDataRecordSourcesWithinStore(row:Pick<AppDataRecord,'source_refs'>,resourceKey:string,store:RecordStoreDeclaration){return !row.source_refs?.length||!!store.resource_content&&row.source_refs.every(ref=>ref.resource_key===resourceKey);}
