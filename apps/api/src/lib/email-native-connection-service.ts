import {z} from 'zod';
import type {EmailActor} from './email-mailbox-service.js';
import {NativeEmailConnectionBeginSchema,NativeEmailConnectionCallbackSchema,NativeEmailConnectionBindingSchema,nativeEmailConnectionPayloadDigest,nativeEmailConnectionStateDigest,type NativeEmailConnectionPorts,type NativeEmailConnectionScope,type NativeEmailConnectionOwner,type NativeEmailConnectionRecord,type NativeEmailConnectionStatus,type NativeEmailConnectionVerified,type NativeEmailConnectionGuard} from './email-native-connection-contract.js';

const scopeSchema=z.strictObject({org_id:z.string().min(1).max(256),owner_user_id:z.string().min(1).max(256)});
const verifiedSchema=z.strictObject({account_id:z.string().min(1).max(256),provider:z.enum(['gmail','microsoft']),principal_digest:z.string().regex(/^[a-f0-9]{64}$/u),credential_revision:z.number().int().positive(),authority_epoch:z.number().int().positive(),capabilities:z.array(z.enum(['read','modify','send'])).min(1).max(3),primary_address:z.string().email().max(320),display_label:z.string().max(256),verified_sender_identities:z.array(z.string().email().max(320)).min(1).max(32)});
const conflict=():never=>{throw Error('EMAIL_CONNECTION_CONFLICT');};
/** Human OAuth setup only. It cannot grant agent authority or dispatch mailbox
 * operations. A durable exchanging receipt makes code exchange one attempt. */
