import { and, eq, inArray, sql } from 'drizzle-orm';
import { AppDigestSchema, NATIVE_ACTION_HOST_POLICY, parseNativeAppManifest } from '@deft/app-kit';
import { appNativeBindings, appInstallations, appVersions, appGrantSnapshots, capabilityProviderSnapshots, orgMembers, users } from '@deft/db/schema';
import type { AppRunTransaction } from './app-run-repository.js';
import { AppError } from './app-errors.js';
import { buildRequestedAppGrantProjection, digestAppGrantValue } from './app-grant-service.js';
import { buildNativeAppReviewedAuthority, NATIVE_APP_EFFECTIVE_CLASSIFICATION } from './app-native-grant.js';
import { NativeCalendarTargetSchema, NativeOwnerReviewRequestSchema, parseNativeProviderSnapshot, nativeActionDescriptors } from './app-native-contract.js';
import { isAppNativeCalendarEnabled } from './env.js';
import { HistoricalCreatePolicySchema } from './app-public-cancellation-contract.js';

export const nativeStale = () => new AppError('Native Calendar authority changed or is unavailable', 'APP_STALE', 409);
export function assertNativeCalendarEnabled() {
  if (!isAppNativeCalendarEnabled()) throw new AppError('Native Calendar unavailable', 'APP_FEATURE_DISABLED', 503);
}
export async function lockNativeParticipants(tx: AppRunTransaction, orgId: string, userIds: readonly string[], updateIds: readonly string[] = []) {
  for (const userId of [...new Set(userIds)].sort()) {
    if (updateIds.includes(userId)) await tx.execute(sql`SELECT id FROM org_members WHERE org_id = ${orgId} AND user_id = ${userId} FOR UPDATE`);
    else await tx.execute(sql`SELECT id FROM org_members WHERE org_id = ${orgId} AND user_id = ${userId} FOR SHARE`);
  }
}
export async function nativeParticipantsAreHuman(tx: AppRunTransaction, userIds: readonly string[]) {
  const ids = [...new Set(userIds)];
  const rows = await tx.select({ id: users.id, kind: users.kind, is_agent: users.is_agent }).from(users).where(inArray(users.id, ids));
  return ids.every(id => rows.some(row => row.id === id && row.kind === 'human' && !row.is_agent));
}

/** Caller has locked every participant before entering this App fence. */
export async function loadReviewedNativeApp(tx: Pick<AppRunTransaction, 'select'>, orgId: string, installationId: string,
  lock: 'share' | 'update' = 'share') {
  assertNativeCalendarEnabled();
  const [installation] = await tx.select().from(appInstallations).where(and(eq(appInstallations.org_id, orgId),
    eq(appInstallations.id, installationId))).limit(1).for(lock);
  if (!installation || installation.state !== 'active' || !installation.active_version_id
    || !installation.active_grant_snapshot_id || installation.active_grant_snapshot_kind !== 'effective') throw nativeStale();
  const [version] = await tx.select().from(appVersions).where(and(eq(appVersions.org_id, orgId),
    eq(appVersions.installation_id, installation.id), eq(appVersions.id, installation.active_version_id),
    eq(appVersions.state, 'active'), eq(appVersions.protocol_version, '6'))).limit(1).for('share');
  const [grant] = await tx.select().from(appGrantSnapshots).where(and(eq(appGrantSnapshots.org_id, orgId),
    eq(appGrantSnapshots.app_installation_id, installation.id), eq(appGrantSnapshots.id, installation.active_grant_snapshot_id),
    eq(appGrantSnapshots.snapshot_kind, 'effective'))).limit(1);
  if (!version || !grant || grant.app_version_id !== version.id || grant.package_digest !== version.package_digest
    || grant.manifest_digest !== version.manifest_digest || grant.requested_snapshot_id !== version.requested_grant_snapshot_id) throw nativeStale();
  const manifest = parseNativeAppManifest(version.manifest);
  if (manifest.id !== installation.app_id || manifest.version !== version.version
    || digestAppGrantValue(manifest) !== version.manifest_digest
    || grant.app_id !== installation.app_id || grant.app_version !== version.version) throw nativeStale();
  const [requested] = await tx.select().from(appGrantSnapshots).where(and(eq(appGrantSnapshots.org_id, orgId),
    eq(appGrantSnapshots.app_installation_id, installation.id), eq(appGrantSnapshots.app_version_id, version.id),
    eq(appGrantSnapshots.id, version.requested_grant_snapshot_id ?? ''), eq(appGrantSnapshots.snapshot_kind, 'requested'))).limit(1);
  const expectedRequested = buildRequestedAppGrantProjection({ organization_id: orgId, app_installation_id: installation.id,
    app_version_id: version.id, manifest, manifest_digest: version.manifest_digest, package_digest: version.package_digest });
  const review = AppDigestSchema.safeParse(grant.canonical_snapshot.review_digest);
  if (!requested || requested.snapshot_digest !== expectedRequested.snapshot_digest
    || digestAppGrantValue(requested.canonical_snapshot) !== expectedRequested.snapshot_digest || !review.success) throw nativeStale();
  const authority = buildNativeAppReviewedAuthority(manifest, { lineage_key: installation.lineage_key,
    package_digest: version.package_digest, manifest_digest: version.manifest_digest });
  const expected = { ...authority, organization_id: orgId, app_installation_id: installation.id, app_version_id: version.id,
    requested_snapshot_id: requested.id, requested_snapshot_digest: requested.snapshot_digest,
    classification: NATIVE_APP_EFFECTIVE_CLASSIFICATION, review_digest: review.data };
  if (grant.snapshot_digest !== digestAppGrantValue(expected) || digestAppGrantValue(grant.canonical_snapshot) !== grant.snapshot_digest
    || digestAppGrantValue(grant.classification) !== digestAppGrantValue(NATIVE_APP_EFFECTIVE_CLASSIFICATION)
    || grant.resource_rights.length !== 0) throw nativeStale();
  return { installation, version, grant, manifest, authority };
}

