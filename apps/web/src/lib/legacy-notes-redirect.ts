// Old note links go to the document the note moved to (plan Task F16). The
// /notes page asks GET /api/documents/by-legacy/note/:id and then replaces
// itself with this target; anything unmapped goes to Drive.

/** The old note id in a legacy link: `?id=` first, then the older MCP form `?note=`. */
export function legacyNoteId(search: URLSearchParams): string | null {
  return search.get('id') || search.get('note') || null;
}

/** `/d/<id>` when the note is mapped to a document, `/drive` otherwise. */
export function legacyNotesTarget(search: URLSearchParams, mapped: string | null): string {
  return legacyNoteId(search) && mapped ? `/d/${encodeURIComponent(mapped)}` : '/drive';
}

/** An old-style link for a note id the API gave without a document id; the redirect page resolves it. */
export function legacyNotesHref(noteId: string): string {
  return `/notes?id=${encodeURIComponent(noteId)}`;
}
