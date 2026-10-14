import {AppIntegrationSourceMappingSchema} from './app-integration-source-mapping.js';
import {AppRecordMirrorDeclarationsSchema} from './record-mirror.js';
import {AppFutureRecordActionDeclarationsSchema,AppFutureExecutionWindowSchema,AppPreparedFutureReleaseSchema,AppPreparedActionLifecycleInputSchema,AppPreparedActionLifecycleReceiptSchema} from './future-record-action.js';
import {AppLocalJobOperationsSchema} from './local-job-declaration.js';
import {z} from 'zod';
import {AppPreparedCopyEffectSchema,AppPreparedCopyEffectInputSchema} from './prepared-copy-effect.js';
import {AppPreparedEffectDeclarationsSchema,AppPreparedEffectSchema,AppPreparedEffectInputSchema} from './prepared-effect.js';
import {AppRecordChangeDeclarationsSchema,AppRecordChangeControlsSchema,AppRecordPrepareChangeInputSchema,AppRecordApplyChangeInputSchema,AppPreparedRecordChangeSchema} from './record-change.js';
import {AppConnectionActionConsentSchema,AppConnectionSessionScopeSchema} from './connection-session.js';
import {AppResourceActionPlanInputSchema,AppResourceActionReadInputSchema,AppDataPreparedResourceActionSchema} from './app-resource-action.js';

export const APP_DATA_LIMITS = Object.freeze({record_bytes: 480 * 1024, json_bytes: 512 * 1024,result_json_bytes:2*1024*1024,
  files: 32, file_bytes: 25 * 1024 * 1024, source_bytes:35*1024*1024,total_file_bytes: 25 * 1024 * 1024, frame_header_bytes: 16384});
export const APP_DATA_FRAME_MEDIA_TYPE = 'application/vnd.deft.app-data-frame.v1' as const;
const id = z.string().uuid(), key = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u)
  .refine(value => !['constructor','prototype','__proto__'].includes(value));
export const AppDataResolveInputSchema=z.strictObject({schema_version:z.literal('deft.app_data_resolve.v1'),target_key:key,store_key:key});
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const nodeId=z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u);
const revision = z.number().int().min(1).max(2147483646);
const opaque = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u);
const label = z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f<>]+$/u);
const mediaType = z.string().regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u);
const filename = z.string().min(1).max(255).refine(value => !/[\u0000-\u001f\u007f/\\]/u.test(value));
export {canonicalAppDataJson} from './app-data-json.js';
import {canonicalAppDataJson} from './app-data-json.js';
const value = z.record(z.string(), z.unknown()).refine(row => {
  try {canonicalAppDataJson(row); return new TextEncoder().encode(JSON.stringify(row)).byteLength <= APP_DATA_LIMITS.record_bytes;} catch {return false;}
}, 'Record must be a bounded complete JSON object');
export const RecordStoreDeclarationSchema = z.strictObject({schema_version: z.literal('deft.app_record_store.v1'), key,
  resource_key: key, runtime_requirement_key: key, supplemental_effects:AppPreparedEffectDeclarationsSchema.optional(), record_changes:AppRecordChangeDeclarationsSchema.optional(), local_job_operations:AppLocalJobOperationsSchema.optional(), future_record_actions:AppFutureRecordActionDeclarationsSchema.optional(), record_mirrors:AppRecordMirrorDeclarationsSchema.optional(), max_record_bytes: z.number().int().min(1).max(APP_DATA_LIMITS.record_bytes),
  max_files: z.number().int().min(0).max(32), max_file_bytes: z.number().int().min(1).max(APP_DATA_LIMITS.file_bytes),
  max_total_file_bytes: z.number().int().min(1).max(APP_DATA_LIMITS.total_file_bytes),
  source_projection: AppIntegrationSourceMappingSchema.optional(),
  resource_content: z.strictObject({max_presentation_bytes: z.number().int().min(1).max(262144),
    max_source_bytes: z.number().int().min(1).max(APP_DATA_LIMITS.source_bytes), max_file_bytes: z.number().int().min(1).max(APP_DATA_LIMITS.file_bytes),
    max_image_bytes: z.number().int().min(1).max(2097152)}).optional(),
}).refine(row => row.max_file_bytes <= row.max_total_file_bytes)
  .refine(row => !row.source_projection || !!row.resource_content, 'Source mapping requires bounded public resource content');
