import { and, eq } from 'drizzle-orm';
import { isDeepStrictEqual } from 'node:util';
import { appVersions, appGrantSnapshots, appResourceBindings, appRuntimeRegistrations,
  appOwnerConnectionAdmissions, capabilityProviderSnapshots, appConnectionSessions } from '@deft/db/schema';
import { parseAttachmentAppManifest, digestResourceSyncDescriptorV2, SyncDescriptorV2Schema, ResourceObservationSnapshotSchema,
  appConsentDeadline } from '@deft/app-kit';
import { CapabilityProviderDiscoverySnapshotSchema, canonicalCapabilityJson } from '@deft/shared';
import { appResourceObservationConsents, appResourceObservationRuns } from '../../../../packages/db/src/resource-observation-schema.js';
import type { AppRunTransaction } from './app-run-repository.js';
import type { appRuns } from '@deft/db/schema';
import { loadLiveAttachmentSyncBindingAuthority } from './app-attachment-sync-authority.js';
import { attachmentStale, ATTACHMENT_APP_EFFECTIVE_CLASSIFICATION, buildAttachmentAppReviewedAuthority } from './app-attachment-authority.js';
import { buildRequestedAppGrantProjection, digestAppGrantValue } from './app-grant-service.js';
import { OwnerConnectionAdmissionSnapshotSchema } from './app-owner-connection-contract.js';
import { attachmentSyncConsentReview } from './app-attachment-sync-consent.js';
import { createAttachmentSyncDiscoverySnapshot } from './app-attachment-sync-discovery.js';
import { AppConnectionSessionRecordSchema } from './app-connection-session-service.js';
import { connectionProfileDigest, getAppConnectionSessionRegistry } from './app-connection-session-registry.js';
import { buildAttachmentSyncAuthorizationSnapshot } from './app-attachment-sync-run.js';
import { observedResourceAuthorization } from './app-resource-observation-authority.js';
import { runtimeActionDescriptors } from './app-runtime-review.js';

/** Only this module can construct the branded result. It carries no Runtime
 * session/token or execution authority and is never accepted by live loaders. */
const historicalClosure = Symbol('historical private sync closure');
export type HistoricalSyncClosureAuthority = Awaited<ReturnType<typeof loadHistoricalSyncClosureAuthority>>;

/** Reconstruct retained review bytes independently of today's installation
 * epochs. Current rights are checked separately and cannot revive old consent. */
