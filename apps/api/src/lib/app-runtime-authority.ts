import { humanActionReleaseIsCurrent } from './app-experience-human-action-live.js';
import {appConnectionUpgradeSourceIsAvailable} from './app-connection-upgrade-fence.js';
import { assertOwnerConnectionRegistration } from './app-owner-connection-authority.js';
import { actionBatchReleaseIsCurrent } from './app-action-batch-live.js';
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
import {runtimeRenewalOptedIn,runtimeRenewalPrincipal,runtimeRenewalPersistentPrincipal,runtimeRenewalTargetOwner,runtimeRenewalTargetDeadline,runtimeRenewalDeadline} from './app-runtime-renewal.js';

const runtimeLiveAuthorizer = new PostgresAppRunLiveAuthorization();
type CurrentRuntimeAction = ReviewedRuntimeAction & Readonly<{ protocol_version: string; owner_target_consent_expires_at?: Date;owner_target_consent_lifetime?:'until_revoked' }>;

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
  renewal?:Readonly<{renewable_until:Date|null;principal_expires_at:Date|null;target_expires_at?:Date;expires_at:Date;renewal_lifetime?:'until_revoked'}>;
}>;

/** This private candidate slice accepts a human-origin Run fixture only. A
 * future app-origin intake must capture the full actor/surface authority
 * vector; no existing v0-v2 entrance can assert this binding. */