export const RecordStoreDeclarationsSchema = z.array(RecordStoreDeclarationSchema).min(1).max(16)
  .refine(rows => rows.every((row,index) => !index || rows[index-1]!.key < row.key), 'Stores must be unique and sorted')
  .refine(rows=>rows.every(row=>!row.record_changes||row.record_changes.every(change=>{const source=rows.find(item=>item.key===change.source_store_key);return !!source&&source.key!==row.key&&source.resource_key===row.resource_key&&source.runtime_requirement_key===row.runtime_requirement_key;})),'Record changes must name a declared same-resource source store');
export type RecordStoreDeclaration = z.infer<typeof RecordStoreDeclarationSchema>;
export const AppDataFileSchema = z.strictObject({file_id: id, upload_revision: revision, filename, media_type: mediaType,
  size_bytes: z.number().int().min(0).max(APP_DATA_LIMITS.file_bytes), sha256: digest});
const files = z.array(AppDataFileSchema).max(32).refine(rows => new Set(rows.map(row => row.file_id)).size === rows.length
  && rows.reduce((sum,row) => sum + row.size_bytes, 0) <= APP_DATA_LIMITS.total_file_bytes);
export const AppDataSourceReferenceSchema=z.strictObject({resource_key:key,record_id:id,content_digest:digest});
export const AppDataSourceReferencesSchema=z.array(AppDataSourceReferenceSchema).max(1);
export type AppDataSourceReference=z.infer<typeof AppDataSourceReferenceSchema>;
export const AppDataRecordSchema = z.strictObject({schema_version: z.literal('deft.app_record.v1'), store_key: key, record_id: id,
  revision, content_revision: revision, content_digest: digest, status: z.enum(['draft','submitted','archived']), value, source_refs:AppDataSourceReferencesSchema.optional(),
  files, summary:z.record(key,z.union([z.string().max(2048),z.number().finite(),z.boolean()])).optional(), created_at: z.iso.datetime(), updated_at: z.iso.datetime()});
export type AppDataRecord = z.infer<typeof AppDataRecordSchema>;
export const AppDataRecordMetaSchema = AppDataRecordSchema.omit({value:true,files:true});
/** Displayable verified principal identifier. Its domain grammar belongs to the Runtime. */
export const AppDataIdentitySchema = z.strictObject({address: z.string().min(1).max(320).regex(/^[^\u0000-\u001f\u007f<>]+$/u), label});
const identities = z.array(AppDataIdentitySchema).max(32);
export const AppDataConnectionSchema = z.strictObject({session_id:id,session_revision:revision,
  runtime_session_ref:opaque,account_ref:opaque});
export const AppDataAuthorityPinsSchema = z.strictObject({consent_id:id.nullable(),consent_digest:digest.nullable(),data_policy_digest:digest})
  .refine(row => (row.consent_id === null) === (row.consent_digest === null));
