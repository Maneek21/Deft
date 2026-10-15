import { AppConsentLifetimeSchema, AppConsentExpirySchema, appConsentDeadline, appConsentExpiryValid } from './consent-lifetime.js';
import {z} from 'zod';
import {AppConnectionSessionScopeSchema} from './connection-session.js';
import {canonicalAppDataJson} from './app-data-json.js';
const key=z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u).refine(value=>!['constructor','prototype','__proto__'].includes(value));
const id=z.string().uuid(),digest=z.string().regex(/^sha256:[a-f0-9]{64}$/u),revision=z.number().int().min(1).max(2147483646);
const label=z.string().min(1).max(160).regex(/^[^\u0000-\u001f\u007f<>]+$/u);
export const AppRecordChangeDeclarationsSchema=z.array(z.strictObject({key,source_store_key:key})).min(1).max(8)
 .refine(rows=>rows.every((row,index)=>!index||rows[index-1]!.key<row.key),'Change declarations must be sorted and unique');
export const AppRecordChangeControlsSchema=z.array(z.strictObject({operation_key:key,source_store_key:key,label,parameters:z.literal('runtime_prompt').optional()})).min(1).max(8)
 .refine(rows=>new Set(rows.map(row=>row.operation_key)).size===rows.length,'Change controls must be unique');
const wellFormed=(value:string)=>{for(const character of value){const code=character.codePointAt(0)!;if(code>=0xd800&&code<=0xdfff)return false;}return true;};
const parameterKey=z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u).refine(value=>!['constructor','prototype','__proto__'].includes(value));
export const AppRecordChangeParametersSchema=z.record(parameterKey,z.string().max(8192).refine(value=>wellFormed(value)&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)&&!value.includes('{{')&&!value.includes('}}')))
 .refine(values=>{try{return Object.keys(values).length<=64&&new TextEncoder().encode(canonicalAppDataJson(values)).length<=65536;}catch{return false;}},'Parameter values exceed their limits');
export const AppRecordChangeParameterFieldsSchema=z.array(z.strictObject({key:parameterKey,label:z.string().min(1).max(160).regex(/^[^\u0000-\u001f\u007f<>]+$/u),max_characters:z.number().int().min(1).max(8192)})).max(64)
 .refine(rows=>rows.every((row,index)=>!index||rows[index-1]!.key<row.key),'Parameter fields must be unique and sorted');
export const AppRecordChangeReferenceSchema=z.strictObject({store_key:key,record_id:id,expected_revision:revision,expected_content_digest:digest});
export const AppRecordPrepareChangeInputSchema=AppRecordChangeReferenceSchema.extend({operation_key:key,source:AppRecordChangeReferenceSchema,invocation_mode:z.literal('initial').optional(),parameters:AppRecordChangeParametersSchema.optional()})
 .refine(input=>input.store_key!==input.source.store_key,'Changes must name distinct source and destination stores')
 .refine(input=>input.invocation_mode===undefined||input.parameters===undefined,'Initial changes cannot receive manual parameter values');
export const AppRecordApplyChangeInputSchema=AppRecordChangeReferenceSchema.extend({operation_key:key,source:AppRecordChangeReferenceSchema,prepared_id:id,prepared_digest:digest,invocation_mode:z.literal('initial').optional(),parameters:AppRecordChangeParametersSchema.optional()})
 .refine(input=>input.store_key!==input.source.store_key,'Changes must name distinct source and destination stores')
 .refine(input=>input.invocation_mode===undefined||input.parameters===undefined,'Initial changes cannot receive manual parameter values');