export async function runtimeRunMatchesAuthority(
  tx: AppRunTransaction, orgId: string, runId: string, authority: LiveRuntimeAuthority,
): Promise<CurrentRuntimeAction | null> {
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
  if (!await humanActionReleaseIsCurrent(tx, run)) return null;
  if (!await actionBatchReleaseIsCurrent(tx, run)) return null;
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
      if(current.binding.owner_resource_binding_id&&!await appConnectionUpgradeSourceIsAvailable(tx,{org_id:orgId,resource_binding_id:current.binding.owner_resource_binding_id}))return null;
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
      return matches ? Object.freeze({ ...current.action, protocol_version: current.protocol_version,
        ...(current.owner_target_consent_lifetime?{owner_target_consent_lifetime:current.owner_target_consent_lifetime}:{}),
        ...(current.owner_target_consent_expires_at ? { owner_target_consent_expires_at: current.owner_target_consent_expires_at } : {}) }) : null;
    }
    const isAgent = run.initiating_actor_type === 'agent_employee';
    if ((!isAgent && run.initiating_actor_type !== 'human')
      || (!isAgent && run.initiating_actor_id !== run.execution_actor_id)
      || run.origin_public_endpoint_id !== null || run.origin_public_ingress_id !== null
      || snapshot.data.authenticated_subject.actor_type !== run.initiating_actor_type) return null;
    if (isAgent) {
      if (snapshot.data.authenticated_subject.actor_type !== 'agent_employee'
        || snapshot.data.authenticated_subject.agent_employee_id !== run.initiating_actor_id
        || run.budget_reserved_at === null || run.budget_reserved_count !== 1) return null;
    } else if (snapshot.data.authenticated_subject.actor_type !== 'human'
      || snapshot.data.authenticated_subject.user_id !== run.initiating_actor_id) return null;
    const current = isAgent
      ? await runtimeLiveAuthorizer.captureReviewedRuntimeAgentInTransaction(tx, {
        org_id:orgId,agent_employee_id:run.initiating_actor_id,runtime_binding_id:authority.pin.runtime_binding_id })
      : await runtimeLiveAuthorizer.captureReviewedRuntimeInTransaction(tx, {
        org_id:orgId,user_id:run.initiating_actor_id,runtime_binding_id:authority.pin.runtime_binding_id });
    if ('agent_owner_user_id' in current && current.agent_owner_user_id !== run.execution_actor_id) return null;
    if(current.binding.owner_resource_binding_id&&!await appConnectionUpgradeSourceIsAvailable(tx,{org_id:orgId,resource_binding_id:current.binding.owner_resource_binding_id}))return null;
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
    return matches ? Object.freeze({ ...current.action, protocol_version: current.protocol_version,
      ...(current.owner_target_consent_lifetime?{owner_target_consent_lifetime:current.owner_target_consent_lifetime}:{}),
        ...(current.owner_target_consent_expires_at ? { owner_target_consent_expires_at: current.owner_target_consent_expires_at } : {}) }) : null;
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
  const [registrationLocator] = await tx.select({ app_installation_id: appRuntimeRegistrations.app_installation_id,
    owner_connection_admission_id: appRuntimeRegistrations.owner_connection_admission_id,
    reviewed_by_user_id: appRuntimeRegistrations.reviewed_by_user_id }).from(appRuntimeRegistrations).where(and(
      eq(appRuntimeRegistrations.org_id, orgId), eq(appRuntimeRegistrations.id, locator.runtime_registration_id))).limit(1);
  if (!registrationLocator) return null;
  if (registrationLocator.owner_connection_admission_id && registrationLocator.reviewed_by_user_id)
    memberIds.push(registrationLocator.reviewed_by_user_id);
  let prelockedRunActorId: string | undefined;
  let prelockedAgentId: string | undefined;
  if (runId) {
    const [runLocator] = await tx.select({ actor_type: appRuns.initiating_actor_type,
      actor_id: appRuns.initiating_actor_id,
      execution_actor_type: appRuns.execution_actor_type,
      execution_actor_id: appRuns.execution_actor_id,
      origin_public_endpoint_id: appRuns.origin_public_endpoint_id,
      origin_public_ingress_id: appRuns.origin_public_ingress_id }).from(appRuns).where(and(
      eq(appRuns.org_id, orgId), eq(appRuns.id, runId),
    )).limit(1);
    if (!runLocator || !['human','app_public','agent_employee'].includes(runLocator.actor_type)) return null;
    if(runLocator.actor_type==='agent_employee' && runLocator.execution_actor_type!=='human')return null;
    if (runLocator.actor_type === 'app_public' && (runLocator.execution_actor_type !== 'human'
      || !runLocator.origin_public_endpoint_id || !runLocator.origin_public_ingress_id
      || runLocator.actor_id !== runLocator.origin_public_ingress_id)) return null;
    prelockedRunActorId = runLocator.actor_id;
    if (runLocator.actor_type === 'agent_employee') prelockedAgentId = runLocator.actor_id;
    memberIds.push(runLocator.actor_type === 'human'
      ? runLocator.actor_id : runLocator.execution_actor_id);
  }
  memberIds.push(locator.operator_user_id);
  if(runtimeRenewalOptedIn(locator)){
    const [targetBinding]=await tx.select().from(appRuntimeBindings).where(and(eq(appRuntimeBindings.org_id,orgId),eq(appRuntimeBindings.id,locator.runtime_binding_id))).limit(1);
    if(!targetBinding)return null;
    try { const owner=await runtimeRenewalTargetOwner(tx,orgId,targetBinding.owner_resource_binding_id);if(owner)memberIds.push(owner); }
    catch { return null; }
  }
  for (const userId of [...new Set(memberIds)].sort()) {
    await tx.execute(sql`SELECT id FROM org_members WHERE org_id = ${orgId}
      AND user_id = ${userId} FOR SHARE`);
  }
  if (prelockedAgentId) await tx.execute(sql`SELECT id FROM agent_employees
    WHERE org_id = ${orgId} AND id = ${prelockedAgentId} FOR SHARE`);
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
  if (registration.owner_connection_admission_id) {
    if (!registration.reviewed_by_user_id || !binding.owner_resource_binding_id
      || binding.reviewed_by_user_id !== registration.reviewed_by_user_id) return null;
    try { await assertOwnerConnectionRegistration(tx, registration, { owner_user_id: registration.reviewed_by_user_id,
      action_key: binding.action_key });
      const { loadRuntimeOwnerTarget } = await import('./app-runtime-owner-target.js');
      const target = await loadRuntimeOwnerTarget(tx, { org_id: orgId, owner_user_id: registration.reviewed_by_user_id,
        resource_binding_id: binding.owner_resource_binding_id, installation_id: registration.app_installation_id,
        app_version_id: registration.app_version_id, grant_snapshot_id: registration.grant_snapshot_id,
        operator_user_id: registration.operator_user_id, prelocked_participant_ids: memberIds });
      if (target.registration.owner_connection_admission_id !== registration.owner_connection_admission_id
        || target.registration.owner_connection_admission_digest !== registration.owner_connection_admission_digest) return null;
    } catch { return null; }
  }
  let renewal:LiveRuntimeAuthority['renewal'];
  if(runtimeRenewalOptedIn(session)){
    try {
    if(!session.renewal_web_session_id||!session.renewal_operator_role||session.renewal_lifetime!=='until_revoked'&&!session.renewable_until)return null;
    const target_expires_at=await runtimeRenewalTargetDeadline(tx,binding,registration,memberIds,session.renewal_lifetime==='until_revoked');
    const persistent=session.renewal_lifetime==='until_revoked';
    if(persistent&&!await runtimeRenewalPersistentPrincipal(tx,{org_id:orgId,operator_user_id:session.operator_user_id,role:session.renewal_operator_role}))return null;
    const principal_expires_at=persistent?null:await runtimeRenewalPrincipal(tx,{org_id:orgId,operator_user_id:session.operator_user_id,sid:session.renewal_web_session_id,role:session.renewal_operator_role},now());
    if(!persistent&&!principal_expires_at||!runtimeRenewalDeadline({now:now(),current_expires_at:session.expires_at,expected_expires_at:session.expires_at,renewable_until:session.renewable_until,principal_expires_at,target_expires_at,...(persistent?{renewal_lifetime:'until_revoked' as const}:{})}))return null;
    renewal={renewable_until:session.renewable_until,principal_expires_at,target_expires_at,expires_at:session.expires_at,...(persistent?{renewal_lifetime:'until_revoked' as const}:{})};
    } catch { return null; }
  }
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
    ...(renewal?{renewal}:{}),
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
  technical_renewal?:Readonly<{requested_until:Date|null;sid:string;role:string;renewal_lifetime?:'until_revoked'}>;
}>): Promise<Readonly<{ session_id: string; session_token: string; expires_at: Date;renewable_until?:Date|null;renewal_lifetime?:'until_revoked' }> | null> {
  const now = input.now ?? new Date();
  const sessionId = crypto.randomUUID();
  const sessionToken = randomBytes(32).toString('base64url');
  let issued = false;
  let expiresAt=new Date(now.getTime()+APP_RUNTIME_SESSION_MS),renewableUntil:Date|null|undefined;
  try { issued = await db.transaction(async (tx) => {
    const [binding] = await tx.select().from(appRuntimeBindings).where(and(
      eq(appRuntimeBindings.org_id, input.org_id), eq(appRuntimeBindings.id, input.runtime_binding_id),
    )).limit(1);
    if (!binding) return false;
    const [registration] = await tx.select().from(appRuntimeRegistrations).where(and(
      eq(appRuntimeRegistrations.org_id, input.org_id), eq(appRuntimeRegistrations.id, binding.runtime_registration_id),
    )).limit(1);
    if (!registration || registration.operator_user_id !== input.operator_user_id) return false;
    const participants = [...new Set([input.operator_user_id,
      ...(registration.owner_connection_admission_id && registration.reviewed_by_user_id ? [registration.reviewed_by_user_id] : [])])].sort();
    if(input.technical_renewal){const owner=await runtimeRenewalTargetOwner(tx,input.org_id,binding.owner_resource_binding_id);if(owner&&!participants.includes(owner))participants.push(owner);participants.sort();}
    for (const userId of participants) await tx.execute(sql`SELECT id FROM org_members WHERE org_id = ${input.org_id}
      AND user_id = ${userId} FOR SHARE`);
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
    if(input.technical_renewal){
      if(!input.guard)throw Error('APP_RUNTIME_AUTHORITY_STALE');
      const target=await runtimeRenewalTargetDeadline(tx,lockedBinding,lockedRegistration,participants,input.technical_renewal.renewal_lifetime==='until_revoked');
      // This is a tentative ceiling only. The inserted session's full live
      // check locks/rechecks the SID last, then the original web guard runs.
      const principal=await runtimeRenewalPrincipal(tx,{org_id:input.org_id,operator_user_id:input.operator_user_id,sid:input.technical_renewal.sid,role:input.technical_renewal.role},input.now??new Date(),false);
      const persistent=input.technical_renewal.renewal_lifetime==='until_revoked';
      const requested=input.technical_renewal.requested_until?.getTime()??Infinity;
      if(!principal||(!persistent&&!Number.isFinite(requested))||(persistent&&input.technical_renewal.requested_until!==null))throw Error('APP_RUNTIME_AUTHORITY_STALE');
      renewableUntil=persistent?null:new Date(Math.min(requested,principal.getTime(),target?.getTime()??Infinity));
      if(renewableUntil&&renewableUntil<=now)throw Error('APP_RUNTIME_AUTHORITY_STALE');expiresAt=new Date(Math.min(expiresAt.getTime(),renewableUntil?.getTime()??Infinity));
    }
    // The live check runs after insertion in the same transaction, so a stale
    // registration, grant, membership or installation cannot mint authority.
    await tx.insert(appRuntimeSessions).values({
      id: sessionId, org_id: input.org_id,
      runtime_registration_id: registration.id, runtime_binding_id: binding.id,
      operator_user_id: input.operator_user_id, token_hash: bootstrapTokenHash,
      runtime_epoch: lockedRegistration.runtime_epoch,
      lifecycle_epoch: installation.lifecycle_epoch, grant_epoch: installation.grant_epoch,
      expires_at: expiresAt,
      ...(input.technical_renewal?{renewable_until:renewableUntil,...(input.technical_renewal.renewal_lifetime?{renewal_lifetime:input.technical_renewal.renewal_lifetime}:{}),renewal_web_session_id:input.technical_renewal!.sid,renewal_operator_role:input.technical_renewal!.role}:{}),
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
        expires_at:[expiresAt]})||!isAppV5RuntimeActionsEnabled())throw new Error('APP_RUNTIME_AUTHORITY_STALE');
    } else if(input.technical_renewal){
      await input.guard!(tx);
      if(input.guard!.current_web_session_expires_at()<=new Date())throw new Error('APP_RUNTIME_AUTHORITY_STALE');
    }
    return true;
  }); } catch { return null; }
  return issued ? Object.freeze({ session_id: sessionId, session_token: sessionToken,
    expires_at: expiresAt,...(input.technical_renewal?{renewable_until:renewableUntil,...(input.technical_renewal.renewal_lifetime?{renewal_lifetime:input.technical_renewal.renewal_lifetime}:{})}:{}) }) : null;
}

