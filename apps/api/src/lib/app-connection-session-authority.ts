import {parseAppAuthorityManifest} from './app-authority-manifest.js';
import {appConsentDeadline,appConsentExpiryValid,type AppConsentLifetime} from '@deft/app-kit/core';
import {selectAdmittedConnectionPolicy} from './app-connection-admitted-policy.js';
import { and, eq } from 'drizzle-orm';
import { isDeepStrictEqual } from 'node:util';
import { AppConnectionRuntimeAuthorityRequestSchema, AppConnectionRuntimeAuthorityResultSchema,
  type AppConnectionSessionScope, type AppConnectionActionConsent } from '@deft/app-kit/core';
import { appRuntimeBindings, webSessions } from '@deft/db/schema';
import {currentConnectionBindingLocators} from './app-connection-current-locators.js';
import { db } from './db.js';
import { AppError } from './app-errors.js';
import { loadLiveAttachmentSyncBindingAuthority,loadConsentContinuationBindingIdentity,type LiveAttachmentSyncBindingAuthority } from './app-attachment-sync-authority.js';
import { attachmentFinalAuthorityIsCurrent } from './app-attachment-authority.js';
import { connectionProfileDigest, getAppConnectionSessionRegistry, type AppConnectionSessionRegistry } from './app-connection-session-registry.js';
import { AppConnectionSessionRecordSchema, type AppConnectionSessionPorts, type AppConnectionSessionAuthority } from './app-connection-session-service.js';
import { PostgresAppConnectionSessionStore } from './app-connection-session-store.js';
import type { ExperienceCaller } from './app-experience-service.js';
import type { WebAuthorityGuard } from './app-resource-sync-web-authority.js';
import type { AppRunTransaction } from './app-run-repository.js';
import { digestAppGrantValue } from './app-grant-service.js';
import {appConnectionUpgradeSourceIsAvailable} from './app-connection-upgrade-fence.js';

type RequiredConnectionAction = {action_key:string;action_binding_id:string}|'none';
/** Private same-admission immutable bytes; never a serialized authority or later-phase cache. */
export type CurrentAppConnectionReviewedDeclarations = Readonly<{scope:AppConnectionSessionScope;
  manifest:ReturnType<typeof parseAppAuthorityManifest>;grant_record_stores:unknown}>;
const denied = () => new AppError('Account connection access ended', 'APP_ACCESS_DENIED', 403);
/** Retained SID is checked only after current member/App/registration/binding
 * locks. It carries no bearer and gives the runtime no human impersonation port. */
export function retainedWebGuard(caller: ExperienceCaller): WebAuthorityGuard {
  let expiry = caller.access_expires_at ?? 0;
  return Object.assign(async (tx: AppRunTransaction) => {
    const [session] = await tx.select({ revoked_at: webSessions.revoked_at, expires_at: webSessions.expires_at }).from(webSessions).where(and(eq(webSessions.id, caller.sid),
      eq(webSessions.org_id, caller.org_id), eq(webSessions.user_id, caller.user_id))).for('share');
    if (!session || session.revoked_at) throw denied();
    expiry = Math.min(expiry, session.expires_at.getTime());
    if (expiry <= Date.now()) throw denied();
  }, { current_web_session_expires_at: () => new Date(expiry) });
}

