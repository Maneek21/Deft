import {z} from 'zod';
import {canonicalCapabilityJson} from '@deft/shared';
import {AppConnectionPinsSchema} from './app-connection-contract.js';
import type {EmailOperation,EmailScope} from './email-mailbox-service.js';
import {NativeEmailAccountBridgeSchema} from './email-native-connection-profile.js';

const id=z.string().min(1).max(256).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const scope=z.strictObject({org_id:id,owner_user_id:id,account_id:id});
const digest=z.string().regex(/^[a-f0-9]{64}$/u),revision=z.number().int().positive().max(2147483646);
const capabilities=z.array(z.enum(['read','modify','send'])).min(1).max(3).refine(values=>new Set(values).size===values.length&&values.includes('read'));
export const EmailAccountDisplayIdentitySchema=z.strictObject({primary_address:z.string().max(320).refine(v=>!/[\u0000-\u001f\u007f-\u009f]/u.test(v)),display_label:z.string().max(256).refine(v=>!/[\u0000-\u001f\u007f-\u009f]/u.test(v))});
export const EmailAccountBridgeSchema=z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('retained_registry_v1'),pins:AppConnectionPinsSchema,module_sha256:digest}),NativeEmailAccountBridgeSchema]);
export const emailAccountBridgeBindingId=(bridge:z.infer<typeof EmailAccountBridgeSchema>)=>bridge.kind==='retained_registry_v1'?bridge.pins.resource_binding_id:bridge.credential_binding_id;
export const emailAccountBridgeActionId=(bridge:z.infer<typeof EmailAccountBridgeSchema>)=>bridge.kind==='retained_registry_v1'?bridge.pins.action_binding_id:bridge.credential_action_id;
export const emailAccountBridgeOwner=(bridge:z.infer<typeof EmailAccountBridgeSchema>)=>bridge.kind==='retained_registry_v1'?bridge.pins:bridge.scope;
export const EmailAccountConsentSchema=z.strictObject({
 scope,provider:z.enum(['gmail','microsoft','imap_smtp']),principal_digest:digest,revision,native_revision:revision,
 credential_revision:revision,state:z.enum(['active','paused','disconnected','revoked']),capabilities,
 bridge:EmailAccountBridgeSchema,identity:EmailAccountDisplayIdentitySchema.optional(),consented_at:z.iso.datetime(),updated_at:z.iso.datetime(),revoked_at:z.iso.datetime().nullable(),
}).superRefine((value,ctx)=>{
 const owner=emailAccountBridgeOwner(value.bridge);
 if(owner.org_id!==value.scope.org_id||owner.owner_user_id!==value.scope.owner_user_id||value.bridge.kind==='native_owner_provider_v1'&&(value.bridge.scope.account_id!==value.scope.account_id||value.bridge.provider!==value.provider))
  ctx.addIssue({code:'custom',message:'Bridge scope mismatch'});
 if((value.state==='revoked')!==Boolean(value.revoked_at))ctx.addIssue({code:'custom',message:'Revocation marker mismatch'});
 if(value.capabilities.some(cap=>cap!=='read')&&!emailAccountBridgeActionId(value.bridge))ctx.addIssue({code:'custom',message:'Effect custody bridge missing'});
});
export type EmailAccountConsent=Readonly<z.infer<typeof EmailAccountConsentSchema>>;
export type EmailAccountBridge=Readonly<z.infer<typeof EmailAccountBridgeSchema>>;
const identity=z.strictObject({scope,provider:z.enum(['gmail','microsoft','imap_smtp']),principal_digest:digest,
 native_revision:revision,consent_revision:z.number().int().min(0).max(2147483646),credential_revision:revision});
/** Snapshot supplied only by the locked host adoption/current-custody path.
 * The planner is not an authorization API and these values cannot come from HTTP.
 * SQL membership, exact SID/lease and custody checks remain the caller's guards. */
export const EmailAccountConnectionProofSchema=identity.extend({bridge:EmailAccountBridgeSchema,identity:EmailAccountDisplayIdentitySchema.optional(),available_capabilities:capabilities,health:z.literal('connected')});
export type EmailAccountConnectionProof=Readonly<z.infer<typeof EmailAccountConnectionProofSchema>>;
export type EmailAccountLifecyclePlan=Readonly<{expected_revision:number;expected_native_revision:number;next:EmailAccountConsent;
 effect_policy:'preserve_started_unknown';reason:'adopt'|'reconnect'|'consent'|'pause'|'disconnect'|'revoke'}>;
