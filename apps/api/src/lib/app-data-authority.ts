import {parseAppAuthorityManifest} from './app-authority-manifest.js';
import {collectAppDataContext} from './app-data-context-collection.js';
import {withAppDataDiagnostic,measureAppDataPhase} from './app-data-diagnostics.js';
import {appConsentDeadline,type AppConsentLifetime} from '@deft/app-kit/core';
import {validateContinuationCarrier} from './app-connection-consent-continuation-fence.js';
import {validateStoredFormConnection} from './app-connection-form-fence.js';
import {AppRecordChangeAuthorityRequestSchema,AppRecordChangeAuthorityResultSchema} from '@deft/app-kit/core';
import {verifiedRetainedPreparedRecordAction} from './app-data-prepared-effect.js';
import {sameRecordChangeAuthority} from './app-data-record-change-guards.js';
import {and,eq,sql,desc} from 'drizzle-orm';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {AppDataConnectionSchema,AppDataConsentSnapshotSchema,AppDataRuntimeAuthorityRequestSchema,AppDataRuntimeAuthorityResultSchema,
  canonicalAppDataJson,AppResourceActionReleasedInputSchema,
  type AppDataResult} from '@deft/app-kit/core';
import {appVersions,appGrantSnapshots,webSessions,users,orgMembers,appDataInvocations} from '@deft/db/schema';
import {db} from './db.js';
import {AppError} from './app-errors.js';
import {currentAppConnectionReadAuthority,type CurrentAppConnectionReviewedDeclarations} from './app-connection-session-authority.js';
import {appDataConnectionActionSelection,appDataRuntimeConnectionActionSelection,appDataRuntimeUsesTransportPreauthentication} from './app-data-read-authority.js';
import {readSavedAppDataConnection} from './app-data-connection-read.js';
import {getAppConnectionSessionRegistry} from './app-connection-session-registry.js';
import {appDataConsentConnections} from './app-data-consent-repair.js';
import {PostgresAppDataStore} from './app-data-store.js';
import type {ExperienceCaller} from './app-experience-service.js';
import type {WebAuthorityGuard} from './app-resource-sync-web-authority.js';
import {isAppOwnerConnectionsEnabled} from './env.js';
import {appConnectionUpgradeSourceIsAvailable} from './app-connection-upgrade-fence.js';
export const appDataDenied=()=>new AppError('App data access ended','APP_ACCESS_DENIED',403);
export const appDataDigest=(value:unknown)=>`sha256:${createHash('sha256').update(canonicalAppDataJson(value)).digest('hex')}`;
export function appDataRetainedGuard(caller:ExperienceCaller):WebAuthorityGuard {
 let expiry=caller.access_expires_at??0;return Object.assign(async(tx:Parameters<WebAuthorityGuard>[0])=>{
  const [member]=await tx.select({is_active:orgMembers.is_active,role:orgMembers.role}).from(orgMembers).where(and(eq(orgMembers.org_id,caller.org_id),eq(orgMembers.user_id,caller.user_id))).for('share');
  const [human]=await tx.select({kind:users.kind}).from(users).where(eq(users.id,caller.user_id));
  const [session]=await tx.select({revoked_at:webSessions.revoked_at,expires_at:webSessions.expires_at}).from(webSessions).where(and(eq(webSessions.id,caller.sid),eq(webSessions.org_id,caller.org_id),eq(webSessions.user_id,caller.user_id))).for('share');
  if(!member?.is_active||member.role==='guest'||human?.kind!=='human'||!session||session.revoked_at)throw appDataDenied();
  expiry=Math.min(expiry,session.expires_at.getTime());if(expiry<=Date.now())throw appDataDenied();
 },{current_web_session_expires_at:()=>new Date(expiry)});
}
async function currentAppDataBase(caller:Pick<ExperienceCaller,'org_id'|'user_id'|'access_expires_at'>,sessionId:string,guard:WebAuthorityGuard,
 requiredAction?:{action_key:string;action_binding_id:string}|'none'){
 if(process.env.DEFT_APPS_ENABLED!=='true'||!isAppOwnerConnectionsEnabled())throw appDataDenied();
 const locator={org_id:caller.org_id,owner_user_id:caller.user_id,session_id:sessionId};
 const session=await measureAppDataPhase('session_read',()=>readSavedAppDataConnection(locator));if(!session||session.state!=='connected'||!session.runtime_session_ref||!session.account)throw appDataDenied();
 if(!await db.transaction(tx=>appConnectionUpgradeSourceIsAvailable(tx,{org_id:caller.org_id,owner_user_id:caller.user_id,session_id:sessionId,purpose:'saved_read'})))throw appDataDenied();
 let reviewedDeclarations:CurrentAppConnectionReviewedDeclarations|undefined;
 const current=await measureAppDataPhase('connection_authority',()=>currentAppConnectionReadAuthority(caller,{installation_id:session.scope.installation_id,target_key:session.scope.target_key},guard,requiredAction,undefined,reviewed=>{reviewedDeclarations=reviewed;}));
 if(!isDeepStrictEqual(current.scope,session.scope)||!isDeepStrictEqual(current.profile,session.profile))throw appDataDenied();
 // The fresh current reader already checked the exact reviewed protocol and transport.
 // Reuse that proof only inside this admission; every later phase calls it again.
 const declared=current.connection_protocol;
 if(declared!=='v1'&&declared!=='v2'&&declared!=='credential_form.v1')throw appDataDenied();
 if(declared==='credential_form.v1')await db.transaction(async tx=>{if(!await validateStoredFormConnection(tx,locator,session))await validateContinuationCarrier(tx,session,true);});
 // The fresh reader can hand off immutable bytes only from this exact admission.
 // Later authority phases always call it again; nothing is placed on the public result.
 let manifest:ReturnType<typeof parseAppAuthorityManifest>,grantStores:unknown;
 if(reviewedDeclarations){
  if(!isDeepStrictEqual(reviewedDeclarations.scope,current.scope))throw appDataDenied();
  manifest=reviewedDeclarations.manifest;grantStores=reviewedDeclarations.grant_record_stores;
 }else{
  const [declarationsRow]=await db.select({manifest:appVersions.manifest,canonical_snapshot:appGrantSnapshots.canonical_snapshot}).from(appVersions)
   .innerJoin(appGrantSnapshots,and(eq(appGrantSnapshots.org_id,caller.org_id),eq(appGrantSnapshots.id,current.scope.grant_snapshot_id)))
   .where(and(eq(appVersions.org_id,caller.org_id),eq(appVersions.id,current.scope.app_version_id)));
  if(!declarationsRow)throw appDataDenied();
  manifest=parseAppAuthorityManifest(declarationsRow.manifest,{org_id:caller.org_id,app_version_id:current.scope.app_version_id});
  grantStores=(declarationsRow.canonical_snapshot as Record<string,unknown>).record_stores??[];
 }
 const declarations=manifest.record_stores??[];if(!isDeepStrictEqual(declarations,grantStores))throw appDataDenied();
 const policy=manifest.owner_connections?.find(item=>item.resource_key===current.scope.resource_key&&item.provider_profile_key===current.profile.key
  &&item.runtime_requirement_key===current.profile.runtime_requirement_key);if(!policy)throw appDataDenied();
 const connection=AppDataConnectionSchema.parse({session_id:sessionId,session_revision:session.revision,runtime_session_ref:session.runtime_session_ref,account_ref:session.account.account_ref});
 const consentConnections=await measureAppDataPhase('consent_connections',()=>appDataConsentConnections(session));
 return {locator,session,current,declarations,policy,connection,consentConnections};
}
type AppDataBase=Awaited<ReturnType<typeof currentAppDataBase>>;
function resolveAppDataStore(base:AppDataBase,storeKey:string,requireConsent:boolean|'optional',
 consentRows:Awaited<ReturnType<PostgresAppDataStore['activeConsent']>>,expectedConsentId?:string){
 const {current,declarations,policy,connection,consentConnections}=base;
 const store=declarations.find(item=>item.key===storeKey);if(!store||store.resource_key!==current.scope.resource_key||store.runtime_requirement_key!==current.profile.runtime_requirement_key)throw appDataDenied();
 const policyDigest=appDataDigest(store);let consent:null|{consent_id:string;consent_digest:string;expires_at:Date|null;consent_lifetime?:AppConsentLifetime}=null;
 if(requireConsent){const rows=consentRows;
  const valid=rows.filter(row=>{const snap=AppDataConsentSnapshotSchema.parse(row.snapshot);return (!expectedConsentId||row.consent_id===expectedConsentId)
   &&isDeepStrictEqual(snap.scope,current.scope)&&consentConnections.some(item=>item.session_id===snap.connection.session_id&&item.runtime_session_ref===snap.connection.runtime_session_ref&&item.account?.account_ref===snap.connection.account_ref&&snap.connection.session_revision<=item.revision)
   &&snap.connection.account_ref===connection.account_ref&&isDeepStrictEqual(snap.store,store)&&snap.data_policy_digest===policyDigest&&appDataDigest(snap)===row.consent_digest
   &&appConsentDeadline(row.expires_at,snap.consent_lifetime)<=appConsentDeadline(current.scope.consent_expires_at,current.scope.consent_lifetime)
   &&(snap.consent_lifetime==='until_revoked'?policy.allow_until_revoked===true:row.expires_at!.getTime()<=row.created_at.getTime()+policy.max_consent_seconds*1000);});
  if(rows.length!==valid.length||valid.length>1||valid.length===0&&(requireConsent===true||expectedConsentId!==undefined))throw appDataDenied();consent=valid[0]?{...valid[0],...(AppDataConsentSnapshotSchema.parse(valid[0].snapshot).consent_lifetime?{consent_lifetime:'until_revoked' as const}:{})}:null;
 }
 const expires_at=Math.min(current.expires_at,appConsentDeadline(current.scope.consent_expires_at,current.scope.consent_lifetime),consent?appConsentDeadline(consent.expires_at,consent.consent_lifetime):Infinity);
 if(expires_at<=Date.now())throw appDataDenied();return {...current,store,connection,consent,consent_connection_ids:consentConnections.map(item=>item.session_id),data_policy_digest:policyDigest,expires_at,
  consent_max_seconds:policy.max_consent_seconds,allow_until_revoked:policy.allow_until_revoked};
}
async function finishAppDataBase(base:AppDataBase){
 const after=await readSavedAppDataConnection(base.locator);
 if(!after||after.state!=='connected'||after.revision!==base.session.revision||base.current.expires_at<=Date.now())throw appDataDenied();
}
export async function currentAppDataAuthority(caller:Pick<ExperienceCaller,'org_id'|'user_id'|'access_expires_at'>,sessionId:string,storeKey:string,guard:WebAuthorityGuard,
 requireConsent:boolean|'optional',expectedConsentId?:string,requiredAction?:{action_key:string;action_binding_id:string}|'none'){
 const base=await currentAppDataBase(caller,sessionId,guard,requiredAction);
 const rows=requireConsent?await measureAppDataPhase('consent_read',()=>new PostgresAppDataStore(caller).activeConsent(base.consentConnections.map(item=>item.session_id),storeKey)):[];
 const result=resolveAppDataStore(base,storeKey,requireConsent,rows,expectedConsentId);
 await finishAppDataBase(base);if(result.expires_at<=Date.now())throw appDataDenied();return result;
}

