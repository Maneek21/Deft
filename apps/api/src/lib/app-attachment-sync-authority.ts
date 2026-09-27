import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  appResourceBindings, appRuntimeRegistrations, appRuntimeSessions,
  capabilityProviderSnapshots, orgMembers, users,
} from '@deft/db/schema';
import { SyncDescriptorV2Schema, digestResourceSyncDescriptorV2 } from '@deft/app-kit';
import { parseAttachmentConsentPolicy } from './app-attachment-policy.js';
import { attachmentFinalAuthorityIsCurrent } from './app-attachment-authority.js';
import { CapabilityProviderDiscoverySnapshotSchema } from '@deft/shared';
import type { AppRunTransaction } from './app-run-repository.js';
import { APP_RESOURCE_SYNC_HOST_POLICY } from './app-resource-sync-policy.js';
import { loadReviewedAttachmentSyncDescriptor } from './app-attachment-sync-reviewed.js';
import { createAttachmentSyncDiscoverySnapshot } from './app-attachment-sync-discovery.js';
import { digestAppGrantValue } from './app-grant-service.js';
import { attachmentSyncConsentReview } from './app-attachment-sync-consent.js';

type Registration = typeof appRuntimeRegistrations.$inferSelect;
type Binding = typeof appResourceBindings.$inferSelect;
type Session = typeof appRuntimeSessions.$inferSelect;
type ProviderSnapshot = typeof capabilityProviderSnapshots.$inferSelect;
type Reviewed = Awaited<ReturnType<typeof loadReviewedAttachmentSyncDescriptor>>;

export type LiveAttachmentSyncBindingAuthority = Readonly<Reviewed & {
  registration: Registration;
  binding: Binding;
  provider_snapshot: ProviderSnapshot;
  checked_at: Date;
}>;
export type LiveAttachmentSyncAuthority = Readonly<LiveAttachmentSyncBindingAuthority & { session: Session }>;

type BindingLocator = Readonly<{ org_id: string; resource_binding_id: string; clock: () => Date;
  prelocked_participant_ids?: readonly string[] }>;
type SessionLocator = Readonly<{ org_id: string; session_id: string;
  token_hash: string; clock: () => Date }>;

/** Participant kinds are read after waits without taking users locks after the
 * established member/App locks. Callers supply IDs from locked authority rows. */
export async function attachmentSyncParticipantsAreHuman(tx: AppRunTransaction,
  ownerUserId: string, operatorUserId: string): Promise<boolean> {
  const ids = [...new Set([ownerUserId, operatorUserId])];
  const rows = await tx.select({ id: users.id, kind: users.kind, is_agent: users.is_agent }).from(users).where(inArray(users.id, ids));
  return ids.every(id => rows.some(row => row.id === id && row.kind === 'human' && row.is_agent === false));
}

function currentTime(clock: () => Date): Date | null {
  const checked = clock();
  return checked instanceof Date && Number.isFinite(checked.getTime()) ? checked : null;
}

async function validProviderSnapshot(row: ProviderSnapshot, registration: Registration,
  binding: Binding, descriptor: Reviewed['descriptor']): Promise<boolean> {
  if (row.org_id !== binding.org_id || row.id !== binding.provider_snapshot_id
    || row.provider_kind !== 'app_runtime' || row.provider_instance_id !== registration.id
    || row.adapter_contract_version !== 'deft.app_runtime_channel.v3') return false;
  const parsed = CapabilityProviderDiscoverySnapshotSchema.safeParse(row.safe_snapshot);
  if (!parsed.success || parsed.data.snapshot_digest !== row.snapshot_digest
    || parsed.data.provider.org_id !== binding.org_id
    || parsed.data.provider.provider_kind !== 'app_runtime'
    || parsed.data.provider.provider_instance_id !== registration.id
    || parsed.data.adapter_contract_version !== 'deft.app_runtime_channel.v3'
    || new Date(parsed.data.captured_at).getTime() !== row.captured_at.getTime()) return false;
  const expected = await createAttachmentSyncDiscoverySnapshot({ org_id: binding.org_id,
    registration_id: registration.id, descriptor, captured_at: row.captured_at });
  return expected.snapshot_digest === row.snapshot_digest
    && digestAppGrantValue(expected) === digestAppGrantValue(parsed.data);
}

/** Caller owns any Run lock. All mutable human rows are locked before App,
 * then registration and binding; this reader does not create authority. */