export type AppConnectionAuthorityOwner=Pick<ExperienceCaller,'org_id'|'user_id'|'access_expires_at'>;
async function loadCurrentConnectionAuthority(caller: AppConnectionAuthorityOwner,
  nomination: { installation_id: string; target_key: string }, guard: WebAuthorityGuard, requireTransport:boolean, requestedMode:'v1'|'v2'|'credential_form.v1'|'declared'='v1',requiredAction?:RequiredConnectionAction,suppliedTransaction?:AppRunTransaction,continuationExpiry?:Date|null,continuationLifetime?:AppConsentLifetime,onReviewedDeclarations?:(reviewed:CurrentAppConnectionReviewedDeclarations)=>void,onLiveBinding?:(authority:LiveAttachmentSyncBindingAuthority)=>void) {
  const use=async(tx:AppRunTransaction) => {
    const locators = await currentConnectionBindingLocators(tx,caller,nomination).limit(2);
    if (locators.length !== 1) throw denied();
    let admissionRegistry: AppConnectionSessionRegistry | undefined;
    const current = await (continuationExpiry!==undefined?loadConsentContinuationBindingIdentity:loadLiveAttachmentSyncBindingAuthority)(tx, { org_id: caller.org_id,
      resource_binding_id: locators[0]!.id, clock: () => new Date(), onConnectionRegistry: registry => { admissionRegistry = registry; } });
    if (!current || current.binding.owner_user_id !== caller.user_id || current.binding.target_key !== nomination.target_key
      || !current.registration.owner_connection_admission_id || !appConsentExpiryValid(current.binding.consent_expires_at,current.binding.consent_lifetime??undefined)) throw denied();
    const manifest = parseAppAuthorityManifest(current.version.manifest, {org_id: caller.org_id, app_version_id: current.version.id});
    // The binding reader validated and share-locked this admission and its
    // participants in this same transaction, including current deployment proofs.
    const admission=current.owner_connection_admission;
    if(!admission)throw denied();
    const policy=selectAdmittedConnectionPolicy(manifest.owner_connections??[],admission.policy,{resource_key:current.binding.resource_key,runtime_requirement_key:current.descriptor.runtime_requirement_key});
    if(!policy)throw denied();
    // Reuse only this live reader's validated deployment acquisition. This
    // function performs a fresh read again at every later authority boundary.
    const registry = admissionRegistry ?? await getAppConnectionSessionRegistry(tx);
    const profile = registry.profile(caller.org_id, nomination.installation_id, policy, current.registration.operator_user_id);
    if(admission.snapshot.connection_profile_digest!==connectionProfileDigest(profile)
      ||admission.snapshot.connection_transport_digest!==registry.transportDigest(caller.org_id,nomination.installation_id,profile)
      ||!isDeepStrictEqual(admission.snapshot.connection_profile,profile))throw denied();
    const scope: AppConnectionSessionScope = { org_id: caller.org_id, owner_user_id: caller.user_id,
      installation_id: current.installation.id, app_version_id: current.version.id, grant_snapshot_id: current.grant.id,
      package_digest: current.version.package_digest, grant_snapshot_digest: current.grant.snapshot_digest,
      lifecycle_epoch: current.installation.lifecycle_epoch, grant_epoch: current.installation.grant_epoch,
      target_key: current.binding.target_key, resource_key: current.binding.resource_key, resource_binding_id: current.binding.id,
      runtime_registration_id: current.registration.id, operator_user_id: current.registration.operator_user_id,
      runtime_epoch: current.registration.runtime_epoch, profile_digest: connectionProfileDigest(profile),
      consent_expires_at: (continuationExpiry!==undefined?continuationExpiry:current.binding.consent_expires_at)?.toISOString()??null,
      ...((continuationExpiry!==undefined?continuationLifetime:current.binding.consent_lifetime)?{consent_lifetime:'until_revoked' as const}:{}) };
    if(continuationExpiry!==undefined&&(!appConsentExpiryValid(continuationExpiry,continuationLifetime)||appConsentDeadline(continuationExpiry,continuationLifetime)<=Date.now()
      ||appConsentDeadline(continuationExpiry,continuationLifetime)<=appConsentDeadline(current.binding.consent_expires_at,current.binding.consent_lifetime??undefined)
      ||(continuationLifetime==='until_revoked'?policy.allow_until_revoked!==true:continuationExpiry!.getTime()>Date.now()+policy.max_consent_seconds*1000)))throw denied();
    let runtime_ready=false,mode:'v1'|'v2'|'credential_form.v1'=requestedMode==='declared'?registry.reviewedProtocol(scope.org_id,scope.installation_id,profile):requestedMode==='v2'?'v2':requestedMode==='credential_form.v1'?'credential_form.v1':'v1';
    try{if(requestedMode==='declared'){if(registry.protocol(scope,profile)!==mode)throw denied();registry.assertReady(scope,profile);}
      else if(mode==='v2')registry.runtimeV2(scope,profile);else if(mode==='credential_form.v1')registry.formRuntime(scope,profile);else registry.runtime(scope,profile);
      runtime_ready=true;}
    catch(error){if(requireTransport||!(error instanceof AppError))throw error;}
    let action_consent: AppConnectionActionConsent | undefined;
    const action_consents: AppConnectionActionConsent[] = [];
    // Data-only readers still require the enrolled transport and every live
    // connection fence, but do not disclose or authorize action capabilities.
    if(requireTransport&&requiredAction!=='none'){
    const bindings = await tx.select({id:appRuntimeBindings.id,action_key:appRuntimeBindings.action_key}).from(appRuntimeBindings).where(and(
      eq(appRuntimeBindings.org_id, caller.org_id), eq(appRuntimeBindings.app_installation_id, scope.installation_id),
      eq(appRuntimeBindings.app_version_id, scope.app_version_id), eq(appRuntimeBindings.grant_snapshot_id, scope.grant_snapshot_id),
      eq(appRuntimeBindings.owner_resource_binding_id, scope.resource_binding_id), eq(appRuntimeBindings.reviewed_by_user_id, caller.user_id),
      eq(appRuntimeBindings.state, 'active'))).limit(mode!=='v1'?17:16);
    if(mode!=='v1'&&bindings.length>16)throw denied();
    const allowed = policy.action_keys.filter(key => profile.action_keys.includes(key));
    // A released resource Run already pins one action. Keep every current
    // connection/admission check and reject ambiguous bindings, but capture
    // only that exact action rather than unrelated Send or mirror actions.
    if(requiredAction&&(mode==='v1'||!allowed.includes(requiredAction.action_key)
      ||bindings.filter(binding=>binding.id===requiredAction.action_binding_id&&binding.action_key===requiredAction.action_key).length!==1))throw denied();
    const { getAppRunRuntime } = await import('./app-run-runtime.js');
    const authorizer = bindings.some(binding => allowed.includes(binding.action_key))
      ? (await getAppRunRuntime()).liveAuthorization : null;
    for (const binding of bindings.sort((a, b) => a.action_key.localeCompare(b.action_key))) {
      if(mode!=='v1'&&allowed.includes(binding.action_key)&&bindings.filter(row=>row.action_key===binding.action_key).length!==1)throw denied();
      if (!allowed.includes(binding.action_key) || bindings.filter(row => row.action_key === binding.action_key).length !== 1) continue;
      if(requiredAction&&(binding.id!==requiredAction.action_binding_id||binding.action_key!==requiredAction.action_key))continue;
      try {
        const actionInput={org_id:caller.org_id,user_id:caller.user_id,runtime_binding_id:binding.id};
        const reviewed = continuationExpiry!==undefined ? await authorizer!.captureConsentContinuationPurposes(tx,actionInput,continuationExpiry,continuationLifetime)
          : await authorizer!.captureReviewedRuntimeInTransaction(tx,actionInput);
        if (reviewed.protocol_version !== '7' || reviewed.operator_user_id !== scope.operator_user_id
          || reviewed.owner_target_consent_lifetime!=='until_revoked'&&(!reviewed.owner_target_consent_expires_at || reviewed.owner_target_consent_expires_at <= new Date())) continue;
        const consent = { action_binding_id: binding.id, action_key: binding.action_key,
          authority_epoch: reviewed.registration.runtime_epoch, consent_id: binding.id,
          consent_digest: digestAppGrantValue(reviewed.authorization_snapshot),
          expires_at:scope.consent_lifetime==='until_revoked'&&reviewed.owner_target_consent_lifetime==='until_revoked'?null:new Date(Math.min(reviewed.owner_target_consent_expires_at?.getTime()??Infinity,appConsentDeadline(scope.consent_expires_at,scope.consent_lifetime))).toISOString(),
          ...(scope.consent_lifetime==='until_revoked'&&reviewed.owner_target_consent_lifetime==='until_revoked'?{consent_lifetime:'until_revoked' as const}:{}) };
        if(mode==='v1'){action_consent=consent;break;}
        action_consents.push(consent);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'APP_RUN_AUTHORIZATION_STALE') throw error;
      }
    }
    }
    if (!await attachmentFinalAuthorityIsCurrent(tx, [caller.user_id, scope.operator_user_id], {
      guard, expires_at:(continuationExpiry!==undefined?continuationExpiry:current.binding.consent_expires_at)?[(continuationExpiry!==undefined?continuationExpiry:current.binding.consent_expires_at)!]:[] })) throw denied();
    if(action_consents.length>8)throw denied();
    onReviewedDeclarations?.({scope,manifest,grant_record_stores:(current.grant.canonical_snapshot as Record<string,unknown>).record_stores??[]});
    // Private composite-reader handoff while its supplied transaction still owns
    // these exact locks. This is never a later-phase or serialized authority.
    if(suppliedTransaction)onLiveBinding?.(current);
    return { scope, profile, runtime_ready,connection_protocol:mode, ...(mode!=='v1'?{action_consents}:action_consent ? { action_consent } : {}),
      expires_at: Math.min(guard.current_web_session_expires_at().getTime(), caller.access_expires_at ?? 0) };
  };
  return suppliedTransaction?use(suppliedTransaction):db.transaction(use);
}

