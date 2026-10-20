import {appConsentDeadline} from '@deft/app-kit/core';
import { and, eq, inArray, or, notInArray, sql } from 'drizzle-orm';
import { isDeepStrictEqual } from 'node:util';
import { AppConnectionReattachAnyRuntimeRequestSchema, AppConnectionReattachAnyAuthorityResultSchema } from '@deft/app-kit/core';
import { appRuns, appRunAttempts, appRuntimeBindings, appResourceBindings } from '@deft/db/schema';
import { db } from './db.js';
import { AppError } from './app-errors.js';
import { getAppConnectionSessionRegistry } from './app-connection-session-registry.js';
import { currentAppConnectionReadAuthority, productionAppConnectionSessionPorts } from './app-connection-session-authority.js';
import { PostgresAppConnectionSessionStore, connectionSessionAdmissionFence } from './app-connection-session-store.js';
import { AppConnectionSessionRecordSchema, type AppConnectionSessionAuthority, type AppConnectionSessionRecord } from './app-connection-session-service.js';
import type { AppConnectionReattachmentPorts } from './app-connection-reattachment-service.js';
import { loadLiveAttachmentSyncBindingAuthority } from './app-attachment-sync-authority.js';
import { attachmentFinalAuthorityIsCurrent } from './app-attachment-authority.js';
import type { ExperienceCaller } from './app-experience-service.js';
import type { WebAuthorityGuard } from './app-resource-sync-web-authority.js';
import { webSessions, appConnectionSessions } from '@deft/db/schema';

const denied = () => new AppError('Account reattachment access ended', 'APP_ACCESS_DENIED', 403);
async function assertNoActiveReattachmentEffects(source: AppConnectionSessionRecord, target: AppConnectionSessionAuthority,
  guard: WebAuthorityGuard, sessionId?: string) {
  if(!isDeepStrictEqual(source.action_consents?.map(consent=>consent.action_key),target.action_consents?.map(consent=>consent.action_key)))throw denied();
  await db.transaction(async tx => {
    const current = await loadLiveAttachmentSyncBindingAuthority(tx, { org_id: target.scope.org_id,
      resource_binding_id: target.scope.resource_binding_id, clock: () => new Date() });
    if (!current || current.binding.owner_user_id !== target.scope.owner_user_id
      || current.version.id !== target.scope.app_version_id || current.grant.id !== target.scope.grant_snapshot_id) throw denied();
    const [connection] = await tx.select({ id: appConnectionSessions.session_id }).from(appConnectionSessions)
      .where(connectionSessionAdmissionFence(target.scope, new Date(), sessionId)).limit(1);
    if (connection) throw denied();
    // Retained effects may belong to an older attachment than the nominated
    // source. Include only this owner's exact installed target across history.
    const historical = await tx.select({ id: appResourceBindings.id }).from(appResourceBindings).where(and(
      eq(appResourceBindings.org_id, target.scope.org_id),
      eq(appResourceBindings.app_installation_id, target.scope.installation_id),
      eq(appResourceBindings.owner_user_id, target.scope.owner_user_id),
      eq(appResourceBindings.target_key, target.scope.target_key),
      eq(appResourceBindings.resource_key, target.scope.resource_key)));
    const resources = [...new Set([source.scope.resource_binding_id, target.scope.resource_binding_id, ...historical.map(row => row.id)])];
    const bindings = await tx.select({ id: appRuntimeBindings.id }).from(appRuntimeBindings).where(and(
      eq(appRuntimeBindings.org_id, target.scope.org_id), eq(appRuntimeBindings.app_installation_id, target.scope.installation_id),
      inArray(appRuntimeBindings.owner_resource_binding_id, resources)));
    const targetRun = and(eq(appRuns.org_id, target.scope.org_id),
      eq(appRuns.origin_app_installation_id, target.scope.installation_id),
      or(inArray(appRuns.origin_resource_binding_id, resources), bindings.length
        ? inArray(appRuns.origin_runtime_binding_id, bindings.map(row => row.id)) : undefined));
    const [run] = await tx.select({ id: appRuns.id }).from(appRuns).where(and(targetRun,
      inArray(appRuns.state, ['pending', 'pending_approval', 'running', 'waiting_external']))).limit(1);
    const [attempt] = await tx.select({ id: appRunAttempts.id }).from(appRunAttempts).innerJoin(appRuns,
      and(eq(appRuns.org_id, appRunAttempts.org_id), eq(appRuns.id, appRunAttempts.run_id))).where(and(targetRun,
      notInArray(appRuns.state, ['succeeded', 'failed', 'cancelled', 'expired']),
      inArray(appRunAttempts.state, ['pending', 'claimed', 'provider_call_started']))).limit(1);
    // A terminal unknown remains immutable evidence. It cannot lend authority
    // to the new binding, and an unexpired/active attempt still blocks custody.
    const [unsafeUnknown] = await tx.select({id:appRuns.id}).from(appRuns).where(and(targetRun,
      eq(appRuns.state,'unknown_outcome'),sql`(
        ${appRuns.unknown_outcome_at} IS NULL
        OR NOT EXISTS(SELECT 1 FROM app_run_attempts a WHERE a.org_id=${appRuns.org_id} AND a.run_id=${appRuns.id} AND a.state='unknown_outcome')
        OR EXISTS(SELECT 1 FROM app_run_attempts a WHERE a.org_id=${appRuns.org_id} AND a.run_id=${appRuns.id}
          AND (a.state NOT IN ('succeeded','failed','cancelled','unknown_outcome')
            OR a.lease_expires_at>clock_timestamp()
            OR (a.state='unknown_outcome' AND (a.claimed_at IS NULL OR a.lease_expires_at IS NULL))))
      )`)).limit(1);
    // Legacy/v1 reattachment keeps its historical stricter effect gate.
    const [legacyUnknown] = source.action_consents===undefined ? await tx.select({id:appRuns.id}).from(appRuns).where(and(targetRun,eq(appRuns.state,'unknown_outcome'))).limit(1) : [];
    if (run || attempt || unsafeUnknown || legacyUnknown || !await attachmentFinalAuthorityIsCurrent(tx,
      [target.scope.owner_user_id, target.scope.operator_user_id], { guard, expires_at: target.scope.consent_expires_at?[new Date(target.scope.consent_expires_at)]:[] })) throw denied();
  });
}

