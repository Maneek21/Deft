import { createHash, randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  appGrantSnapshots, appInstallations, appRuntimeBindings,
  appRuntimeRegistrations, appRuntimeSessions, appRuns, appVersions,
  capabilityProviderSnapshots, orgMembers,
} from '@deft/db/schema';
import { AppRunAuthorizationSnapshotSchema, AppRuntimeSessionAuthoritySchema,
  canonicalCapabilityJson, type AppRuntimeSessionAuthority } from '@deft/shared';
import { db } from './db.js';
import type { AppRunTransaction } from './app-run-repository.js';
import { APP_RUNTIME_CHANNEL_VERSION, APP_RUNTIME_SESSION_MS } from './app-runtime-contract.js';
import { PostgresAppRunLiveAuthorization } from './app-run-live-authorization.js';
import type { ReviewedRuntimeAction } from './app-runtime-review.js';
import type { WebAuthorityGuard } from './app-resource-sync-web-authority.js';
import { isAppV5RuntimeActionsEnabled } from './env.js';

const runtimeLiveAuthorizer = new PostgresAppRunLiveAuthorization();

export function hashAppRuntimeToken(token: string): string {
  return `sha256:${createHash('sha256').update('deft.app_runtime.session.v1\0').update(token).digest('hex')}`;
}

export type LiveRuntimeAuthority = Readonly<{
  pin: AppRuntimeSessionAuthority;
  grant_snapshot_id: string;
  operator_user_id: string;
  provider_instance_id: string;
  provider_snapshot_id: string;
  operation_name: string;
  risk_class: typeof appRuntimeBindings.$inferSelect['risk_class'];
  review_requirement: typeof appRuntimeBindings.$inferSelect['review_requirement'];
  retry_class: typeof appRuntimeBindings.$inferSelect['retry_class'];
  retention_class: typeof appRuntimeBindings.$inferSelect['retention_class'];
  prelocked_run_actor_id?: string;
  attachment_authority?: Readonly<{ participants: readonly string[]; session_expires_at: Date }>;
}>;

/** This private candidate slice accepts a human-origin Run fixture only. A
 * future app-origin intake must capture the full actor/surface authority
 * vector; no existing v0-v2 entrance can assert this binding. */
