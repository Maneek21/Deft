import {appConsentDeadline} from '@deft/app-kit';
import {and,eq,inArray,notInArray,or,ne} from 'drizzle-orm';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {AppConnectionUpgradeAuthorityRequestSchema,AppConnectionUpgradeAuthorityResultSchema,
 AppConnectionRuntimeV2AuthorityRequestSchema,AppConnectionRuntimeV2AuthorityResultSchema} from '@deft/app-kit';
import {appRuns,appRunAttempts,appRuntimeBindings,appConnectionSessions} from '@deft/db/schema';
import {db} from './db.js';
import {AppError} from './app-errors.js';
import {isAppOwnerConnectionsEnabled} from './env.js';
import {currentAppConnectionSessionV2Authority,retainedWebGuard} from './app-connection-session-authority.js';
import {getAppConnectionSessionRegistry} from './app-connection-session-registry.js';
import {PostgresAppConnectionSessionStore,connectionSessionAdmissionFence} from './app-connection-session-store.js';
import {AppConnectionSessionRecordSchema,type AppConnectionSessionRecord,type AppConnectionSessionAuthority} from './app-connection-session-service.js';
import type {AppConnectionUpgradePorts} from './app-connection-upgrade-service.js';
import type {ExperienceCaller} from './app-experience-service.js';
import type {WebAuthorityGuard} from './app-resource-sync-web-authority.js';
const denied=()=>new AppError('Account upgrade access ended','APP_ACCESS_DENIED',403);
const enabled=()=>{if(process.env.DEFT_APPS_ENABLED!=='true'||!isAppOwnerConnectionsEnabled())throw denied();};
// Host callback consumption prevents replay. Only the Runtime can certify that
// provider exchange never started; status authority permits asking for that
// proof after both deadlines, without authorizing another callback.
export function appConnectionUpgradeExpiredClosureAllowed(record:AppConnectionSessionRecord,now:number){
 const data=record.upgrade;
 return !!data?.begin_consumed&&!!data.review&&!data.receipt
  &&Date.parse(data.review_expires_at)<=now&&Date.parse(record.callback_expires_at)<=now;
}
export async function assertNoActiveConnectionUpgradeEffects(source:AppConnectionSessionRecord,target:AppConnectionSessionAuthority,sessionId?:string){
 enabled();await db.transaction(async tx=>{
  const [competing]=await tx.select({id:appConnectionSessions.session_id}).from(appConnectionSessions).where(and(
   connectionSessionAdmissionFence(target.scope,new Date(),sessionId),ne(appConnectionSessions.session_id,source.session_id))).limit(1);
  const resources=[source.scope.resource_binding_id,target.scope.resource_binding_id];
  const bindings=await tx.select({id:appRuntimeBindings.id}).from(appRuntimeBindings).where(and(eq(appRuntimeBindings.org_id,target.scope.org_id),
   eq(appRuntimeBindings.app_installation_id,target.scope.installation_id),inArray(appRuntimeBindings.owner_resource_binding_id,resources)));
  const where=and(eq(appRuns.org_id,target.scope.org_id),eq(appRuns.origin_app_installation_id,target.scope.installation_id),
   or(inArray(appRuns.origin_resource_binding_id,resources),bindings.length?inArray(appRuns.origin_runtime_binding_id,bindings.map(row=>row.id)):undefined));
  const [run]=await tx.select({id:appRuns.id}).from(appRuns).where(and(where,inArray(appRuns.state,['pending','pending_approval','running','waiting_external','unknown_outcome']))).limit(1);
  const [attempt]=await tx.select({id:appRunAttempts.id}).from(appRunAttempts).innerJoin(appRuns,and(eq(appRuns.org_id,appRunAttempts.org_id),eq(appRuns.id,appRunAttempts.run_id)))
   .where(and(where,notInArray(appRuns.state,['succeeded','failed','cancelled','expired']),inArray(appRunAttempts.state,['pending','claimed','provider_call_started','unknown_outcome']))).limit(1);
  if(competing||run||attempt)throw denied();
 });
}
export function productionAppConnectionUpgradePorts(caller:ExperienceCaller,guard:WebAuthorityGuard):AppConnectionUpgradePorts{
 return {store:new PostgresAppConnectionSessionStore(db,caller),currentAuthority:async(activeCaller,nomination)=>{
   enabled();const current=await currentAppConnectionSessionV2Authority(activeCaller,nomination,guard);enabled();return current;},
  transportDigest:async record=>(await getAppConnectionSessionRegistry()).transportDigest(record.scope.org_id,record.scope.installation_id,record.profile),
  requestRuntime:async(record,input,signal)=>(await getAppConnectionSessionRegistry()).upgradeRuntime(record.scope,record.profile).request(input,signal),
  assertNoActiveEffects:assertNoActiveConnectionUpgradeEffects};
}
export async function appConnectionUpgradeRuntimeAuthority(raw:unknown,authorization:string|undefined){
 enabled();const input=AppConnectionUpgradeAuthorityRequestSchema.parse(raw),registry=await getAppConnectionSessionRegistry();registry.authenticate(input.scope,authorization);
 const store=new PostgresAppConnectionSessionStore(),locator={org_id:input.scope.org_id,owner_user_id:input.scope.owner_user_id,session_id:input.session_id};
 const row=await store.metadata(locator);if(!row)throw denied();
 const record=AppConnectionSessionRecordSchema.parse(row.record),data=record.upgrade;
 const states={prepare:'starting',begin:'upgrade_starting',callback:'connecting',status:'upgrade_checking'};
 if(!data||record.revision!==row.revision||record.state!==states[input.operation]||!isDeepStrictEqual(record.scope,input.scope)
  ||!isDeepStrictEqual(data.source,input.source)||data.transport_digest!==input.transport_digest||data.review_expires_at!==input.review_expires_at
  ||!isDeepStrictEqual(record.action_consents,input.action_consents)||input.operation!=='prepare'&&!isDeepStrictEqual(data.review,input.review)
  ||['begin','callback'].includes(input.operation)&&!data.begin_consumed||input.operation==='callback'&&!record.callback_consumed)throw denied();
 if(input.operation==='status'&&input.close_expired&&!appConnectionUpgradeExpiredClosureAllowed(record,Date.now()))throw denied();
 if(input.operation==='begin'&&createHash('sha256').update(input.callback_state).digest('hex')!==record.callback_state_hash
  ||(input.operation==='callback'||input.operation==='status')&&input.runtime_session_ref!==record.runtime_session_ref)throw denied();
 const caller={org_id:locator.org_id,user_id:locator.owner_user_id,sid:row.web_session_id,access_expires_at:row.access_expires_at.getTime()};
 const current=await productionAppConnectionUpgradePorts(caller,retainedWebGuard(caller)).currentAuthority(caller,{installation_id:record.scope.installation_id,target_key:record.scope.target_key});
 if(!isDeepStrictEqual(current.scope,record.scope)||!isDeepStrictEqual(current.profile,record.profile)
  ||input.operation!=='status'&&!isDeepStrictEqual(current.action_consents,record.action_consents)
  ||registry.transportDigest(record.scope.org_id,record.scope.installation_id,record.profile)!==data.transport_digest)throw denied();
 const source=await store.read({org_id:locator.org_id,owner_user_id:locator.owner_user_id,session_id:data.source.session_id});
 if(!source||source.state!=='connected'||source.revision!==data.source.session_revision||!isDeepStrictEqual(source.scope,data.source.scope)
  ||source.runtime_session_ref!==data.source.runtime_session_ref||source.account?.account_ref!==data.source.account_ref
  ||registry.transportDigest(source.scope.org_id,source.scope.installation_id,source.profile)!==data.transport_digest)throw denied();
 if(input.operation!=='status'||input.close_expired)await assertNoActiveConnectionUpgradeEffects(source,current,record.session_id);
 const expiry=Math.min(Date.parse(input.expires_at),current.expires_at,appConsentDeadline(record.scope.consent_expires_at, record.scope.consent_lifetime),
  input.operation==='status'?Infinity:Date.parse(data.review_expires_at),...(input.operation==='status'?[]:input.action_consents.map(item=>appConsentDeadline(item.expires_at,item.consent_lifetime))));
 const after=await store.metadata(locator),sourceAfter=await store.metadata({org_id:locator.org_id,owner_user_id:locator.owner_user_id,session_id:source.session_id});
 if(expiry<=Date.now()||after?.revision!==row.revision||sourceAfter?.revision!==source.revision)throw denied();enabled();
 registry.authenticate(current.scope,authorization);return AppConnectionUpgradeAuthorityResultSchema.parse({...input,allowed:true,expires_at:new Date(expiry).toISOString()});
}
export async function appConnectionRuntimeV2Authority(raw:unknown,authorization:string|undefined){
 enabled();const input=AppConnectionRuntimeV2AuthorityRequestSchema.parse(raw),registry=await getAppConnectionSessionRegistry();registry.authenticate(input.scope,authorization);
 const store=new PostgresAppConnectionSessionStore(),locator={org_id:input.scope.org_id,owner_user_id:input.scope.owner_user_id,session_id:input.session_id};
 const row=await store.metadata(locator);if(!row)throw denied();const record=AppConnectionSessionRecordSchema.parse(row.record);
 const states={begin:'starting',callback:'connecting',status:'checking',disconnect:'disconnecting'};
 if((record.upgrade||record.credential_repair)&&['begin','callback'].includes(input.operation)||record.state!==states[input.operation]||record.revision!==row.revision
  ||!isDeepStrictEqual(record.scope,input.scope)||!isDeepStrictEqual(record.action_consents,input.action_consents)
  ||input.operation==='callback'&&!record.callback_consumed)throw denied();
 const caller={org_id:locator.org_id,user_id:locator.owner_user_id,sid:row.web_session_id,access_expires_at:row.access_expires_at.getTime()};
 const current=await currentAppConnectionSessionV2Authority(caller,{installation_id:record.scope.installation_id,target_key:record.scope.target_key},retainedWebGuard(caller));
 const expiry=Math.min(Date.parse(input.expires_at),current.expires_at,appConsentDeadline(record.scope.consent_expires_at, record.scope.consent_lifetime),
  ...(['begin','callback'].includes(input.operation)?[Date.parse(record.callback_expires_at),...input.action_consents.map(item=>appConsentDeadline(item.expires_at,item.consent_lifetime))]:[]));
 if(!isDeepStrictEqual(current.scope,record.scope)||['begin','callback'].includes(input.operation)&&!isDeepStrictEqual(current.action_consents,record.action_consents)
  ||(await store.metadata(locator))?.revision!==row.revision||expiry<=Date.now())throw denied();enabled();
 return AppConnectionRuntimeV2AuthorityResultSchema.parse({...input,allowed:true,expires_at:new Date(expiry).toISOString()});
}