export async function loadLiveAttachmentSyncBindingAuthority(tx: AppRunTransaction,
  input: BindingLocator): Promise<LiveAttachmentSyncBindingAuthority | null> {
  const [locator] = await tx.select({
    owner_user_id: appResourceBindings.owner_user_id,
    registration_id: appResourceBindings.runtime_registration_id,
    installation_id: appResourceBindings.app_installation_id,
    resource_key: appResourceBindings.resource_key,
  }).from(appResourceBindings).where(and(eq(appResourceBindings.org_id, input.org_id),
    eq(appResourceBindings.id, input.resource_binding_id))).limit(1);
  if (!locator) return null;
  const [registrationLocator] = await tx.select({ operator_user_id: appRuntimeRegistrations.operator_user_id,
    app_installation_id: appRuntimeRegistrations.app_installation_id })
    .from(appRuntimeRegistrations).where(and(eq(appRuntimeRegistrations.org_id, input.org_id),
      eq(appRuntimeRegistrations.id, locator.registration_id))).limit(1);
  if (!registrationLocator || registrationLocator.app_installation_id !== locator.installation_id) return null;
  const participantIds = [...new Set([locator.owner_user_id, registrationLocator.operator_user_id])].sort();
  if (input.prelocked_participant_ids) {
    // Composite readers already hold their full participant set before App.
    // A changed locator must fail rather than introduce a later member lock.
    if (participantIds.some(id => !input.prelocked_participant_ids!.includes(id))) return null;
  } else {
    for (const userId of participantIds) {
      await tx.execute(sql`SELECT id FROM org_members WHERE org_id = ${input.org_id}
        AND user_id = ${userId} FOR SHARE`);
    }
  }
  const [owner] = await tx.select({ is_active: orgMembers.is_active, role: orgMembers.role, kind: users.kind, is_agent: users.is_agent })
    .from(orgMembers).innerJoin(users, eq(users.id, orgMembers.user_id)).where(and(eq(orgMembers.org_id, input.org_id),
      eq(orgMembers.user_id, locator.owner_user_id))).limit(1);
  const [operator] = await tx.select({ is_active: orgMembers.is_active, role: orgMembers.role, kind: users.kind, is_agent: users.is_agent })
    .from(orgMembers).innerJoin(users, eq(users.id, orgMembers.user_id)).where(and(eq(orgMembers.org_id, input.org_id),
      eq(orgMembers.user_id, registrationLocator.operator_user_id))).limit(1);
  if (!owner?.is_active || (owner.kind !== 'human' || owner.is_agent !== false) || !['owner', 'admin'].includes(owner.role)
    || !operator?.is_active || (operator.kind !== 'human' || operator.is_agent !== false) || operator.role === 'guest') return null;
  let reviewed: Reviewed;
  try { reviewed = await loadReviewedAttachmentSyncDescriptor(tx, input.org_id,
    locator.installation_id, locator.resource_key); }
  catch { return null; }
  await tx.execute(sql`SELECT id FROM app_runtime_registrations WHERE org_id = ${input.org_id}
    AND id = ${locator.registration_id} FOR SHARE`);
  await tx.execute(sql`SELECT id FROM app_resource_bindings WHERE org_id = ${input.org_id}
    AND id = ${input.resource_binding_id} FOR SHARE`);
  const [registration] = await tx.select().from(appRuntimeRegistrations).where(and(
    eq(appRuntimeRegistrations.org_id, input.org_id), eq(appRuntimeRegistrations.id, locator.registration_id)))
    .limit(1);
  const [binding] = await tx.select().from(appResourceBindings).where(and(
    eq(appResourceBindings.org_id, input.org_id), eq(appResourceBindings.id, input.resource_binding_id)))
    .limit(1);
  if (!registration || !binding || registration.state !== 'active' || registration.runtime_epoch < 1
    || registration.contract_version !== 'deft.app_runtime_channel.v3'
    || registration.operator_user_id !== registrationLocator.operator_user_id
    || registration.reviewed_by_user_id !== locator.owner_user_id
    || registration.app_installation_id !== reviewed.installation.id
    || registration.app_version_id !== reviewed.version.id
    || registration.grant_snapshot_id !== reviewed.grant.id
    || binding.state !== 'active' || binding.runtime_registration_id !== registration.id
    || binding.registration_contract_version !== registration.contract_version
    || binding.app_installation_id !== reviewed.installation.id
    || binding.app_version_id !== reviewed.version.id
    || binding.grant_snapshot_id !== reviewed.grant.id
    || binding.owner_user_id !== locator.owner_user_id
    || binding.reviewed_by_user_id !== locator.owner_user_id
    || binding.owner_scope !== 'private_user'
    || binding.resource_key !== reviewed.descriptor.key
    || binding.resource_family !== reviewed.descriptor.resource_type
    || binding.descriptor_digest !== reviewed.descriptor_digest
    || binding.provider_kind !== 'app_runtime'
    || binding.provider_instance_id !== registration.id
    || binding.operation_name !== `sync_${binding.resource_key}`
    || binding.interface_identity !== `deft.resource_sync.v3:${input.org_id.toLowerCase()}:${reviewed.installation.id.toLowerCase()}:${binding.resource_key}`
    || binding.risk_class !== APP_RESOURCE_SYNC_HOST_POLICY.risk_class
    || binding.review_requirement !== APP_RESOURCE_SYNC_HOST_POLICY.review_requirement
    || binding.review_scope !== APP_RESOURCE_SYNC_HOST_POLICY.review_scope
    || binding.retry_class !== APP_RESOURCE_SYNC_HOST_POLICY.retry_class
    || binding.retention_class !== APP_RESOURCE_SYNC_HOST_POLICY.retention_class
    || !binding.consent_expires_at || !binding.reviewed_at
    || binding.consent_expires_at <= binding.reviewed_at) return null;
  try {
    const parsed = SyncDescriptorV2Schema.parse(binding.reviewed_descriptor);
    if (await digestResourceSyncDescriptorV2(parsed) !== reviewed.descriptor_digest) return null;
  } catch { return null; }
  try { parseAttachmentConsentPolicy(reviewed.descriptor.attachments, binding.attachment_policy); } catch { return null; }
  if (binding.attachment_consent_digest !== digestAppGrantValue(attachmentSyncConsentReview({
    org_id: input.org_id, owner_user_id: binding.owner_user_id, operator_user_id: registration.operator_user_id,
    reviewed, consent_expires_at: binding.consent_expires_at, limits: binding, attachment_policy: binding.attachment_policy }))) return null;
  const [providerSnapshot] = await tx.select().from(capabilityProviderSnapshots).where(and(
    eq(capabilityProviderSnapshots.org_id, input.org_id),
    eq(capabilityProviderSnapshots.id, binding.provider_snapshot_id))).limit(1);
  if (!providerSnapshot) return null;
  try { if (!await validProviderSnapshot(providerSnapshot, registration, binding,
    reviewed.descriptor)) return null; }
  catch { return null; }
  if (!await attachmentSyncParticipantsAreHuman(tx, binding.owner_user_id, registration.operator_user_id)) return null;
  const checkedAt = currentTime(input.clock);
  if (!checkedAt || binding.consent_expires_at <= checkedAt
    || !await attachmentFinalAuthorityIsCurrent(tx, [binding.owner_user_id, registration.operator_user_id], { clock: input.clock, expires_at: [binding.consent_expires_at] })) return null;
  return Object.freeze({ ...reviewed, registration, binding, provider_snapshot: providerSnapshot,
    checked_at: checkedAt });
}