export async function runtimeRunMatchesAuthority(
  tx: AppRunTransaction, orgId: string, runId: string, authority: LiveRuntimeAuthority,
): Promise<ReviewedRuntimeAction | null> {
  const [run] = await tx.select().from(appRuns).where(and(
    eq(appRuns.org_id, orgId), eq(appRuns.id, runId),
  )).limit(1);
  if (!run || run.origin_kind !== 'app' || run.provider_kind !== 'app_runtime'
    || (authority.prelocked_run_actor_id !== undefined
      && run.initiating_actor_id !== authority.prelocked_run_actor_id)
    || run.origin_app_installation_id !== authority.pin.app_installation_id
    || run.origin_app_version_id !== authority.pin.app_version_id
    || run.origin_app_grant_snapshot_id !== authority.grant_snapshot_id
    || run.origin_runtime_binding_id !== authority.pin.runtime_binding_id
    || run.origin_app_binding_key !== null
    || run.provider_instance_id !== authority.provider_instance_id
    || run.provider_snapshot_id !== authority.provider_snapshot_id
    || run.operation_name !== authority.operation_name
    || run.risk_class !== authority.risk_class
    || run.review_requirement !== authority.review_requirement
    || run.retry_class !== authority.retry_class
    || run.retention_class !== authority.retention_class
    || run.execution_actor_type !== 'human') return null;
  const snapshot = AppRunAuthorizationSnapshotSchema.safeParse(run.authorization_snapshot);
  if (!snapshot.success) return null;
  try {
    if (run.initiating_actor_type === 'app_public') {
      if (!run.origin_public_endpoint_id || !run.origin_public_ingress_id
        || run.initiating_actor_id !== run.origin_public_ingress_id
        || snapshot.data.authenticated_subject.actor_type !== 'app_public'
        || snapshot.data.authenticated_subject.endpoint_id !== run.origin_public_endpoint_id
        || snapshot.data.authenticated_subject.ingress_id !== run.origin_public_ingress_id) return null;
      const current = await runtimeLiveAuthorizer.captureReviewedPublicRuntimeInTransaction(tx, {
        org_id: orgId, endpoint_id: run.origin_public_endpoint_id,
        ingress_id: run.origin_public_ingress_id,
      });
      const matches = current.registration.id === authority.pin.runtime_registration_id
        && current.registration.runtime_epoch === authority.pin.runtime_epoch
        && current.endpoint.approver_user_id === run.execution_actor_id
        && current.binding.id === run.origin_runtime_binding_id
        && current.binding.provider_instance_id === run.provider_instance_id
        && current.binding.provider_snapshot_id === run.provider_snapshot_id
        && current.binding.operation_name === run.operation_name
        && current.binding.risk_class === run.risk_class
        && current.binding.review_requirement === run.review_requirement
        && current.binding.retry_class === run.retry_class
        && current.binding.retention_class === run.retention_class
        && current.action.host_policy.review_scope === run.review_scope
        && canonicalCapabilityJson(snapshot.data.authority_refs)
          === canonicalCapabilityJson(current.authorization_snapshot.authority_refs);
      return matches ? current.action : null;
    }
    if (run.initiating_actor_type !== 'human'
      || run.initiating_actor_id !== run.execution_actor_id
      || run.origin_public_endpoint_id !== null || run.origin_public_ingress_id !== null
      || snapshot.data.authenticated_subject.actor_type !== 'human'
      || snapshot.data.authenticated_subject.user_id !== run.initiating_actor_id) return null;
    const current = await runtimeLiveAuthorizer.captureReviewedRuntimeInTransaction(tx, {
      org_id: orgId, user_id: run.initiating_actor_id,
      runtime_binding_id: authority.pin.runtime_binding_id,
    });
    const matches = current.registration.id === authority.pin.runtime_registration_id
      && current.registration.runtime_epoch === authority.pin.runtime_epoch
      && current.binding.provider_instance_id === run.provider_instance_id
      && current.binding.provider_snapshot_id === run.provider_snapshot_id
      && current.binding.operation_name === run.operation_name
      && current.binding.risk_class === run.risk_class
      && current.binding.review_requirement === run.review_requirement
      && current.binding.retry_class === run.retry_class
      && current.binding.retention_class === run.retention_class
      && current.action.host_policy.review_scope === run.review_scope
      && canonicalCapabilityJson(snapshot.data.authority_refs)
        === canonicalCapabilityJson(current.authorization_snapshot.authority_refs);
    return matches ? current.action : null;
  } catch { return null; }
}

/** Every channel operation rereads live host authority under row locks.
 * Token hash is necessary but never sufficient: revocation, operator membership,
 * installation epochs, active version/grant and reviewed binding are all live. */