const proofFields={store_key:key,consent_id:id,consent_digest:digest,data_policy_digest:digest,consent_expires_at:AppConsentExpirySchema,consent_lifetime:AppConsentLifetimeSchema.optional()};
export const AppRecordChangeAuthoritiesSchema=z.tuple([
 z.strictObject({role:z.literal('destination'),...proofFields}).refine(v=>appConsentExpiryValid(v.consent_expires_at,v.consent_lifetime)),z.strictObject({role:z.literal('source'),...proofFields}).refine(v=>appConsentExpiryValid(v.consent_expires_at,v.consent_lifetime))
]).refine(([a,b])=>a.store_key!==b.store_key);
const connection=z.strictObject({session_id:id,session_revision:revision,runtime_session_ref:z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u),account_ref:z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u)});
const runtime={request_id:id,scope:AppConnectionSessionScopeSchema,connection,record_authorities:AppRecordChangeAuthoritiesSchema,expires_at:z.iso.datetime()};
export const AppRecordChangeRuntimeRequestSchema=z.discriminatedUnion('operation',[
 z.strictObject({schema_version:z.literal('deft.app_data_runtime.v2'),...runtime,operation:z.literal('record_prepare_change'),input:AppRecordPrepareChangeInputSchema}),
 z.strictObject({schema_version:z.literal('deft.app_data_runtime.v2'),...runtime,operation:z.literal('record_apply_change'),input:AppRecordApplyChangeInputSchema})
]).refine(input=>input.record_authorities[0].store_key===input.input.store_key&&input.record_authorities[1].store_key===input.input.source.store_key)
 .refine(input=>Date.parse(input.expires_at)<=Math.min(appConsentDeadline(input.scope.consent_expires_at, input.scope.consent_lifetime),...input.record_authorities.map(proof=>appConsentDeadline(proof.consent_expires_at, proof.consent_lifetime))));
export const AppRecordChangeAuthorityRequestSchema=z.strictObject({schema_version:z.literal('deft.app_data_authority.v2'),...runtime,
 operation:z.enum(['record_prepare_change','record_apply_change']),input_digest:digest})
 .refine(input=>Date.parse(input.expires_at)<=Math.min(appConsentDeadline(input.scope.consent_expires_at, input.scope.consent_lifetime),...input.record_authorities.map(proof=>appConsentDeadline(proof.consent_expires_at, proof.consent_lifetime))));
export const AppRecordChangeAuthorityResultSchema=AppRecordChangeAuthorityRequestSchema.safeExtend({allowed:z.literal(true)});
const boundedValue=z.record(z.string(),z.unknown()).refine(value=>{try{return new TextEncoder().encode(canonicalAppDataJson(value)).length<=491520;}catch{return false;}});
const preparedFields={prepared_id:id,prepared_digest:digest,
 operation_key:key,invocation_mode:z.literal('initial').optional(),account_ref:z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u),destination:AppRecordChangeReferenceSchema,source:AppRecordChangeReferenceSchema,
 authorization_digest:digest,value:boundedValue,preview:z.strictObject({title:z.string().min(1).max(512),description:z.string().max(2048),warnings:z.array(z.string().min(1).max(512)).max(8)}),expires_at:z.iso.datetime()};
export const AppPreparedRecordChangeV1Schema=z.strictObject({schema_version:z.literal('deft.app_prepared_record_change.v1'),...preparedFields});
export const AppPreparedRecordChangeV2Schema=z.strictObject({schema_version:z.literal('deft.app_prepared_record_change.v2'),...preparedFields,parameters:AppRecordChangeParametersSchema,parameter_fields:AppRecordChangeParameterFieldsSchema})
 .refine(value=>value.invocation_mode===undefined&&Object.keys(value.parameters).every(key=>value.parameter_fields.some(field=>field.key===key&&value.parameters[key]!.length<=field.max_characters)),'Parameters must name current source fields');
export const AppPreparedRecordChangeSchema=z.union([AppPreparedRecordChangeV1Schema,AppPreparedRecordChangeV2Schema])
 .refine(value=>value.destination.store_key!==value.source.store_key);
export type AppRecordChangeRuntimeRequest=z.infer<typeof AppRecordChangeRuntimeRequestSchema>;
export type AppRecordChangeAuthorityRequest=z.infer<typeof AppRecordChangeAuthorityRequestSchema>;
export type AppPreparedRecordChange=z.infer<typeof AppPreparedRecordChangeSchema>;
export type AppRecordChangeReference=z.infer<typeof AppRecordChangeReferenceSchema>;
export type AppRecordPrepareChangeInput=z.infer<typeof AppRecordPrepareChangeInputSchema>;
export type AppRecordApplyChangeInput=z.infer<typeof AppRecordApplyChangeInputSchema>;
