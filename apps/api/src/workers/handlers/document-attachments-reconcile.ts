// Handler: document-attachments-reconcile (plan Task F8). Queued when the
// stored listener couldn't update a document's document_attachments
// .in_current after its content had committed; recomputes the flags from the
// document's latest stored content_json (lib/document-versions.ts), so it is
// idempotent and a late run is still right.
import { reconcileDocumentAttachments } from '../../lib/document-versions.js';
import { logId } from '../../lib/log-metadata.js';
import { jobOrgId } from '../job-org.js';
import type { JobData } from '../types.js';

export async function handleDocumentAttachmentsReconcile(job: JobData): Promise<void> {
  const orgId = jobOrgId(job);
  const documentId: unknown = job.data?.document_id;
  if (!orgId || typeof documentId !== 'string' || !documentId) {
    console.warn(`[document-attachments-reconcile] job ${logId(job.id)} names no document and workspace; skipping`);
    return;
  }
  await reconcileDocumentAttachments(orgId, documentId);
}
