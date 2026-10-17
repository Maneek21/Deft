import {z} from 'zod';
import type {EmailActor,EmailAuthority,EmailCapability,EmailScope} from './email-mailbox-service.js';
import {EmailSignatureStore} from './email-signature-store.js';
import {SignatureEntrySchema,SignaturePreferencesSchema,normalize,signatureAvailability,type SignatureIdentityAvailability,type SignaturePreferences} from './email-signature-types.js';
export type {SignatureIdentityAvailability} from './email-signature-types.js';

const Id=z.string().min(1).max(256).refine(v=>v.trim()===v&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v));
const Scope=z.strictObject({org_id:Id,owner_user_id:Id,account_id:Id});
const Actor=z.strictObject({user_id:Id,web_session_id:Id,access_expires_at:z.number().finite()});
const Patch=z.strictObject({expected_revision:z.number().int().min(0).max(2147483646),identities:z.array(SignatureEntrySchema).max(32)});
export class EmailSignatureServiceError extends Error{constructor(readonly code:'EMAIL_SIGNATURE_ACCESS_DENIED'|'EMAIL_SIGNATURE_INVALID'|'EMAIL_SIGNATURE_CONFLICT'|'EMAIL_SIGNATURE_UNAVAILABLE'){super(code);}}
const denied=()=>new EmailSignatureServiceError('EMAIL_SIGNATURE_ACCESS_DENIED');
const sameScope=(a:EmailScope,b:EmailScope)=>a.org_id===b.org_id&&a.owner_user_id===b.owner_user_id&&a.account_id===b.account_id;
export type SignatureIdentityReader=(scope:EmailScope,signal?:AbortSignal)=>Promise<SignatureIdentityAvailability>;
/** Signature preferences are owner-authored account data. Reading requires only
 * human draft authority; current verified identities are optional availability
 * metadata, never a condition for retaining previously saved settings. */
export class EmailSignatureService{
 constructor(private readonly authority:EmailAuthority,private readonly store:EmailSignatureStore,private readonly readIdentity:SignatureIdentityReader,private readonly now=Date.now){}
 private async authorize(actorRaw:EmailActor,scopeRaw:EmailScope,signal?:AbortSignal){
  let actor:EmailActor,scope:EmailScope;try{actor=Object.freeze(Actor.parse(actorRaw));scope=Object.freeze(Scope.parse(scopeRaw));}catch{throw denied();}
  if(actor.user_id!==scope.owner_user_id||actor.access_expires_at<=this.now())throw denied();
  let cap:EmailCapability;try{cap=structuredClone(await this.authority.current(actor,scope,'human_draft',undefined,signal));}catch{throw denied();}
  const valid=(v:EmailCapability)=>{if(!sameScope(scope,v.scope)||!Number.isFinite(v.expires_at)||v.expires_at<=this.now()||!v.resource_binding_id||!v.authority_version
    ||v.resource_binding_id!==cap.resource_binding_id||v.authority_version!==cap.authority_version)throw denied();};valid(cap);
  return {actor,scope,guard:async(tx:unknown)=>{signal?.throwIfAborted();valid(await this.authority.current(actor,scope,'human_draft',tx,signal));}};
 }
 private async availability(scope:EmailScope,signal?:AbortSignal){
  try{signal?.throwIfAborted();const value=await this.readIdentity(scope,signal);
   if(value.account_id!==scope.account_id||value.org_id!==scope.org_id||value.owner_user_id!==scope.owner_user_id||!Array.isArray(value.verified_sender_identities)
     ||value.verified_sender_identities.length>32||value.verified_sender_identities.some(v=>!z.string().email().max(320).safeParse(v).success))return undefined;return value;
  }catch(error){if(signal?.aborted)throw error;return undefined;}
 }
 private map(error:unknown,signal?:AbortSignal){if(signal?.aborted)throw error;if(error instanceof EmailSignatureServiceError)return error;
  const message=error&&typeof error==='object'&&'message'in error?String(error.message):'';
  if(message==='EMAIL_SIGNATURE_CONFLICT')return new EmailSignatureServiceError('EMAIL_SIGNATURE_CONFLICT');
  if(message==='EMAIL_SIGNATURE_INVALID'||error instanceof z.ZodError)return new EmailSignatureServiceError('EMAIL_SIGNATURE_INVALID');
  return new EmailSignatureServiceError('EMAIL_SIGNATURE_UNAVAILABLE');
 }
 async get(actor:EmailActor,scope:EmailScope,signal?:AbortSignal){
  const auth=await this.authorize(actor,scope,signal);try{
   const stored=await this.store.read(auth.scope,auth.guard,signal),identity=await this.availability(auth.scope,signal);
   await auth.guard(undefined);return Object.freeze({account_id:auth.scope.account_id,revision:stored.revision,preferences:stored.preferences,
    identity_availability:signatureAvailability(identity,stored.preferences)});
  }catch(error){throw this.map(error,signal);}
 }
 async put(actor:EmailActor,scope:EmailScope,raw:unknown,signal?:AbortSignal){
  const auth=await this.authorize(actor,scope,signal);try{
   const patch=Patch.parse(raw),previous=await this.store.read(auth.scope,auth.guard,signal);
   if(previous.revision!==patch.expected_revision)throw new EmailSignatureServiceError('EMAIL_SIGNATURE_CONFLICT');
   const identity=await this.availability(auth.scope,signal);if(!identity)throw new EmailSignatureServiceError('EMAIL_SIGNATURE_ACCESS_DENIED');
   const verified=new Set(identity.verified_sender_identities.map(normalize));const merged=new Map(previous.preferences.identities.map(item=>[normalize(item.address),item]));
   for(const entry of patch.identities){if(!verified.has(normalize(entry.address)))throw new EmailSignatureServiceError('EMAIL_SIGNATURE_ACCESS_DENIED');merged.set(normalize(entry.address),entry);}
   const preferences:SignaturePreferences=SignaturePreferencesSchema.parse({identities:[...merged.values()]});
   const stored=await this.store.replace(auth.scope,patch.expected_revision,preferences,auth.guard,signal);
   await auth.guard(undefined);return Object.freeze({account_id:auth.scope.account_id,revision:stored.revision,preferences:stored.preferences,
    identity_availability:signatureAvailability(identity,stored.preferences)});
  }catch(error){throw this.map(error,signal);}
 }
}
