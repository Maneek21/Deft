import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { auditLog, appInstallations } from '@deft/db/schema';
import { OwnerConnectionAdmissionSnapshotSchema } from './app-owner-connection-contract.js';
import { AppOwnerConnectionService } from './app-owner-connection-service.js';
import { AppConnectionReattachmentService } from './app-connection-reattachment-service.js';
import { productionAppConnectionReattachmentPorts } from './app-connection-reattachment-authority.js';
import { AppResourceObservationService } from './app-resource-observation-service.js';
import { ResourceObservationSnapshotSchema } from '../../../../packages/app-kit/src/resource-observation.js';
import { AppDataConsentSnapshotSchema } from '@deft/app-kit';
import { AppDataService } from './app-data-service.js';
import { getAppAttachmentRuntime } from './app-attachment-runtime.js';
import { db } from './db.js';
import { assertContinuityProof, continuityGuard, UPGRADE_ALIAS_ACTION, type CapturedUpgradeApproval, type UpgradeContinuityProof } from './app-upgrade-trust-continuity.js';
import { UpgradeRegistrationAliasSchema } from './app-upgrade-trust-registry.js';
import { issuePersistentSuccessorResource } from './app-upgrade-trust-resource.js';
import { deliverUpgradeBackgroundAccess } from './app-upgrade-trust-delivery.js';
import type { ModuleActor } from '@deft/shared/modules';
import type { WebAuthorityGuard } from './app-resource-sync-web-authority.js';

