import { appConsentDeadline} from './consent-lifetime.js';
import {z} from 'zod';
import {canonicalAppDataJson,AppDataConnectionSchema,AppDataAuthorityPinsSchema,AppDataResultSchema,AppDataSourceReferenceSchema} from './app-data.js';
import {AppConnectionSessionScopeSchema} from './connection-session.js';
const key=z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u).refine(v=>!['constructor','prototype','__proto__'].includes(v));
const boundedObject=z.record(z.string(),z.unknown()).refine(v=>{try{return new TextEncoder().encode(canonicalAppDataJson(v)).byteLength<=512*1024;}catch{return false;}});
export const APP_INTEGRATION_TOOL_OPERATIONS=['read','draft','triage','send'] as const;
export type AppIntegrationToolOperation=typeof APP_INTEGRATION_TOOL_OPERATIONS[number];
export const APP_INTEGRATION_TOOL_DATA_OPERATIONS=['resource_list','resource_read_presentation','record_read','record_create','record_save','prepare_action','prepare_resource_action'] as const;
export const AppIntegrationToolInputPinSchema=z.strictObject({operation:z.enum(APP_INTEGRATION_TOOL_DATA_OPERATIONS),outer_key:key,
 inner_field:z.enum(['record_id','expected_revision','value','query','operation_key']),required:z.boolean()});
/** App-owned names/schema. Declaration advertises capability, never permission. */
export const AppIntegrationToolDeclarationSchema=z.strictObject({key,description:z.string().min(1).max(4096),
 operation:z.enum(APP_INTEGRATION_TOOL_OPERATIONS),mode:z.enum(['catalog','data','review','status']),
 store_key:key,resource_key:key,runtime_requirement_key:key,input_schema:boundedObject,account_input_key:key.optional(),source_input_key:key.optional(),
 status_tool_key:key.optional(),status_input_pins:z.record(key,key).optional(),
 data_operations:z.array(z.enum(APP_INTEGRATION_TOOL_DATA_OPERATIONS)).max(4),input_pins:z.array(AppIntegrationToolInputPinSchema).max(12),action_key:key.optional(),visibility:z.enum(['delegated_tools','human_only'])}).superRefine((row,ctx)=>{
 const effects=row.data_operations.some(op=>op==='prepare_action'||op==='prepare_resource_action');
 const fields:Record<string,readonly string[]>={record_id:['record_read','record_create','record_save','prepare_action'],expected_revision:['record_save','prepare_action'],value:['record_create','record_save'],query:['resource_list'],operation_key:['prepare_resource_action']};
 const properties=row.input_schema.properties;
 const hasProperty=(name:string|undefined)=>!!name&&!!properties&&typeof properties==='object'&&Object.hasOwn(properties,name);
 if(row.input_schema.type!=='object'||row.input_schema.additionalProperties!==false||row.mode!=='catalog'&&!hasProperty(row.account_input_key)
  ||row.source_input_key&&!hasProperty(row.source_input_key)||row.mode==='catalog'&&(row.account_input_key||row.source_input_key||row.data_operations.length||row.operation!=='read')
  ||row.mode==='status'&&(!row.status_tool_key||!row.status_input_pins||!Object.keys(row.status_input_pins).length||Object.keys(row.status_input_pins).some(k=>!hasProperty(k))||row.data_operations.length>0))ctx.addIssue({code:'custom',message:'Invalid signed tool selector'});
 if(row.mode!=='status'&&(row.status_tool_key||row.status_input_pins)||row.mode!=='review'&&row.action_key)ctx.addIssue({code:'custom',message:'Invalid signed tool mode'});
 if(row.input_pins.some(pin=>!fields[pin.inner_field]?.includes(pin.operation)||!properties||typeof properties!=='object'||!Object.hasOwn(properties,pin.outer_key)))ctx.addIssue({code:'custom',message:'Invalid signed input pin'});
 if(new Set(row.data_operations).size!==row.data_operations.length||new Set(row.input_pins.map(pin=>pin.operation+':'+pin.inner_field)).size!==row.input_pins.length
  ||row.input_pins.some(pin=>!row.data_operations.includes(pin.operation)||!pin.required&&pin.inner_field!=='record_id')||effects!==(row.mode==='review')||effects&&!row.action_key
  ||row.operation==='read'&&row.data_operations.some(op=>!['resource_list','resource_read_presentation','record_read'].includes(op)))ctx.addIssue({code:'custom',message:'Invalid tool data operation declaration'});
});
export type AppIntegrationToolDeclaration=z.infer<typeof AppIntegrationToolDeclarationSchema>;
export function parseAppIntegrationToolDeclaredInput(declaration:AppIntegrationToolDeclaration,input:unknown){
 const parsed=z.fromJSONSchema(declaration.input_schema).parse(input);
 if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('APP_INTEGRATION_TOOL_INPUT_INVALID');
 return parsed as Record<string,unknown>;
}
export const AppIntegrationToolsDeclarationSchema=z.array(AppIntegrationToolDeclarationSchema).min(1).max(32)
 .refine(rows=>new Set(rows.map(row=>row.key)).size===rows.length)
 .refine(rows=>rows.every(row=>row.mode!=='status'||rows.some(original=>original.key===row.status_tool_key&&original.mode==='review'&&original.operation===row.operation&&original.store_key===row.store_key&&original.resource_key===row.resource_key&&Object.values(row.status_input_pins??{}).every(key=>Object.hasOwn(original.input_schema.properties as object,key)))));