const record = {store_key:key,record_id:id}, expected = {expected_revision:revision,expected_content_digest:digest};
const file = {...record,file_id:id,upload_revision:revision,sha256:digest};
const resource = {store_key:key,resource_key:key}, source = {...resource,record_id:id,content_digest:digest};
const cursor = z.string().min(1).max(2048).nullable();
export const AppDataOperationInputSchema = z.discriminatedUnion('operation',[
  z.strictObject({operation:z.literal('connection_metadata'),input:z.strictObject({store_key:key,seed:z.strictObject({operation_key:key,destination_store_key:key,value:value}).optional()})}),
  z.strictObject({operation:z.literal('record_list'),input:z.strictObject({store_key:key,cursor,limit:z.number().int().min(1).max(25)})}),
  z.strictObject({operation:z.literal('record_read'),input:z.strictObject(record)}),
  z.strictObject({operation:z.literal('record_create'),input:z.strictObject({...record,value,
    source_refs:AppDataSourceReferencesSchema.optional()})}),
  z.strictObject({operation:z.literal('record_save'),input:z.strictObject({...record,...expected,value})}),
  z.strictObject({operation:z.literal('record_archive'),input:z.strictObject({...record,...expected})}),
  z.strictObject({operation:z.literal('file_upload'),input:z.strictObject({...record,...expected,file_id:id,filename,media_type:mediaType,
    size_bytes:z.number().int().min(0).max(APP_DATA_LIMITS.file_bytes),sha256:digest})}),
  z.strictObject({operation:z.literal('file_copy'),input:z.strictObject({...record,...expected,file_id:id,source:AppDataSourceReferenceSchema.extend({file_ref:digest})})}),
  z.strictObject({operation:z.literal('file_read'),input:z.strictObject(file)}),
  z.strictObject({operation:z.literal('file_detach'),input:z.strictObject({...file,...expected})}),
  z.strictObject({operation:z.literal('resource_list'),input:z.strictObject({...resource,cursor,limit:z.number().int().min(1).max(25),
    query:z.string().max(2048).optional(),anchor_record_id:id.optional()})}),
  z.strictObject({operation:z.enum(['resource_read_metadata','resource_read_presentation','resource_read_source','resource_list_files']),input:z.strictObject(source)}),
  z.strictObject({operation:z.literal('resource_read_file'),input:z.strictObject({...source,file_ref:digest})}),
  z.strictObject({operation:z.literal('resource_read_image'),input:z.strictObject({...source,image_ref:digest,external_images:z.enum(['blocked','allowed'])})}),
  z.strictObject({operation:z.literal('resource_refresh'),input:z.strictObject(resource)}),
  z.strictObject({operation:z.literal('record_prepare_change'),input:AppRecordPrepareChangeInputSchema}),
  z.strictObject({operation:z.literal('record_apply_change'),input:AppRecordApplyChangeInputSchema}),
  z.strictObject({operation:z.literal('request_status'),input:z.strictObject({store_key:key,request_id:id})}),
  z.strictObject({operation:z.literal('prepare_action'),input:z.strictObject({...record,...expected,action_key:key,prepare_expires_at:z.iso.datetime().optional(),execution_window:AppFutureExecutionWindowSchema.optional()})}),
  z.strictObject({operation:z.enum(['prepared_action_commit','prepared_action_restore']),input:AppPreparedActionLifecycleInputSchema}),
  z.strictObject({operation:z.literal('read_prepared'),input:z.strictObject({store_key:key,snapshot_id:id,snapshot_digest:digest})}),
  z.strictObject({operation:z.literal('prepare_resource_action'),input:AppResourceActionPlanInputSchema}),
  z.strictObject({operation:z.literal('read_prepared_resource_action'),input:AppResourceActionReadInputSchema}),
]);
export type AppDataOperationInput = z.infer<typeof AppDataOperationInputSchema>;
const operations = z.enum(['connection_metadata','record_list','record_read','record_create','record_save','record_archive',
  'file_upload','file_copy','file_read','file_detach','resource_list','resource_read_metadata','resource_read_presentation','resource_read_source','resource_list_files',
  'resource_read_file','resource_read_image','resource_refresh','record_prepare_change','record_apply_change','request_status','prepare_action','read_prepared','prepared_action_commit','prepared_action_restore','prepare_resource_action','read_prepared_resource_action']);
export const AppDataRequestSchema = z.strictObject({schema_version:z.literal('deft.app_data_request.v1'),request_id:id,
  operation:operations,input:z.record(z.string(),z.unknown())}).superRefine((row,ctx) => {
    if (!AppDataOperationInputSchema.safeParse({operation:row.operation,input:row.input}).success)
      ctx.addIssue({code:'custom',message:'Operation input does not match the public contract'});
  });
export type AppDataRequest = z.infer<typeof AppDataRequestSchema>;
const runtimeBase = {schema_version:z.literal('deft.app_data_runtime.v1'),request_id:id,scope:AppConnectionSessionScopeSchema,
  connection:AppDataConnectionSchema,authority:AppDataAuthorityPinsSchema,expires_at:z.iso.datetime()};
export const AppDataRuntimeRequestSchema = z.strictObject({...runtimeBase,operation:operations,input:z.record(z.string(),z.unknown())})
  .superRefine((row,ctx) => {if (['record_prepare_change','record_apply_change'].includes(row.operation)||!AppDataOperationInputSchema.safeParse({operation:row.operation,input:row.input}).success)
    ctx.addIssue({code:'custom',message:'Operation input does not match the public contract'});
    if (Date.parse(row.expires_at)>Date.parse(row.scope.consent_expires_at)) ctx.addIssue({code:'custom',message:'Data request exceeds consent'});});
export type AppDataRuntimeRequest = z.infer<typeof AppDataRuntimeRequestSchema>;
export const AppDataRuntimeAuthorityRequestSchema = z.strictObject({...runtimeBase,schema_version:z.literal('deft.app_data_authority.v1'),
  operation:z.union([operations,z.enum(['run_inspect','run_inspection_status'])]),input_digest:digest}).refine(row=>!['record_prepare_change','record_apply_change'].includes(row.operation));