/** Only extends an explicitly enrolled, still-live session; attempt identity is immutable. */
export async function renewAppRuntimeSession(input:{session_id:string;session_token:string;expected_expires_at:string},clock:()=>Date=()=>new Date()){
 const tokenHash=hashAppRuntimeToken(input.session_token);
 try { return await db.transaction(async tx=>{
  const [locator]=await tx.select({org_id:appRuntimeSessions.org_id}).from(appRuntimeSessions).where(and(eq(appRuntimeSessions.id,input.session_id),eq(appRuntimeSessions.token_hash,tokenHash))).limit(1);if(!locator)return null;
  const live=await loadLiveRuntimeAuthority(tx,locator.org_id,input.session_id,tokenHash,clock);if(!live?.renewal)return null;
  // The database enforces the fifteen-minute extension bound. Derive the new
  // expiry from that same clock, without allowing API/DB skew to raise the cap.
  const serverClock=await tx.execute(sql`SELECT clock_timestamp() AS renewed_at`);
  const renewedAt=new Date(serverClock.rows[0]!.renewed_at as string|Date);
  const next=runtimeRenewalDeadline({now:renewedAt,current_expires_at:live.renewal.expires_at,expected_expires_at:new Date(input.expected_expires_at),...live.renewal});if(!next)return null;
  await tx.update(appRuntimeSessions).set({expires_at:next,updated_at:clock()}).where(and(eq(appRuntimeSessions.org_id,locator.org_id),eq(appRuntimeSessions.id,input.session_id),eq(appRuntimeSessions.token_hash,tokenHash)));
  if(!await loadLiveRuntimeAuthority(tx,locator.org_id,input.session_id,tokenHash,clock))throw Error('APP_RUNTIME_AUTHORITY_STALE');
  return {session_id:input.session_id,expires_at:next.toISOString(),renewable_until:live.renewal.renewable_until?.toISOString()??null,...(live.renewal.renewal_lifetime?{renewal_lifetime:live.renewal.renewal_lifetime}:{})};
 }); } catch(error) {
  if(error instanceof Error && error.message==='APP_RUNTIME_AUTHORITY_STALE')return null;
  throw error;
 }
}
