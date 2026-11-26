'use client';

// The posting prompt (spec 5.3, mockup 4; plan Task F13). Right after
// someone posts a document into a chat, they alone see how many people in
// the chat can't open it, and may give the chat a role on it:
//   "{N} people in #{chat} can't open this, including {G} guest(s).
//    Give #{chat} [role ▾] [Share] [Don't share]"
// The guest clause is dropped when no guest is left out. In a DM it reads
// "{N} people in this conversation can't open this.". It shows only to
// someone who may share the document (`can_share`, edit on it) and only
// while somebody can't open it. The counts come from F9's
// GET /api/documents/:id/audience, cached under the signed-in session
// (keys.ts); Share calls F9's POST /shares for the chat; "Don't share" only
// closes the prompt.

import { useState } from 'react';
import useSWR, { mutate as swrMutate } from 'swr';
import { X } from 'lucide-react';
import { api } from '@/lib/api';
import { audienceKey, fetchScoped, revalidateSpaceDocuments, type SessionScope } from './keys';

export { audienceKey };
export type Audience = { cannot_open: number; guests: number; can_share: boolean };
type ShareRole = 'view' | 'comment' | 'edit';

/** Where the prompt says the document went: `#chat`, or "this conversation" in a DM. */
export function promptPlace(spaceName: string, isDm: boolean): string {
  return isDm ? 'this conversation' : `#${spaceName}`;
}

/** The prompt's count, as its two parts: who can't open it, and the guest clause ('' when none applies). */
export function postingPromptCounts(audience: Audience, spaceName: string, isDm: boolean): { lead: string; guests: string } {
  const people = audience.cannot_open === 1 ? '1 person' : `${audience.cannot_open} people`;
  const guests = !isDm && audience.guests > 0
    ? `, including ${audience.guests} ${audience.guests === 1 ? 'guest' : 'guests'}`
    : '';
  return { lead: `${people} in ${promptPlace(spaceName, isDm)} can't open this`, guests };
}

export function PostingPrompt({
  sessionScope, documentId, spaceId, spaceName, isDm, onClose,
}: {
  /** The signed-in session's cache scope (useAuth): the audience is read and cached under it. */
  sessionScope: SessionScope;
  documentId: string;
  spaceId: string;
  spaceName: string;
  isDm: boolean;
  onClose: () => void;
}) {
  const key = audienceKey(sessionScope, documentId, spaceId);
  const { data } = useSWR<Audience>(key, fetchScoped, { revalidateOnFocus: false, shouldRetryOnError: false });
  const [role, setRole] = useState<ShareRole>('comment');
  const [busy, setBusy] = useState(false);
  const [shared, setShared] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const place = promptPlace(spaceName, isDm);

  if (shared) {
    return (
      <div className="mt-1.5 flex w-full max-w-[520px] min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-[12px]"
        style={{ background: 'var(--accent-muted)', color: 'var(--on-surface)' }} data-testid="posting-prompt-shared">
        <span className="min-w-0 flex-1">Shared with {place}.</span>
        <button type="button" onClick={onClose} aria-label="Close" className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md"
          style={{ color: 'var(--on-surface-variant)' }}>
          <X size={14} />
        </button>
      </div>
    );
  }
  if (!data || !data.can_share || data.cannot_open <= 0) return null;

  const counts = postingPromptCounts(data, spaceName, isDm);
  const share = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post(`/api/documents/${encodeURIComponent(documentId)}/shares`, { principal_type: 'space', principal_id: spaceId, role });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: unknown } | null;
        setError(typeof body?.error === 'string' && body.error.trim() ? body.error : 'Could not share the document');
        return;
      }
      setShared(true);
      // The Docs tab lists what was shared into the chat, and the counts changed.
      void revalidateSpaceDocuments(sessionScope, spaceId);
      if (key) void swrMutate(key);
    } catch {
      setError('Could not share the document');
    } finally {
      setBusy(false);
    }
  };

  const control = 'min-h-[36px] rounded-md px-3 text-[12px]';
  return (
    <div className="mt-1.5 flex w-full max-w-[520px] min-w-0 flex-col gap-2 rounded-lg px-3 py-2.5"
      style={{ background: 'var(--surface-container)', border: '1px dashed var(--outline-variant)' }}
      data-testid="posting-prompt" role="status">
      <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--outline)' }}>Only visible to you</div>
      <p className="break-words text-[13px]" style={{ color: 'var(--on-surface)' }}>
        <b>{counts.lead}</b>{counts.guests}.
      </p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-[12px]" style={{ color: 'var(--on-surface-variant)' }}>Give {place}</span>
        <select aria-label={`Role for ${place}`} value={role} onChange={(e) => setRole(e.target.value as ShareRole)} disabled={busy}
          className={control} style={{ background: 'var(--surface)', border: '1px solid var(--outline-variant)', color: 'var(--on-surface)' }}>
          <option value="view">Can view</option>
          <option value="comment">Can comment</option>
          <option value="edit">Can edit</option>
        </select>
        <button type="button" onClick={() => { void share(); }} disabled={busy}
          className={`${control} font-semibold text-white disabled:opacity-60`} style={{ background: 'var(--primary-container)' }}>
          {busy ? 'Sharing…' : 'Share'}
        </button>
        <button type="button" onClick={onClose} disabled={busy} className={control} style={{ color: 'var(--on-surface-variant)' }}>
          Don&apos;t share
        </button>
      </div>
      {error && <p role="alert" className="text-[12px]" style={{ color: 'var(--status-red, #ef4444)' }}>{error}</p>}
    </div>
  );
}