export async function issueUpgradeSuccessor(proof: UpgradeContinuityProof, captured: CapturedUpgradeApproval,
  manager: ModuleActor, managerGuard: WebAuthorityGuard) {
  const guard = continuityGuard(proof), caller = { org_id: proof.org_id, user_id: proof.owner_id, sid: proof.web_session_id, access_expires_at: Date.parse(proof.issuance_expires_at) };
  const owner: ModuleActor = { kind: 'human', org_id: proof.org_id, actor_id: proof.owner_id, role: proof.owner_role, source: 'rest', scopes: [] };
  const keys = (await getAppAttachmentRuntime()).keys, service = new AppOwnerConnectionService(keys);
  const oldAdmission = OwnerConnectionAdmissionSnapshotSchema.parse(captured.admission.snapshot);
  const [version] = await db.select().from(appInstallations).where(and(eq(appInstallations.org_id, proof.org_id), eq(appInstallations.id, proof.installation_id))).limit(1);
  if (!version) throw Error('UPGRADE_INSTALLATION_UNAVAILABLE');
  const { appVersions, appGrantSnapshots } = await import('@deft/db/schema');
  const [target] = await db.select().from(appVersions).where(and(eq(appVersions.org_id, proof.org_id), eq(appVersions.id, proof.version_id))).limit(1);
  const [grant] = await db.select().from(appGrantSnapshots).where(and(eq(appGrantSnapshots.org_id, proof.org_id), eq(appGrantSnapshots.id, proof.grant_id))).limit(1);
  if (!target || !grant) throw Error('UPGRADE_GRANT_UNAVAILABLE');
  const admissionInput = { installation_id: proof.installation_id, policy_key: oldAdmission.policy.key, operator_user_id: proof.operator_id,
    limits: oldAdmission.limits, expected_app_version_id: proof.version_id, expected_package_digest: target.package_digest,
    expected_grant_snapshot_digest: grant.snapshot_digest, expected_lifecycle_epoch: proof.lifecycle_epoch, expected_grant_epoch: proof.grant_epoch };
  // One deployment admission is shared by all owners of the same policy.
  const { appOwnerConnectionAdmissions } = await import('@deft/db/schema');
  const [existingAdmission] = await db.select().from(appOwnerConnectionAdmissions).where(and(eq(appOwnerConnectionAdmissions.org_id, proof.org_id),
    eq(appOwnerConnectionAdmissions.app_installation_id, proof.installation_id), eq(appOwnerConnectionAdmissions.app_version_id, proof.version_id),
    eq(appOwnerConnectionAdmissions.policy_key, oldAdmission.policy.key), eq(appOwnerConnectionAdmissions.state, 'active'))).limit(1);
  const reference = existingAdmission ? { admission_id: existingAdmission.id, admission_digest: existingAdmission.review_digest } : await (async () => {
    const review = await service.reviewAdmission(manager, admissionInput, managerGuard);
    await db.transaction(tx => assertContinuityProof(tx, proof));
    return service.activateAdmission(manager, { ...admissionInput, expected_review_digest: review.review_digest, accept_host_policy: true }, managerGuard);
  })();
  const resourceInput = { ...reference, target_key: captured.binding.target_key,
    consent_expires_at: captured.binding.consent_expires_at?.toISOString() ?? null,
    ...(captured.binding.consent_lifetime ? { consent_lifetime: captured.binding.consent_lifetime } : {}),
    attachment_policy: captured.binding.attachment_policy, limits: { max_records_per_page: captured.binding.max_records_per_page,
      max_page_bytes: captured.binding.max_page_bytes, max_retained_records: captured.binding.max_retained_records,
      max_retained_bytes: captured.binding.max_retained_bytes, min_interval_seconds: captured.binding.min_interval_seconds } };
  const resource = proof.source_scope.consent_lifetime === 'until_revoked'
    ? await issuePersistentSuccessorResource(proof, captured, reference, keys)
    : await (async () => {
      const review = await service.resource(owner, resourceInput, guard) as { review_digest: string };
      return service.resource(owner, { ...resourceInput, expected_review_digest: review.review_digest, accept_host_policy: true }, guard, true) as Promise<{ registration_id: string; binding_id: string }>;
    })();
  const alias = UpgradeRegistrationAliasSchema.parse({ schema_version: 'deft.app_upgrade_registration.v1', org_id: proof.org_id,
    installation_id: proof.installation_id, proof_id: proof.request_id, registration_id: resource.registration_id, binding_id: resource.binding_id,
    runtime_epoch: 1, source_registration_id: proof.source_scope.runtime_registration_id, source_runtime_epoch: proof.source_scope.runtime_epoch,
    profile_digest: proof.source_scope.profile_digest, transport_digest: proof.transport_digest });
  await db.transaction(async tx => { await assertContinuityProof(tx, proof);
    await tx.insert(auditLog).values({ org_id: proof.org_id, actor_type: 'system', actor_id: manager.actor_id,
      action: UPGRADE_ALIAS_ACTION, entity_type: 'app_runtime_registration', entity_id: resource.registration_id, metadata: alias }); });
  for (const action of captured.actions) {
    const input = { ...reference, action_key: action.action_key, owner_resource_binding_id: resource.binding_id };
    const review = await service.action(owner, input, guard) as { review_digest: string };
    await service.action(owner, { ...input, expected_review_digest: review.review_digest, accept_host_policy: true }, guard, true);
  }
  const reattachment = new AppConnectionReattachmentService(productionAppConnectionReattachmentPorts(caller, guard));
  const review = await reattachment.review(caller, { installation_id: proof.installation_id, target_key: proof.source_scope.target_key,
    source_session_id: proof.source_session_id, request_id: proof.request_id });
  if (!('review_digest' in review)) throw Error('UPGRADE_REATTACHMENT_REQUIRES_RECOVERY');
  const connected = await reattachment.activate(caller, { session_id: proof.request_id, review_digest: review.review_digest });
  if (!('state' in connected) || connected.state !== 'connected') throw Error('UPGRADE_REATTACHMENT_REQUIRES_RECOVERY');
  for (const observation of captured.observations) {
    const snapshot = ResourceObservationSnapshotSchema.parse(observation.snapshot), observations = new AppResourceObservationService();
    const reviewed = await observations.review(owner, { connection_session_id: proof.request_id, request_id: randomUUID(), interval_seconds: snapshot.interval_seconds,
      expires_at: snapshot.expires_at, ...(snapshot.consent_lifetime ? { consent_lifetime: snapshot.consent_lifetime } : {}) }, guard);
    await observations.activate(owner, { consent_id: reviewed.consent_id, review_digest: reviewed.review_digest }, guard);
  }
  let delivery: 'installed'|'recovery_required' = 'installed';
  try { await deliverUpgradeBackgroundAccess(proof); } catch { delivery = 'recovery_required'; }
  // Preserve approved private-store purposes through the ordinary review and
  // activation validators. This deliberately runs after account/channel setup.
  for (const consent of captured.data) {
    // Activation supersedes this store's source consent. Each store therefore
    // checks its own still-live source pin; previously transferred stores do
    // not turn a later, independently approved store into a false revocation.
    const dataService = new AppDataService(caller, continuityGuard({ ...proof,
      source_data: proof.source_data.filter(pin => pin.id === consent.consent_id) }));
    const snapshot = AppDataConsentSnapshotSchema.parse(consent.snapshot);
    const reviewed = await dataService.review(proof.request_id, { store_key: consent.store_key, expires_at: snapshot.expires_at,
      ...(snapshot.consent_lifetime ? { consent_lifetime: snapshot.consent_lifetime } : {}) });
    await dataService.activate(proof.request_id, { store_key: consent.store_key, consent_id: reviewed.snapshot.consent_id, accept_host_policy: true,
      expected_review_digest: reviewed.review_digest, expires_at: reviewed.snapshot.expires_at,
      ...(snapshot.consent_lifetime ? { consent_lifetime: snapshot.consent_lifetime } : {}) });
  }
  return { state: delivery, source_session_id: proof.source_session_id, session_id: proof.request_id,
    resource_binding_id: resource.binding_id, app_version_id: proof.version_id };
}