/** Dedicated fresh owner review: historical expiry is evidence only. Every
 * other current authority fence is shared with operational admission. */
export async function currentConsentContinuationAuthority(caller:ExperienceCaller,nomination:{installation_id:string;target_key:string},guard:WebAuthorityGuard,expiry:Date|null,tx?:AppRunTransaction,lifetime?:AppConsentLifetime){
  const current=await loadCurrentConnectionAuthority(caller,nomination,guard,true,'declared',undefined,tx,expiry,lifetime);
  if(!('action_consents' in current))throw denied();
  return {...current,action_consents:current.action_consents};
}

/** All operational callers still require the exact enrolled transport. */
export async function currentAppConnectionSessionAuthority(caller:ExperienceCaller,
 nomination:{installation_id:string;target_key:string},guard:WebAuthorityGuard):Promise<AppConnectionSessionAuthority>{
 const {runtime_ready,...authority}=await loadCurrentConnectionAuthority(caller,nomination,guard,true);return authority;
}
/** Setup metadata only: genuine current DB pins can be enrolled by the operator
 * before the exact transport entry exists. This grants no runtime invocation. */
export function currentAppConnectionMetadataAuthority(caller:ExperienceCaller,
 nomination:{installation_id:string;target_key:string},guard:WebAuthorityGuard){
 return loadCurrentConnectionAuthority(caller,nomination,guard,false,'declared');
}
export async function currentAppConnectionReadAuthority(caller:AppConnectionAuthorityOwner,
 nomination:{installation_id:string;target_key:string},guard:WebAuthorityGuard,requiredAction?:RequiredConnectionAction,suppliedTransaction?:AppRunTransaction,onReviewedDeclarations?:(reviewed:CurrentAppConnectionReviewedDeclarations)=>void,onLiveBinding?:(authority:LiveAttachmentSyncBindingAuthority)=>void):Promise<AppConnectionSessionAuthority & {connection_protocol:'v1'|'v2'|'credential_form.v1'}>{
 if(onLiveBinding&&!suppliedTransaction)throw denied();
 const {runtime_ready,...authority}=await loadCurrentConnectionAuthority(caller,nomination,guard,true,'declared',requiredAction,suppliedTransaction,undefined,undefined,onReviewedDeclarations,onLiveBinding);return authority;
}

