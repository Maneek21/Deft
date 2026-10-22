import { digestAppAuthorityDescriptor } from './app-authority-descriptor.js';
import type { AppRunTransaction } from './app-run-repository.js';
import { attachmentStale, loadReviewedAttachmentApp } from './app-attachment-authority.js';

export async function loadReviewedAttachmentSyncDescriptor(tx: AppRunTransaction, orgId: string,
  installationId: string, resourceKey?: string) {
  const reviewed = await loadReviewedAttachmentApp(tx, orgId, installationId);
  const descriptor = resourceKey === undefined ? reviewed.manifest.sync_descriptors[0]
    : reviewed.manifest.sync_descriptors.find(item => item.key === resourceKey);
  if (!descriptor) throw attachmentStale();
  return { installation: reviewed.installation, version: reviewed.version, grant: reviewed.grant, manifest: reviewed.manifest,
    descriptor, descriptor_digest: await digestAppAuthorityDescriptor(descriptor, { org_id: orgId, app_version_id: reviewed.version.id }),
    descriptors: reviewed.manifest.sync_descriptors };
}