/** Context-only batch. Connection authority is checked twice per account;
 * every store still gets its own current consent/policy validation. This does
 * not authorize later requests, cache a grant, or supply action authority. */
export async function currentAppDataContext(caller:Pick<ExperienceCaller,'org_id'|'user_id'|'access_expires_at'>,sessionId:string,guard:WebAuthorityGuard,
 options:{storeKey?:string;includeIdentities?:boolean},metadata:(store:string)=>Promise<NonNullable<AppDataResult['identities']>>){
 const selected=(base:AppDataBase)=>{
  const requested=options.storeKey===undefined?undefined:base.declarations.find(item=>item.key===options.storeKey&&item.resource_key===base.current.scope.resource_key);
  const keys=options.storeKey===undefined?null:new Set([options.storeKey,...(requested?.record_changes??[]).map(change=>change.source_store_key)]);
  return base.declarations.filter(item=>item.resource_key===base.current.scope.resource_key&&(!keys||keys.has(item.key)));
 };
 const result=await collectAppDataContext({
  capture:()=>currentAppDataBase(caller,sessionId,guard,'none'),
  identity:base=>({scope:base.current.scope,profile:base.current.profile,connection:base.connection,declarations:base.declarations,policy:base.policy,consentConnections:base.consentConnections}),
  metadata:async base=>{if(options.includeIdentities===false)return [];for(const declaration of selected(base)){
   try{const identities=await metadata(declaration.key);if(identities.length)return identities;}catch(error){if(!(error instanceof AppError))throw error;}
  }return [];},
  stores:async base=>{
   const declarations=selected(base),keys=declarations.map(item=>item.key);
   if(!keys.length)return [];
   const rows=await measureAppDataPhase('consent_read',()=>new PostgresAppDataStore(caller).activeConsents(base.consentConnections.map(item=>item.session_id),keys));
   const stores=[];for(const declaration of declarations){try{
    const authority=resolveAppDataStore(base,declaration.key,'optional',rows.filter(row=>row.store_key===declaration.key));
    stores.push(authority);
   }catch(error){if(!(error instanceof AppError))throw error;}}
   return stores;
  },finish:finishAppDataBase,denied:appDataDenied,
 });
 return {session:result.base.session,authorities:result.stores,identities:result.identities};
}
export type CurrentAppDataAuthority=Awaited<ReturnType<typeof currentAppDataAuthority>>;
export function appDataRequiresConsent(operation:string){return !operation.startsWith('resource_')&&operation!=='connection_metadata'&&!['run_inspect','run_inspection_status'].includes(operation);}
export async function appDataRuntimeAuthority(raw:unknown,authorization:string|undefined){const id=raw&&typeof raw==='object'&&(raw as Record<string,unknown>).request_id;return withAppDataDiagnostic('authority',()=>appDataRuntimeAuthorityOwned(raw,authorization),typeof id==='string'?id:undefined);}
async function appDataRuntimeAuthorityOwned(raw:unknown,authorization:string|undefined){
 if(raw&&typeof raw==='object'&&(raw as Record<string,unknown>).schema_version==='deft.app_data_authority.v2')return appRecordChangeRuntimeAuthority(raw,authorization);
 const delegated=await (await import('./app-integration-runtime-gateway.js')).maybeAppIntegrationDataRuntimeAuthority(raw,authorization);if(delegated)return delegated;
 const input=AppDataRuntimeAuthorityRequestSchema.parse(raw);
 if(appDataRuntimeUsesTransportPreauthentication(input.operation))await (await import('./app-connection-session-registry.js')).preauthenticateAppConnectionTransport(input.scope,authorization);
 else (await getAppConnectionSessionRegistry()).authenticate(input.scope,authorization);
 const owner={org_id:input.scope.org_id,user_id:input.scope.owner_user_id},store=new PostgresAppDataStore(owner),row=await store.invocation(input.request_id);
 if(!row||row.state!=='inflight'||!isDeepStrictEqual({...row.context,expires_at:input.expires_at},input)
  ||Date.parse(input.expires_at)>row.expires_at.getTime()||row.expires_at.getTime()<=Date.now())throw appDataDenied();
 const caller={...owner,sid:row.web_session_id,access_expires_at:row.access_expires_at.getTime()};
 // Resource-plan introspection returns only data authority. The trusted review and
 // released Run independently capture current action grants; recapturing every
 // unrelated action here adds serialized work without changing this response.
 // Store selectors are retained in the declaration linked by the exact policy
 // digest; no author value or nomination travels through introspection.
 const [version]=await db.select({manifest:appVersions.manifest}).from(appVersions).where(and(eq(appVersions.org_id,owner.org_id),eq(appVersions.id,input.scope.app_version_id)));
 const declaration=parseAppAuthorityManifest(version?.manifest,{org_id:owner.org_id,app_version_id:input.scope.app_version_id}).record_stores?.find(item=>appDataDigest(item)===input.authority.data_policy_digest);
 if(!declaration)throw appDataDenied();
 const current=await currentAppDataAuthority(caller,input.connection.session_id,declaration.key,appDataRetainedGuard(caller),input.operation==='connection_metadata'?input.authority.consent_id!==null:appDataRequiresConsent(input.operation),input.authority.consent_id??undefined,appDataRuntimeConnectionActionSelection(input.operation));
 if(['prepared_action_commit','prepared_action_restore'].includes(input.operation)){
  const {assertFutureRecordActionLocalRequest,futureRecordActionLocalInput}=await import('./app-future-record-action-local.js');
  await db.transaction(async tx=>{
   const phase=input.operation==='prepared_action_commit'?'commit':'restore';
   const result=await tx.execute(sql`SELECT * FROM app_future_record_action_releases WHERE org_id=${owner.org_id} AND owner_user_id=${owner.user_id} AND ${phase==='commit'?sql`freeze_request_id`:sql`restore_request_id`}=${input.request_id}`);
   const {decodeFutureReleaseRow}=await import('./app-future-record-action-store.js');const future=result.rows[0]?decodeFutureReleaseRow(result.rows[0]):undefined;
   if(!future)throw appDataDenied();const localInput=futureRecordActionLocalInput(future,phase);
   if(appDataDigest({operation:input.operation,input:localInput})!==input.input_digest)throw appDataDenied();
   await assertFutureRecordActionLocalRequest(tx,current,input.request_id,input.operation,localInput);
  });
 }
 const pins={consent_id:current.consent?.consent_id??null,consent_digest:current.consent?.consent_digest??null,data_policy_digest:current.data_policy_digest};
 if(!isDeepStrictEqual(current.scope,input.scope)||!isDeepStrictEqual(current.connection,input.connection)||!isDeepStrictEqual(pins,input.authority))throw appDataDenied();
 if(['run_inspect','run_inspection_status'].includes(input.operation)){const {assertRunInspectionInvocation}=await import('./app-run-inspection-service.js');await assertRunInspectionInvocation(caller,input.request_id,input.connection);}
 const deadline=Math.min(Date.parse(input.expires_at),row.expires_at.getTime(),current.expires_at);const after=await store.invocation(input.request_id);
 if(deadline<=Date.now()||after?.state!=='inflight'||!isDeepStrictEqual(after.context,row.context))throw appDataDenied();
 (await getAppConnectionSessionRegistry()).authenticate(input.scope,authorization);
 return AppDataRuntimeAuthorityResultSchema.parse({...input,allowed:true,expires_at:new Date(deadline).toISOString()});
}

