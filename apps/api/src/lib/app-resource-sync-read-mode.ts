import type { AppRunTransaction } from './app-run-repository.js';
import type { WebAuthorityGuard } from './app-resource-sync-web-authority.js';
import { attachmentFinalAuthorityIsCurrent, attachmentStale } from './app-attachment-authority.js';

/** Only explicit blob routes supply this mode. It conveys no delivery rights. */
export type AttachmentSyncReadMode = Readonly<{ kind: 'attachment_v3'; guard: WebAuthorityGuard }>;

export async function finishAttachmentSyncMetadata(tx: AppRunTransaction, ids: readonly string[],
  mode: AttachmentSyncReadMode | undefined, expiresAt: readonly Date[] = []): Promise<void> {
  if (mode && !await attachmentFinalAuthorityIsCurrent(tx, ids,
    { guard: mode.guard, expires_at: expiresAt })) throw attachmentStale();
}
