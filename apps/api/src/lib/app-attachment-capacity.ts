import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { appAttachmentStages } from '@deft/db/schema';
import type { AppRunTransaction } from './app-run-repository.js';
import { attachmentStale } from './app-attachment-authority.js';
import { APP_ATTACHMENT_RETAINED_STAGE_LIMIT } from './app-attachment-policy.js';

/** Caller holds this exact checkpoint UPDATE lock. Only live ciphertext costs
 * are derived; the existing counter remains binary + projection bytes. The
 * state-leading cleanup index excludes indefinite purged history. No provider
 * identifiers or metadata plaintext enter this capacity projection. */
export async function retainedAttachmentMetadataCapacity(tx: AppRunTransaction, scope: {
  org_id: string; resource_binding_id: string; checkpoint_id: string;
}) {
  const rows = await tx.select({ bytes: sql<number>`octet_length(decode(${appAttachmentStages.metadata_envelope}->>'ciphertext_b64','base64'))` })
    .from(appAttachmentStages).where(and(eq(appAttachmentStages.org_id,scope.org_id),
      eq(appAttachmentStages.resource_binding_id,scope.resource_binding_id),eq(appAttachmentStages.checkpoint_id,scope.checkpoint_id),
      inArray(appAttachmentStages.state,['uploading','ready','blocked','linked','linked_blocked','retired'])))
    .orderBy(asc(appAttachmentStages.state),asc(appAttachmentStages.stage_expires_at),asc(appAttachmentStages.id))
    .limit(APP_ATTACHMENT_RETAINED_STAGE_LIMIT + 1);
  if (rows.length > APP_ATTACHMENT_RETAINED_STAGE_LIMIT
    || rows.some(r => !Number.isSafeInteger(r.bytes) || r.bytes < 0 || r.bytes > 8192)) throw attachmentStale();
  return { count: rows.length, bytes: rows.reduce((sum,r) => sum+r.bytes,0) };
}