export async function currentAppConnectionSessionV2Authority(caller:ExperienceCaller,
 nomination:{installation_id:string;target_key:string},guard:WebAuthorityGuard){
 const {runtime_ready,...authority}=await loadCurrentConnectionAuthority(caller,nomination,guard,true,'v2');
 return {...authority,action_consents:'action_consents' in authority?authority.action_consents:[]};
}

export async function currentAppConnectionFormAuthority(caller:ExperienceCaller,nomination:{installation_id:string;target_key:string},guard:WebAuthorityGuard){
 const {runtime_ready,...authority}=await loadCurrentConnectionAuthority(caller,nomination,guard,true,'credential_form.v1');return {...authority,action_consents:'action_consents' in authority?authority.action_consents:[]};
}

export function productionAppConnectionSessionPorts(caller: ExperienceCaller, guard: WebAuthorityGuard): AppConnectionSessionPorts {
  return { store: new PostgresAppConnectionSessionStore(db, caller),
    currentAuthority: (activeCaller, nomination,purpose) => ['status','disconnect','refresh'].includes(purpose)
      ?currentAppConnectionReadAuthority(activeCaller,nomination,guard):currentAppConnectionSessionAuthority(activeCaller, nomination, guard),
    registeredRuntime: async (scope, profile) => (await getAppConnectionSessionRegistry()).runtime(scope, profile),
    registeredRuntimeV2:async(scope,profile)=>(await getAppConnectionSessionRegistry()).runtimeV2(scope,profile),
    sessionAvailable:record=>db.transaction(tx=>appConnectionUpgradeSourceIsAvailable(tx,{org_id:record.scope.org_id,
      owner_user_id:record.scope.owner_user_id,session_id:record.session_id})) };
}

