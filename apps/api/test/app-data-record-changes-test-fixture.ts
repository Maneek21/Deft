import {randomUUID,createHash} from 'node:crypto';
import {canonicalAppDataJson} from '../../../packages/app-kit/src/app-data';
export const hash='sha256:'+'a'.repeat(64),uuid=randomUUID;
export const digest=(value:unknown)=>'sha256:'+createHash('sha256').update(canonicalAppDataJson(value)).digest('hex');
export function fixture(){const expires=new Date(Date.now()+3600000).toISOString(),now=new Date().toISOString();
 const scope={org_id:uuid(),owner_user_id:uuid(),installation_id:uuid(),app_version_id:uuid(),grant_snapshot_id:uuid(),package_digest:hash,grant_snapshot_digest:hash,
 lifecycle_epoch:1,grant_epoch:1,target_key:'sender',resource_key:'mail',resource_binding_id:uuid(),runtime_registration_id:uuid(),operator_user_id:uuid(),runtime_epoch:1,profile_digest:hash,consent_expires_at:expires};
 const connection={session_id:uuid(),session_revision:1,runtime_session_ref:'opaque_runtime',account_ref:uuid()};
 const declaration=(key:string)=>({schema_version:'deft.app_record_store.v1' as const,key,resource_key:'mail',runtime_requirement_key:'sync_provider',max_record_bytes:491520,max_files:32,max_file_bytes:26214400,max_total_file_bytes:26214400});
 const destination={scope,connection,store:{...declaration('drafts'),record_changes:[{key:'template_replace',source_store_key:'templates'}]},consent:{consent_id:uuid(),consent_digest:hash,expires_at:new Date(expires)},expires_at:Date.now()+600000,data_policy_digest:hash,profile:{} as any};
 const source={...destination,store:declaration('templates'),consent:{consent_id:uuid(),consent_digest:hash,expires_at:new Date(expires)}};
 const input={store_key:'drafts',record_id:uuid(),expected_revision:1,expected_content_digest:hash,operation_key:'template_replace',source:{store_key:'templates',record_id:uuid(),expected_revision:1,expected_content_digest:hash}};
 const proofs=[destination,source].map((value,index)=>({role:index?'source':'destination',store_key:value.store.key,consent_id:value.consent.consent_id,consent_digest:hash,data_policy_digest:hash,consent_expires_at:expires}));
 const value={to:'person@example.test',subject:'Preview subject',body:'  preserved\ttext\n\n',body_html:'',attachments:[],mode:'compose',reply_record_id:''};
 const prepare=()=>{const {operation_key,source,...dest}=input;const snapshot={schema_version:'deft.app_prepared_record_change.v1' as const,prepared_id:uuid(),operation_key,account_ref:connection.account_ref,destination:dest,source,
 authorization_digest:digest({scope,connection,record_authorities:proofs}),value,preview:{title:'Use saved template',description:'Review the saved draft.',warnings:[]},expires_at:new Date(Date.now()+240000).toISOString()};return {...snapshot,prepared_digest:digest(snapshot)};};
 const row={schema_version:'deft.app_record.v1' as const,store_key:'drafts',record_id:input.record_id,revision:1,content_revision:1,content_digest:hash,status:'draft' as const,value:{...value,subject:'Before',body:'Before'},files:[],created_at:now,updated_at:now};
 return {scope,connection,destination,source,input,proofs,value,prepare,row,expires};}