export const AppDataRuntimeAuthorityResultSchema = AppDataRuntimeAuthorityRequestSchema.safeExtend({allowed:z.literal(true)});
export const AppDataBinaryMetadataSchema = z.strictObject({schema_version:z.literal('deft.app_data_binary.v1'),request_id:id,
  operation:z.enum(['file_read','resource_read_source','resource_read_file','resource_read_image']),input_digest:digest,
  record_id:id,file_id:id.optional(),upload_revision:revision.optional(),size_bytes:z.number().int().min(0).max(APP_DATA_LIMITS.source_bytes),
  sha256:digest,media_type:mediaType,filename});
export const AppDataSourceFileSchema=z.strictObject({file_ref:digest,filename,media_type:mediaType,
  size_bytes:z.number().int().min(0).max(APP_DATA_LIMITS.source_bytes),disposition:z.enum(['attachment','inline']),
  preview:z.enum(['text','image','pdf','unsupported']),content_id:z.string().max(256).optional()});
export type AppDataSourceFile=z.infer<typeof AppDataSourceFileSchema>;
export const AppDataResourceMetaSchema = z.strictObject({record_id:id,content_digest:digest,revision:opaque,label,
  data:z.record(z.string(),z.union([z.string().max(2048),z.number().finite(),z.boolean()])),tombstone:z.boolean(),
  membership_generation:revision,checkpoint_generation:revision});
export const AppDataFreshnessSchema = z.strictObject({observed_at:z.iso.datetime().nullable(),complete:z.boolean(),
  checkpoint_generation:revision,coverage_generation:revision,provider_observed:z.boolean()});
export const AppDataPreparedRecordActionSchema=z.strictObject({schema_version:z.literal('deft.app_prepared_record_action.v1'),
  snapshot_id:id,snapshot_digest:digest,record_id:id,revision,record_content_digest:digest.optional(),action_key:key,
  input:z.record(key,z.union([z.string().max(2048),z.number().finite(),z.boolean()])).refine(row=>Object.keys(row).length<=32&&new TextEncoder().encode(JSON.stringify(row)).length<=8192),preview:value,expires_at:z.iso.datetime(),future_release:AppPreparedFutureReleaseSchema.optional(),copy_effect:AppPreparedCopyEffectSchema.optional(),required_action_consents:z.array(AppConnectionActionConsentSchema).min(1).max(8).refine(rows=>new Set(rows.map(row=>row.action_key)).size===rows.length&&rows.every((row,i)=>i===0||rows[i-1]!.action_key<row.action_key)).optional()})
  .safeExtend({supplemental_effect:AppPreparedEffectSchema.optional()}).refine(row=>{
    const fields=['effect_version','effect_key','effect_plan_digest','effect_content_digest','effect_custody_generation'];
    if(!row.supplemental_effect)return fields.every(field=>!Object.hasOwn(row.input,field));
    if(row.copy_effect)return false;
    const pins=AppPreparedEffectInputSchema.safeParse(Object.fromEntries(fields.map(field=>[field,row.input[field]]))),effect=row.supplemental_effect;
    return pins.success&&pins.data.effect_version===effect.version&&pins.data.effect_key===effect.effect_key
      &&pins.data.effect_plan_digest===effect.plan_digest&&pins.data.effect_content_digest===effect.content_digest&&pins.data.effect_custody_generation===effect.custody_generation&&row.input.account_ref===effect.account_ref;
  },'A supplemental effect requires its exact reviewed input pins').refine(row=>{
    if(row.future_release&&Date.parse(row.expires_at)!==Date.parse(row.future_release.execution_window.dispatch_expires_at))return false;
    const fields=['sent_copy_version','sent_copy_mode','sent_copy_plan_digest'];
    if(row.required_action_consents?.some(consent=>consent.action_key===row.action_key||Date.parse(consent.expires_at)<Date.parse(row.expires_at)))return false;
    if(!row.copy_effect)return fields.every(field=>!Object.hasOwn(row.input,field));
    const pins=AppPreparedCopyEffectInputSchema.safeParse(Object.fromEntries(fields.map(field=>[field,row.input[field]])));
    return pins.success&&pins.data.sent_copy_version===row.copy_effect.schema_version
      &&pins.data.sent_copy_mode===row.copy_effect.mode&&pins.data.sent_copy_plan_digest===row.copy_effect.plan_digest
      &&row.input.account_ref===row.copy_effect.account_ref&&row.input.mime_digest===row.copy_effect.content_digest;
  },'A copy effect requires its exact reviewed input pins');
