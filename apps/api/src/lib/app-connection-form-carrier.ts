import {z} from 'zod';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {AppConnectionSessionScopeSchema,AppConnectionProfileSchema} from '../../../../packages/app-kit/src/connection-session.js';
import {AppConnectionActionConsentsSchema} from '../../../../packages/app-kit/src/connection-session-v2.js';
import {AppConnectionFormRecordSchema,type AppConnectionFormRecord} from '../../../../packages/app-kit/src/connection-form.js';

/** Closed subset of the unchanged OAuth metadata record. No callback material
 * produced here is executable or disclosed. SQL101 pairs it with its journal. */
export const FormCarrierSchema=z.strictObject({session_id:z.string().uuid(),revision:z.number().int().nonnegative(),scope:AppConnectionSessionScopeSchema,
 profile:AppConnectionProfileSchema,state:z.enum(['starting','awaiting_callback','checking','disconnecting','connected','not_connected','disconnected','indeterminate']),
 callback_state_hash:z.string().regex(/^[a-f0-9]{64}$/u),callback_consumed:z.literal(true),callback_expires_at:z.iso.datetime(),
 runtime_session_ref:z.string().regex(/^[A-Za-z0-9_-]{1,512}$/u).nullable(),account:z.strictObject({account_ref:z.string().uuid(),label:z.string().min(1).max(200)}).nullable(),
 action_consents:AppConnectionActionConsentsSchema,created_at:z.iso.datetime(),updated_at:z.iso.datetime()});
export type FormCarrier=z.infer<typeof FormCarrierSchema>;
export const formCanonical=(raw:unknown):string=>JSON.stringify(raw,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value);
export const formDigest=(raw:unknown)=>'sha256:'+createHash('sha256').update(formCanonical(raw)).digest('hex');
export const formCarrierState=(record:AppConnectionFormRecord)=>record.state==='awaiting_input'?'awaiting_callback':record.state;
export function projectFormCarrier(record:AppConnectionFormRecord,prior:FormCarrier):FormCarrier{
 return FormCarrierSchema.parse({...prior,revision:record.revision,state:formCarrierState(record),runtime_session_ref:record.runtime_session_ref,
 account:record.account?{account_ref:record.account.account_ref,label:record.account.label}:null,updated_at:record.updated_at});
}
/** Required by data/Run/observation resolution as well as the form store. */
export function validateFormCarrierPair(rawForm:unknown,rawCarrier:unknown){
 const form=AppConnectionFormRecordSchema.parse(rawForm),carrier=FormCarrierSchema.parse(rawCarrier);
 if(carrier.session_id!==form.session_id||carrier.revision!==form.revision||!isDeepStrictEqual(carrier.scope,form.scope)
 ||!isDeepStrictEqual(carrier.action_consents,form.action_consents)||carrier.state!==formCarrierState(form)
 ||carrier.runtime_session_ref!==form.runtime_session_ref||carrier.callback_expires_at!==form.input_expires_at
 ||carrier.created_at!==form.created_at||carrier.updated_at!==form.updated_at
 ||!isDeepStrictEqual(carrier.account,form.account?{account_ref:form.account.account_ref,label:form.account.label}:null)
 ||carrier.profile.authorization_origin!==form.authorization_origin)throw new Error('APP_CONNECTION_FORM_SPLIT_STATE');
 if(form.receipt&&!form.source&&form.receipt.custody_generation!==1)throw new Error('APP_CONNECTION_FORM_GENERATION_INVALID');
 if(form.receipt){const {digest,...receipt}=form.receipt;if(digest!==formDigest(receipt)||receipt.scope_digest!==formDigest(form.scope))throw new Error('APP_CONNECTION_FORM_RECEIPT_INVALID');}
 return {form,carrier};
}
/** A recorded predecessor is immutable evidence, not current authority. */
export function validateFormPredecessor(next:AppConnectionFormRecord,prior:AppConnectionFormRecord){
 const source=next.source;if(!source||prior.state!=='connected'||!prior.account||!prior.receipt||!prior.runtime_session_ref
 ||prior.session_id!==source.session_id||prior.revision!==source.session_revision||!isDeepStrictEqual(prior.scope,source.scope)
 ||prior.runtime_session_ref!==source.runtime_session_ref||prior.account.account_ref!==source.account_ref)throw new Error('APP_CONNECTION_FORM_SOURCE_STALE');
 if(next.receipt&&(next.receipt.account_ref!==prior.receipt.account_ref||next.receipt.principal_digest!==prior.receipt.principal_digest
 ||next.receipt.custody_generation!==prior.receipt.custody_generation+1))throw new Error('APP_CONNECTION_FORM_GENERATION_INVALID');
}