export function productionAppConnectionReattachmentPorts(caller: ExperienceCaller, guard: WebAuthorityGuard): AppConnectionReattachmentPorts {
  const ports = productionAppConnectionSessionPorts(caller, guard);
  return { store: ports.store, currentAuthority: async (activeCaller,nomination)=>{const authority=await currentAppConnectionReadAuthority(activeCaller,nomination,guard);
      const protocol=(await getAppConnectionSessionRegistry()).protocol(authority.scope,authority.profile);
      if(protocol!=='v1'&&protocol!=='v2')throw denied();return authority;},
    transportDigest: async record => (await getAppConnectionSessionRegistry()).transportDigest(record.scope.org_id,
      record.scope.installation_id, record.profile),
    requestRuntime: async (record, input, signal) => (await getAppConnectionSessionRegistry())
      .reattachmentRuntime(record.scope, record.profile).request(input, signal),
    assertNoActiveEffects: (source, target, sessionId) => assertNoActiveReattachmentEffects(source, target, guard, sessionId) };
}

/** Separate runtime-only audience; old session scope never grants current access. */
export async function appConnectionReattachmentRuntimeAuthority(raw: unknown, authorization: string | undefined) {
  const input = AppConnectionReattachAnyRuntimeRequestSchema.parse(raw), registry = await getAppConnectionSessionRegistry();
  registry.authenticate(input.scope, authorization);
  const store = new PostgresAppConnectionSessionStore(), locator = { org_id: input.scope.org_id,
    owner_user_id: input.scope.owner_user_id, session_id: input.session_id };
  const metadata = await store.metadata(locator);
  if (!metadata) throw denied();
  const record = AppConnectionSessionRecordSchema.parse(metadata.record), data = record.reattachment;
  const states = { prepare: 'starting', activate: 'reattaching', status: 'reattach_checking' } as const;
  if (!data || record.revision !== metadata.revision || record.state !== states[input.operation]
    || !isDeepStrictEqual(record.scope, input.scope) || !isDeepStrictEqual(data.source, input.source)
    || data.transport_digest !== input.transport_digest || data.review_expires_at !== input.review_expires_at
    || input.operation !== 'prepare' && !isDeepStrictEqual(data.review, input.review)
    || (input.schema_version==='deft.app_connection_reattach_runtime.v2')!==(record.action_consents!==undefined)
    || !isDeepStrictEqual(record.action_consents,'action_consents' in input?input.action_consents:undefined)
    || input.operation !== 'status' && !isDeepStrictEqual(record.action_consent, 'action_consent' in input?input.action_consent:undefined)) throw denied();
  const source = await store.read({ org_id: locator.org_id, owner_user_id: locator.owner_user_id, session_id: data.source.session_id });
  if (!source || source.state !== 'connected' || source.revision !== data.source.session_revision
    || !isDeepStrictEqual(source.scope, data.source.scope) || source.runtime_session_ref !== data.source.runtime_session_ref
    || source.account?.account_ref !== data.source.account_ref) throw denied();
  const caller = { org_id: locator.org_id, user_id: locator.owner_user_id, sid: metadata.web_session_id,
    access_expires_at: metadata.access_expires_at.getTime() };
  let expiry = caller.access_expires_at;
  const guard: WebAuthorityGuard = Object.assign(async (tx: Parameters<WebAuthorityGuard>[0]) => {
    const [session] = await tx.select().from(webSessions).where(and(eq(webSessions.id, caller.sid),
      eq(webSessions.org_id, caller.org_id), eq(webSessions.user_id, caller.user_id))).limit(1).for('share');
    if (!session || session.revoked_at) throw denied();
    expiry = Math.min(expiry, session.expires_at.getTime()); if (expiry <= Date.now()) throw denied();
  }, { current_web_session_expires_at: () => new Date(expiry) });
  const current = await currentAppConnectionReadAuthority(caller,
    { installation_id: record.scope.installation_id, target_key: record.scope.target_key }, guard);
  if ((registry.protocol(current.scope,current.profile)==='v2')!==(input.schema_version==='deft.app_connection_reattach_runtime.v2')
    || !['v1','v2'].includes(registry.protocol(current.scope,current.profile))
    || !isDeepStrictEqual(current.scope, record.scope) || !isDeepStrictEqual(current.profile, record.profile)
    || input.operation !== 'status' && (!isDeepStrictEqual(current.action_consent, record.action_consent)||!isDeepStrictEqual(current.action_consents,record.action_consents))
    || registry.transportDigest(record.scope.org_id, record.scope.installation_id, record.profile) !== data.transport_digest) throw denied();
  // An unactivated status may recover eligibility; it must not bypass the
  // same historical effect fence. Completed activation remains status-only.
  if (input.operation !== 'status' || !record.callback_consumed) {
    await assertNoActiveReattachmentEffects(source, current, guard, record.session_id);
  }
  const deadline = Math.min(Date.parse(input.expires_at), current.expires_at, appConsentDeadline(current.scope.consent_expires_at, current.scope.consent_lifetime),
    input.operation === 'status' ? Infinity : Math.min(Date.parse(data.review_expires_at),...(record.action_consents??[]).map(consent=>appConsentDeadline(consent.expires_at, consent.consent_lifetime))));
  const after = await store.metadata(locator), sourceAfter = await store.metadata({ org_id: locator.org_id,
    owner_user_id: locator.owner_user_id, session_id: data.source.session_id });
  if (deadline <= Date.now() || !after || after.revision !== metadata.revision || !sourceAfter
    || sourceAfter.revision !== source.revision) throw denied();
  (await getAppConnectionSessionRegistry()).authenticate(current.scope, authorization);
  return AppConnectionReattachAnyAuthorityResultSchema.parse({ ...input, allowed: true, expires_at: new Date(deadline).toISOString() });
}