export type AppDataPreparedRecordAction=z.infer<typeof AppDataPreparedRecordActionSchema>;
/** Bounded provider-independent search diagnostics, not a claim of full mailbox coverage. */
export const AppDataSearchStatusSchema=z.strictObject({status:z.enum(['supported','unsupported']),
  original_query:z.string().max(2048),
  unsupported:z.array(z.strictObject({index:z.number().int().min(0).max(2048).nullable(),field:z.string().max(64).nullable(),reason:z.string().max(256)})).max(32),
  limitations:z.array(z.string().max(256)).max(32),query_complete:z.boolean()})
  .refine(row=>row.status==='supported'?row.unsupported.length===0:!row.query_complete&&row.unsupported.length>0)
  .refine(row=>new TextEncoder().encode(JSON.stringify(row)).byteLength<=16384,'Search diagnostics exceed the metadata byte budget');
export const AppDataResultSchema = z.strictObject({schema_version:z.literal('deft.app_data_result.v1'),request_id:id,
  operation:operations,input_digest:digest,outcome:z.enum(['completed','conflict','not_found','indeterminate']),
  document_policy:z.strictObject({schema_version:z.literal('deft.app_record_document_policy.v1'),field:key,automatic_value:z.string().min(1).max(64)}).optional(),human_save:z.strictObject({request_id:id,store_key:key,record_id:id,revision,content_digest:digest}).optional(),primary_identity:AppDataIdentitySchema.nullable().optional(),record_seed_value:value.optional(),record:AppDataRecordSchema.optional(),prepared_change:AppPreparedRecordChangeSchema.optional(),identities:identities.optional(),items:z.array(z.union([AppDataRecordMetaSchema,AppDataResourceMetaSchema])).max(25).optional(),
  next_cursor:cursor.optional(),resource:AppDataResourceMetaSchema.optional(),files:z.array(AppDataSourceFileSchema).max(32).optional(),
  presentation:z.record(z.string(),z.unknown()).optional(),freshness:AppDataFreshnessSchema.optional(),search:AppDataSearchStatusSchema.optional(),
  request_status:z.strictObject({request_id:id,operation:operations,input_digest:digest,state:z.enum(['completed','indeterminate','not_found']),
    record_id:id.optional(),revision:revision.optional(),content_digest:digest.optional(),prepared_action_receipt:AppPreparedActionLifecycleReceiptSchema.optional()}).optional(),
  prepared_action_receipt:AppPreparedActionLifecycleReceiptSchema.optional(),prepared:AppDataPreparedRecordActionSchema.optional(),prepared_resource:AppDataPreparedResourceActionSchema.optional()})
  .refine(row=>row.operation!=='resource_read_metadata'||Object.keys(row).every(key=>['schema_version','request_id','operation','input_digest','outcome',...(row.outcome==='completed'?['resource']:[])].includes(key))&&(row.outcome!=='completed'||!!row.resource),'Metadata-only reads disclose only exact scalar resource metadata')
  .refine(row=>!row.prepared_action_receipt||(['prepared_action_commit','prepared_action_restore'].includes(row.operation)&&row.prepared_action_receipt.request_id===row.request_id&&row.prepared_action_receipt.phase===(row.operation==='prepared_action_commit'?'commit':'restore')),'Lifecycle receipts require their exact host-only operation')
  .refine(row=>!row.request_status?.prepared_action_receipt||(row.operation==='request_status'&&row.request_status.prepared_action_receipt.request_id===row.request_status.request_id&&['prepared_action_commit','prepared_action_restore'].includes(row.request_status.operation)),'Recovered lifecycle receipts require original request status')
  .refine(row=>!row.document_policy||row.operation==='record_read'&&!!row.record,'Document policy requires a full host-only record read')
  .refine(row=>!row.prepared_change||row.operation==='record_prepare_change','Prepared record changes remain host-only prepare results')
  .refine(row=>!row.prepared_resource||['prepare_resource_action','read_prepared_resource_action'].includes(row.operation))
  .refine(row=>!row.search||row.operation==='resource_list'
    &&(row.search.status!=='unsupported'||row.outcome==='completed'&&row.items?.length===0&&row.next_cursor===null&&!row.freshness),
    'Search diagnostics belong to resource lists; unsupported queries disclose no results or fresh coverage')
  .refine(row=>!row.primary_identity||!!row.identities?.some(identity=>identity.address===row.primary_identity!.address),'Primary identity must be currently verified');