export async function loadHistoricalSyncClosureAuthority(tx: AppRunTransaction, input: {
  run: typeof appRuns.$inferSelect; current_resource_binding_id: string;
  participant_ids: readonly string[]; clock: () => Date;
}) {
  const { run } = input;
  const fail = attachmentStale;
  const [binding] = await tx.select().from(appResourceBindings).where(and(eq(appResourceBindings.org_id, run.org_id),
    eq(appResourceBindings.id, run.origin_resource_binding_id!))).limit(1).for('share');
  if (!binding || !binding.runtime_registration_id || binding.id === input.current_resource_binding_id) throw fail();
  const [registration] = await tx.select().from(appRuntimeRegistrations).where(and(eq(appRuntimeRegistrations.org_id, run.org_id),
    eq(appRuntimeRegistrations.id, binding.runtime_registration_id))).limit(1).for('share');
  if (!registration || !registration.owner_connection_admission_id || !registration.owner_connection_admission_digest) throw fail();
  const current = await loadLiveAttachmentSyncBindingAuthority(tx, { org_id: run.org_id,
    resource_binding_id: input.current_resource_binding_id, prelocked_participant_ids: input.participant_ids, clock: input.clock });
  if (!current?.owner_connection_admission || current.installation.id !== binding.app_installation_id
    || current.binding.owner_user_id !== binding.owner_user_id || current.registration.operator_user_id !== registration.operator_user_id
    || current.binding.target_key !== binding.target_key || current.binding.resource_key !== binding.resource_key
    || current.version.id === binding.app_version_id) throw fail();
  const [version] = await tx.select().from(appVersions).where(and(eq(appVersions.org_id, run.org_id),
    eq(appVersions.id, binding.app_version_id), eq(appVersions.installation_id, current.installation.id))).limit(1).for('share');
  const [grant] = await tx.select().from(appGrantSnapshots).where(and(eq(appGrantSnapshots.org_id, run.org_id),
    eq(appGrantSnapshots.id, binding.grant_snapshot_id), eq(appGrantSnapshots.app_version_id, binding.app_version_id),
    eq(appGrantSnapshots.app_installation_id, current.installation.id))).limit(1);
  const [admissionRow] = await tx.select().from(appOwnerConnectionAdmissions).where(and(eq(appOwnerConnectionAdmissions.org_id, run.org_id),
    eq(appOwnerConnectionAdmissions.id, registration.owner_connection_admission_id))).limit(1).for('share');
  if (!version || !grant || !admissionRow || version.protocol_version !== '7' || grant.snapshot_kind !== 'effective') throw fail();
  const manifest = parseAttachmentAppManifest(version.manifest);
  const admission = OwnerConnectionAdmissionSnapshotSchema.parse(admissionRow.snapshot);
  const policy = manifest.owner_connections?.find(item => item.key === admissionRow.policy_key);
  const descriptor = manifest.sync_descriptors.find(item => item.key === binding.resource_key);
  if (!policy || !descriptor || digestAppGrantValue(manifest) !== version.manifest_digest
    || manifest.id !== current.installation.app_id || manifest.version !== version.version
    || grant.manifest_digest !== version.manifest_digest || grant.package_digest !== version.package_digest
    || grant.app_id !== manifest.id || grant.app_version !== manifest.version
    || !version.requested_grant_snapshot_id || grant.requested_snapshot_id !== version.requested_grant_snapshot_id) throw fail();
  const [requested] = await tx.select().from(appGrantSnapshots).where(and(eq(appGrantSnapshots.org_id, run.org_id),
    eq(appGrantSnapshots.id, version.requested_grant_snapshot_id), eq(appGrantSnapshots.app_version_id, version.id),
    eq(appGrantSnapshots.app_installation_id, current.installation.id), eq(appGrantSnapshots.snapshot_kind, 'requested'))).limit(1);
  const projection = buildRequestedAppGrantProjection({ organization_id: run.org_id, app_installation_id: current.installation.id,
    app_version_id: version.id, manifest, manifest_digest: version.manifest_digest, package_digest: version.package_digest });
  const canonical = { ...buildAttachmentAppReviewedAuthority(manifest, { lineage_key: current.installation.lineage_key,
    package_digest: version.package_digest, manifest_digest: version.manifest_digest }, true), organization_id: run.org_id,
    app_installation_id: current.installation.id, app_version_id: version.id, requested_snapshot_id: requested?.id,
    requested_snapshot_digest: requested?.snapshot_digest, classification: ATTACHMENT_APP_EFFECTIVE_CLASSIFICATION,
    review_digest: grant.canonical_snapshot.review_digest };
  if (!requested || requested.snapshot_digest !== projection.snapshot_digest
    || digestAppGrantValue(requested.canonical_snapshot) !== projection.snapshot_digest
    || digestAppGrantValue(canonical) !== grant.snapshot_digest || digestAppGrantValue(grant.canonical_snapshot) !== grant.snapshot_digest
    || grant.resource_rights.length || !isDeepStrictEqual(grant.classification, ATTACHMENT_APP_EFFECTIVE_CLASSIFICATION)) throw fail();
  const descriptorDigest = await digestResourceSyncDescriptorV2(descriptor);
  if (binding.descriptor_digest !== descriptorDigest || binding.resource_family !== descriptor.resource_type
    || await digestResourceSyncDescriptorV2(SyncDescriptorV2Schema.parse(binding.reviewed_descriptor)) !== descriptorDigest) throw fail();
  const originalActions = runtimeActionDescriptors(manifest).filter(item => policy.action_keys.includes(item.action_key))
    .map(item => ({ action_key: item.action_key, contract_digest: item.contract_digest }))
    .sort((a, b) => a.action_key.localeCompare(b.action_key));
  const currentAdmission = current.owner_connection_admission.snapshot;
  if (!['active', 'revoked'].includes(admissionRow.state) || digestAppGrantValue(admission) !== admissionRow.review_digest || admissionRow.review_digest !== registration.owner_connection_admission_digest
    || admission.org_id !== run.org_id || admission.installation_id !== current.installation.id
    || admission.app_version_id !== version.id || admission.grant_snapshot_id !== grant.id
    || admission.package_digest !== version.package_digest || admission.grant_snapshot_digest !== grant.snapshot_digest
    || admissionRow.operator_user_id !== registration.operator_user_id || admissionRow.app_version_id !== version.id
    || admissionRow.grant_snapshot_id !== grant.id || admissionRow.app_installation_id !== current.installation.id
    || admission.operator_user_id !== registration.operator_user_id || admission.policy_digest !== digestAppGrantValue(policy)
    || !isDeepStrictEqual(admission.actions, originalActions)
    || !isDeepStrictEqual(admission.policy, policy) || admission.resource_descriptor_digest !== descriptorDigest
    || descriptorDigest !== current.descriptor_digest || !isDeepStrictEqual(admission.policy, currentAdmission.policy)
    || !isDeepStrictEqual(admission.limits, currentAdmission.limits) || !isDeepStrictEqual(admission.actions, currentAdmission.actions)
    || !admission.connection_profile || !currentAdmission.connection_profile
    || admission.connection_profile_digest !== connectionProfileDigest(admission.connection_profile)
    || !isDeepStrictEqual(admission.connection_profile, currentAdmission.connection_profile)
    || admission.connection_transport_digest !== currentAdmission.connection_transport_digest) throw fail();
  for (const key of ['max_records_per_page', 'max_page_bytes', 'max_retained_records', 'max_retained_bytes', 'min_interval_seconds',
    'risk_class', 'review_requirement', 'review_scope', 'retry_class', 'retention_class', 'attachment_policy'] as const) {
    if (!isDeepStrictEqual(binding[key], current.binding[key])) throw fail();
  }
  if (binding.owner_scope !== 'private_user' || binding.reviewed_by_user_id !== binding.owner_user_id
    || registration.reviewed_by_user_id !== binding.owner_user_id || binding.provider_kind !== 'app_runtime'
    || registration.app_installation_id !== current.installation.id || registration.app_version_id !== version.id
    || registration.grant_snapshot_id !== grant.id || binding.provider_instance_id !== registration.id
    || binding.registration_contract_version !== 'deft.app_runtime_channel.v3' || registration.contract_version !== binding.registration_contract_version
    || binding.interface_identity !== `deft.resource_sync.v3:${run.org_id.toLowerCase()}:${current.installation.id.toLowerCase()}:${binding.resource_key}`
    || binding.operation_name !== `sync_${binding.resource_key}` || !binding.reviewed_at
    || binding.reviewed_at > run.created_at || appConsentDeadline(binding.consent_expires_at, binding.consent_lifetime ?? undefined) <= run.created_at.getTime()) throw fail();
  // Explicit original epochs from the verified historical admission. This is
  // not a current installation row with substituted authority fields.
  const installation = { id: current.installation.id, lifecycle_epoch: admission.lifecycle_epoch, grant_epoch: admission.grant_epoch };
  const historicalReview = { installation, version, grant, descriptor,
    descriptor_digest: descriptorDigest, descriptors: manifest.sync_descriptors };
  const consent = attachmentSyncConsentReview({ org_id: run.org_id, owner_user_id: binding.owner_user_id,
    operator_user_id: registration.operator_user_id, reviewed: historicalReview, consent_expires_at: binding.consent_expires_at,
    ...(binding.consent_lifetime ? { consent_lifetime: binding.consent_lifetime } : {}), limits: binding,
    attachment_policy: binding.attachment_policy, owner_connection_admission: {
      admission_id: admissionRow.id, admission_digest: admissionRow.review_digest } });
  const originalConsent = { ...consent,
    ...(binding.target_key === 'primary' ? {} : { target_key: binding.target_key }) };
  if (digestAppGrantValue(originalConsent) !== binding.attachment_consent_digest) throw fail();
  const [provider] = await tx.select().from(capabilityProviderSnapshots).where(and(eq(capabilityProviderSnapshots.org_id, run.org_id),
    eq(capabilityProviderSnapshots.id, binding.provider_snapshot_id))).limit(1);
  if (!provider) throw fail();
  const providerData = CapabilityProviderDiscoverySnapshotSchema.parse(provider.safe_snapshot);
  const expectedProvider = await createAttachmentSyncDiscoverySnapshot({ org_id: run.org_id, registration_id: registration.id,
    descriptor, captured_at: provider.captured_at });
  if (provider.snapshot_digest !== expectedProvider.snapshot_digest || digestAppGrantValue(providerData) !== digestAppGrantValue(expectedProvider)
    || provider.provider_instance_id !== registration.id || provider.provider_kind !== 'app_runtime'
    || provider.adapter_contract_version !== 'deft.app_runtime_channel.v3') throw fail();
  const facts = { binding, registration, installation, version, grant, descriptor_digest: descriptorDigest, provider_snapshot: provider };
  let authorization = buildAttachmentSyncAuthorizationSnapshot(facts);
  const [link] = await tx.select().from(appResourceObservationRuns).where(and(eq(appResourceObservationRuns.org_id, run.org_id),
    eq(appResourceObservationRuns.run_id, run.id))).limit(1);
  if (!link) throw fail(); // This historical flow is limited to retained owner observations.
  const [observation] = await tx.select().from(appResourceObservationConsents).where(and(eq(appResourceObservationConsents.org_id, run.org_id),
    eq(appResourceObservationConsents.consent_id, link.consent_id))).limit(1).for('share');
  if (!observation || !['active', 'revoked'].includes(observation.state) || observation.consent_digest !== link.consent_digest) throw fail();
  const snapshot = ResourceObservationSnapshotSchema.parse(observation.snapshot);
  if (digestAppGrantValue(snapshot) !== observation.consent_digest || snapshot.scope.resource_binding_id !== binding.id
    || observation.resource_binding_id !== binding.id || observation.owner_user_id !== binding.owner_user_id
    || observation.connection_session_id !== snapshot.connection.session_id
    || (observation.expires_at?.toISOString() ?? null) !== snapshot.expires_at
    || snapshot.scope.org_id !== run.org_id || snapshot.scope.owner_user_id !== binding.owner_user_id
    || snapshot.resource_policy_digest !== digestAppGrantValue(authorization.authority_refs.filter(ref => ref.authority_kind === 'policy'))
    || appConsentDeadline(snapshot.expires_at, snapshot.consent_lifetime) <= run.created_at.getTime()) throw fail();
  const [session] = await tx.select().from(appConnectionSessions).where(and(eq(appConnectionSessions.org_id, run.org_id),
    eq(appConnectionSessions.owner_user_id, binding.owner_user_id), eq(appConnectionSessions.session_id, snapshot.connection.session_id))).limit(1).for('share');
  if (!session) throw fail();
  const record = AppConnectionSessionRecordSchema.parse(session.record), scope = record.scope;
  const receipt = record.credential_repair?.receipt ?? record.upgrade?.receipt ?? record.reattachment?.receipt;
  if (!isDeepStrictEqual(scope, snapshot.scope) || record.state !== 'connected' || !record.account
    || scope.installation_id !== installation.id || scope.app_version_id !== version.id || scope.grant_snapshot_id !== grant.id
    || scope.lifecycle_epoch !== installation.lifecycle_epoch || scope.grant_epoch !== installation.grant_epoch
    || scope.package_digest !== version.package_digest || scope.grant_snapshot_digest !== grant.snapshot_digest
    || scope.runtime_registration_id !== registration.id || scope.runtime_epoch !== registration.runtime_epoch
    || scope.operator_user_id !== registration.operator_user_id || scope.target_key !== binding.target_key
    || scope.resource_key !== binding.resource_key || scope.consent_expires_at !== (binding.consent_expires_at?.toISOString() ?? null)
    || scope.consent_lifetime !== (binding.consent_lifetime ?? undefined)
    || scope.profile_digest !== admission.connection_profile_digest || !isDeepStrictEqual(record.profile, admission.connection_profile)
    || record.runtime_session_ref !== snapshot.connection.runtime_session_ref || record.account.account_ref !== snapshot.connection.account_ref
    || snapshot.connection.expected_custody_generation !== (receipt?.custody_generation ?? null)
    || snapshot.connection.receipt_digest !== (receipt?.receipt_digest ?? null)) throw fail();
  const registry = await getAppConnectionSessionRegistry();
  registry.assertReady(scope, record.profile); // Metadata only; no Runtime handle or request is returned.
  if (registry.transportDigest(run.org_id, installation.id, record.profile) !== admission.connection_transport_digest) throw fail();
  authorization = observedResourceAuthorization(authorization, observation);
  if (canonicalCapabilityJson(authorization) !== canonicalCapabilityJson(run.authorization_snapshot)) throw fail();
  return Object.freeze({ [historicalClosure]: true as const, historical: facts, current, authorization,
    original_consent_deadline: Math.min(appConsentDeadline(binding.consent_expires_at, binding.consent_lifetime ?? undefined),
      appConsentDeadline(snapshot.expires_at, snapshot.consent_lifetime)),
    original_reviewed_at: binding.reviewed_at, observation_created_at: observation.created_at,
    admission_created_at: admissionRow.created_at, connection_created_at: session.created_at,
    observation: { consent_id: observation.consent_id, consent_digest: observation.consent_digest,
      connection_session_id: snapshot.connection.session_id, account_ref: snapshot.connection.account_ref,
      expected_custody_generation: snapshot.connection.expected_custody_generation, receipt_digest: snapshot.connection.receipt_digest } });
}