export function nativeOwnerRequest(binding: typeof appNativeBindings.$inferSelect) {
  return NativeOwnerReviewRequestSchema.parse({ schema_version: 'deft.app_native_owner_review_request.v1', binding_id: binding.id,
    expected_proposal_digest: binding.proposal_digest, expected_stage_manager_authorization_version: binding.stage_manager_authorization_version,
    expected_owner_authorization_version: binding.owner_authorization_version, expected_app_version_id: binding.app_version_id,
    expected_package_digest: binding.package_digest, expected_grant_snapshot_digest: binding.grant_snapshot_digest,
    expected_lifecycle_epoch: binding.installation_lifecycle_epoch, expected_grant_epoch: binding.installation_grant_epoch });
}
export function nativeProposal(binding: typeof appNativeBindings.$inferSelect, snapshotDigest: string) {
  return { schema_version: binding.historical_create_policy ? 'deft.app_native_proposal.v2' : 'deft.app_native_proposal.v1', org_id: binding.org_id, binding_id: binding.id,
    installation_id: binding.app_installation_id, app_version_id: binding.app_version_id, grant_snapshot_id: binding.grant_snapshot_id,
    action_key: binding.action_key, target: NativeCalendarTargetSchema.parse(binding.target),
    stage_manager_user_id: binding.stage_manager_user_id, owner_user_id: binding.owner_user_id,
    stage_manager_authorization_version: binding.stage_manager_authorization_version, owner_authorization_version: binding.owner_authorization_version,
    installation_lifecycle_epoch: binding.installation_lifecycle_epoch, installation_grant_epoch: binding.installation_grant_epoch,
    package_digest: binding.package_digest, grant_snapshot_digest: binding.grant_snapshot_digest,
    provider_snapshot_id: binding.provider_snapshot_id, provider_snapshot_digest: snapshotDigest,
    reviewed_contract_digest: binding.reviewed_contract_digest, host_policy: NATIVE_ACTION_HOST_POLICY,
    ...(binding.historical_create_policy ? { historical_create_policy: HistoricalCreatePolicySchema.parse(binding.historical_create_policy) } : {}) };
}
export function nativeOwnerReview(binding: typeof appNativeBindings.$inferSelect, snapshotDigest: string) {
  const review = { schema_version: binding.historical_create_policy ? 'deft.app_native_owner_review.v2' : 'deft.app_native_owner_review.v1', request: nativeOwnerRequest(binding),
    organization_id: binding.org_id, owner_user_id: binding.owner_user_id, stage_manager_user_id: binding.stage_manager_user_id,
    installation_id: binding.app_installation_id, action_key: binding.action_key,
    target: NativeCalendarTargetSchema.parse(binding.target), provider_snapshot_digest: snapshotDigest,
    contract_digest: binding.reviewed_contract_digest, host_policy: NATIVE_ACTION_HOST_POLICY,
    ...(binding.historical_create_policy ? { historical_create_policy: HistoricalCreatePolicySchema.parse(binding.historical_create_policy),
      historical_scope: 'owner_selected_public_cancellation_only' as const } : {}) };
  return { ...review, review_digest: digestAppGrantValue(review) };
}

/** Scoped locator -> sorted complete participant locks -> App -> immutable rows -> binding.
 * A management caller must prelock its actor in the same complete sorted set. */
