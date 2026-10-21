import {AppDataRuntimeAuthorityRequestSchema} from '@deft/app-kit/core';
type RecordRef={store_key:string;record_id:string;revision:number;content_digest:string};
type Authority={scope:{org_id:string;owner_user_id:string;installation_id:string;target_key:string;resource_key:string};connection:{account_ref:string}};
type Row={org_id:string;owner_user_id:string;request_id:string;state:string;revision:number;operation:string;context:unknown;result:unknown};
/** A historical Save is evidence of human choice, never current permission.
 * Current record/store consent is checked separately before returning or using it. */
export function humanRecordSaveReceipt(authority:Authority,record:RecordRef,rows:readonly Row[]){
 if(rows.length!==1)return undefined;const row=rows[0]!;
 const parsed=AppDataRuntimeAuthorityRequestSchema.safeParse(row.context);if(!parsed.success)return undefined;const context=parsed.data;
 const result=row.result as Record<string,unknown>|null;
 if(row.state!=='completed'||row.revision!==1||row.operation!=='record_save'||row.org_id!==authority.scope.org_id||row.owner_user_id!==authority.scope.owner_user_id
  ||context.operation!=='record_save'||context.request_id!==row.request_id||context.scope.org_id!==authority.scope.org_id||context.scope.owner_user_id!==authority.scope.owner_user_id
  ||context.scope.installation_id!==authority.scope.installation_id||context.scope.target_key!==authority.scope.target_key||context.scope.resource_key!==authority.scope.resource_key||context.connection.account_ref!==authority.connection.account_ref
  ||!result||Array.isArray(result)||result.request_id!==row.request_id||result.operation!=='record_save'||result.input_digest!==context.input_digest||result.outcome!=='completed'
  ||result.store_key!==record.store_key||result.record_id!==record.record_id||result.revision!==record.revision||result.content_digest!==record.content_digest)return undefined;
 return {request_id:row.request_id,store_key:record.store_key,record_id:record.record_id,revision:record.revision,content_digest:record.content_digest};
}
