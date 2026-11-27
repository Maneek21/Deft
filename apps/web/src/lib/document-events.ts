// In-page signal that an open document changed (plan Task F12): the document
// page raises it when the server's `document:updated` names the document, and
// parts of the editor that wait on the server (a new image a viewer can't load
// until the next store confirms it) listen and try again.

export const DOCUMENT_UPDATED_EVENT = 'deft:document-updated';

export function announceDocumentUpdated(documentId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(DOCUMENT_UPDATED_EVENT, { detail: { id: documentId } }));
}
