import {appConsentDeadline} from '@deft/app-kit/core';
import { createHash,randomBytes,timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AppConnectionUpgradeReviewRequestSchema,AppConnectionUpgradeBeginRequestSchema,
  AppConnectionUpgradeCallbackRequestSchema,AppConnectionUpgradeStatusRequestSchema,
  AppConnectionUpgradeReviewViewSchema,AppConnectionUpgradeRuntimeRequestSchema,
  AppConnectionUpgradeRuntimeResultSchema,AppConnectionUpgradeBegunSchema,AppConnectionUpgradeClosedViewSchema,AppConnectionSessionViewSchema,
  canonicalConnectionReattachmentJson,type AppConnectionUpgradeRuntimeRequest,type AppConnectionUpgradeRuntimeResult,
  type AppConnectionActionConsents } from '@deft/app-kit/core';
import { AppError } from './app-errors.js';
import { AppConnectionSessionRecordSchema,type AppConnectionSessionRecord,type AppConnectionSessionPorts,
  type AppConnectionSessionAuthority } from './app-connection-session-service.js';
import type {ExperienceCaller} from './app-experience-service.js';
const denied=()=>new AppError('Account upgrade access ended','APP_ACCESS_DENIED',403);
const conflict=()=>new AppError('Account upgrade changed','APP_STATE_CONFLICT',409);
const sha=(value:unknown)=>`sha256:${createHash('sha256').update(canonicalConnectionReattachmentJson(value)).digest('hex')}`;
const stateHash=(value:string)=>createHash('sha256').update(value).digest('hex');
export type AppConnectionUpgradePorts=Readonly<Pick<AppConnectionSessionPorts,'store'> & {
 currentAuthority(caller:ExperienceCaller,nomination:{installation_id:string;target_key:string}):Promise<AppConnectionSessionAuthority & {action_consents:AppConnectionActionConsents}>;
 transportDigest(record:AppConnectionSessionRecord):Promise<string>;
 assertNoActiveEffects(source:AppConnectionSessionRecord,target:AppConnectionSessionAuthority,sessionId?:string):Promise<void>;
 requestRuntime(record:AppConnectionSessionRecord,input:AppConnectionUpgradeRuntimeRequest,signal:AbortSignal):Promise<unknown>;
}>;
export function connectionUpgradeReviewDigest(record:AppConnectionSessionRecord,eligibility:{account:{account_ref:string;label:string};custody_generation:number;custody_digest:string}){
 const data=record.upgrade!;return sha({schema_version:'deft.app_connection_upgrade_review_pin.v1',session_id:record.session_id,
  scope:record.scope,source:data.source,transport_digest:data.transport_digest,review_expires_at:data.review_expires_at,
  action_consents:record.action_consents,eligibility});
}
export function connectionUpgradeReceiptDigest(record:AppConnectionSessionRecord,reply:Extract<AppConnectionUpgradeRuntimeResult,{state:'connected'}>){
 const data=record.upgrade!;return sha({schema_version:'deft.app_connection_upgrade_receipt.v1',session_id:record.session_id,
  scope:record.scope,source:data.source,transport_digest:data.transport_digest,review_digest:data.review!.digest,
  account_ref:reply.account.account_ref,custody_generation:reply.custody_generation,runtime_session_ref:reply.runtime_session_ref});
}
export function connectionUpgradeClosureDigest(record:AppConnectionSessionRecord){const data=record.upgrade!;
 return sha({schema_version:'deft.app_connection_upgrade_closure.v1',session_id:record.session_id,scope:record.scope,source:data.source,
  transport_digest:data.transport_digest,review_expires_at:data.review_expires_at,action_consents:record.action_consents,
  review_digest:data.review!.digest,reason:'callback_expired',custody_generation:data.review!.custody_generation+1});
}
/** OAuth adds capability only after separate current owner review. Every
 * uncertain Begin/callback is retained; status never repeats either operation. */