export const AppIntegrationToolRequestSchema=z.strictObject({schema_version:z.literal('deft.app_integration_tool.v1'),
 installation_id:z.uuid(),request_id:z.uuid(),tool_key:key,input:boundedObject});
export type AppIntegrationToolRequest=z.infer<typeof AppIntegrationToolRequestSchema>;
const digest=z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const envelope={request_id:z.uuid(),scope:AppConnectionSessionScopeSchema,connection:AppDataConnectionSchema,authority:AppDataAuthorityPinsSchema,
 tool_key:key,tool_operation:z.enum(APP_INTEGRATION_TOOL_OPERATIONS),store_key:key,expires_at:z.iso.datetime(),prepare_expires_at:z.iso.datetime().optional(),
 source_refs:z.array(AppDataSourceReferenceSchema).max(25)};
export const AppIntegrationToolRuntimeRequestSchema=z.strictObject({schema_version:z.literal('deft.app_integration_tool_runtime.v1'),...envelope,input:boundedObject})
 .refine(row=>Date.parse(row.expires_at)<=appConsentDeadline(row.scope.consent_expires_at, row.scope.consent_lifetime)
  &&row.source_refs.every(ref=>ref.resource_key===row.scope.resource_key)
  &&new Set(row.source_refs.map(ref=>ref.record_id)).size===row.source_refs.length
  &&(row.tool_operation==='triage'||row.source_refs.length<=1));
export type AppIntegrationToolRuntimeRequest=z.infer<typeof AppIntegrationToolRuntimeRequestSchema>;
export const AppIntegrationToolRuntimeAuthorityRequestSchema=z.strictObject({schema_version:z.literal('deft.app_integration_tool_authority.v1'),...envelope,input_digest:digest,
 inner:z.strictObject({operation:z.enum(APP_INTEGRATION_TOOL_DATA_OPERATIONS),store_key:key,input_digest:digest,input:boundedObject,action_key:key.optional()}).nullable()});
export const AppIntegrationToolRuntimeAuthorityResultSchema=AppIntegrationToolRuntimeAuthorityRequestSchema.safeExtend({allowed:z.literal(true)});
export const AppIntegrationToolRuntimeResultSchema=z.strictObject({schema_version:z.literal('deft.app_integration_tool_result.v1'),request_id:z.uuid(),
 tool_key:key,tool_operation:z.enum(APP_INTEGRATION_TOOL_OPERATIONS),store_key:key,input_digest:digest,outcome:z.enum(['completed','denied','indeterminate']),data_result:AppDataResultSchema.optional(),value:boundedObject.optional()})
 .refine(row=>new TextEncoder().encode(canonicalAppDataJson(row)).byteLength<=512*1024&&(row.outcome!=='completed'||Number(!!row.data_result)+Number(!!row.value)===1));
export type AppIntegrationToolRuntimeResult=z.infer<typeof AppIntegrationToolRuntimeResultSchema>;
/** Owner review creates independent read/draft/triage/send delegation only. */
export const AppIntegrationToolGrantInputSchema=z.strictObject({installation_id:z.uuid(),account_ref:z.string().min(1).max(512),
 resource_binding_id:z.uuid(),store_key:key,principal_kind:z.enum(['defty','personal_mcp']),principal_id:z.uuid(),
 operations:z.array(z.enum(APP_INTEGRATION_TOOL_OPERATIONS)).min(1).max(4),expires_at:z.iso.datetime(),expected_revision:z.number().int().nonnegative()})
 .refine(row=>new Set(row.operations).size===row.operations.length);
export type AppIntegrationToolGrantInput=z.infer<typeof AppIntegrationToolGrantInputSchema>;
