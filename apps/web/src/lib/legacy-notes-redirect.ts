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

/** The document a legacy note moved to, or null for a 404, any other refusal, a network error or an unreadable answer. */
export async function resolveLegacyNote(noteId: string, client: { get: (path: string) => Promise<Response> }): Promise<string | null> {
  try {
    const res = await client.get(`/api/documents/by-legacy/note/${encodeURIComponent(noteId)}`);
    if (!res.ok) return null;
    const body = await res.json().catch(() => null) as { document_id?: unknown } | null;
    return typeof body?.document_id === 'string' && body.document_id ? body.document_id : null;
  } catch {
    return null;
  }
}

/** Where a note search result goes: a document link the API gave (`/d/<id>`), else the old note id through the redirect. */
export function noteResultHref(item: { id: string; url?: string | null }): string {
  return typeof item.url === 'string' && /^\/d\/[^/?#]+$/.test(item.url) ? item.url : legacyNotesHref(item.id);
}

/** An old-style link for a note id the API gave without a document id; the redirect page resolves it. */
export function legacyNotesHref(noteId: string): string {
  return `/notes?id=${encodeURIComponent(noteId)}`;
}