export class AppConnectionUpgradeService{
 private lastClock=0;
 constructor(private readonly ports:AppConnectionUpgradePorts,private readonly now=Date.now){}
 private clock(){this.lastClock=Math.max(this.lastClock,this.now());return this.lastClock;}
 private locator(record:AppConnectionSessionRecord){return {org_id:record.scope.org_id,owner_user_id:record.scope.owner_user_id,session_id:record.session_id};}
 private nomination(record:AppConnectionSessionRecord){return {installation_id:record.scope.installation_id,target_key:record.scope.target_key};}
 private async read(caller:ExperienceCaller,id:string){const raw=await this.ports.store.read({org_id:caller.org_id,owner_user_id:caller.user_id,session_id:id});
  if(!raw)throw denied();const record=AppConnectionSessionRecordSchema.parse(raw);
  if(record.scope.org_id!==caller.org_id||record.scope.owner_user_id!==caller.user_id||record.session_id!==id)throw denied();return record;}
 private async authority(caller:ExperienceCaller,nomination:{installation_id:string;target_key:string},expected?:AppConnectionSessionRecord,history=false){
  const current=await this.ports.currentAuthority(caller,nomination);
  if(current.scope.org_id!==caller.org_id||current.scope.owner_user_id!==caller.user_id||current.scope.installation_id!==nomination.installation_id
    ||current.scope.target_key!==nomination.target_key||!Number.isFinite(caller.access_expires_at)||!Number.isFinite(current.expires_at)
    ||Math.min(current.expires_at,caller.access_expires_at!,appConsentDeadline(current.scope.consent_expires_at, current.scope.consent_lifetime))<=this.clock()
    ||expected&&(!isDeepStrictEqual(expected.scope,current.scope)||!isDeepStrictEqual(expected.profile,current.profile)
      ||!history&&!isDeepStrictEqual(expected.action_consents,current.action_consents)))throw denied();
  return {...current,expires_at:Math.min(current.expires_at,caller.access_expires_at!)};
 }
 private async write(prior:AppConnectionSessionRecord,change:Partial<AppConnectionSessionRecord>){
  const next=AppConnectionSessionRecordSchema.parse({...prior,...change,revision:prior.revision+1,updated_at:new Date(this.clock()).toISOString()});
  if(!await this.ports.store.compareAndSet(this.locator(prior),prior.revision,next))throw conflict();return next;
 }
 private async source(caller:ExperienceCaller,record:AppConnectionSessionRecord){const pin=record.upgrade!.source,source=await this.read(caller,pin.session_id);
  if(source.state!=='connected'||source.revision!==pin.session_revision||!isDeepStrictEqual(source.scope,pin.scope)
   ||source.runtime_session_ref!==pin.runtime_session_ref||source.account?.account_ref!==pin.account_ref)throw denied();return source;}
 private view(record:AppConnectionSessionRecord){const data=record.upgrade!;
  if(data.closure&&record.state==='not_connected')return AppConnectionUpgradeClosedViewSchema.parse({
   schema_version:'deft.app_connection_upgrade_closed.v1',session_id:record.session_id,scope:record.scope,state:'not_connected',account:null,
   expires_at:record.scope.consent_expires_at,source_session_id:data.source.session_id,source_revision:data.source.session_revision,
   account_ref:data.source.account_ref,review_expires_at:data.review_expires_at,closure:data.closure});
  if(record.state==='upgrade_reviewed'&&!data.begin_consumed&&data.review)return AppConnectionUpgradeReviewViewSchema.parse({
   schema_version:'deft.app_connection_upgrade_review.v1',session_id:record.session_id,source_session_id:data.source.session_id,
   source_revision:data.source.session_revision,scope:record.scope,account:data.review.account,custody_generation:data.review.custody_generation,
   action_consents:record.action_consents,review_digest:data.review.digest,expires_at:data.review_expires_at});
  return AppConnectionSessionViewSchema.parse({schema_version:'deft.app_connection_session.v1',session_id:record.session_id,
   scope:record.scope,state:['connected','not_connected','disconnected','awaiting_callback'].includes(record.state)?record.state:'indeterminate',
   account:record.account,expires_at:record.state==='awaiting_callback'?record.callback_expires_at:record.scope.consent_expires_at});
 }
 private request(record:AppConnectionSessionRecord,operation:AppConnectionUpgradeRuntimeRequest['operation'],deadline:number,extra:Record<string,unknown>={}){
  const data=record.upgrade!;return AppConnectionUpgradeRuntimeRequestSchema.parse({schema_version:'deft.app_connection_upgrade_runtime.v1',
   session_id:record.session_id,scope:record.scope,source:data.source,transport_digest:data.transport_digest,
   review_expires_at:data.review_expires_at,expires_at:new Date(deadline).toISOString(),action_consents:record.action_consents,operation,
   ...(operation==='prepare'?{}:{review:data.review}),...(operation==='status'?{runtime_session_ref:record.runtime_session_ref,
    ...(data.begin_consumed&&!data.receipt&&Date.parse(data.review_expires_at)<=this.clock()&&Date.parse(record.callback_expires_at)<=this.clock()?{close_expired:true}:{})}:{}),...extra});
 }
 private async invoke(caller:ExperienceCaller,record:AppConnectionSessionRecord,operation:AppConnectionUpgradeRuntimeRequest['operation'],extra:Record<string,unknown>={}){
  const history=operation==='status',authority=await this.authority(caller,this.nomination(record),record,history),data=record.upgrade!;
  let deadline=Math.min(this.clock()+30_000,authority.expires_at,appConsentDeadline(record.scope.consent_expires_at, record.scope.consent_lifetime),
   history?Infinity:Date.parse(data.review_expires_at),...(history?[]:record.action_consents!.map(item=>appConsentDeadline(item.expires_at,item.consent_lifetime))));
  if(deadline<=this.clock())throw denied();
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,committed:AppConnectionSessionRecord|undefined;
  let rejectTimeout:((error:unknown)=>void)|undefined;
  const arm=()=>{if(timer)clearTimeout(timer);timer=setTimeout(()=>{controller.abort();rejectTimeout?.(denied());},Math.max(1,deadline-this.clock()));};
  try{const timeout=new Promise<never>((_,reject)=>{rejectTimeout=reject;arm();});
   const work=(async()=>{const source=await this.source(caller,record);
    if(await this.ports.transportDigest(source)!==data.transport_digest||await this.ports.transportDigest(record)!==data.transport_digest)throw denied();
    if(!history||data.begin_consumed&&!data.receipt&&Date.parse(data.review_expires_at)<=this.clock())await this.ports.assertNoActiveEffects(source,authority,record.session_id);
    const current=await this.authority(caller,this.nomination(record),record,history);deadline=Math.min(deadline,current.expires_at);
    if(deadline<=this.clock())throw denied();arm();controller.signal.throwIfAborted();
    return this.ports.requestRuntime(record,this.request(record,operation,deadline,extra),controller.signal);})();
   const reply=AppConnectionUpgradeRuntimeResultSchema.parse(await Promise.race([work,timeout]));
   if(reply.session_id!==record.session_id||deadline<=this.clock())throw denied();
   await this.authority(caller,this.nomination(record),record,history);await this.source(caller,record);
   if(reply.state==='eligible'){
    if(!['prepare','status'].includes(operation)||data.begin_consumed||record.callback_consumed||data.receipt||reply.account.account_ref!==data.source.account_ref)throw denied();
    const eligibility={account:reply.account,custody_generation:reply.custody_generation,custody_digest:reply.custody_digest};
    const review={...eligibility,digest:connectionUpgradeReviewDigest(record,eligibility)};
    if(data.review&&!isDeepStrictEqual(data.review,review))throw denied();
    committed=await this.write(record,{state:Date.parse(data.review_expires_at)<=this.clock()?'not_connected':'upgrade_reviewed',upgrade:{...data,review}});
   }else if(reply.state==='awaiting_callback'){
    if(operation!=='begin'||new URL(reply.authorization_url).origin!==record.profile.authorization_origin)throw denied();
    committed=await this.write(record,{state:'awaiting_callback',runtime_session_ref:reply.runtime_session_ref});
   }else if(reply.state==='connected'){
    if(!['callback','status'].includes(operation)||!data.begin_consumed||!record.callback_consumed||!data.review
      ||reply.account.account_ref!==data.source.account_ref||!isDeepStrictEqual(reply.account,data.review.account)
      ||reply.custody_generation!==data.review.custody_generation+1||reply.receipt_digest!==connectionUpgradeReceiptDigest(record,reply)
      ||operation==='callback'&&(extra.callback as {outcome:string})?.outcome==='denied')throw denied();
    const receipt={custody_generation:reply.custody_generation,receipt_digest:reply.receipt_digest};
    if(data.receipt&&!isDeepStrictEqual(data.receipt,receipt))throw denied();
    committed=await this.write(record,{state:'connected',account:reply.account,runtime_session_ref:reply.runtime_session_ref,upgrade:{...data,receipt}});
   }else if(reply.state==='expired'){
    // Host consumption fences replay; this proof certifies that the Runtime
    // never started the provider exchange. Keep the consumed flag immutable.
    if(operation!=='status'||!data.begin_consumed||!data.review||data.receipt
     ||Date.parse(data.review_expires_at)>this.clock()||Date.parse(record.callback_expires_at)>this.clock()
     ||reply.closure.custody_generation!==data.review.custody_generation+1||reply.closure.receipt_digest!==connectionUpgradeClosureDigest(record))throw denied();
    if(data.closure&&!isDeepStrictEqual(data.closure,reply.closure))throw denied();
    committed=await this.write(record,{state:'not_connected',upgrade:{...data,closure:reply.closure}});
   }else if(reply.state==='not_connected'){
    if(!['callback','status'].includes(operation)||data.begin_consumed)throw denied();
    committed=await this.write(record,{state:'not_connected'});
   }else committed=await this.write(record,{state:'indeterminate'});
   await this.authority(caller,this.nomination(committed),committed,history);
   if(deadline<=this.clock())throw denied();controller.signal.throwIfAborted();
   if(reply.state==='awaiting_callback')return AppConnectionUpgradeBegunSchema.parse({...this.view(committed),
    schema_version:'deft.app_connection_upgrade_session.v1',state:'awaiting_callback',callback_state:extra.callback_state,authorization_url:reply.authorization_url});
   return this.view(committed);
  }catch(error){if(!committed)committed=await this.write(record,{state:'indeterminate'});
   if(error instanceof AppError&&error.code==='APP_ACCESS_DENIED')throw error;
   await this.authority(caller,this.nomination(committed),committed,history);return this.view({...committed,state:'indeterminate'});
  }finally{if(timer)clearTimeout(timer);controller.abort();}
 }
 async review(caller:ExperienceCaller,raw:unknown){const input=AppConnectionUpgradeReviewRequestSchema.parse(raw),authority=await this.authority(caller,input);
  const source=await this.read(caller,input.source_session_id),a=source.scope,b=authority.scope;
  if(source.state!=='connected'||!source.account||!source.runtime_session_ref||source.upgrade&&!source.upgrade.receipt
   ||['org_id','owner_user_id','installation_id','target_key','resource_key','operator_user_id'].some(key=>a[key as keyof typeof a]!==b[key as keyof typeof b])
   ||['provider_id','credential_custody','runtime_requirement_key','resource_key','operator_user_id'].some(key=>source.profile[key as keyof typeof source.profile]!==authority.profile[key as keyof typeof authority.profile]))throw denied();
  await this.ports.assertNoActiveEffects(source,authority);
  const now=this.clock(),expiry=Math.min(now+300_000,authority.expires_at,appConsentDeadline(b.consent_expires_at, b.consent_lifetime),...authority.action_consents.map(item=>appConsentDeadline(item.expires_at,item.consent_lifetime)));
  const record=AppConnectionSessionRecordSchema.parse({session_id:input.request_id,revision:0,scope:b,profile:authority.profile,
   state:'starting',callback_state_hash:stateHash(randomBytes(32).toString('base64url')),callback_consumed:false,callback_expires_at:new Date(expiry).toISOString(),
   runtime_session_ref:null,account:null,created_at:new Date(now).toISOString(),updated_at:new Date(now).toISOString(),action_consents:authority.action_consents,
   upgrade:{schema_version:'deft.app_connection_upgrade.v1',source:{session_id:source.session_id,session_revision:source.revision,scope:a,
    runtime_session_ref:source.runtime_session_ref,account_ref:source.account.account_ref},transport_digest:await this.ports.transportDigest(source),
    review_expires_at:new Date(expiry).toISOString(),begin_consumed:false,review:null,receipt:null}});
  if(await this.ports.transportDigest(record)!==record.upgrade!.transport_digest)throw denied();
  if(!await this.ports.store.create(record))throw conflict();return this.invoke(caller,record,'prepare');
 }
 async begin(caller:ExperienceCaller,raw:unknown){const input=AppConnectionUpgradeBeginRequestSchema.parse(raw),prior=await this.read(caller,input.session_id),data=prior.upgrade;
  if(!data?.review||prior.state!=='upgrade_reviewed'||data.begin_consumed||data.review.digest!==input.review_digest||Date.parse(data.review_expires_at)<=this.clock())throw conflict();
  const authority=await this.authority(caller,this.nomination(prior),prior);
  this.assertAdmissionWindow(prior,authority);
  // Exactly one Begin CAS sets the nonce hash and consumes the Begin intent.
  // A missing acknowledgement permanently fences another Begin.
  const nonce=randomBytes(32).toString('base64url');
  const record=await this.write(prior,{state:'upgrade_starting',upgrade:{...data,begin_consumed:true},callback_state_hash:stateHash(nonce)});
  return this.invoke(caller,record,'begin',{callback_state:nonce});
 }
 async callback(caller:ExperienceCaller,raw:unknown){const input=AppConnectionUpgradeCallbackRequestSchema.parse(raw),prior=await this.read(caller,input.session_id);
  if(!prior.upgrade?.begin_consumed||!prior.upgrade.review||prior.state!=='awaiting_callback'||prior.callback_consumed||!prior.runtime_session_ref
   ||Date.parse(prior.callback_expires_at)<=this.clock()||!timingSafeEqual(Buffer.from(prior.callback_state_hash,'hex'),Buffer.from(stateHash(input.state),'hex')))throw conflict();
  const authority=await this.authority(caller,this.nomination(prior),prior);
  this.assertAdmissionWindow(prior,authority);
  const record=await this.write(prior,{state:'connecting',callback_consumed:true});
  return this.invoke(caller,record,'callback',{runtime_session_ref:prior.runtime_session_ref,callback:input.outcome==='authorized'?{outcome:'authorized',code:input.code}:{outcome:'denied'}});
 }
 private assertAdmissionWindow(record:AppConnectionSessionRecord,authority:AppConnectionSessionAuthority){
  // Authority resolution may outlive the initial expiry check. Reserve a full
  // bounded Runtime request window before durably consuming Begin or callback.
  const deadline=Math.min(authority.expires_at,Date.parse(record.callback_expires_at),Date.parse(record.upgrade!.review_expires_at),
   appConsentDeadline(record.scope.consent_expires_at,record.scope.consent_lifetime),
   ...record.action_consents!.map(item=>appConsentDeadline(item.expires_at,item.consent_lifetime)));
  if(deadline-this.clock()<30_000)throw conflict();
 }
 async status(caller:ExperienceCaller,raw:unknown){const input=AppConnectionUpgradeStatusRequestSchema.parse(raw),prior=await this.read(caller,input.session_id);
  if(!prior.upgrade)throw conflict();await this.authority(caller,this.nomination(prior),prior,true);
  // A published receipt completed the custody move. Later ordinary management
  // uncertainty must never be resolved by resurrecting the upgrade journal.
  if(prior.upgrade.receipt)return this.view(prior);
  if(['connected','not_connected','disconnected'].includes(prior.state))return this.view(prior);
  if(prior.state==='awaiting_callback'&&Date.parse(prior.callback_expires_at)>this.clock())return this.view(prior);
  return this.invoke(caller,await this.write(prior,{state:'upgrade_checking'}),'status');
 }
}