export type AppDataResult = z.infer<typeof AppDataResultSchema>;
export const AppDataConsentSnapshotSchema = z.strictObject({schema_version:z.literal('deft.app_data_consent.v1'),
  consent_id:id,scope:AppConnectionSessionScopeSchema,connection:AppDataConnectionSchema,store:RecordStoreDeclarationSchema,
  data_policy_digest:digest,purpose:z.literal('human_record_write'),expires_at:z.iso.datetime()});
export const AppDataConsentReviewRequestSchema = z.strictObject({store_key:key,expires_at:z.iso.datetime()});
export const AppDataConsentActivateRequestSchema = AppDataConsentReviewRequestSchema.extend({consent_id:id,expected_review_digest:digest,accept_host_policy:z.literal(true)});
export const AppDataConsentReferenceSchema = z.strictObject({consent_id:id,consent_digest:digest,expires_at:z.iso.datetime()});
export const AppDataContextSchema = z.strictObject({schema_version:z.literal('deft.app_data_context.v1'),installation_id:id,
  targets:z.array(z.strictObject({session_id:id,target_key:key,account:z.strictObject({account_ref:opaque,label}),resource_key:key,
    identities:identities,stores:z.array(z.strictObject({declaration:RecordStoreDeclarationSchema,consent:AppDataConsentReferenceSchema.nullable()})).max(16)})).max(32)});
export const DeftExperienceRecordFormProfileSchema = z.strictObject({schema_version:z.literal('deft.record_form_profile.v1'),
  max_record_bytes:z.number().int().min(1).max(APP_DATA_LIMITS.record_bytes),
  addresses:z.array(z.strictObject({field:key,label,optional:z.boolean()})).max(16),
  identity:z.strictObject({field:key,address_field:key,label}).optional(),
  subject:z.strictObject({field:key,label,max_characters:z.number().int().min(1).max(998)}),
  richtext:z.strictObject({html_field:key,plain_field:key,label,max_characters:z.number().int().min(1).max(262144),
    links:z.literal('host_validated'),inline_images:z.enum(['none','host_files'])}),
  files:z.strictObject({field:key,max_files:z.number().int().min(0).max(32),max_file_bytes:z.number().int().min(1).max(APP_DATA_LIMITS.file_bytes),
    max_total_bytes:z.number().int().min(1).max(APP_DATA_LIMITS.total_file_bytes)})}).refine(row=>{
      const fields=[...row.addresses.map(item=>item.field),...(row.identity?[row.identity.field]:[]),row.subject.field,
        row.richtext.html_field,row.richtext.plain_field,row.files.field];
      return new Set(fields).size===fields.length&&row.files.max_file_bytes<=row.files.max_total_bytes;
    },'Edited fields must be distinct and file budgets consistent');
export const DeftExperienceRecordFormNodeSchema = z.strictObject({kind:z.literal('record_form'),id:nodeId,label,store_key:key,
  record_id:id,expected_revision:z.number().int().min(0).max(2147483646),content_digest:digest,seed:z.strictObject({schema_version:z.literal("deft.record_form_seed.v1"),value:value}).optional(),profile:DeftExperienceRecordFormProfileSchema,initial_change:z.strictObject({operation_key:key,source_store_key:key,source_identity_field:key}).optional(),record_changes:AppRecordChangeControlsSchema.optional(),source_refs:AppDataSourceReferencesSchema.optional(),action_key:key.optional(),presentation:z.enum(['normal','minimized']).optional(),disabled:z.boolean().optional()}).refine(node=>node.seed?node.expected_revision===0&&node.content_digest==='sha256:'+'0'.repeat(64)&&!node.source_refs?.length:node.expected_revision>=1,'Revision zero requires explicit unsaved seed').refine(node=>!node.initial_change||node.initial_change.source_store_key!==node.store_key,'Initial changes require a distinct source store');