/** Additional data proof only. The action runner must independently validate
 * its current action registration/binding, human release and owner action grant.
 * Resource and action registrations can legitimately be distinct. */
export async function authorizeReleasedAppDataAction(nomination:{org_id:string;owner_id:string;installation_id:string;
 app_version_id:string;grant_snapshot_id:string;runtime_registration_id:string;runtime_binding_id:string;operation_name:string;
 input:Record<string,string|number|boolean>;run_id?:string}):Promise<boolean>{
 try{
  const input=nomination.input;
  const integration=await (await import('./app-integration-tool-prepared.js')).authorizeReleasedIntegrationTool(nomination);
  if(integration!==null)return integration;
  if(Object.hasOwn(input,'resource_action_version'))return authorizeReleasedAppDataResourceAction(nomination);
  if(input.record_action_version!=='deft.app_prepared_record_action.v1'||typeof input.record_store_key!=='string'
   ||typeof input.connection_session_id!=='string'||!Number.isSafeInteger(input.connection_revision)
   ||typeof input.data_consent_id!=='string'||typeof input.data_consent_digest!=='string'||typeof input.prepared_digest!=='string')return false;
  const seven=['record_action_version','record_store_key','connection_session_id','connection_revision','data_consent_id','data_consent_digest','prepared_digest'];
  const preparedInput=Object.fromEntries(Object.entries(input).filter(([key])=>!seven.includes(key)));
  const future=await authorizeReleasedFutureRecordAction(nomination,preparedInput);
  if(future!==null)return future;
  const rows=await db.select().from(appDataInvocations).where(and(eq(appDataInvocations.org_id,nomination.org_id),eq(appDataInvocations.owner_user_id,nomination.owner_id),
   eq(appDataInvocations.connection_session_id,input.connection_session_id),eq(appDataInvocations.state,'completed'),
   sql`${appDataInvocations.result}->'prepared'->>'snapshot_id'=${String(input.snapshot_id)}`,
   sql`${appDataInvocations.result}->'prepared'->>'snapshot_digest'=${input.prepared_digest}`,
   sql`${appDataInvocations.result}->'prepared'->'input'=${JSON.stringify(preparedInput)}::jsonb`)).limit(1);
  const candidates=rows.filter(row=>{const prepared=row.result?.prepared as Record<string,unknown>|undefined;
   return !!prepared&&prepared.snapshot_id===input.snapshot_id&&prepared.snapshot_digest===input.prepared_digest&&prepared.action_key===nomination.operation_name&&typeof prepared.expires_at==='string'&&Date.parse(prepared.expires_at)>Date.now();});
  if(!candidates.length)return false;
  const row=candidates.find(candidate=>isDeepStrictEqual((candidate.result!.prepared as Record<string,unknown>).input,preparedInput));if(!row)return false;
  const prepared=verifiedRetainedPreparedRecordAction(row.result!.prepared,nomination.runtime_binding_id);
  if(prepared.future_release)return false;
  const caller={org_id:nomination.org_id,user_id:nomination.owner_id,sid:row.web_session_id,access_expires_at:row.access_expires_at.getTime()};
  const current=await currentAppDataAuthority(caller,input.connection_session_id,input.record_store_key,appDataRetainedGuard(caller),true,input.data_consent_id);
  verifiedRetainedPreparedRecordAction(row.result!.prepared,nomination.runtime_binding_id,current.store);
  if(prepared.required_action_consents?.some(required=>!current.action_consents?.some(active=>isDeepStrictEqual(active,required))||appConsentDeadline(required.expires_at, required.consent_lifetime)<=Date.now()))return false;
  return current.scope.installation_id===nomination.installation_id&&current.scope.app_version_id===nomination.app_version_id
   &&current.scope.grant_snapshot_id===nomination.grant_snapshot_id&&current.connection.session_revision===input.connection_revision
   &&current.consent?.consent_id===input.data_consent_id&&current.consent.consent_digest===input.data_consent_digest
   &&current.connection.account_ref===input.account_ref;
 }catch{return false;}
}

