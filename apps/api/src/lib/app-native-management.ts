import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { appNativeBindings, orgMembers, users, auditLog } from '@deft/db/schema';
import type { ModuleActor } from '@deft/shared/modules';
import { db } from './db.js';
import { AppError } from './app-errors.js';
import { assertCurrentModuleManagerWithExecutor } from './module-service.js';
import { NativeBindingStageSchema, NativeOwnerReviewRequestSchema, NativeOwnerAcceptSchema, buildNativeProviderSnapshot } from './app-native-contract.js';
import { assertNativeCalendarEnabled, loadReviewedNativeApp, loadLiveNativeAuthority, lockNativeParticipants,
  nativeProposal, nativeStale } from './app-native-authority.js';
import { nativeActionDescriptors } from './app-native-contract.js';
import { persistCapabilityProviderSnapshotWithExecutor } from './capability-provider-snapshot-repository.js';
import { digestAppGrantValue } from './app-grant-service.js';
import type { AppRunTransaction } from './app-run-repository.js';
import { nativeFinalAuthorityIsCurrent } from './app-native-final-authority.js';

export type NativeManagementOptions = { guard?: (tx: AppRunTransaction) => Promise<void> };
function human(actor: ModuleActor) {
  if (actor.kind !== 'human' || !['rest', 'ui'].includes(actor.source)) throw new AppError('Native Calendar access denied', 'APP_ACCESS_DENIED', 403);
}
function manager(actor: ModuleActor) {
  human(actor);
  if (actor.kind !== 'human' || !['owner', 'admin'].includes(actor.role)) throw new AppError('Native Calendar manager required', 'APP_ACCESS_DENIED', 403);
}
async function finalGuard(tx: AppRunTransaction, participants: readonly string[], options: NativeManagementOptions) {
  if (!await nativeFinalAuthorityIsCurrent(tx, participants, options)) throw nativeStale();
}
export async function stageNativeBinding(actor: ModuleActor, raw: unknown, options: NativeManagementOptions = {}) {
  manager(actor); assertNativeCalendarEnabled();
  const input = NativeBindingStageSchema.parse(raw);
  return db.transaction(async tx => {
    const participants = [...new Set([actor.actor_id, input.target.calendar_owner_user_id])];
    await lockNativeParticipants(tx, actor.org_id, participants, [actor.actor_id]);
    await assertCurrentModuleManagerWithExecutor(tx, actor);
    const people = await tx.select({ member: orgMembers, kind: users.kind }).from(orgMembers)
      .innerJoin(users, eq(users.id, orgMembers.user_id)).where(and(eq(orgMembers.org_id, actor.org_id), inArray(orgMembers.user_id, participants)));
    const owner = people.find(person => person.member.user_id === input.target.calendar_owner_user_id);
    const proposer = people.find(person => person.member.user_id === actor.actor_id);
    if (!owner?.member.is_active || owner.kind !== 'human' || owner.member.role === 'guest'
      || !proposer?.member.is_active || proposer.kind !== 'human' || !['owner', 'admin'].includes(proposer.member.role)) throw nativeStale();
    const current = await loadReviewedNativeApp(tx, actor.org_id, input.installation_id, 'update');
    const action = nativeActionDescriptors(current.manifest).find(item => item.key === input.action_key);
    if (!action || action.operation !== input.target.operation_name || current.version.id !== input.expected_app_version_id
      || current.version.package_digest !== input.expected_package_digest || current.grant.snapshot_digest !== input.expected_grant_snapshot_digest
      || current.installation.lifecycle_epoch !== input.expected_lifecycle_epoch || current.installation.grant_epoch !== input.expected_grant_epoch) throw nativeStale();
    const [existing] = await tx.select().from(appNativeBindings).where(and(eq(appNativeBindings.org_id, actor.org_id),
      eq(appNativeBindings.app_installation_id, current.installation.id), eq(appNativeBindings.app_version_id, current.version.id),
      eq(appNativeBindings.grant_snapshot_id, current.grant.id), eq(appNativeBindings.action_key, action.key),
      inArray(appNativeBindings.state, ['staged', 'active']))).limit(1).for('share');
    if (existing) {
      if (existing.owner_user_id !== owner.member.user_id || existing.stage_manager_user_id !== proposer.member.user_id
        || digestAppGrantValue(existing.target) !== digestAppGrantValue(input.target)) throw nativeStale();
      const authority = await loadLiveNativeAuthority(tx, { org_id: actor.org_id, native_binding_id: existing.id,
        prelocked_participant_ids: participants, allow_staged: true });
      await finalGuard(tx, participants, options);
      return { schema_version: 'deft.app_native_binding_stage_result.v1', binding_id: existing.id,
        state: existing.state, proposal_digest: authority.binding.proposal_digest };
    }
    const now = new Date();
    const snapshot = buildNativeProviderSnapshot({ org_id: actor.org_id, owner_user_id: owner.member.user_id, captured_at: now.toISOString() });
    const snapshotId = await persistCapabilityProviderSnapshotWithExecutor(tx, snapshot);
    const binding: typeof appNativeBindings.$inferSelect = {
      id: randomUUID(), org_id: actor.org_id, app_installation_id: current.installation.id, app_version_id: current.version.id,
      grant_snapshot_id: current.grant.id, grant_snapshot_kind: 'effective', action_key: action.key, operation_name: action.operation,
      provider_kind: 'native', provider_instance_id: snapshot.provider.provider_instance_id, provider_snapshot_id: snapshotId,
      owner_user_id: owner.member.user_id, stage_manager_user_id: proposer.member.user_id,
      stage_manager_authorization_version: proposer.member.app_run_authorization_version,
      owner_authorization_version: owner.member.app_run_authorization_version,
      installation_lifecycle_epoch: current.installation.lifecycle_epoch, installation_grant_epoch: current.installation.grant_epoch,
      package_digest: current.version.package_digest, grant_snapshot_digest: current.grant.snapshot_digest,
      target: input.target, proposal_digest: '', consent_digest: null, reviewed_contract_digest: action.contract_digest,
      risk_class: 'internal_write', review_requirement: 'always', review_scope: 'per_invocation', retry_class: 'idempotent_with_key',
      retention_class: 'standard', state: 'staged', reviewed_at: null, created_at: now, updated_at: now,
    };
    binding.proposal_digest = digestAppGrantValue(nativeProposal(binding, snapshot.snapshot_digest));
    await tx.insert(appNativeBindings).values(binding);
    await tx.insert(auditLog).values({ org_id: actor.org_id, actor_type: 'human', actor_id: actor.actor_id,
      action: 'app.native.binding_stage', entity_type: 'app_native_binding', entity_id: binding.id,
      after_state: { state: 'staged', proposal_digest: binding.proposal_digest, owner_user_id: binding.owner_user_id } });
    await finalGuard(tx, participants, options);
    return { schema_version: 'deft.app_native_binding_stage_result.v1', binding_id: binding.id, state: binding.state, proposal_digest: binding.proposal_digest };
  });
}

