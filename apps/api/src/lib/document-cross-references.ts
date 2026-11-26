// Task keys written in a document (PROJ-42) become backlinks on the task
// (spec 5.12; plan Task F15, review finding A-I2). Notes queued a
// cross-reference scan when one was saved; documents queue one after a
// document is created with content and after every derived store of its
// content (F7's stored listeners: live editing's derived copy and every
// writeDocument), when the stored text names a task key (lib/task-key.ts).
// Nothing about the store itself changes: this only listens.
//
// The job (workers/handlers/cross-reference.ts) reads the document again as
// the queued person (a store's first editor, else the agent that wrote it;
// a created document's creator) and records only what they can see; Defty
// has no employee row, so its own writes queue a scan that records nothing.
// The job key holds the revision (`doc-xref:<documentId>:<revision>`), so
// each store is scanned once.
import { and, eq, inArray } from 'drizzle-orm';
import { documents } from '@deft/db/documents';
import { jsonToText } from '@deft/doc-schema';
import { onDocumentStored, type DocumentStoredEvent } from '../collab/persistence.js';
import { db } from './db.js';
import { onDocumentEvent, type DocumentLifecycleEvent } from './document-events.js';
import { enqueue, QUEUE_NAMES } from './queues.js';
import { mentionsTaskKey } from './task-key.js';

async function queueScan(orgId: string, documentId: string, revision: number, userId: string): Promise<void> {
  await enqueue(QUEUE_NAMES.AGENT_JOBS, 'cross-reference', {
    sourceType: 'document', sourceId: documentId, content: '', orgId, userId,
  }, { orgId, dedupeKey: `doc-xref:${documentId}:${revision}` });
}

/** A derived store: queues a scan when the stored text names a task key. */
export async function queueStoredDocumentScan(e: DocumentStoredEvent): Promise<void> {
  const userId = e.editorIds[0] ?? e.agentUserIds[0];
  if (!userId) return;
  let text: string;
  try {
    text = jsonToText(e.json);
  } catch {
    return;
  }
  if (mentionsTaskKey(text)) await queueScan(e.orgId, e.documentId, e.revision, userId);
}

/** Created documents: queues a scan of each whose text names a task key. */
export async function queueCreatedDocumentScans(e: DocumentLifecycleEvent): Promise<void> {
  if (e.type !== 'created' || !e.actorId) return;
  const rows = await db.select({ id: documents.id, text: documents.content_text, revision: documents.revision }).from(documents)
    .where(and(eq(documents.org_id, e.orgId), inArray(documents.id, e.documentIds), eq(documents.is_deleted, false)));
  for (const row of rows) {
    if (mentionsTaskKey(row.text)) await queueScan(e.orgId, row.id, row.revision, e.actorId);
  }
}

/** Starts both listeners (server.ts, next to the versioning listeners); returns the stop. */
export function startDocumentCrossReferences(): () => void {
  const offStored = onDocumentStored(queueStoredDocumentScan);
  const offCreated = onDocumentEvent(queueCreatedDocumentScans);
  return () => {
    offStored();
    offCreated();
  };
}