const denied=():never=>{throw Error('EMAIL_ACCOUNT_LIFECYCLE_CONFLICT');};
const equal=(a:unknown,b:unknown)=>canonicalCapabilityJson(a)===canonicalCapabilityJson(b);
const sorted=(values:readonly ('read'|'modify'|'send')[])=>[...values].sort() as ('read'|'modify'|'send')[];
const stamp=(now:number)=>{if(!Number.isSafeInteger(now)||now<0)denied();return new Date(now).toISOString();};
function immutable(prior:EmailAccountConsent,proof:z.infer<typeof identity>){
 if(!equal(prior.scope,proof.scope)||prior.provider!==proof.provider||prior.principal_digest!==proof.principal_digest
  ||prior.revision!==proof.consent_revision||proof.native_revision<prior.native_revision)denied();
}
function connected(prior:EmailAccountConsent|null,proof:EmailAccountConnectionProof,desired:readonly ('read'|'modify'|'send')[]){
 const owner=emailAccountBridgeOwner(proof.bridge);
 if(owner.org_id!==proof.scope.org_id||owner.owner_user_id!==proof.scope.owner_user_id
  ||desired.some(cap=>!proof.available_capabilities.includes(cap)))denied();
 if(prior){immutable(prior,proof);if(!equal(prior.bridge,proof.bridge)||proof.credential_revision<prior.credential_revision)denied();}
}
/** Explicit owner adoption; the host must prove current reviewed legacy custody
 * and fresh owner consent in the same commit transaction before storing next. */
export function planEmailAccountAdoption(rawProof:EmailAccountConnectionProof,desired:readonly ('read'|'modify'|'send')[],now:number):EmailAccountLifecyclePlan{
 const proof=EmailAccountConnectionProofSchema.parse(rawProof),requested=capabilities.parse(desired),time=stamp(now);connected(null,proof,requested);if(proof.consent_revision!==0)denied();
 const next=EmailAccountConsentSchema.parse({scope:proof.scope,provider:proof.provider,principal_digest:proof.principal_digest,revision:1,native_revision:proof.native_revision+1,
  credential_revision:proof.credential_revision,state:'active',capabilities:sorted(requested),bridge:proof.bridge,...(proof.identity?{identity:proof.identity}:{}),consented_at:time,updated_at:time,revoked_at:null});
 return {expected_revision:0,expected_native_revision:proof.native_revision,next,effect_policy:'preserve_started_unknown',reason:'adopt'};
}
export function planEmailAccountReconnect(rawPrior:EmailAccountConsent,rawProof:EmailAccountConnectionProof,now:number):EmailAccountLifecyclePlan{
 const prior=EmailAccountConsentSchema.parse(rawPrior),proof=EmailAccountConnectionProofSchema.parse(rawProof);connected(prior,proof,prior.capabilities);
 // Revocation is terminal here. Restoring revoked consent needs a separate,
 // explicit adoption review; provider health alone cannot restore it.
 if(prior.state==='revoked')denied();
 return finish(prior,{...prior,state:'active',credential_revision:proof.credential_revision,...(proof.identity?{identity:proof.identity}:{})},proof.native_revision,'reconnect',now);
}
export function planEmailAccountConsent(rawPrior:EmailAccountConsent,rawProof:EmailAccountConnectionProof,desired:readonly ('read'|'modify'|'send')[],now:number):EmailAccountLifecyclePlan{
 const prior=EmailAccountConsentSchema.parse(rawPrior),proof=EmailAccountConnectionProofSchema.parse(rawProof),requested=capabilities.parse(desired);connected(prior,proof,requested);
 if(prior.state!=='active')denied();return finish(prior,{...prior,capabilities:sorted(requested),credential_revision:proof.credential_revision,consented_at:stamp(now)},proof.native_revision,'consent',now);
}
/** Local state changes never change credential identity or restart an effect. */
export function planEmailAccountStop(rawPrior:EmailAccountConsent,rawIdentity:z.infer<typeof identity>,reason:'pause'|'disconnect'|'revoke',now:number):EmailAccountLifecyclePlan{
 const prior=EmailAccountConsentSchema.parse(rawPrior),proof=identity.parse(rawIdentity);immutable(prior,proof);
 if(proof.credential_revision<prior.credential_revision||prior.state==='revoked'||!['pause','disconnect','revoke'].includes(reason))denied();
 const state=reason==='pause'?'paused':reason==='disconnect'?'disconnected':'revoked';
 return finish(prior,{...prior,state,credential_revision:proof.credential_revision,revoked_at:reason==='revoke'?stamp(now):null},proof.native_revision,reason,now);
}
function finish(prior:EmailAccountConsent,next:EmailAccountConsent,nativeRevision:number,reason:EmailAccountLifecyclePlan['reason'],now:number):EmailAccountLifecyclePlan{
 const time=stamp(now);if(Date.parse(time)<Date.parse(prior.updated_at))denied();
 return {expected_revision:prior.revision,expected_native_revision:nativeRevision,next:EmailAccountConsentSchema.parse({...next,revision:prior.revision+1,native_revision:nativeRevision+1,updated_at:time}),effect_policy:'preserve_started_unknown',reason};
}
/** Consent selection only: successful selection is never a cached allow result.
 * Local drafts require read ownership, not an unused provider modify/send grant. */
export function requireEmailAccountConsent(raw:EmailAccountConsent,selected:EmailScope,operation:EmailOperation):'read'|'modify'|'send'{
 const consent=EmailAccountConsentSchema.parse(raw);
 if(!equal(consent.scope,selected)||consent.state!=='active')throw Error('EMAIL_ACCESS_DENIED');
 const required=operation==='human_read'||operation==='human_sync'||operation==='human_draft'?'read':operation==='human_modify'?'modify':operation==='human_send'?'send':null;
 if(!required||!consent.capabilities.includes(required))throw Error('EMAIL_ACCESS_DENIED');return required;
}