/** Future authority never falls back to a retained browser invocation. Only
 * the original Run may consume its dedicated, freshly checked release. */
async function authorizeReleasedFutureRecordAction(nomination:Parameters<typeof authorizeReleasedAppDataAction>[0],preparedInput:Record<string,string|number|boolean>):Promise<boolean|null>{
 return db.transaction(async tx=>{
  const installed=await tx.execute(sql<{present:boolean}>`SELECT to_regclass('app_future_record_action_releases') IS NOT NULL AS present`);
  if(!installed.rows[0]?.present)return null;
  const result=await tx.execute(sql`SELECT * FROM app_future_record_action_releases WHERE org_id=${nomination.org_id} AND owner_user_id=${nomination.owner_id} AND prepared->>'snapshot_id'=${String(nomination.input.snapshot_id)} FOR SHARE`);
  const {decodeFutureReleaseRow}=await import('./app-future-record-action-store.js');const row=result.rows[0]?decodeFutureReleaseRow(result.rows[0]):undefined;
  if(!row)return null;
  const {ReviewedFutureRecordActionAuthoritySchema,currentFutureRecordActionAuthority}=await import('./app-future-record-action-authority.js');
  const pins=ReviewedFutureRecordActionAuthoritySchema.parse(row.reviewed_authority);
  if(!nomination.run_id||row.run_id!==nomination.run_id||row.state!=='dispatching'||row.local_state!=='committed'
  ||row.input_digest!==appDataDigest(nomination.input)||row.prepared_digest!==nomination.input.prepared_digest
  ||row.authority_digest!==appDataDigest(pins)||row.dispatch_lifetime_expires_at===null||row.dispatch_lifetime_expires_at.getTime()<=Date.now()
  ||row.dispatch_expires_at.getTime()<=Date.now()||row.not_before.getTime()>Date.now()
  ||pins.scope.installation_id!==nomination.installation_id||pins.scope.app_version_id!==nomination.app_version_id
  ||pins.scope.grant_snapshot_id!==nomination.grant_snapshot_id||pins.policy.action_key!==nomination.operation_name
  ||!pins.action_consents.some(consent=>consent.action_key===nomination.operation_name&&consent.action_binding_id===nomination.runtime_binding_id)
  ||pins.connection.session_id!==nomination.input.connection_session_id||pins.connection.session_revision!==nomination.input.connection_revision
  ||pins.connection.account_ref!==nomination.input.account_ref||pins.data_consent_id!==nomination.input.data_consent_id
  ||pins.data_consent_digest!==nomination.input.data_consent_digest||pins.store_key!==nomination.input.record_store_key)return false;
  const {record_content_digest:_,...preparedMetadata}=row.prepared;
  const prepared=verifiedRetainedPreparedRecordAction({...preparedMetadata,input:preparedInput},nomination.runtime_binding_id);
  if(!prepared.future_release||!isDeepStrictEqual(prepared.input,preparedInput)||prepared.snapshot_digest!==row.prepared_digest)return false;
  await currentFutureRecordActionAuthority(tx,pins,()=>new Date(),prepared);
  return row.dispatch_lifetime_expires_at.getTime()>Date.now();
 });
}

