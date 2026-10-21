import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {canonicalAppDataJson,AppDataOperationInputSchema,AppDataPreparedRecordActionSchema,AppDataPreparedResourceActionSchema} from '@deft/app-kit/core';
import {AppIntegrationToolDeclarationSchema,AppIntegrationToolRuntimeRequestSchema,AppIntegrationToolRuntimeAuthorityRequestSchema} from '../../../../packages/app-kit/src/app-integration-tools.js';
export const integrationDigest=(value:unknown)=>'sha256:'+createHash('sha256').update(canonicalAppDataJson(value)).digest('hex');
const digest=z.string().regex(/^sha256:[a-f0-9]{64}$/u),id=z.uuid(),key=z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u);
export const IntegrationCallerSchema=z.strictObject({org_id:id,user_id:id,kind:z.enum(['defty','personal_mcp']),principal_id:id,
 access_expires_at:z.number().finite(),authorization_version:z.number().int().positive().optional(),conversation_id:id.optional(),employee_id:id.optional()});
export const IntegrationPreparedLocatorSchema=z.strictObject({kind:z.enum(['record','resource']),snapshot_id:id,snapshot_digest:digest,
 action_key:key,input_digest:digest,record_id:id.optional(),revision:z.number().int().positive().optional(),expires_at:z.iso.datetime()})
 .refine(v=>v.kind==='record'?!!v.record_id&&!!v.revision:v.record_id===undefined&&v.revision===undefined);
export type IntegrationPreparedLocator=z.infer<typeof IntegrationPreparedLocatorSchema>;
const envelope=z.strictObject(AppIntegrationToolRuntimeRequestSchema.shape).omit({schema_version:true,input:true});
export const IntegrationToolMetadataSchema=z.strictObject({kind:z.literal('tool'),caller:IntegrationCallerSchema,
 target:z.strictObject({installation_id:id,account_ref:z.string().min(1).max(512),resource_binding_id:id,store_key:key}),
 envelope,input_digest:digest,declaration_digest:digest,
 // Values are hashes even for draft fields. No body, preview or token enters SQL.
 field_digests:z.record(key,digest).refine(v=>Object.keys(v).length<=32),
 grant:z.strictObject({id,revision:z.number().int().positive(),digest}),authority_identity:z.string().min(1).max(32768),
 authority_expires_at:z.number().finite()});
export type IntegrationToolMetadata=z.infer<typeof IntegrationToolMetadataSchema>;
export type IntegrationToolJournalRow=Readonly<{metadata:IntegrationToolMetadata,state:'inflight'|'completed'|'indeterminate',prepared:IntegrationPreparedLocator|null,
 run_id:string|null,run_input_digest:string|null,runtime_binding_id:string|null}>;
export function toolMetadata(raw:unknown,declaration:unknown,authority:Pick<IntegrationToolMetadata,'caller'|'target'|'grant'|'authority_identity'|'authority_expires_at'>){
 const request=AppIntegrationToolRuntimeRequestSchema.parse(raw),declared=AppIntegrationToolDeclarationSchema.parse(declaration);
 const {schema_version,input,...pins}=request;
 return IntegrationToolMetadataSchema.parse({...authority,kind:'tool',envelope:pins,input_digest:integrationDigest(input),declaration_digest:integrationDigest(declared),
  field_digests:Object.fromEntries(Object.entries(input).map(([field,value])=>[field,integrationDigest(value)]))});
}
export function assertToolCallback(metadata:IntegrationToolMetadata,declaration:unknown,raw:unknown){
 const declared=AppIntegrationToolDeclarationSchema.parse(declaration),check=AppIntegrationToolRuntimeAuthorityRequestSchema.parse(raw);
 const {schema_version,input_digest,inner,...pins}=check;
 const deny=()=>{throw Error('APP_INTEGRATION_TOOL_INNER_DENIED');};
 if(!isDeepStrictEqual(pins,metadata.envelope)||input_digest!==metadata.input_digest||integrationDigest(declared)!==metadata.declaration_digest
  ||declared.key!==pins.tool_key||declared.operation!==pins.tool_operation||declared.store_key!==pins.store_key||!inner
  ||!declared.data_operations.includes(inner.operation)||inner.store_key!==pins.store_key)deny();
 if(!inner)return check;
 if(!AppDataOperationInputSchema.safeParse({operation:inner.operation,input:inner.input}).success||inner.input.store_key!==pins.store_key
  ||inner.input_digest!==integrationDigest({operation:inner.operation,input:inner.input}))deny();
 const mapped=declared.input_pins.filter(pin=>pin.operation===inner.operation);
 for(const pin of mapped){const expected=metadata.field_digests[pin.outer_key];
  if(expected===undefined){if(pin.required||inner.input[pin.inner_field]!==pins.request_id)deny();}
  else if(inner.input[pin.inner_field]===undefined||integrationDigest(inner.input[pin.inner_field])!==expected)deny();}
 for(const field of ['record_id','expected_revision','value','operation_key'] as const)
  if(Object.hasOwn(inner.input,field)&&!(inner.operation==='resource_read_presentation'&&field==='record_id')&&!mapped.some(pin=>pin.inner_field===field))deny();
 if(['prepare_action','prepare_resource_action'].includes(inner.operation)?inner.action_key!==declared.action_key||inner.input.action_key!==declared.action_key:inner.action_key!==undefined)deny();
 if(Object.hasOwn(inner.input,'resource_key')&&inner.input.resource_key!==pins.scope.resource_key)deny();
 if(inner.operation==='resource_read_presentation'&&!pins.source_refs.some(ref=>ref.record_id===inner.input.record_id&&ref.content_digest===inner.input.content_digest&&ref.resource_key===inner.input.resource_key))deny();
 if(inner.operation==='resource_list'&&Object.hasOwn(inner.input,'anchor_record_id')&&(pins.source_refs.length!==1||inner.input.anchor_record_id!==pins.source_refs[0]?.record_id))deny();
 if(inner.operation==='prepare_resource_action'&&!isDeepStrictEqual(inner.input.sources,pins.source_refs))deny();
 if(Object.hasOwn(inner.input,'prepare_expires_at')&&(typeof inner.input.prepare_expires_at!=='string'||inner.input.prepare_expires_at!==pins.prepare_expires_at||Date.parse(inner.input.prepare_expires_at)>metadata.authority_expires_at))deny();
 return check;
}
export function preparedLocator(result:unknown):IntegrationPreparedLocator{
 const record=AppDataPreparedRecordActionSchema.safeParse(result);
 if(record.success){const p=record.data;if(p.future_release)throw Error('APP_INTEGRATION_FUTURE_UNAVAILABLE');
  return IntegrationPreparedLocatorSchema.parse({kind:'record',snapshot_id:p.snapshot_id,snapshot_digest:p.snapshot_digest,action_key:p.action_key,input_digest:integrationDigest(p.input),record_id:p.record_id,revision:p.revision,expires_at:p.expires_at});}
 const p=AppDataPreparedResourceActionSchema.parse(result);
 return IntegrationPreparedLocatorSchema.parse({kind:'resource',snapshot_id:p.snapshot_id,snapshot_digest:p.snapshot_digest,action_key:p.action_key,input_digest:integrationDigest(p.input),expires_at:p.expires_at});
}