async function ownerAuthority(tx: AppRunTransaction, actor: ModuleActor, bindingId: string) {
  human(actor);
  const authority = await loadLiveNativeAuthority(tx, { org_id: actor.org_id, native_binding_id: bindingId,
    allow_staged: true, app_lock: 'update' });
  if (authority.binding.owner_user_id !== actor.actor_id) throw new AppError('Native Calendar owner consent required', 'APP_ACCESS_DENIED', 403);
  return authority;
}
export async function getNativeOwnerContext(actor: ModuleActor, bindingId: string, options: NativeManagementOptions = {}) {
  human(actor); assertNativeCalendarEnabled();
  return db.transaction(async tx => {
    const authority = await ownerAuthority(tx, actor, bindingId);
    await finalGuard(tx, authority.participants, options);
    return { schema_version: 'deft.app_native_owner_consent_context.v1', binding_id: authority.binding.id,
      state: authority.binding.state, review_request: authority.binding.state === 'staged' ? authority.review.request : null,
      review: authority.binding.state === 'staged' ? authority.review : null,
      current_consent: authority.binding.state === 'active' ? { consent_digest: authority.binding.consent_digest } : null };
  });
}
export async function prepareNativeOwnerReview(actor: ModuleActor, raw: unknown, options: NativeManagementOptions = {}) {
  human(actor); assertNativeCalendarEnabled();
  const input = NativeOwnerReviewRequestSchema.parse(raw);
  return db.transaction(async tx => {
    const authority = await ownerAuthority(tx, actor, input.binding_id);
    if (authority.binding.state !== 'staged' || digestAppGrantValue(input) !== digestAppGrantValue(authority.review.request)) throw nativeStale();
    await finalGuard(tx, authority.participants, options);
    return authority.review;
  });
}
export async function acceptNativeOwnerConsent(actor: ModuleActor, raw: unknown, options: NativeManagementOptions = {}) {
  human(actor); assertNativeCalendarEnabled();
  const { expected_review_digest, accept_host_policy: _accept, ...input } = NativeOwnerAcceptSchema.parse(raw);
  return db.transaction(async tx => {
    const authority = await ownerAuthority(tx, actor, input.binding_id);
    if (digestAppGrantValue(input) !== digestAppGrantValue(authority.review.request) || expected_review_digest !== authority.review.review_digest) throw nativeStale();
    if (authority.binding.state === 'staged') {
      await tx.update(appNativeBindings).set({ state: 'active', consent_digest: expected_review_digest, reviewed_at: new Date() })
        .where(and(eq(appNativeBindings.org_id, actor.org_id), eq(appNativeBindings.id, input.binding_id), eq(appNativeBindings.state, 'staged')));
      await tx.insert(auditLog).values({ org_id: actor.org_id, actor_type: 'human', actor_id: actor.actor_id,
        action: 'app.native.owner_consent', entity_type: 'app_native_binding', entity_id: input.binding_id,
        after_state: { state: 'active', consent_digest: expected_review_digest } });
    }
    await finalGuard(tx, authority.participants, options);
    return { schema_version: 'deft.app_native_owner_consent_result.v1', binding_id: input.binding_id,
      state: 'active', consent_digest: expected_review_digest };
  });
}

