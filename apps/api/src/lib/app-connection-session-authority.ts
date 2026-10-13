import {assertOwnerConnectionRegistration} from './app-owner-connection-authority.js';
import {selectAdmittedConnectionPolicy} from './app-connection-admitted-policy.js';
import { and, eq } from 'drizzle-orm';
import { isDeepStrictEqual } from 'node:util';
import { parseAttachmentAppManifest, AppConnectionRuntimeAuthorityRequestSchema, AppConnectionRuntimeAuthorityResultSchema,
  type AppConnectionSessionScope, type AppConnectionActionConsent } from '@deft/app-kit';
import { appRuntimeBindings, webSessions } from '@deft/db/schema';
import {currentConnectionBindingLocators} from './app-connection-current-locators.js';
import { db } from './db.js';
import { AppError } from './app-errors.js';
import { loadLiveAttachmentSyncBindingAuthority,loadConsentContinuationBindingIdentity } from './app-attachment-sync-authority.js';
import { attachmentFinalAuthorityIsCurrent } from './app-attachment-authority.js';
import { connectionProfileDigest, getAppConnectionSessionRegistry } from './app-connection-session-registry.js';
import { AppConnectionSessionRecordSchema, type AppConnectionSessionPorts, type AppConnectionSessionAuthority } from './app-connection-session-service.js';
import { PostgresAppConnectionSessionStore } from './app-connection-session-store.js';
import type { ExperienceCaller } from './app-experience-service.js';
import type { WebAuthorityGuard } from './app-resource-sync-web-authority.js';
import type { AppRunTransaction } from './app-run-repository.js';
import { digestAppGrantValue } from './app-grant-service.js';
import {appConnectionUpgradeSourceIsAvailable} from './app-connection-upgrade-fence.js';

type RequiredConnectionAction = {action_key:string;action_binding_id:string}|'none';
const denied = () => new AppError('Account connection access ended', 'APP_ACCESS_DENIED', 403);
/** Retained SID is checked only after current member/App/registration/binding
 * locks. It carries no bearer and gives the runtime no human impersonation port. */
export function retainedWebGuard(caller: ExperienceCaller): WebAuthorityGuard {
  let expiry = caller.access_expires_at ?? 0;
  return Object.assign(async (tx: AppRunTransaction) => {
    const [session] = await tx.select().from(webSessions).where(and(eq(webSessions.id, caller.sid),
      eq(webSessions.org_id, caller.org_id), eq(webSessions.user_id, caller.user_id))).for('share');
    if (!session || session.revoked_at) throw denied();
    expiry = Math.min(expiry, session.expires_at.getTime());
    if (expiry <= Date.now()) throw denied();
  }, { current_web_session_expires_at: () => new Date(expiry) });
}

