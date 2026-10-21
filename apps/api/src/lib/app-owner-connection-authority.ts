import { and, eq, inArray } from 'drizzle-orm';
import { appOwnerConnectionAdmissions, orgMembers, users, type appRuntimeRegistrations } from '@deft/db/schema';
import type { AppRunTransaction } from './app-run-repository.js';
import { loadReviewedAttachmentApp } from './app-attachment-authority.js';
import { digestAppGrantValue } from './app-grant-service.js';
import { OwnerConnectionAdmissionSnapshotSchema, resolveOwnerConnectionProfile, ownerConnectionTransportDigest, type OwnerConnectionAdmissionReference } from './app-owner-connection-contract.js';
import { connectionProfileDigest } from './app-connection-session-registry.js';
import { isAppOwnerConnectionsEnabled } from './env.js';
import { AppError } from './app-errors.js';
import { runtimeActionDescriptors } from './app-runtime-review.js';
import { digestResourceSyncDescriptorV2, parseAttachmentAppManifest } from '@deft/app-kit';

type LockedReviewedApp = Pick<Awaited<ReturnType<typeof loadReviewedAttachmentApp>>, 'installation' | 'version' | 'grant'>;

export const ownerConnectionDenied = () => new AppError('Private owner connection authority unavailable', 'APP_ACCESS_DENIED', 403);
async function assertMembers(tx: AppRunTransaction, orgId: string, ids: readonly string[]) {
  const members = await tx.select({ user_id: orgMembers.user_id, active: orgMembers.is_active, role: orgMembers.role,
    kind: users.kind, is_agent: users.is_agent }).from(orgMembers).innerJoin(users, eq(users.id, orgMembers.user_id))
    .where(and(eq(orgMembers.org_id, orgId), inArray(orgMembers.user_id, [...new Set(ids)])));
  if (!ids.every(id => members.some(member => member.user_id === id && member.active
    && ['owner', 'admin', 'member'].includes(member.role) && member.kind === 'human' && member.is_agent === false))) throw ownerConnectionDenied();
  return members;
}
export async function assertOwnerConnectionMember(tx: AppRunTransaction, orgId: string, ownerId: string) {
  return (await assertMembers(tx, orgId, [ownerId]))[0]!;
}
export async function loadOwnerConnectionAdmission(tx: AppRunTransaction, orgId: string, reference: OwnerConnectionAdmissionReference,
  lockedReviewed?: LockedReviewedApp, ownerUserId?: string) {
  if (!isAppOwnerConnectionsEnabled()) throw ownerConnectionDenied();
  const condition = and(eq(appOwnerConnectionAdmissions.org_id, orgId), eq(appOwnerConnectionAdmissions.id, reference.admission_id),
    eq(appOwnerConnectionAdmissions.review_digest, reference.admission_digest));
  const locator = lockedReviewed ? { app_installation_id: lockedReviewed.installation.id }
    : (await tx.select().from(appOwnerConnectionAdmissions).where(condition).limit(1))[0];
  if (!locator) throw ownerConnectionDenied();
  // Only current authority readers may supply rows they already validated and
  // locked in this exact transaction. Admission/membership are always reread.
  const reviewed = lockedReviewed ? { ...lockedReviewed, manifest: parseAttachmentAppManifest(lockedReviewed.version.manifest) }
    : await loadReviewedAttachmentApp(tx, orgId, locator.app_installation_id);
  if (reviewed.installation.org_id !== orgId || reviewed.installation.id !== locator.app_installation_id
    || reviewed.installation.state !== 'active' || reviewed.version.state !== 'active'
    || reviewed.version.org_id !== orgId || reviewed.version.installation_id !== reviewed.installation.id
    || reviewed.version.protocol_version !== '7' || reviewed.installation.active_version_id !== reviewed.version.id
    || reviewed.grant.org_id !== orgId || reviewed.grant.app_installation_id !== reviewed.installation.id
    || reviewed.grant.app_version_id !== reviewed.version.id || reviewed.grant.snapshot_kind !== 'effective'
    || reviewed.installation.active_grant_snapshot_id !== reviewed.grant.id) throw ownerConnectionDenied();
  const [row] = await tx.select().from(appOwnerConnectionAdmissions).where(condition).limit(1).for('share');
  if (!row || row.state !== 'active' || row.revoked_at || row.app_installation_id !== reviewed.installation.id) throw ownerConnectionDenied();
  const snapshot = OwnerConnectionAdmissionSnapshotSchema.parse(row.snapshot);
  const policy = reviewed.manifest.owner_connections?.find(item => item.key === row.policy_key);
  const profile = policy ? await resolveOwnerConnectionProfile(orgId, reviewed.installation.id, policy, row.operator_user_id, tx) : undefined;
  if (profile ? snapshot.connection_profile_digest !== connectionProfileDigest(profile)
    || snapshot.connection_transport_digest !== await ownerConnectionTransportDigest(orgId, reviewed.installation.id, profile, tx)
    || digestAppGrantValue(snapshot.connection_profile) !== digestAppGrantValue(profile)
    : snapshot.connection_profile !== undefined || snapshot.connection_profile_digest !== undefined) throw ownerConnectionDenied();
  if (!policy || digestAppGrantValue(snapshot) !== row.review_digest || snapshot.org_id !== orgId
    || snapshot.installation_id !== row.app_installation_id || snapshot.app_version_id !== reviewed.version.id
    || snapshot.grant_snapshot_id !== reviewed.grant.id || row.app_version_id !== reviewed.version.id || row.grant_snapshot_id !== reviewed.grant.id
    || snapshot.operator_user_id !== row.operator_user_id || snapshot.package_digest !== reviewed.version.package_digest
    || snapshot.grant_snapshot_digest !== reviewed.grant.snapshot_digest || snapshot.lifecycle_epoch !== reviewed.installation.lifecycle_epoch
    || snapshot.grant_epoch !== reviewed.installation.grant_epoch || snapshot.policy_digest !== digestAppGrantValue(policy)
    || digestAppGrantValue(snapshot.policy) !== digestAppGrantValue(policy)) throw ownerConnectionDenied();
  await assertMembers(tx, orgId, [row.operator_user_id, ...(ownerUserId ? [ownerUserId] : [])]);
  const descriptor = reviewed.manifest.sync_descriptors.find(item => item.key === policy.resource_key);
  const actions = runtimeActionDescriptors(reviewed.manifest).filter(item => policy.action_keys.includes(item.action_key))
    .map(item => ({ action_key: item.action_key, contract_digest: item.contract_digest }))
    .sort((a,b) => a.action_key < b.action_key ? -1 : a.action_key > b.action_key ? 1 : 0);
  if (!descriptor || snapshot.resource_descriptor_digest !== await digestResourceSyncDescriptorV2(descriptor)
    || digestAppGrantValue(snapshot.actions) !== digestAppGrantValue(actions)) throw ownerConnectionDenied();
  return { row, snapshot, policy, reviewed, reference };
}
export async function assertOwnerConnectionRegistration(tx: AppRunTransaction, registration: typeof appRuntimeRegistrations.$inferSelect,
  input: { owner_user_id: string; resource_key?: string; action_key?: string; lockedReviewed?: LockedReviewedApp }) {
  if (!registration.owner_connection_admission_id || !registration.owner_connection_admission_digest) throw ownerConnectionDenied();
  const admission = await loadOwnerConnectionAdmission(tx, registration.org_id, { admission_id: registration.owner_connection_admission_id,
    admission_digest: registration.owner_connection_admission_digest }, input.lockedReviewed, input.owner_user_id);
  if (registration.reviewed_by_user_id !== input.owner_user_id || registration.operator_user_id !== admission.row.operator_user_id
    || registration.app_installation_id !== admission.row.app_installation_id || registration.app_version_id !== admission.row.app_version_id
    || registration.grant_snapshot_id !== admission.row.grant_snapshot_id || input.resource_key && input.resource_key !== admission.policy.resource_key
    || input.action_key && !admission.policy.action_keys.includes(input.action_key)) throw ownerConnectionDenied();
  return admission;
}