export class NativeEmailConnectionService {
 constructor(private readonly ports:NativeEmailConnectionPorts,private readonly now=Date.now){}
 private async owner(actor:EmailActor,rawScope:NativeEmailConnectionScope,signal?:AbortSignal){
  const scope=scopeSchema.parse(rawScope);signal?.throwIfAborted();
  if(actor.user_id!==scope.owner_user_id)throw Error('EMAIL_ACCESS_DENIED');
  const owner=await this.ports.current(actor,scope,undefined,signal);this.check(owner,actor,scope,signal);return owner;
 }
 private check(owner:NativeEmailConnectionOwner,actor:EmailActor,scope:NativeEmailConnectionScope,signal?:AbortSignal){
  signal?.throwIfAborted();if(owner.scope.org_id!==scope.org_id||owner.scope.owner_user_id!==scope.owner_user_id||owner.session_id!==actor.web_session_id||owner.expires_at<=this.now()||actor.access_expires_at<=this.now()||!owner.authority_version)throw Error('EMAIL_ACCESS_DENIED');
 }
 private guard(actor:EmailActor,owner:NativeEmailConnectionOwner,signal?:AbortSignal){return async(transaction?:unknown)=>{
  const fresh=await this.ports.current(actor,owner.scope,transaction,signal);this.check(fresh,actor,owner.scope,signal);if(fresh.authority_version!==owner.authority_version)throw Error('EMAIL_ACCESS_DENIED');
 };}
 private project(row:NativeEmailConnectionRecord,owner:NativeEmailConnectionOwner):NativeEmailConnectionStatus{
  const state=(row.state==='preparing'||row.state==='pending')&&row.expires_at<=this.now()?'expired':row.state==='exchanging'&&row.expires_at<=this.now()?'unknown':row.state;
  return {schema_version:'deft.email_connection.v1',request_id:row.request_id,provider:row.binding.provider,state,expires_at:new Date(row.expires_at).toISOString(),account_id:row.result?.account_id??null,capabilities:row.result?.capabilities??row.binding.capabilities,
   ...(state==='pending'&&row.session_id===owner.session_id&&row.authorization_url?{authorization_url:row.authorization_url}:{}),
   ...(row.result?{primary_address:row.result.primary_address,display_label:row.result.display_label}:{}),...(row.error?{error:row.error}:state==='unknown'?{error:'connection_unknown' as const}:{})};
 }
 private async expire(row:NativeEmailConnectionRecord,guard:NativeEmailConnectionGuard,signal?:AbortSignal){
  if(row.expires_at>this.now()||!['preparing','pending','exchanging'].includes(row.state))return row;
  return this.ports.store.change(row,{...row,state:row.state==='exchanging'?'unknown':'expired',revision:row.revision+1,...(row.state==='exchanging'?{error:'connection_unknown' as const}:{})},guard,signal);
 }
 async providers(actor:EmailActor,scope:NativeEmailConnectionScope,signal?:AbortSignal){const owner=await this.owner(actor,scope,signal),guard=this.guard(actor,owner,signal),providers=await this.ports.providers(actor,scope,signal);await guard();return {providers};}
 async read(actor:EmailActor,scope:NativeEmailConnectionScope,requestId:string,signal?:AbortSignal):Promise<NativeEmailConnectionStatus|null>{
  z.uuid().parse(requestId);const owner=await this.owner(actor,scope,signal),guard=this.guard(actor,owner,signal),row=await this.ports.store.read(scope,requestId,guard,signal),settled=row?await this.expire(row,guard,signal):null;await guard();return settled?this.project(settled,owner):null;
 }
 async begin(actor:EmailActor,scope:NativeEmailConnectionScope,raw:unknown,signal?:AbortSignal):Promise<NativeEmailConnectionStatus>{
  const input=NativeEmailConnectionBeginSchema.parse(raw),owner=await this.owner(actor,scope,signal),guard=this.guard(actor,owner,signal),digest=nativeEmailConnectionPayloadDigest(input),prior=await this.ports.store.read(scope,input.request_id,guard,signal);
  if(prior){if(prior.request_digest!==digest)conflict();const settled=await this.expire(prior,guard,signal);await guard();return this.project(settled,owner);}
  const binding=NativeEmailConnectionBindingSchema.parse(await this.ports.select(actor,scope,input,signal));await guard();
  if(binding.scope.org_id!==scope.org_id||binding.scope.owner_user_id!==scope.owner_user_id||binding.provider!==input.provider||input.account_id&&binding.account_id!==input.account_id||binding.capabilities.length!==input.capabilities.length||binding.capabilities.some(v=>!input.capabilities.includes(v)))throw Error('EMAIL_ACCESS_DENIED');
  const reservation=await this.ports.store.reserve({scope,request_id:input.request_id,request_digest:digest,session_id:owner.session_id,owner_authority_version:owner.authority_version,state:'preparing',revision:1,expires_at:Math.min(this.now()+600000,owner.expires_at),binding},guard,signal);
  if(reservation.record.request_digest!==digest)conflict();if(!reservation.created){await guard();return this.project(reservation.record,owner);}
  const row=reservation.record;
  try{
   const providerGuard=async()=>{await guard();await this.ports.assertBinding(actor,binding,signal);await guard();};
   const pending=await this.ports.provider(binding).begin(binding,owner.session_id,providerGuard,signal);await providerGuard();
   const url=new URL(pending.authorization_url),state=url.searchParams.get('state');
   const providerUrl=binding.provider==='gmail'?url.hostname==='accounts.google.com'&&url.pathname==='/o/oauth2/v2/auth':url.hostname==='login.microsoftonline.com'&&/^\/(?:common|organizations|consumers|[a-f0-9-]{36})\/oauth2\/v2\.0\/authorize$/iu.test(url.pathname);
   if(url.protocol!=='https:'||url.port||url.username||url.password||url.hash||!providerUrl||!state||!/^[A-Za-z0-9_-]{43}$/u.test(state)||!Number.isSafeInteger(pending.expires_at)||pending.expires_at<=this.now()||pending.expires_at>this.now()+600000)throw Error('EMAIL_CONNECTION_PROVIDER_INVALID');
   const next=await this.ports.store.change(row,{...row,state:'pending',revision:row.revision+1,expires_at:Math.min(row.expires_at,pending.expires_at),authorization_url:pending.authorization_url,state_digest:nativeEmailConnectionStateDigest(state)},guard,signal);await guard();return this.project(next,owner);
  }catch(error){
   // No code exchange occurred here, but an opaque state may have been written.
   // Retain a terminal receipt; the same request never silently starts again.
   try{await this.ports.store.change(row,{...row,state:'failed',revision:row.revision+1,error:'connection_failed'},guard,signal);}catch{}
   throw error;
  }
 }
 async callback(actor:EmailActor,scope:NativeEmailConnectionScope,raw:unknown,signal?:AbortSignal):Promise<NativeEmailConnectionStatus>{
  const input=NativeEmailConnectionCallbackSchema.parse(raw),owner=await this.owner(actor,scope,signal),guard=this.guard(actor,owner,signal),row=await this.ports.store.byState(scope,nativeEmailConnectionStateDigest(input.state),guard,signal);
  if(!row||row.session_id!==owner.session_id||row.owner_authority_version!==owner.authority_version)throw Error('EMAIL_ACCESS_DENIED');
  if(row.state!=='pending'){const settled=await this.expire(row,guard,signal);await guard();return this.project(settled,owner);}
  if(row.expires_at<=this.now()){const expired=await this.ports.store.change(row,{...row,state:'expired',revision:row.revision+1},guard,signal);return this.project(expired,owner);}
  if('error' in input){const failed=await this.ports.store.change(row,{...row,state:'failed',revision:row.revision+1,error:'provider_denied'},guard,signal);await guard();return this.project(failed,owner);}
  // This short CAS commits before any token request; crashed/lost-ACK exchange
  // remains inspect-only, never retried with the consumed authorization code.
  const exchanging=await this.ports.store.change(row,{...row,state:'exchanging',revision:row.revision+1},guard,signal);
  try{
   const providerGuard=async()=>{await guard();await this.ports.assertBinding(actor,row.binding,signal);await guard();};
   await providerGuard();const verified=verifiedSchema.parse(await this.ports.provider(row.binding).complete(row.binding,row.session_id,{state:input.state,code:input.code},providerGuard,signal));await providerGuard();
   this.verify(row,verified);
   const connected=await this.ports.store.publish(exchanging,verified,guard,signal);await guard();
   // Activation is durable even if enqueue fails; the ordinary account scheduler
   // repair source remains authoritative. No Outbox effect is resumed here.
   try{if(connected.result)await this.ports.schedule?.(connected.result,scope);}catch{signal?.throwIfAborted();}
   await guard();return this.project(connected,owner);
  }catch(error){
   // Provider/network errors can follow a successful exchange or custody write.
   // No false revoke/grant claim; explicit unknown is the conservative receipt.
   try{await this.ports.store.change(exchanging,{...exchanging,state:'unknown',revision:exchanging.revision+1,error:'connection_unknown'},guard,signal);}catch{}
   throw error;
  }
 }
 private verify(row:NativeEmailConnectionRecord,v:NativeEmailConnectionVerified){
  const b=row.binding;if(v.account_id!==b.account_id||v.provider!==b.provider||v.authority_epoch!==b.authority_epoch||b.expected_principal_digest&&b.expected_principal_digest!==v.principal_digest||!v.capabilities.includes('read')||new Set(v.capabilities).size!==v.capabilities.length||v.capabilities.some(cap=>!b.capabilities.includes(cap))||!v.verified_sender_identities.includes(v.primary_address))throw Error('EMAIL_CONNECTION_IDENTITY_CHANGED');
 }
}
