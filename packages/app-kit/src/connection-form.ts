import {z} from 'zod';
const accountRef=z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u);
import {AppConnectionSessionScopeSchema} from './connection-session.js';
import {AppConnectionReattachSourceSchema} from './connection-session-reattach.js';
import {AppConnectionActionConsentsSchema} from './connection-session-v2.js';
const id=z.string().uuid(),hash=z.string().regex(/^sha256:[a-f0-9]{64}$/u),opaque=z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u);
export const APP_CONNECTION_FORM_LIMITS=Object.freeze({transport_json_bytes:16384,form_json_bytes:65536,setup_ms:60000,input_lease_ms:300000,targets:32});
/** This module is metadata only: no credential/form field can enter a host,
 * Worker, callback or operator transport request. The reviewed runtime owns UI. */
export const AppConnectionFormAccountSchema=z.strictObject({account_ref:accountRef,label:z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f<>]+$/u),address:z.email().max(320),capabilities:z.array(z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u)).max(16),identity_assurance:z.literal('owner_declared_authenticated')});
export const AppConnectionFormReceiptSchema=z.strictObject({schema_version:z.literal('deft.app_connection_form_receipt.v1'),account_ref:accountRef,custody_generation:z.number().int().min(1).max(2147483646),principal_digest:hash,custody_digest:hash,scope_digest:hash,committed_at:z.iso.datetime(),digest:hash});
export const AppConnectionFormBeginSchema=z.strictObject({schema_version:z.literal('deft.app_connection_form_begin.v1'),installation_id:id,target_key:AppConnectionSessionScopeSchema.shape.target_key,request_id:id,source_session_id:id.nullable()});
export const AppConnectionFormManageSchema=z.strictObject({session_id:id});
const runtime={schema_version:z.literal('deft.app_connection_form_runtime.v1'),session_id:id,scope:AppConnectionSessionScopeSchema,expires_at:z.iso.datetime(),setup_expires_at:z.iso.datetime(),action_consents:AppConnectionActionConsentsSchema,source:AppConnectionReattachSourceSchema.nullable()};
const variants=[z.strictObject({...runtime,operation:z.literal('begin')}),z.strictObject({...runtime,operation:z.literal('status'),runtime_session_ref:opaque.nullable()}),z.strictObject({...runtime,operation:z.literal('disconnect'),runtime_session_ref:opaque})] as const;
const deadline=(v:{expires_at:string;scope:{consent_expires_at:string};setup_expires_at:string})=>Date.parse(v.setup_expires_at)<=Date.parse(v.scope.consent_expires_at)&&Date.parse(v.expires_at)<=Date.parse(v.scope.consent_expires_at);
export const AppConnectionFormRuntimeRequestSchema=z.discriminatedUnion('operation',variants).refine(deadline);
export type AppConnectionFormRuntimeRequest=Readonly<z.infer<typeof AppConnectionFormRuntimeRequestSchema>>;
const authority={...runtime,schema_version:z.literal('deft.app_connection_form_authority.v1')};
const authorityVariants=[z.strictObject({...authority,operation:z.literal('begin')}),z.strictObject({...authority,operation:z.literal('status'),runtime_session_ref:opaque.nullable()}),z.strictObject({...authority,operation:z.literal('disconnect'),runtime_session_ref:opaque}),z.strictObject({...authority,operation:z.literal('submit'),runtime_session_ref:opaque})] as const;
export const AppConnectionFormAuthorityRequestSchema=z.discriminatedUnion('operation',authorityVariants).refine(deadline);
export const AppConnectionFormAuthorityResultSchema=z.discriminatedUnion('operation',[authorityVariants[0].extend({allowed:z.literal(true)}),authorityVariants[1].extend({allowed:z.literal(true)}),authorityVariants[2].extend({allowed:z.literal(true)}),authorityVariants[3].extend({allowed:z.literal(true)})]).refine(deadline);
const result={schema_version:z.literal('deft.app_connection_form_runtime.v1'),session_id:id,runtime_session_ref:opaque};
export const AppConnectionFormRuntimeResultSchema=z.discriminatedUnion('state',[
 z.strictObject({...result,state:z.literal('awaiting_input'),input_consumed:z.literal(false),receipt:z.null(),setup_expires_at:z.iso.datetime(),setup_url:z.url().max(2048).optional()}),
 z.strictObject({...result,state:z.literal('connected'),input_consumed:z.literal(true),account:AppConnectionFormAccountSchema,receipt:AppConnectionFormReceiptSchema}),
 z.strictObject({...result,state:z.enum(['not_connected','indeterminate']),input_consumed:z.boolean(),account:z.null(),receipt:z.null()}),
 z.strictObject({...result,state:z.literal('disconnected'),input_consumed:z.boolean(),account:AppConnectionFormAccountSchema.nullable(),receipt:AppConnectionFormReceiptSchema.nullable()}),
]).superRefine((v,ctx)=>{if('account' in v&&v.account&&v.receipt&&v.account.account_ref!==v.receipt.account_ref)ctx.addIssue({code:'custom',message:'Receipt cannot replace the account'});if(v.state==='awaiting_input'&&v.setup_url){const u=new URL(v.setup_url);if(u.protocol!=='https:'||u.username||u.password||u.port||u.pathname!=='/setup'||u.search||!/^#[A-Za-z0-9_-]{43}$/u.test(u.hash))ctx.addIssue({code:'custom',message:'Setup requires reviewed HTTPS runtime form'});}});
export type AppConnectionFormRuntimeResult=Readonly<z.infer<typeof AppConnectionFormRuntimeResultSchema>>;
const recordBase=z.strictObject({schema_version:z.literal('deft.app_connection_form_record.v1'),session_id:id,revision:z.number().int().positive().max(2147483646),scope:AppConnectionSessionScopeSchema,action_consents:AppConnectionActionConsentsSchema,source:AppConnectionReattachSourceSchema.nullable(),transport_digest:hash,authorization_origin:z.url().max(512).refine(value=>{const u=new URL(value);return u.protocol==='https:'&&u.origin===value&&!u.port&&!u.username&&!u.password;}),state:z.enum(['starting','awaiting_input','checking','disconnecting','connected','not_connected','disconnected','indeterminate']),runtime_session_ref:opaque.nullable(),begin_consumed:z.boolean(),input_consumed:z.boolean(),input_expires_at:z.iso.datetime(),account:AppConnectionFormAccountSchema.nullable(),receipt:AppConnectionFormReceiptSchema.nullable(),created_at:z.iso.datetime(),updated_at:z.iso.datetime()});
export const AppConnectionFormRecordSchema=recordBase.superRefine((v,ctx)=>{if(Date.parse(v.input_expires_at)>Date.parse(v.created_at)+APP_CONNECTION_FORM_LIMITS.input_lease_ms||Date.parse(v.updated_at)<Date.parse(v.created_at)||Date.parse(v.input_expires_at)>Date.parse(v.scope.consent_expires_at)||v.receipt&&(!v.input_consumed||!v.account||v.receipt.account_ref!==v.account.account_ref)||v.state==='connected'&&(!v.account||!v.receipt||!v.runtime_session_ref)||v.account&&v.source&&v.account.account_ref!==v.source.account_ref)ctx.addIssue({code:'custom',message:'Invalid form custody pins'});});
export type AppConnectionFormRecord=Readonly<z.infer<typeof AppConnectionFormRecordSchema>>;
export const AppConnectionFormSessionViewSchema=recordBase.omit({action_consents:true,source:true,transport_digest:true,authorization_origin:true,runtime_session_ref:true}).extend({schema_version:z.literal('deft.app_connection_form_session.v1')});
export type AppConnectionFormSessionView=Readonly<z.infer<typeof AppConnectionFormSessionViewSchema>>;
export const AppConnectionFormResponseSchema=z.strictObject({session:AppConnectionFormSessionViewSchema,setup_url:z.string().max(2048).optional()});
export const AppConnectionFormContextSchema=z.strictObject({schema_version:z.literal('deft.app_connection_form_context.v1'),installation_id:id,org_id:id,owner_user_id:id,
 targets:z.array(z.strictObject({target_key:AppConnectionSessionScopeSchema.shape.target_key,profile:z.strictObject({key:AppConnectionSessionScopeSchema.shape.target_key,label:z.string().min(1).max(200),authorization_origin:z.url().max(512)}),
 scope:AppConnectionSessionScopeSchema,runtime_ready:z.boolean(),action_keys:z.array(AppConnectionSessionScopeSchema.shape.target_key).max(8),session:AppConnectionFormSessionViewSchema.nullable(),
 candidate:z.strictObject({source_session_id:id,account:AppConnectionFormAccountSchema}).nullable()})).max(APP_CONNECTION_FORM_LIMITS.targets)});
export type AppConnectionFormContext=Readonly<z.infer<typeof AppConnectionFormContextSchema>>;
