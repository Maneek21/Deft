import { digestResourceSyncDescriptorV2 } from '@deft/app-kit';
import type { AppRunTransaction } from './app-run-repository.js';
import { attachmentStale, loadReviewedAttachmentApp } from './app-attachment-authority.js';

export async function loadReviewedAttachmentSyncDescriptor(tx: AppRunTransaction, orgId: string,
  installationId: string, resourceKey?: string) {
  const reviewed = await loadReviewedAttachmentApp(tx, orgId, installationId);
  const descriptor = resourceKey === undefined ? reviewed.manifest.sync_descriptors[0]
    : reviewed.manifest.sync_descriptors.find(item => item.key === resourceKey);
  if (!descriptor) throw attachmentStale();
  return { installation: reviewed.installation, version: reviewed.version, grant: reviewed.grant,
    descriptor, descriptor_digest: await digestResourceSyncDescriptorV2(descriptor),
    descriptors: reviewed.manifest.sync_descriptors };
}