export async function revokeNativeBinding(actor: ModuleActor, bindingId: string, expectedProposalDigest: string,
  options: NativeManagementOptions = {}) {
  human(actor); assertNativeCalendarEnabled();
  return db.transaction(async tx => {
    const [locator] = await tx.select().from(appNativeBindings).where(and(eq(appNativeBindings.org_id, actor.org_id),
      eq(appNativeBindings.id, bindingId))).limit(1);
    if (!locator) throw nativeStale();
    const participants = [...new Set([actor.actor_id, locator.owner_user_id, locator.stage_manager_user_id])];
    await lockNativeParticipants(tx, actor.org_id, participants);
    const [member] = await tx.select().from(orgMembers).where(and(eq(orgMembers.org_id, actor.org_id), eq(orgMembers.user_id, actor.actor_id))).limit(1);
    if (!member?.is_active || member.role === 'guest' || (actor.actor_id !== locator.owner_user_id && !['owner', 'admin'].includes(member.role))) throw nativeStale();
    // Revocation must remain possible after a participant or App becomes stale.
    await tx.execute(sql`SELECT id FROM app_installations WHERE org_id = ${actor.org_id} AND id = ${locator.app_installation_id} FOR UPDATE`);
    const [binding] = await tx.select().from(appNativeBindings).where(and(eq(appNativeBindings.org_id, actor.org_id), eq(appNativeBindings.id, bindingId))).limit(1).for('update');
    if (!binding || binding.proposal_digest !== expectedProposalDigest) throw nativeStale();
    if (binding.state !== 'revoked') await tx.update(appNativeBindings).set({ state: 'revoked' }).where(and(eq(appNativeBindings.org_id, actor.org_id), eq(appNativeBindings.id, bindingId)));
    if (!await nativeFinalAuthorityIsCurrent(tx, [actor.actor_id], options)) throw nativeStale();
    return { schema_version: 'deft.app_native_revoke_result.v1', binding_id: bindingId, state: 'revoked' };
  });
}