/** Runtime-only online introspection: exact inflight operation, durable pins,
 * retained human SID/deadline and current admin/owner authority are required. */
export async function appConnectionRuntimeAuthority(raw: unknown, authorization: string | undefined) {
  const input = AppConnectionRuntimeAuthorityRequestSchema.parse(raw);
  const registry = await getAppConnectionSessionRegistry();
  registry.authenticate(input.scope, authorization);
  const store = new PostgresAppConnectionSessionStore();
  const locator = { org_id: input.scope.org_id, owner_user_id: input.scope.owner_user_id, session_id: input.session_id };
  const metadata = await store.metadata(locator);
  if (!metadata) throw denied();
  const record = AppConnectionSessionRecordSchema.parse(metadata.record);
  const states = { begin: 'starting', callback: 'connecting', status: 'checking', disconnect: 'disconnecting' } as const;
  if (record.state !== states[input.operation] || !isDeepStrictEqual(input.scope, record.scope)
    || record.revision !== metadata.revision || input.operation === 'callback' && !record.callback_consumed) throw denied();
  const caller = { org_id: locator.org_id, user_id: locator.owner_user_id, sid: metadata.web_session_id,
    access_expires_at: metadata.access_expires_at.getTime() };
  const current = await currentAppConnectionSessionAuthority(caller, { installation_id: record.scope.installation_id,
    target_key: record.scope.target_key }, retainedWebGuard(caller));
  const deadline = Math.min(Date.parse(input.expires_at), current.expires_at, appConsentDeadline(record.scope.consent_expires_at, record.scope.consent_lifetime),
    input.operation === 'begin' || input.operation === 'callback' ? Date.parse(record.callback_expires_at) : Infinity);
  const after = await store.metadata(locator);
  if (!after || after.revision !== metadata.revision || !isDeepStrictEqual(current.scope, record.scope)
    || (input.operation === 'begin' || input.operation === 'callback') && (!isDeepStrictEqual(input.action_consent, record.action_consent)
      || !isDeepStrictEqual(current.action_consent, record.action_consent)
      || input.action_consent && appConsentDeadline(input.action_consent.expires_at,input.action_consent.consent_lifetime) <= Date.now())
    || deadline <= Date.now()) throw denied();
  (await getAppConnectionSessionRegistry()).authenticate(current.scope, authorization);
  return AppConnectionRuntimeAuthorityResultSchema.parse({ ...input, allowed: true, expires_at: new Date(deadline).toISOString() });
}
