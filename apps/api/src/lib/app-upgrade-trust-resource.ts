import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { appRuntimeRegistrations, appResourceBindings, appSyncCheckpoints, auditLog } from '@deft/db/schema';
import { db } from './db.js';
import { assertContinuityProof, type CapturedUpgradeApproval, type UpgradeContinuityProof } from './app-upgrade-trust-continuity.js';
import { loadOwnerConnectionAdmission } from './app-owner-connection-authority.js';
import type { OwnerConnectionAdmissionReference } from './app-owner-connection-contract.js';
import { loadReviewedAttachmentSyncDescriptor } from './app-attachment-sync-reviewed.js';
import { attachmentSyncConsentReview } from './app-attachment-sync-consent.js';
import { createAttachmentSyncDiscoverySnapshot } from './app-attachment-sync-discovery.js';
import { persistCapabilityProviderSnapshotWithExecutor } from './capability-provider-snapshot-repository.js';
import { AppResourceSyncSecretService } from './app-resource-sync-secrets.js';
import type { AppRunKeyProvider } from './app-run-keyrings.js';
import { digestAppGrantValue } from './app-grant-service.js';
import { loadLiveAttachmentSyncBindingAuthority } from './app-attachment-sync-authority.js';

/** This is succession of an already persistent consent, not initial enrollment
 * or a lifetime extension. The additive SQL guard independently checks the
 * existing persistent source, exact trust proof, manifest and unchanged limits. */
export async function issuePersistentSuccessorResource(proof: UpgradeContinuityProof, captured: CapturedUpgradeApproval,
  reference: OwnerConnectionAdmissionReference, keys: AppRunKeyProvider) {
  return db.transaction(async tx => {
    await assertContinuityProof(tx, proof);
    if (proof.source_scope.consent_lifetime !== 'until_revoked') throw Error('PERSISTENT_SOURCE_REQUIRED');
    const reviewed = await loadReviewedAttachmentSyncDescriptor(tx, proof.org_id, proof.installation_id, captured.binding.resource_key);
    const admission = await loadOwnerConnectionAdmission(tx, proof.org_id, reference, reviewed, proof.owner_id);
    if (admission.policy.allow_until_revoked !== true) throw Error('PERSISTENT_ADMISSION_REQUIRED');
    const registration_id = randomUUID(), binding_id = randomUUID(), checkpoint_id = randomUUID(), now = new Date();
    const source = captured.binding;
    const limits = { max_records_per_page: source.max_records_per_page, max_page_bytes: source.max_page_bytes,
      max_retained_records: source.max_retained_records, max_retained_bytes: source.max_retained_bytes, min_interval_seconds: source.min_interval_seconds };
    const review = { ...attachmentSyncConsentReview({ org_id: proof.org_id, owner_user_id: proof.owner_id, operator_user_id: proof.operator_id,
      reviewed, consent_expires_at: null, consent_lifetime: 'until_revoked', limits, attachment_policy: source.attachment_policy,
      owner_connection_admission: reference }), ...(source.target_key === 'primary' ? {} : { target_key: source.target_key }) };
    await tx.insert(appRuntimeRegistrations).values({ id: registration_id, org_id: proof.org_id, app_installation_id: proof.installation_id,
      app_version_id: proof.version_id, grant_snapshot_id: proof.grant_id, operator_user_id: proof.operator_id,
      owner_connection_admission_id: reference.admission_id, owner_connection_admission_digest: reference.admission_digest,
      contract_version: 'deft.app_runtime_channel.v3', state: 'disabled', created_at: now, updated_at: now });
    const discovery = await createAttachmentSyncDiscoverySnapshot({ org_id: proof.org_id, registration_id, descriptor: reviewed.descriptor, captured_at: now });
    const snapshot = await persistCapabilityProviderSnapshotWithExecutor(tx, discovery);
    await tx.insert(appResourceBindings).values({ ...source, id: binding_id, app_version_id: proof.version_id, grant_snapshot_id: proof.grant_id,
      runtime_registration_id: registration_id, provider_instance_id: registration_id, provider_snapshot_id: snapshot,
      attachment_consent_digest: digestAppGrantValue(review), state: 'disabled', reviewed_by_user_id: null, reviewed_at: null,
      consent_expires_at: null, consent_lifetime: null, created_at: now, updated_at: now });
    const cursor = new AppResourceSyncSecretService(keys).cursorFingerprint(null, { org_id: proof.org_id, resource_binding_id: binding_id,
      checkpoint_id, payload_kind: 'cursor', generation: 1, cursor_sequence: 0 });
    await tx.insert(appSyncCheckpoints).values({ id: checkpoint_id, org_id: proof.org_id, resource_binding_id: binding_id,
      generation: 1, state: 'active', cursor_sequence: 0, cursor_hmac_key_version: cursor.key_version, cursor_hmac: cursor.fingerprint,
      cursor_state: 'empty', cursor_bytes: 0, retained_record_count: 0, retained_bytes: 0, created_at: now, updated_at: now });
    await tx.update(appRuntimeRegistrations).set({ state: 'active', runtime_epoch: 1, reviewed_by_user_id: proof.owner_id, reviewed_at: now, updated_at: now })
      .where(and(eq(appRuntimeRegistrations.org_id, proof.org_id), eq(appRuntimeRegistrations.id, registration_id)));
    await tx.update(appResourceBindings).set({ state: 'active', reviewed_by_user_id: proof.owner_id, reviewed_at: now,
      consent_lifetime: 'until_revoked', updated_at: now }).where(and(eq(appResourceBindings.org_id, proof.org_id), eq(appResourceBindings.id, binding_id)));
    if (!await loadLiveAttachmentSyncBindingAuthority(tx, { org_id: proof.org_id, resource_binding_id: binding_id, clock: () => new Date() })) throw Error('UPGRADE_RESOURCE_STALE');
    await assertContinuityProof(tx, proof);
    await tx.insert(auditLog).values({ org_id: proof.org_id, actor_type: 'system', actor_id: proof.owner_id,
      action: 'app.upgrade_continuity.resource_issued', entity_type: 'app_resource_binding', entity_id: binding_id,
      metadata: { proof_id: proof.request_id, source_resource_binding_id: source.id, prior_version_id: proof.prior_version_id,
        app_version_id: proof.version_id, consent_lifetime: 'until_revoked', consent_expires_at: null } });
    return { registration_id, binding_id, checkpoint_id };
  });
}