/** Extra immutable-plan/data evidence; the public Run independently proves
 * the current action registration, exact human release and every effect lease. */
async function authorizeReleasedAppDataResourceAction(nomination:Parameters<typeof authorizeReleasedAppDataAction>[0]):Promise<boolean>{
 const input=AppResourceActionReleasedInputSchema.parse(nomination.input);
 const {resource_action_version,resource_store_key,connection_session_id,connection_revision,data_consent_id,data_consent_digest,prepared_digest,...planInput}=input;
 void resource_action_version;
 const rows=await db.select().from(appDataInvocations).where(and(eq(appDataInvocations.org_id,nomination.org_id),
  eq(appDataInvocations.owner_user_id,nomination.owner_id),eq(appDataInvocations.connection_session_id,connection_session_id),
  eq(appDataInvocations.state,'completed'),sql`${appDataInvocations.result}->'prepared_resource'->>'snapshot_id'=${input.snapshot_id}`,
  sql`${appDataInvocations.result}->'prepared_resource'->>'snapshot_digest'=${prepared_digest}`,
  sql`${appDataInvocations.result}->'prepared_resource'->'input'=${JSON.stringify(planInput)}::jsonb`))
  .orderBy(desc(appDataInvocations.created_at)).limit(8);
 for(const row of rows){
  const prepared=row.result?.prepared_resource as Record<string,unknown>|undefined;
  if(!prepared||prepared.schema_version!=='deft.app_prepared_resource_action.v1'||prepared.action_key!==nomination.operation_name
    ||typeof prepared.expires_at!=='string'||Date.parse(prepared.expires_at)<=Date.now()||!isDeepStrictEqual(prepared.input,planInput))continue;
  try{
   const caller={org_id:nomination.org_id,user_id:nomination.owner_id,sid:row.web_session_id,access_expires_at:row.access_expires_at.getTime()};
   const current=await currentAppDataAuthority(caller,connection_session_id,resource_store_key,appDataRetainedGuard(caller),true,data_consent_id,{action_key:nomination.operation_name,action_binding_id:nomination.runtime_binding_id});
   if(current.scope.installation_id===nomination.installation_id&&current.scope.app_version_id===nomination.app_version_id
    &&current.scope.grant_snapshot_id===nomination.grant_snapshot_id&&current.connection.session_revision===connection_revision
    &&current.consent?.consent_id===data_consent_id&&current.consent.consent_digest===data_consent_digest
    &&current.connection.account_ref===input.account_ref&&current.scope.resource_key===prepared.resource_key
    &&current.action_consents?.some(consent=>consent.action_key===nomination.operation_name&&consent.action_binding_id===nomination.runtime_binding_id))return true;
  }catch{/* Try only another exact immutable completed disclosure under fresh current human access. */}
 }
 return false;
}