export async function loadLiveNativeAuthority(tx: AppRunTransaction, input: {
  org_id: string; native_binding_id: string; prelocked_participant_ids?: readonly string[];
  allow_staged?: boolean; app_lock?: 'share' | 'update';
}) {
  assertNativeCalendarEnabled();
  const [locator] = await tx.select({ installation_id: appNativeBindings.app_installation_id,
    owner_user_id: appNativeBindings.owner_user_id, manager_user_id: appNativeBindings.stage_manager_user_id })
    .from(appNativeBindings).where(and(eq(appNativeBindings.org_id, input.org_id), eq(appNativeBindings.id, input.native_binding_id))).limit(1);
  if (!locator) throw nativeStale();
  const participants = [locator.owner_user_id, locator.manager_user_id];
  if (input.prelocked_participant_ids && participants.some(id => !input.prelocked_participant_ids!.includes(id))) throw nativeStale();
  await lockNativeParticipants(tx, input.org_id, input.prelocked_participant_ids ?? participants);
  const rows = await tx.select({ member: orgMembers, kind: users.kind, email: users.email }).from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.user_id)).where(and(eq(orgMembers.org_id, input.org_id), inArray(orgMembers.user_id, participants)));
  const owner = rows.find(row => row.member.user_id === locator.owner_user_id);
  const manager = rows.find(row => row.member.user_id === locator.manager_user_id);
  if (!owner?.member.is_active || owner.kind !== 'human' || owner.member.role === 'guest'
    || !manager?.member.is_active || manager.kind !== 'human' || !['owner', 'admin'].includes(manager.member.role)) throw nativeStale();
  const reviewed = await loadReviewedNativeApp(tx, input.org_id, locator.installation_id, input.app_lock);
  const [binding] = await tx.select().from(appNativeBindings).where(and(eq(appNativeBindings.org_id, input.org_id),
    eq(appNativeBindings.id, input.native_binding_id))).limit(1).for('share');
  if (!binding || !['active', ...(input.allow_staged ? ['staged'] : [])].includes(binding.state)
    || binding.app_installation_id !== locator.installation_id || binding.owner_user_id !== locator.owner_user_id
    || binding.stage_manager_user_id !== locator.manager_user_id || binding.app_version_id !== reviewed.version.id
    || binding.grant_snapshot_id !== reviewed.grant.id || binding.grant_snapshot_kind !== 'effective'
    || binding.package_digest !== reviewed.version.package_digest || binding.grant_snapshot_digest !== reviewed.grant.snapshot_digest
    || binding.installation_lifecycle_epoch !== reviewed.installation.lifecycle_epoch
    || binding.installation_grant_epoch !== reviewed.installation.grant_epoch
    || binding.owner_authorization_version !== owner.member.app_run_authorization_version
    || binding.stage_manager_authorization_version !== manager.member.app_run_authorization_version) throw nativeStale();
  const action = nativeActionDescriptors(reviewed.manifest).find(item => item.key === binding.action_key);
  if (binding.historical_create_policy && action?.operation !== 'calendar.events.cancel.v1') throw nativeStale();
  const target = NativeCalendarTargetSchema.parse(binding.target);
  if (!action || target.calendar_owner_user_id !== owner.member.user_id || target.operation_name !== action.operation
    || binding.operation_name !== action.operation || binding.reviewed_contract_digest !== action.contract_digest
    || binding.provider_kind !== 'native' || binding.provider_instance_id !== `calendar:${owner.member.user_id}`
    || binding.risk_class !== 'internal_write' || binding.review_requirement !== 'always' || binding.review_scope !== 'per_invocation'
    || binding.retry_class !== 'idempotent_with_key' || binding.retention_class !== 'standard') throw nativeStale();
  const [provider_snapshot] = await tx.select().from(capabilityProviderSnapshots).where(and(eq(capabilityProviderSnapshots.org_id, input.org_id),
    eq(capabilityProviderSnapshots.id, binding.provider_snapshot_id))).limit(1);
  if (!provider_snapshot || provider_snapshot.provider_kind !== 'native' || provider_snapshot.provider_instance_id !== binding.provider_instance_id
    || provider_snapshot.adapter_contract_version !== target.adapter_contract_version) throw nativeStale();
  const snapshot = parseNativeProviderSnapshot(provider_snapshot.safe_snapshot);
  if (snapshot.provider.org_id !== input.org_id || snapshot.provider.provider_instance_id !== binding.provider_instance_id
    || snapshot.snapshot_digest !== provider_snapshot.snapshot_digest
    || Date.parse(snapshot.captured_at) !== provider_snapshot.captured_at.getTime()
    || digestAppGrantValue(nativeProposal(binding, snapshot.snapshot_digest)) !== binding.proposal_digest) throw nativeStale();
  const review = nativeOwnerReview(binding, snapshot.snapshot_digest);
  if (binding.state === 'active' && (!binding.reviewed_at || binding.consent_digest !== review.review_digest)) throw nativeStale();
  if (!await nativeParticipantsAreHuman(tx, participants)) throw nativeStale();
  assertNativeCalendarEnabled();
  return { ...reviewed, binding, action, provider_snapshot, owner, manager, review, participants };
}