export type DeftExperienceRecordFormNode = z.infer<typeof DeftExperienceRecordFormNodeSchema>;
/** V2 settings fields are lazy host controls, not author-owned record values. */
const scalarLabel=z.string().min(1).max(160).regex(/^[^\u0000-\u001f\u007f<>]+$/u);
export const DeftExperienceRecordScalarFieldSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('text'),field:key,label:scalarLabel,max_characters:z.number().int().min(1).max(2048),required:z.boolean()}),
 z.strictObject({kind:z.literal('boolean'),field:key,label:scalarLabel}),
 z.strictObject({kind:z.literal('choice'),field:key,label:scalarLabel,activation:z.strictObject({field:key,schema_version:z.string().min(1).max(96).regex(/^deft\.[a-z0-9_]+\.v[1-9][0-9]*$/u),inactive_value:key}).optional(),options:z.array(z.strictObject({value:key,label:scalarLabel})).min(1).max(16)
  .refine(options=>new Set(options.map(option=>option.value)).size===options.length)}),
 z.strictObject({kind:z.literal('verified_identity'),field:key,label:scalarLabel,editable:z.literal(false)}),
]);
const repeatedChoiceOptions=z.array(z.strictObject({value:key,label:scalarLabel})).min(1).max(16).refine(options=>new Set(options.map(option=>option.value)).size===options.length);
const repeatedScalar=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('text'),field:key,label:scalarLabel,max_characters:z.number().int().min(1).max(2048),required:z.boolean()}),
 z.strictObject({kind:z.literal('boolean'),field:key,label:scalarLabel}),
 z.strictObject({kind:z.literal('choice'),field:key,label:scalarLabel,options:repeatedChoiceOptions}),
]);
export const DeftExperienceRepeatedFieldsSchema=z.strictObject({schema_version:z.literal('deft.repeated_fields.v1'),field:key,label:scalarLabel,
 min_rows:z.number().int().min(0).max(10),max_rows:z.number().int().min(1).max(10),
 row:z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('object'),fields:z.array(repeatedScalar).min(1).max(8).refine(fields=>new Set(fields.map(field=>field.field)).size===fields.length)}),
  z.strictObject({kind:z.literal('choice'),options:repeatedChoiceOptions,unique:z.boolean()}),
 ])}).refine(group=>group.min_rows<=group.max_rows&&!(group.row.kind==='choice'&&group.row.unique&&group.min_rows>group.row.options.length));
export const DeftExperienceRecordFormV2ProfileSchema=z.strictObject({schema_version:z.literal('deft.record_form_profile.v2'),
 max_record_bytes:z.number().int().min(1).max(APP_DATA_LIMITS.record_bytes),fields:z.array(DeftExperienceRecordScalarFieldSchema).max(16),repeated_fields:z.array(DeftExperienceRepeatedFieldsSchema).min(1).max(4).optional(),
 richtext:z.strictObject({html_field:key,plain_field:key,label:scalarLabel,max_html_characters:z.number().int().min(1).max(262144),
  max_plain_characters:z.number().int().min(1).max(262144),links:z.literal('host_validated'),inline_images:z.literal('none')}).optional()
}).refine(profile=>{const fields=[...(profile.repeated_fields??[]).map(group=>group.field),...profile.fields.map(field=>field.field),...profile.fields.flatMap(field=>field.kind==='choice'&&field.activation?[field.activation.field]:[]),...(profile.richtext?[profile.richtext.html_field,profile.richtext.plain_field]:[])];
 return fields.length>0&&new Set(fields).size===fields.length&&profile.fields.every(field=>field.kind!=='choice'||!field.activation||field.options.some(option=>option.value===field.activation!.inactive_value));},'Edited fields must be distinct');
export const DeftExperienceRecordFormV2NodeSchema=z.strictObject({kind:z.literal('record_form'),id:nodeId,label,store_key:key,
 record_id:id,expected_revision:revision,content_digest:digest,profile:DeftExperienceRecordFormV2ProfileSchema,disabled:z.boolean().optional()});
export type DeftExperienceRecordFormV2Node=z.infer<typeof DeftExperienceRecordFormV2NodeSchema>;
export type DeftExperienceRecordFormV2Profile=z.infer<typeof DeftExperienceRecordFormV2ProfileSchema>;