export async function loadLiveRuntimeAuthority(
  tx: AppRunTransaction,
  orgId: string,
  sessionId: string,
  tokenHash: string,
  now: () => Date,
  runId?: string,
): Promise<LiveRuntimeAuthority | null> {
  // Locate without trusting the row, then lock in the same order as App
  // lifecycle transitions: installation -> registration -> binding -> session.
  const [locator] = await tx.select().from(appRuntimeSessions).where(and(
    eq(appRuntimeSessions.org_id, orgId), eq(appRuntimeSessions.id, sessionId),
    eq(appRuntimeSessions.token_hash, tokenHash),
  )).limit(1);
  if (!locator || locator.audience !== 'app_runtime'
    || !locator.runtime_binding_id || locator.resource_binding_id !== null) return null;
  // Match App lifecycle's membership -> installation lock order. A Run
  // locator is untrusted; its exact actor identity is reread at the boundary.
  const memberIds: string[] = [];
  let prelockedRunActorId: string | undefined;
  if (runId) {
    const [runLocator] = await tx.select({ actor_type: appRuns.initiating_actor_type,
      actor_id: appRuns.initiating_actor_id,
      execution_actor_type: appRuns.execution_actor_type,
      execution_actor_id: appRuns.execution_actor_id,
      origin_public_endpoint_id: appRuns.origin_public_endpoint_id,
      origin_public_ingress_id: appRuns.origin_public_ingress_id }).from(appRuns).where(and(
      eq(appRuns.org_id, orgId), eq(appRuns.id, runId),
    )).limit(1);
    if (!runLocator || (runLocator.actor_type !== 'human' && runLocator.actor_type !== 'app_public')) return null;
    if (runLocator.actor_type === 'app_public' && (runLocator.execution_actor_type !== 'human'
      || !runLocator.origin_public_endpoint_id || !runLocator.origin_public_ingress_id
      || runLocator.actor_id !== runLocator.origin_public_ingress_id)) return null;
    prelockedRunActorId = runLocator.actor_id;
    memberIds.push(runLocator.actor_type === 'human'
      ? runLocator.actor_id : runLocator.execution_actor_id);
  }
  memberIds.push(locator.operator_user_id);
  for (const userId of [...new Set(memberIds)].sort()) {
    await tx.execute(sql`SELECT id FROM org_members WHERE org_id = ${orgId}
      AND user_id = ${userId} FOR SHARE`);
  }
  const [registrationLocator] = await tx.select({
    app_installation_id: appRuntimeRegistrations.app_installation_id,
  }).from(appRuntimeRegistrations).where(and(
    eq(appRuntimeRegistrations.org_id, orgId),
    eq(appRuntimeRegistrations.id, locator.runtime_registration_id),
  )).limit(1);
  if (!registrationLocator) return null;
  await tx.execute(sql`SELECT id FROM app_installations
    WHERE org_id = ${orgId} AND id = ${registrationLocator.app_installation_id} FOR SHARE`);
  await tx.execute(sql`SELECT id FROM app_runtime_registrations
    WHERE org_id = ${orgId} AND id = ${locator.runtime_registration_id} FOR SHARE`);
  await tx.execute(sql`SELECT id FROM app_runtime_bindings
    WHERE org_id = ${orgId} AND id = ${locator.runtime_binding_id} FOR SHARE`);
  await tx.execute(sql`SELECT id FROM app_runtime_sessions
    WHERE org_id = ${orgId} AND id = ${sessionId} FOR UPDATE`);
  const [session] = await tx.select().from(appRuntimeSessions).where(and(
    eq(appRuntimeSessions.org_id, orgId), eq(appRuntimeSessions.id, sessionId),
    eq(appRuntimeSessions.token_hash, tokenHash),
  )).limit(1);
  const checkedAt = now();
  if (!session || session.audience !== 'app_runtime' || session.revoked_at
    || !session.runtime_binding_id || session.resource_binding_id !== null
    || session.expires_at <= checkedAt || session.runtime_registration_id !== locator.runtime_registration_id
    || session.runtime_binding_id !== locator.runtime_binding_id
    || session.operator_user_id !== locator.operator_user_id) return null;
  const [registration] = await tx.select().from(appRuntimeRegistrations).where(and(
    eq(appRuntimeRegistrations.org_id, orgId),
    eq(appRuntimeRegistrations.id, session.runtime_registration_id),
  )).limit(1);
  if (!registration || registration.state !== 'active'
    || registration.contract_version !== APP_RUNTIME_CHANNEL_VERSION
    || registration.runtime_epoch !== session.runtime_epoch
    || registration.operator_user_id !== session.operator_user_id) return null;
  const [binding] = await tx.select().from(appRuntimeBindings).where(and(
    eq(appRuntimeBindings.org_id, orgId), eq(appRuntimeBindings.id, session.runtime_binding_id),
  )).limit(1);
  if (!binding || binding.state !== 'active'
    || binding.runtime_registration_id !== registration.id
    || binding.app_installation_id !== registration.app_installation_id
    || binding.app_version_id !== registration.app_version_id
    || binding.grant_snapshot_id !== registration.grant_snapshot_id
    || binding.provider_kind !== 'app_runtime') return null;
  if (registration.app_installation_id !== registrationLocator.app_installation_id) return null;
  const [installation] = await tx.select().from(appInstallations).where(and(
    eq(appInstallations.org_id, orgId), eq(appInstallations.id, registration.app_installation_id),
  )).limit(1);
  if (!installation || installation.state !== 'active'
    || installation.active_version_id !== registration.app_version_id
    || installation.active_grant_snapshot_id !== registration.grant_snapshot_id
    || installation.lifecycle_epoch !== session.lifecycle_epoch
    || installation.grant_epoch !== session.grant_epoch) return null;
  await tx.execute(sql`SELECT id FROM app_versions WHERE org_id = ${orgId}
    AND id = ${registration.app_version_id} FOR SHARE`);
  const [version] = await tx.select({ state: appVersions.state, protocol_version: appVersions.protocol_version }).from(appVersions).where(and(
      eq(appVersions.org_id, orgId), eq(appVersions.id, registration.app_version_id),
      eq(appVersions.installation_id, registration.app_installation_id),
    )).limit(1);
  const [grant] = await tx.select({ snapshot_kind: appGrantSnapshots.snapshot_kind }).from(appGrantSnapshots).where(and(
      eq(appGrantSnapshots.org_id, orgId), eq(appGrantSnapshots.id, registration.grant_snapshot_id),
      eq(appGrantSnapshots.app_installation_id, registration.app_installation_id),
      eq(appGrantSnapshots.app_version_id, registration.app_version_id),
    )).limit(1);
  const [member] = await tx.select({ is_active: orgMembers.is_active }).from(orgMembers).where(and(
      eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, session.operator_user_id),
    )).limit(1);
  const [snapshot] = await tx.select({ provider_kind: capabilityProviderSnapshots.provider_kind }).from(capabilityProviderSnapshots).where(and(
      eq(capabilityProviderSnapshots.org_id, orgId), eq(capabilityProviderSnapshots.id, binding.provider_snapshot_id),
      eq(capabilityProviderSnapshots.provider_instance_id, binding.provider_instance_id),
    )).limit(1);
  if (version?.state !== 'active' || grant?.snapshot_kind !== 'effective'
    || !member?.is_active || snapshot?.provider_kind !== 'app_runtime') return null;
  if (session.expires_at <= now()) return null;
  return Object.freeze({
    pin: AppRuntimeSessionAuthoritySchema.parse({
      org_id: orgId, app_installation_id: registration.app_installation_id,
      app_version_id: registration.app_version_id,
      lifecycle_epoch: session.lifecycle_epoch, grant_epoch: session.grant_epoch,
      audience: 'app_runtime', runtime_registration_id: registration.id,
      runtime_binding_id: binding.id, runtime_epoch: registration.runtime_epoch,
      session_id: session.id, session_epoch: session.session_epoch,
    }),
    grant_snapshot_id: registration.grant_snapshot_id,
    operator_user_id: session.operator_user_id,
    provider_instance_id: binding.provider_instance_id,
    provider_snapshot_id: binding.provider_snapshot_id,
    operation_name: binding.operation_name,
    risk_class: binding.risk_class,
    review_requirement: binding.review_requirement,
    retry_class: binding.retry_class,
    retention_class: binding.retention_class,
    ...(prelockedRunActorId ? { prelocked_run_actor_id: prelockedRunActorId } : {}),
    ...(version.protocol_version === '7' ? { attachment_authority: Object.freeze({
      participants: Object.freeze([...new Set(memberIds)]), session_expires_at: session.expires_at,
    }) } : {}),
  });
}

