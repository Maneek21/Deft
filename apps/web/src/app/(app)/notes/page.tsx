'use client';

// Old /notes links (plan Task F16). Notes are documents now: ?id= (or the
// older ?note=) asks the API where the note went and replaces this page with
// the document; anything unmapped, hidden or failing goes to Drive.
import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { legacyNoteId, legacyNotesTarget } from '@/lib/legacy-notes-redirect';

async function mappedDocument(noteId: string): Promise<string | null> {
  try {
    const res = await api.get(`/api/documents/by-legacy/note/${encodeURIComponent(noteId)}`);
    if (!res.ok) return null;
    const body = await res.json().catch(() => null) as { document_id?: unknown } | null;
    return typeof body?.document_id === 'string' && body.document_id ? body.document_id : null;
  } catch {
    return null;
  }
}

function LegacyNotesRedirect() {
  const router = useRouter();
  const search = useSearchParams();
  const query = search.toString();

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams(query);
    const noteId = legacyNoteId(params);
    void (noteId ? mappedDocument(noteId) : Promise.resolve(null)).then((mapped) => {
      if (!cancelled) router.replace(legacyNotesTarget(params, mapped));
    });
    return () => { cancelled = true; };
  }, [query, router]);

  return <div className="p-6 text-[13px]" style={{ color: 'var(--text-secondary)' }} role="status">Opening…</div>;
}

export default function NotesRedirectPage() {
  return <Suspense fallback={null}><LegacyNotesRedirect /></Suspense>;
}