export type AppConnectionAuthorityOwner=Pick<ExperienceCaller,'org_id'|'user_id'|'access_expires_at'>;
async function loadCurrentConnectionAuthority(caller: AppConnectionAuthorityOwner,
  nomination: { installation_id: string; target_key: string }, guard: WebAuthorityGuard, requireTransport:boolean, requestedMode:'v1'|'v2'|'credential_form.v1'|'declared'='v1',requiredAction?:RequiredConnectionAction,suppliedTransaction?:AppRunTransaction,continuationExpiry?:Date) {
  const use=async(tx:AppRunTransaction) => {
    const locators = await currentConnectionBindingLocators(tx,caller,nomination).limit(2);
    if (locators.length !== 1) throw denied();
    const current = await (continuationExpiry?loadConsentContinuationBindingIdentity:loadLiveAttachmentSyncBindingAuthority)(tx, { org_id: caller.org_id,
      resource_binding_id: locators[0]!.id, clock: () => new Date() });
    if (!current || current.binding.owner_user_id !== caller.user_id || current.binding.target_key !== nomination.target_key
      || !current.registration.owner_connection_admission_id || !current.binding.consent_expires_at) throw denied();
    const manifest = parseAttachmentAppManifest(current.version.manifest);
    const admission=await assertOwnerConnectionRegistration(tx,current.registration,{owner_user_id:caller.user_id,resource_key:current.binding.resource_key,lockedReviewed:current});
    const policy=selectAdmittedConnectionPolicy(manifest.owner_connections??[],admission.policy,{resource_key:current.binding.resource_key,runtime_requirement_key:current.descriptor.runtime_requirement_key});
    if(!policy)throw denied();
    // The live reader validates the admin admission snapshot including the
    // profile digest. Deployment configuration is an additional current pin.
    const registry = await getAppConnectionSessionRegistry();
    const profile = registry.profile(caller.org_id, nomination.installation_id, policy, current.registration.operator_user_id);
    const scope: AppConnectionSessionScope = { org_id: caller.org_id, owner_user_id: caller.user_id,
      installation_id: current.installation.id, app_version_id: current.version.id, grant_snapshot_id: current.grant.id,
      package_digest: current.version.package_digest, grant_snapshot_digest: current.grant.snapshot_digest,
      lifecycle_epoch: current.installation.lifecycle_epoch, grant_epoch: current.installation.grant_epoch,
      target_key: current.binding.target_key, resource_key: current.binding.resource_key, resource_binding_id: current.binding.id,
      runtime_registration_id: current.registration.id, operator_user_id: current.registration.operator_user_id,
      runtime_epoch: current.registration.runtime_epoch, profile_digest: connectionProfileDigest(profile),
      consent_expires_at: (continuationExpiry??current.binding.consent_expires_at).toISOString() };
    if(continuationExpiry&&(!Number.isFinite(continuationExpiry.getTime())||continuationExpiry<=new Date()
      ||continuationExpiry<=current.binding.consent_expires_at||continuationExpiry.getTime()>Date.now()+policy.max_consent_seconds*1000))throw denied();
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
    const bindings = await tx.select().from(appRuntimeBindings).where(and(
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
        const reviewed = continuationExpiry ? await authorizer!.captureConsentContinuationPurposes(tx,actionInput,continuationExpiry)
          : await authorizer!.captureReviewedRuntimeInTransaction(tx,actionInput);
        if (reviewed.protocol_version !== '7' || reviewed.operator_user_id !== scope.operator_user_id
          || !reviewed.owner_target_consent_expires_at || reviewed.owner_target_consent_expires_at <= new Date()) continue;
        const consent = { action_binding_id: binding.id, action_key: binding.action_key,
          authority_epoch: reviewed.registration.runtime_epoch, consent_id: binding.id,
          consent_digest: digestAppGrantValue(reviewed.authorization_snapshot),
          expires_at: new Date(Math.min(reviewed.owner_target_consent_expires_at.getTime(),
            Date.parse(scope.consent_expires_at))).toISOString() };
        if(mode==='v1'){action_consent=consent;break;}
        action_consents.push(consent);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'APP_RUN_AUTHORIZATION_STALE') throw error;
      }
    }
    }
    if (!await attachmentFinalAuthorityIsCurrent(tx, [caller.user_id, scope.operator_user_id], {
      guard, expires_at: [continuationExpiry??current.binding.consent_expires_at] })) throw denied();
    if(action_consents.length>8)throw denied();
    return { scope, profile, runtime_ready,connection_protocol:mode, ...(mode!=='v1'?{action_consents}:action_consent ? { action_consent } : {}),
      expires_at: Math.min(guard.current_web_session_expires_at().getTime(), caller.access_expires_at ?? 0) };
  };
  return suppliedTransaction?use(suppliedTransaction):db.transaction(use);
}

/** Dedicated fresh owner review: historical expiry is evidence only. Every
 * other current authority fence is shared with operational admission. */
export async function currentConsentContinuationAuthority(caller:ExperienceCaller,nomination:{installation_id:string;target_key:string},guard:WebAuthorityGuard,expiry:Date,tx?:AppRunTransaction){
  const current=await loadCurrentConnectionAuthority(caller,nomination,guard,true,'declared',undefined,tx,expiry);
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
 nomination:{installation_id:string;target_key:string},guard:WebAuthorityGuard,requiredAction?:RequiredConnectionAction,suppliedTransaction?:AppRunTransaction):Promise<AppConnectionSessionAuthority>{
 const {runtime_ready,...authority}=await loadCurrentConnectionAuthority(caller,nomination,guard,true,'declared',requiredAction,suppliedTransaction);return authority;
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
  const deadline = Math.min(Date.parse(input.expires_at), current.expires_at, Date.parse(record.scope.consent_expires_at),
    input.operation === 'begin' || input.operation === 'callback' ? Date.parse(record.callback_expires_at) : Infinity);
  const after = await store.metadata(locator);
  if (!after || after.revision !== metadata.revision || !isDeepStrictEqual(current.scope, record.scope)
    || (input.operation === 'begin' || input.operation === 'callback') && (!isDeepStrictEqual(input.action_consent, record.action_consent)
      || !isDeepStrictEqual(current.action_consent, record.action_consent)
      || input.action_consent && Date.parse(input.action_consent.expires_at) <= Date.now())
    || deadline <= Date.now()) throw denied();
  (await getAppConnectionSessionRegistry()).authenticate(current.scope, authorization);
  return AppConnectionRuntimeAuthorityResultSchema.parse({ ...input, allowed: true, expires_at: new Date(deadline).toISOString() });
}
