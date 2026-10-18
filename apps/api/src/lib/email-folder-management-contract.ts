import {z} from 'zod';
import {canonicalCapabilityJson} from '@deft/shared';
import {createHash} from 'node:crypto';
const id=z.string().min(1).max(256).refine(v=>v===v.trim()&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v));
const unicode=(s:string)=>{for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const d=s.charCodeAt(++i);if(!(d>=0xdc00&&d<=0xdfff))return false;}else if(c>=0xdc00&&c<=0xdfff)return false;}return true;};
export const EmailFolderNameSchema=z.string().min(1).max(128).refine(v=>v===v.trim()&&unicode(v)&&Buffer.byteLength(v,'utf8')<=512&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v));
const token=z.string().min(1).max(8192).regex(/^[A-Za-z0-9_-]+$/u);
export const EmailFolderManageRequestSchema=z.discriminatedUnion('kind',[
 z.strictObject({operation_id:z.uuid(),kind:z.literal('create'),name:EmailFolderNameSchema}),
 z.strictObject({operation_id:z.uuid(),kind:z.literal('rename'),name:EmailFolderNameSchema,rename_id:token})]);
export const EmailFolderManageResultSchema=z.strictObject({schema_version:z.literal('deft.email_folder_manage_result.v1'),account_id:id,operation_id:z.uuid(),kind:z.enum(['create','rename']),
 state:z.enum(['succeeded','failed','unknown']),folder_id:id.nullable(),label:z.string().min(1).max(512).nullable(),automatic_retry:z.literal(false),undo_supported:z.literal(false),
 code:z.enum(['provider_rejected','target_changed','provider_unavailable','outcome_unknown']).optional()}).refine(v=>v.state==='succeeded'?v.folder_id!==null&&v.label!==null:v.folder_id===null&&v.label===null);
export type EmailFolderManageRequest=z.infer<typeof EmailFolderManageRequestSchema>;
export type EmailFolderManageResult=z.infer<typeof EmailFolderManageResultSchema>;
export const EmailFolderManageOperationsSchema=z.strictObject({schema_version:z.literal('deft.email_folder_manage_operations.v1'),account_id:id,
 items:z.array(z.strictObject({operation_id:z.uuid(),kind:z.enum(['create','rename']),proposed_name:EmailFolderNameSchema,created_at:z.iso.datetime(),result:EmailFolderManageResultSchema})).max(20),limit:z.literal(20),coverage:z.literal('recent'),automatic_retry:z.literal(false)}).refine(v=>new Set(v.items.map(row=>row.operation_id)).size===v.items.length&&v.items.every(row=>row.result.operation_id===row.operation_id&&row.result.kind===row.kind&&row.result.account_id===v.account_id));
export type EmailFolderManageProviderRequest=Readonly<{kind:'create';name:string}|{kind:'rename';id:string;name:string;expected_name:string}>;
export const EmailFolderManagedSchema=z.strictObject({id,folder_id:z.string().regex(/^(?:label|folder):[a-f0-9]{64}$/u),label:z.string().min(1).max(512),kind:z.enum(['label','folder'])}).refine(v=>v.folder_id.startsWith(v.kind+':'));
export type EmailFolderManaged=z.infer<typeof EmailFolderManagedSchema>;
export const EmailFolderManagePlanSchema=z.strictObject({schema_version:z.literal('deft.email_folder_manage_plan.v1'),operation_id:z.uuid(),
 scope:z.strictObject({org_id:id,owner_user_id:id,account_id:id}),binding:z.strictObject({provider:z.enum(['gmail','microsoft']),principal_digest:z.string().regex(/^[a-f0-9]{64}$/u),connection_revision:z.number().int().positive(),authority_epoch:z.number().int().positive(),resource_binding_id:id,authority_version:id}),
 request:EmailFolderManageRequestSchema,provider_request:z.union([z.strictObject({kind:z.literal('create'),name:EmailFolderNameSchema}),z.strictObject({kind:z.literal('rename'),id,name:EmailFolderNameSchema,expected_name:z.string().min(1).max(512)})]),digest:z.string().regex(/^[a-f0-9]{64}$/u)}).refine(v=>v.request.operation_id===v.operation_id&&v.request.kind===v.provider_request.kind&&v.request.name===v.provider_request.name);
export const EmailFolderManageValueSchema=z.strictObject({plan:EmailFolderManagePlanSchema,state:z.enum(['prepared','started','succeeded','failed','unknown']),result:EmailFolderManageResultSchema.nullable()}).refine(v=>['prepared','started'].includes(v.state)?v.result===null:v.result!==null&&v.result.state===v.state&&v.result.operation_id===v.plan.operation_id&&v.result.account_id===v.plan.scope.account_id&&v.result.kind===v.plan.request.kind);
export type EmailFolderManagePlan=z.infer<typeof EmailFolderManagePlanSchema>;
export type EmailFolderManageValue=z.infer<typeof EmailFolderManageValueSchema>;
export const emailFolderManageDigest=(value:unknown)=>createHash('sha256').update(canonicalCapabilityJson(value)).digest('hex');
export interface EmailFolderManageJournal{
 load(id:string):Promise<EmailFolderManageValue|null>;
 recent():Promise<readonly {created_at:string;value:EmailFolderManageValue}[]>;
 change<T>(id:string,work:(value:EmailFolderManageValue|null,write:(next:EmailFolderManageValue)=>Promise<void>)=>Promise<T>):Promise<T>;
}
export class EmailFolderManageError extends Error{constructor(readonly code:'EMAIL_FOLDER_MANAGEMENT_UNSUPPORTED'|'EMAIL_FOLDER_MANAGEMENT_CONFLICT'|'EMAIL_FOLDER_MANAGEMENT_BUSY'|'EMAIL_FOLDER_RENAME_INVALID'|'EMAIL_FOLDER_RENAME_EXPIRED'|'EMAIL_FOLDER_TARGET_CHANGED'){super(code);this.name='EmailFolderManageError';}}