/** V3 token/hash and stored target are disjoint from the v1 action channel. */
export async function loadLiveAttachmentSyncAuthority(tx: AppRunTransaction,
  input: SessionLocator): Promise<LiveAttachmentSyncAuthority | null> {
  const [locator] = await tx.select({ resource_binding_id: appRuntimeSessions.resource_binding_id,
    runtime_registration_id: appRuntimeSessions.runtime_registration_id,
    operator_user_id: appRuntimeSessions.operator_user_id,
    audience: appRuntimeSessions.audience, runtime_binding_id: appRuntimeSessions.runtime_binding_id })
    .from(appRuntimeSessions).where(and(eq(appRuntimeSessions.org_id, input.org_id),
      eq(appRuntimeSessions.id, input.session_id), eq(appRuntimeSessions.token_hash, input.token_hash)))
    .limit(1);
  if (!locator || locator.audience !== 'app_resource_sync'
    || locator.runtime_binding_id !== null || !locator.resource_binding_id) return null;
  const bindingAuthority = await loadLiveAttachmentSyncBindingAuthority(tx, {
    org_id: input.org_id, resource_binding_id: locator.resource_binding_id, clock: input.clock,
  });
  if (!bindingAuthority || bindingAuthority.registration.id !== locator.runtime_registration_id
    || bindingAuthority.registration.operator_user_id !== locator.operator_user_id) return null;
  await tx.execute(sql`SELECT id FROM app_runtime_sessions WHERE org_id = ${input.org_id}
    AND id = ${input.session_id} FOR UPDATE`);
  const [session] = await tx.select().from(appRuntimeSessions).where(and(
    eq(appRuntimeSessions.org_id, input.org_id), eq(appRuntimeSessions.id, input.session_id),
    eq(appRuntimeSessions.token_hash, input.token_hash))).limit(1);
  if (!await attachmentSyncParticipantsAreHuman(tx, bindingAuthority.binding.owner_user_id,
    bindingAuthority.registration.operator_user_id)) return null;
  const checkedAt = currentTime(input.clock);
  if (!session || !checkedAt || session.audience !== 'app_resource_sync'
    || session.runtime_binding_id !== null
    || session.resource_binding_id !== bindingAuthority.binding.id
    || session.runtime_registration_id !== bindingAuthority.registration.id
    || session.operator_user_id !== bindingAuthority.registration.operator_user_id
    || session.runtime_epoch !== bindingAuthority.registration.runtime_epoch
    || session.lifecycle_epoch !== bindingAuthority.installation.lifecycle_epoch
    || session.grant_epoch !== bindingAuthority.installation.grant_epoch
    || session.revoked_at || session.expires_at <= checkedAt
    || bindingAuthority.binding.consent_expires_at === null
    || bindingAuthority.binding.consent_expires_at <= checkedAt) return null;
  if (!await attachmentFinalAuthorityIsCurrent(tx, [bindingAuthority.binding.owner_user_id, bindingAuthority.registration.operator_user_id],
    { clock: input.clock, expires_at: [session.expires_at, bindingAuthority.binding.consent_expires_at] })) return null;
  return Object.freeze({ ...bindingAuthority, session, checked_at: checkedAt });
}