/** Host-only minting seam; caller must already authenticate the human operator. */
export async function issueAppRuntimeSession(input: Readonly<{
  org_id: string;
  runtime_binding_id: string;
  operator_user_id: string;
  now?: Date;
  guard?: WebAuthorityGuard;
}>): Promise<Readonly<{ session_id: string; session_token: string; expires_at: Date }> | null> {
  const now = input.now ?? new Date();
  const sessionId = crypto.randomUUID();
  const sessionToken = randomBytes(32).toString('base64url');
  let issued = false;
  try { issued = await db.transaction(async (tx) => {
    const [binding] = await tx.select().from(appRuntimeBindings).where(and(
      eq(appRuntimeBindings.org_id, input.org_id), eq(appRuntimeBindings.id, input.runtime_binding_id),
    )).limit(1);
    if (!binding) return false;
    const [registration] = await tx.select().from(appRuntimeRegistrations).where(and(
      eq(appRuntimeRegistrations.org_id, input.org_id), eq(appRuntimeRegistrations.id, binding.runtime_registration_id),
    )).limit(1);
    if (!registration || registration.operator_user_id !== input.operator_user_id) return false;
    await tx.execute(sql`SELECT id FROM org_members WHERE org_id = ${input.org_id}
      AND user_id = ${input.operator_user_id} FOR SHARE`);
    await tx.execute(sql`SELECT id FROM app_installations WHERE org_id = ${input.org_id}
      AND id = ${registration.app_installation_id} FOR SHARE`);
    await tx.execute(sql`SELECT id FROM app_runtime_registrations WHERE org_id = ${input.org_id}
      AND id = ${registration.id} FOR SHARE`);
    await tx.execute(sql`SELECT id FROM app_runtime_bindings WHERE org_id = ${input.org_id}
      AND id = ${binding.id} FOR SHARE`);
    const [installation] = await tx.select().from(appInstallations).where(and(
      eq(appInstallations.org_id, input.org_id),
      eq(appInstallations.id, registration.app_installation_id),
    )).limit(1);
    if (!installation) return false;
    const [lockedRegistration] = await tx.select().from(appRuntimeRegistrations).where(and(
      eq(appRuntimeRegistrations.org_id, input.org_id), eq(appRuntimeRegistrations.id, registration.id),
    )).limit(1);
    const [lockedBinding] = await tx.select().from(appRuntimeBindings).where(and(
      eq(appRuntimeBindings.org_id, input.org_id), eq(appRuntimeBindings.id, binding.id),
    )).limit(1);
    if (!lockedRegistration || !lockedBinding
      || lockedRegistration.app_installation_id !== installation.id
      || lockedRegistration.operator_user_id !== input.operator_user_id
      || lockedBinding.runtime_registration_id !== lockedRegistration.id) return false;
    const bootstrapTokenHash = hashAppRuntimeToken(sessionToken);
    // The live check runs after insertion in the same transaction, so a stale
    // registration, grant, membership or installation cannot mint authority.
    await tx.insert(appRuntimeSessions).values({
      id: sessionId, org_id: input.org_id,
      runtime_registration_id: registration.id, runtime_binding_id: binding.id,
      operator_user_id: input.operator_user_id, token_hash: bootstrapTokenHash,
      runtime_epoch: lockedRegistration.runtime_epoch,
      lifecycle_epoch: installation.lifecycle_epoch, grant_epoch: installation.grant_epoch,
      expires_at: new Date(now.getTime() + APP_RUNTIME_SESSION_MS),
      created_at: now, updated_at: now,
    });
    if (!await loadLiveRuntimeAuthority(tx, input.org_id, sessionId, bootstrapTokenHash,
      () => input.now ?? new Date())) {
      throw new Error('APP_RUNTIME_AUTHORITY_STALE');
    }
    const [version]=await tx.select({protocol:appVersions.protocol_version}).from(appVersions)
      .where(and(eq(appVersions.org_id,input.org_id),eq(appVersions.id,lockedBinding.app_version_id),
        eq(appVersions.installation_id,installation.id))).limit(1);
    if(version?.protocol==='7'){
      if(!input.guard)throw new Error('APP_RUNTIME_AUTHORITY_STALE');
      const {attachmentFinalAuthorityIsCurrent}=await import('./app-attachment-authority.js');
      if(!await attachmentFinalAuthorityIsCurrent(tx,[input.operator_user_id],{guard:input.guard,
        expires_at:[new Date(now.getTime()+APP_RUNTIME_SESSION_MS)]})||!isAppV5RuntimeActionsEnabled())throw new Error('APP_RUNTIME_AUTHORITY_STALE');
    }
    return true;
  }); } catch { return null; }
  return issued ? Object.freeze({ session_id: sessionId, session_token: sessionToken,
    expires_at: new Date(now.getTime() + APP_RUNTIME_SESSION_MS) }) : null;
}
