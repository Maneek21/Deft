import { APP_RUN_CONTRACT_VERSIONS, AppRunAuthorizationSnapshotSchema } from '@deft/shared';
import { digestAppGrantValue } from './app-grant-service.js';
import type { LiveResourceSyncBindingAuthority } from './app-resource-sync-authority.js';

/** One host projection shared by admission and every v2 execution boundary.
 * checked_at is deliberately excluded: it is a deadline check, not authority. */
export function buildResourceSyncAuthorizationSnapshot(authority: LiveResourceSyncBindingAuthority) {
  const { binding, installation, version, grant, registration } = authority;
  const consentDigest = digestAppGrantValue({
    schema_version: 'deft.app_resource_sync.consent_pin.v1',
    owner_user_id: binding.owner_user_id, reviewed_by_user_id: binding.reviewed_by_user_id,
    reviewed_at: binding.reviewed_at?.toISOString() ?? null,
    consent_expires_at: binding.consent_expires_at?.toISOString() ?? null,
    risk_class: binding.risk_class, review_requirement: binding.review_requirement,
    review_scope: binding.review_scope, retry_class: binding.retry_class,
    retention_class: binding.retention_class,
    max_records_per_page: binding.max_records_per_page, max_page_bytes: binding.max_page_bytes,
    max_retained_records: binding.max_retained_records, max_retained_bytes: binding.max_retained_bytes,
    min_interval_seconds: binding.min_interval_seconds,
  });
  return AppRunAuthorizationSnapshotSchema.parse({
    schema_version: APP_RUN_CONTRACT_VERSIONS.run,
    authenticated_subject: { actor_type: 'system', system_id: binding.id },
    authority_refs: [
      ...[...new Set([binding.owner_user_id, registration.operator_user_id])].sort()
        .map((id) => ({ authority_kind: 'membership', authority_id: id, version: 'active' })),
      { authority_kind: 'app_installation', authority_id: installation.id,
        version: `lifecycle:${installation.lifecycle_epoch}:grant:${installation.grant_epoch}` },
      { authority_kind: 'app_version', authority_id: version.id, version: version.package_digest },
      { authority_kind: 'app_grant', authority_id: grant.id, version: grant.snapshot_digest },
      { authority_kind: 'app_runtime_registration', authority_id: registration.id,
        version: String(registration.runtime_epoch) },
      { authority_kind: 'resource', authority_id: binding.id, version: authority.descriptor_digest },
      { authority_kind: 'policy', authority_id: binding.id, version: consentDigest },
      { authority_kind: 'provider_schema', authority_id: authority.provider_snapshot.id,
        version: authority.provider_snapshot.snapshot_digest },
    ],
  });
}
