// Access-change events for drives and documents, and the live document
// events that follow the viewer rule (consult rules C3 and C4).
//
// `emitDocumentAccessChanged` tells in-process listeners (live editing, F7;
// suggestions, M6) that someone's access may have changed, so they re-check
// it. It is raised after commit: by `finishAccessLoss`
// (lib/document-access-change.ts) for every change that can lower access,
// and directly for changes that only add access. Each change names what it
// touched: a drive, documents, a chat (space) or people. With only a drive
// or a chat, listeners re-check everything loaded in the workspace that the
// drive or chat can reach.
//
// Socket events (rule C4): `document:updated` and `document:shared` reach
// only people who can view the document. For a document of an open drive
// that is the workspace's `org-members` room (owners, admins and members)
// plus each other viewer (guests through their grants); otherwise each
// viewer. The viewers come from one query (`documentViewers` in
// lib/document-access.ts). Payloads carry ids only: clients refetch through
// REST, which applies the access check.
import { getIO, emitToUser } from '../socket.js';
import { db } from './db.js';
import { documentViewers, type Executor } from './document-access.js';

export type DocumentAccessChange = { orgId: string; driveId?: string; documentIds?: string[]; spaceId?: string; userIds?: string[] };

type AccessListener = (c: DocumentAccessChange) => void;

const listeners = new Set<AccessListener>();

/**
 * Tells every listener, after commit. A listener that throws or rejects is
 * logged without the change and never stops the others or the caller.
 */
export function emitDocumentAccessChanged(change: DocumentAccessChange): void {
  for (const listener of [...listeners]) {
    try {
      const result: unknown = listener(change);
      if (result instanceof Promise) result.catch(() => console.error('[document-access-events] an access-change listener failed'));
    } catch {
      console.error('[document-access-events] an access-change listener failed');
    }
  }
}

/** Subscribes to access changes; returns the unsubscribe. */
export function onDocumentAccessChanged(listener: (c: DocumentAccessChange) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Who a live event about some documents goes to, read before it is sent:
 * for each document that exists and isn't deleted, its drive, whether the
 * workspace's members room covers its drive (an open drive), and every other
 * person who can view it. Read it before a change that hides the documents
 * (deleting a drive) and send it after commit.
 */
export type DocumentEventAudience = {
  orgId: string;
  documents: Array<{ documentId: string; driveId: string; membersRoom: boolean; userIds: string[] }>;
};

export async function documentEventAudience(orgId: string, documentIds: readonly string[], executor: Executor = db): Promise<DocumentEventAudience> {
  if (documentIds.length === 0) return { orgId, documents: [] };
  return { orgId, documents: await documentViewers(orgId, documentIds, executor) };
}

/**
 * Sends `event` about each document of `audience`, ids only:
 * `document:updated` carries `{ id, drive_id }` and `document:shared`
 * carries `{ document_id }`. Best effort, like every realtime event.
 */
export function sendDocumentEvent(audience: DocumentEventAudience, event: 'document:updated' | 'document:shared'): void {
  try {
    for (const doc of audience.documents) {
      const payload = event === 'document:updated' ? { id: doc.documentId, drive_id: doc.driveId } : { document_id: doc.documentId };
      if (doc.membersRoom) getIO()?.to(`org-members:${audience.orgId}`).emit(event, payload);
      for (const userId of doc.userIds) emitToUser(audience.orgId, userId, event, payload);
    }
  } catch {
    // Realtime delivery is best effort; clients refetch on navigation.
  }
}

/** After commit: `document:updated` for `documentIds` to the people who can view them now. Never throws. */
export async function emitDocumentUpdated(orgId: string, documentIds: readonly string[]): Promise<void> {
  try {
    sendDocumentEvent(await documentEventAudience(orgId, documentIds), 'document:updated');
  } catch {
    console.error('[document-access-events] document:updated could not be sent');
  }
}