async function appRecordChangeRuntimeAuthority(raw:unknown,authorization:string|undefined){
 const input=AppRecordChangeAuthorityRequestSchema.parse(raw),registry=await getAppConnectionSessionRegistry();registry.authenticate(input.scope,authorization);
 const owner={org_id:input.scope.org_id,user_id:input.scope.owner_user_id},journal=new PostgresAppDataStore(owner),row=await journal.invocation(input.request_id);
 if(!row||row.state!=='inflight'||!isDeepStrictEqual({...row.context,expires_at:input.expires_at},input)
  ||Date.parse(input.expires_at)>row.expires_at.getTime()||row.expires_at.getTime()<=Date.now())throw appDataDenied();
 const caller={...owner,sid:row.web_session_id,access_expires_at:row.access_expires_at.getTime()},guard=appDataRetainedGuard(caller);
 const authorities=[];for(const proof of input.record_authorities){
  const current=await currentAppDataAuthority(caller,input.connection.session_id,proof.store_key,guard,true,proof.consent_id,appDataConnectionActionSelection(input.operation));
  if(!isDeepStrictEqual(current.scope,input.scope)||!isDeepStrictEqual(current.connection,input.connection)||!current.consent
   ||current.consent.consent_id!==proof.consent_id||current.consent.consent_digest!==proof.consent_digest||current.data_policy_digest!==proof.data_policy_digest
   ||(current.consent.expires_at?.toISOString()??null)!==proof.consent_expires_at||current.consent.consent_lifetime!==proof.consent_lifetime)throw appDataDenied();authorities.push(current);
 }
 const destination=authorities[0]!,source=authorities[1]!;
 // The immutable input_digest pins the key validated at dispatch; changed
 // declarations cannot match either retained policy digest.
 if(!destination.store.record_changes?.some(change=>change.source_store_key===source.store.key))throw appDataDenied();
 for(const before of authorities)sameRecordChangeAuthority(before,await currentAppDataAuthority(caller,input.connection.session_id,before.store.key,guard,true,before.consent!.consent_id,appDataConnectionActionSelection(input.operation)));
 const deadline=Math.min(Date.parse(input.expires_at),row.expires_at.getTime(),...authorities.map(value=>value.expires_at));
 const after=await journal.invocation(input.request_id);if(deadline<=Date.now()||after?.state!=='inflight'||!isDeepStrictEqual(after.context,row.context))throw appDataDenied();
 (await getAppConnectionSessionRegistry()).authenticate(input.scope,authorization);
 return AppRecordChangeAuthorityResultSchema.parse({...input,allowed:true,expires_at:new Date(deadline).toISOString()});
}
