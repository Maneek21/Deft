import {createHash} from 'node:crypto';
import {z} from 'zod';
import {canonicalCapabilityJson} from '@deft/shared';
import type {EmailActor} from './email-mailbox-service.js';

const id=z.string().min(1).max(256).refine(v=>v===v.trim()&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v));
export const NativeEmailConnectionCapabilitiesSchema=z.array(z.enum(['read','modify','send'])).min(1).max(3).refine(v=>v.includes('read')&&new Set(v).size===v.length);
export const NativeEmailConnectionBeginSchema=z.strictObject({request_id:z.uuid(),provider:z.enum(['gmail','microsoft']),capabilities:NativeEmailConnectionCapabilitiesSchema,account_id:id.optional()});
export const NativeEmailConnectionCallbackSchema=z.union([
 z.strictObject({state:z.string().regex(/^[A-Za-z0-9_-]{43}$/u),code:z.string().min(1).max(4096).refine(v=>!/[\r\n\0]/u.test(v))}),
 z.strictObject({state:z.string().regex(/^[A-Za-z0-9_-]{43}$/u),error:z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.-]+$/u)}),
]);
export type NativeEmailConnectionBegin=z.infer<typeof NativeEmailConnectionBeginSchema>;
export type NativeEmailConnectionCallback=z.infer<typeof NativeEmailConnectionCallbackSchema>;
export type NativeEmailConnectionScope=Readonly<{org_id:string;owner_user_id:string}>;
export type NativeEmailConnectionOwner=Readonly<{scope:NativeEmailConnectionScope;session_id:string;authority_version:string;expires_at:number}>;
/** All fields are selected by the trusted host. Namespace IDs are custody
 * identifiers, not synthetic App installations or authorization grants. */
