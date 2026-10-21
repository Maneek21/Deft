import {appConsentDeadline,type AppConsentLifetime} from '@deft/app-kit/core';
import { APP_RESOURCE_SYNC_HOST_POLICY, AppResourceSyncConsentLimitsSchema } from './app-resource-sync-policy.js';
import { APP_ATTACHMENT_RETAINED_STAGE_LIMIT, parseAttachmentConsentPolicy } from './app-attachment-policy.js';
import type { loadReviewedAttachmentSyncDescriptor } from './app-attachment-sync-reviewed.js';
import type { OwnerConnectionAdmissionReference } from './app-owner-connection-contract.js';

type Limits = { max_records_per_page: number; max_page_bytes: number; max_retained_records: number;
  max_retained_bytes: number; min_interval_seconds: number };
/** Reconstructed from exact retained binding rights, never provider input. */
export function attachmentSyncConsentReview(input: {
  org_id: string; owner_user_id: string; operator_user_id: string;
  reviewed: Pick<Awaited<ReturnType<typeof loadReviewedAttachmentSyncDescriptor>>, 'version' | 'grant' | 'descriptor' | 'descriptor_digest'> & {
    installation: Pick<Awaited<ReturnType<typeof loadReviewedAttachmentSyncDescriptor>>['installation'], 'id' | 'lifecycle_epoch' | 'grant_epoch'>;
  };
  consent_expires_at: Date|null; consent_lifetime?:AppConsentLifetime; limits: Limits; attachment_policy: unknown;
  owner_connection_admission?: OwnerConnectionAdmissionReference;
}) {
  appConsentDeadline(input.consent_expires_at,input.consent_lifetime);
  const { installation, version, grant, descriptor, descriptor_digest } = input.reviewed;
  const limits = AppResourceSyncConsentLimitsSchema.parse({
    max_records_per_page: input.limits.max_records_per_page, max_page_bytes: input.limits.max_page_bytes,
    max_retained_records: input.limits.max_retained_records, max_retained_bytes: input.limits.max_retained_bytes,
    min_interval_seconds: input.limits.min_interval_seconds,
  });
  return { schema_version: 'deft.app_attachment_consent_review.v1' as const,
    org_id: input.org_id, owner_user_id: input.owner_user_id, installation_id: installation.id,
    app_version_id: version.id, grant_snapshot_id: grant.id, grant_snapshot_digest: grant.snapshot_digest,
    package_digest: version.package_digest, lifecycle_epoch: installation.lifecycle_epoch,
    grant_epoch: installation.grant_epoch, operator_user_id: input.operator_user_id,
    resource_key: descriptor.key, descriptor_digest,
    consent_expires_at: input.consent_expires_at?.toISOString()??null, ...(input.consent_lifetime?{consent_lifetime:input.consent_lifetime}:{}), limits,
    attachment_policy: parseAttachmentConsentPolicy(descriptor.attachments, input.attachment_policy),
    ...(input.owner_connection_admission ? { owner_connection_admission: input.owner_connection_admission } : {}),
    host_policy: { ...APP_RESOURCE_SYNC_HOST_POLICY, encrypted_custody: true, owner_only_binary: true,
      channel_version: 'deft.app_runtime_channel.v3', max_retained_attachment_stages: APP_ATTACHMENT_RETAINED_STAGE_LIMIT, provider_url_fetch: false, irrecoverable_host_purge: true },
  };
}