/** Declared controls, never field-name conventions or provider validation. */
export const DeftExperienceRecordFormV3FieldSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('text'),field:key,label:scalarLabel,max_characters:z.number().int().min(1).max(16384),required:z.boolean(),
  format:z.enum(['plain','mailbox_list']).optional(),presentation:z.enum(['normal','pills']).optional(),optional:z.boolean().optional()}),
 DeftExperienceRecordScalarFieldSchema.options[1],DeftExperienceRecordScalarFieldSchema.options[2],
 z.strictObject({kind:z.literal('verified_identity'),field:key,label:scalarLabel,editable:z.literal(false),identity_field:key.optional()}),
]).refine(field=>field.kind!=='text'||(field.presentation!=='pills'||field.format==='mailbox_list')&&!(field.optional&&field.required),'Control presentation must match its declared format');
export const DeftExperienceRecordFormV3ProfileSchema=z.strictObject({schema_version:z.literal('deft.record_form_profile.v3'),
 max_record_bytes:z.number().int().min(1).max(APP_DATA_LIMITS.record_bytes),fields:z.array(DeftExperienceRecordFormV3FieldSchema).min(1).max(16),
 richtext:DeftExperienceRecordFormProfileSchema.shape.richtext.optional(),files:DeftExperienceRecordFormProfileSchema.shape.files.extend({archive_name_field:key.optional()}).optional(),
 labels:z.strictObject({save:scalarLabel.optional(),review:scalarLabel.optional(),submitted:scalarLabel.optional(),readonly:scalarLabel.optional(),scheduled:scalarLabel.optional(),initial_change_unavailable:scalarLabel.optional()}).optional(),
 review:z.strictObject({title:scalarLabel,confirm_label:scalarLabel,description:z.string().max(500).optional(),
  supplemental_effect:z.strictObject({label:scalarLabel,fields:z.array(z.strictObject({field:key,label:scalarLabel})).min(1).max(16).refine(fields=>new Set(fields.map(field=>field.field)).size===fields.length)}).optional()}).optional(),
}).refine(profile=>{const fields=[...profile.fields.map(field=>field.field),...profile.fields.flatMap(field=>field.kind==='choice'&&field.activation?[field.activation.field]:[]),
 ...(profile.richtext?[profile.richtext.html_field,profile.richtext.plain_field]:[]),...(profile.files?[profile.files.field]:[])];
 return new Set(fields).size===fields.length&&(!profile.files||profile.files.max_file_bytes<=profile.files.max_total_bytes)
  &&profile.fields.every(field=>field.kind!=='choice'||!field.activation||field.options.some(option=>option.value===field.activation!.inactive_value));
},'Edited fields must be distinct and file budgets consistent');
export const DeftExperienceRecordFormV3NodeSchema=z.strictObject({...DeftExperienceRecordFormNodeSchema.shape,profile:DeftExperienceRecordFormV3ProfileSchema})
 .refine(node=>node.seed?node.expected_revision===0&&node.content_digest==='sha256:'+'0'.repeat(64)&&!node.source_refs?.length:node.expected_revision>=1,'Revision zero requires explicit unsaved seed')
 .refine(node=>!node.initial_change||node.initial_change.source_store_key!==node.store_key,'Initial changes require a distinct source store');
export type DeftExperienceRecordFormV3Node=z.infer<typeof DeftExperienceRecordFormV3NodeSchema>;
export type DeftExperienceRecordFormV3Profile=z.infer<typeof DeftExperienceRecordFormV3ProfileSchema>;

export const DeftExperienceRecordDocumentNodeSchema = z.strictObject({kind:z.literal('record_document'),id:nodeId,
  profile_version:z.literal('deft.record_document.v1'),store_key:key,resource_key:key,record_id:id,content_digest:digest,
  image_policy:z.strictObject({store_key:key,record_id:id,expected_revision:revision,content_digest:digest,field:key,automatic_value:z.string().min(1).max(64)}).optional(),printable:z.boolean().optional(),print_control_id:nodeId.optional()}).refine(row=>row.print_control_id===undefined||row.printable===true);
export type DeftExperienceRecordDocumentNode = z.infer<typeof DeftExperienceRecordDocumentNodeSchema>;

export function frameAppData(header: unknown, bytes: Uint8Array): Uint8Array {
  const encoded = new TextEncoder().encode(JSON.stringify(header));
  if (encoded.byteLength > APP_DATA_LIMITS.frame_header_bytes || bytes.byteLength > APP_DATA_LIMITS.source_bytes) throw new TypeError('App data frame exceeds its budget');
  const result = new Uint8Array(4 + encoded.byteLength + bytes.byteLength);
  new DataView(result.buffer).setUint32(0,encoded.byteLength,false);result.set(encoded,4);result.set(bytes,4+encoded.byteLength);return result;
}
export function parseAppDataFrame(bytes:Uint8Array):{header:unknown;bytes:Uint8Array} {
  if (bytes.byteLength < 4 || bytes.byteLength > 4 + APP_DATA_LIMITS.frame_header_bytes + APP_DATA_LIMITS.source_bytes) throw new TypeError('Invalid app data frame');
  const size = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0,false);
  if (size<1||size>APP_DATA_LIMITS.frame_header_bytes||size+4>bytes.byteLength) throw new TypeError('Invalid app data frame header');
  return {header:JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes.subarray(4,4+size))),bytes:bytes.subarray(4+size)};
}