export type NativeEmailConnectionBinding=Readonly<{
 scope:NativeEmailConnectionScope;account_id:string;provider:'gmail'|'microsoft';
 source:'retained_registry_v1'|'native_owner_provider_v1';profile_id:string;profile_revision:number;module_sha256:string;
 credential_namespace_id:string;credential_binding_id:string;credential_action_id:string|null;connection_target:string;
 authority_epoch:number;capabilities:readonly ('read'|'modify'|'send')[];expected_principal_digest:string|null;
 expected_native_revision:number|null;
}>;
export type NativeEmailConnectionState='preparing'|'pending'|'exchanging'|'connected'|'failed'|'unknown'|'expired';
export type NativeEmailConnectionResult=Readonly<{account_id:string;provider:'gmail'|'microsoft';capabilities:readonly ('read'|'modify'|'send')[];primary_address:string;display_label:string;native_revision:number}>;
export type NativeEmailConnectionStatus=Readonly<{
 schema_version:'deft.email_connection.v1';request_id:string;provider:'gmail'|'microsoft';state:NativeEmailConnectionState;
 expires_at:string;account_id:string|null;capabilities:readonly ('read'|'modify'|'send')[];
 authorization_url?:string;primary_address?:string;display_label?:string;
 error?:'provider_denied'|'connection_failed'|'connection_unknown';
}>;
export type NativeEmailConnectionRecord=Readonly<{
 scope:NativeEmailConnectionScope;request_id:string;request_digest:string;session_id:string;owner_authority_version:string;
 state:NativeEmailConnectionState;revision:number;expires_at:number;binding:NativeEmailConnectionBinding;
 authorization_url?:string;state_digest?:string;result?:NativeEmailConnectionResult;
 error?:NativeEmailConnectionStatus['error'];
}>;
/** Verified metadata only; provider subjects and tokens never cross this port. */
export type NativeEmailConnectionVerified=Readonly<{account_id:string;provider:'gmail'|'microsoft';principal_digest:string;credential_revision:number;authority_epoch:number;capabilities:readonly ('read'|'modify'|'send')[];primary_address:string;display_label:string;verified_sender_identities:readonly string[]}>;
const digest=z.string().regex(/^[a-f0-9]{64}$/u),counter=z.number().int().positive().max(2147483646),ownerScope=z.strictObject({org_id:id,owner_user_id:id});
export const NativeEmailConnectionBindingSchema=z.strictObject({scope:ownerScope,account_id:id,provider:z.enum(['gmail','microsoft']),source:z.enum(['retained_registry_v1','native_owner_provider_v1']),profile_id:id,profile_revision:counter,module_sha256:digest,credential_namespace_id:id,credential_binding_id:id,credential_action_id:id.nullable(),connection_target:id,authority_epoch:counter,capabilities:NativeEmailConnectionCapabilitiesSchema,expected_principal_digest:digest.nullable(),expected_native_revision:counter.nullable()}).superRefine((v,c)=>{if(v.capabilities.some(x=>x!=='read')&&!v.credential_action_id)c.addIssue({code:'custom',message:'Effect custody binding required'});});
export const NativeEmailConnectionResultSchema=z.strictObject({account_id:id,provider:z.enum(['gmail','microsoft']),capabilities:NativeEmailConnectionCapabilitiesSchema,primary_address:z.email().max(320),display_label:z.string().max(256),native_revision:counter});
export const NativeEmailConnectionRecordSchema=z.strictObject({scope:ownerScope,request_id:z.uuid(),request_digest:digest,session_id:id,owner_authority_version:id,state:z.enum(['preparing','pending','exchanging','connected','failed','unknown','expired']),revision:counter,expires_at:z.number().int().positive(),binding:NativeEmailConnectionBindingSchema,authorization_url:z.string().url().max(16384).optional(),state_digest:digest.optional(),result:NativeEmailConnectionResultSchema.optional(),error:z.enum(['provider_denied','connection_failed','connection_unknown']).optional()}).superRefine((v,c)=>{if(v.scope.org_id!==v.binding.scope.org_id||v.scope.owner_user_id!==v.binding.scope.owner_user_id||(['pending','exchanging'].includes(v.state)&&(!v.state_digest||!v.authorization_url))||(v.state==='connected')!==Boolean(v.result)||v.result&&(v.result.account_id!==v.binding.account_id||v.result.provider!==v.binding.provider))c.addIssue({code:'custom',message:'Connection receipt binding invalid'});});
export type NativeEmailConnectionGuard=(transaction?:unknown)=>Promise<void>;
export interface NativeEmailConnectionStore {
 read(scope:NativeEmailConnectionScope,requestId:string,guard:NativeEmailConnectionGuard,signal?:AbortSignal):Promise<NativeEmailConnectionRecord|null>;
 byState(scope:NativeEmailConnectionScope,stateDigest:string,guard:NativeEmailConnectionGuard,signal?:AbortSignal):Promise<NativeEmailConnectionRecord|null>;
 reserve(record:NativeEmailConnectionRecord,guard:NativeEmailConnectionGuard,signal?:AbortSignal):Promise<{record:NativeEmailConnectionRecord;created:boolean}>;
 change(record:NativeEmailConnectionRecord,next:NativeEmailConnectionRecord,guard:NativeEmailConnectionGuard,signal?:AbortSignal):Promise<NativeEmailConnectionRecord>;
 /** Publish account/custody metadata and connected receipt in one short DB
  * transaction. The publisher performs no network I/O and checks account CAS. */
 publish(record:NativeEmailConnectionRecord,verified:NativeEmailConnectionVerified,guard:NativeEmailConnectionGuard,signal?:AbortSignal):Promise<NativeEmailConnectionRecord>;
}
export interface NativeEmailConnectionProvider {
 begin(binding:NativeEmailConnectionBinding,browserBinding:string,recheck:()=>Promise<void>,signal?:AbortSignal):Promise<{authorization_url:string;expires_at:number}>;
 complete(binding:NativeEmailConnectionBinding,browserBinding:string,input:{state:string;code:string},recheck:()=>Promise<void>,signal?:AbortSignal):Promise<NativeEmailConnectionVerified>;
}
export interface NativeEmailConnectionPorts {
 current(actor:EmailActor,scope:NativeEmailConnectionScope,transaction?:unknown,signal?:AbortSignal):Promise<NativeEmailConnectionOwner>;
 providers(actor:EmailActor,scope:NativeEmailConnectionScope,signal?:AbortSignal):Promise<readonly {provider:'gmail'|'microsoft';capabilities:readonly ('read'|'modify'|'send')[]}[]>;
 select(actor:EmailActor,scope:NativeEmailConnectionScope,input:NativeEmailConnectionBegin,signal?:AbortSignal):Promise<NativeEmailConnectionBinding>;
 assertBinding(actor:EmailActor,binding:NativeEmailConnectionBinding,signal?:AbortSignal):Promise<void>;
 provider(binding:NativeEmailConnectionBinding):NativeEmailConnectionProvider;
 schedule?(result:NativeEmailConnectionResult,scope:NativeEmailConnectionScope):Promise<void>;
 store:NativeEmailConnectionStore;
}
export const nativeEmailConnectionDigest=(value:unknown)=>createHash('sha256').update(canonicalCapabilityJson(value)).digest('hex');
export const nativeEmailConnectionStateDigest=(state:string)=>createHash('sha256').update(state).digest('hex');
export const nativeEmailConnectionPayloadDigest=(input:NativeEmailConnectionBegin)=>nativeEmailConnectionDigest({...input,capabilities:[...input.capabilities].sort()});
