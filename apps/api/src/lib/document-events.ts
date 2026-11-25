// Document lifecycle events: created, moved, deleted, restored, and the
// Knowledge setting changed. In-process and raised after commit. Knowledge
// (H3, H4) listens: a deleted document, or one whose Knowledge setting
// changed, has what the wiki learned from it withdrawn or re-learned.
//
// F4 raises `deleted` for every document of a deleted drive and
// `knowledge_changed` for every document of a drive whose Knowledge default
// changed (consult item Sol-N3). F5 adds the document-level events through
// the same functions; the interface is F5's (plan, Task F5).
export type DocumentLifecycleEvent = {
  type: 'created' | 'moved' | 'deleted' | 'restored' | 'knowledge_changed';
  orgId: string;
  documentIds: string[];
  fromDriveId?: string;
  toDriveId?: string;
  actorId: string;
};

type LifecycleListener = (e: DocumentLifecycleEvent) => void | Promise<void>;

const listeners = new Set<LifecycleListener>();

/** Tells every listener. One that throws or rejects is logged without the event and never stops the others. */
export function emitDocumentEvent(e: DocumentLifecycleEvent): void {
  if (e.documentIds.length === 0) return;
  for (const listener of [...listeners]) {
    try {
      const result: unknown = listener(e);
      if (result instanceof Promise) result.catch(() => console.error('[document-events] a lifecycle listener failed'));
    } catch {
      console.error('[document-events] a lifecycle listener failed');
    }
  }
}

/** Subscribes to lifecycle events; returns the unsubscribe. */
export function onDocumentEvent(listener: (e: DocumentLifecycleEvent) => void | Promise<void>): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
