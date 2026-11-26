'use client';

// Sharing a document (spec 5.2; plan Tasks F9 and F12). Opens for someone
// who can edit; a share gives at most "Can edit".
// - GET /api/documents/:id/shares lists the shares. Someone the viewer may not
//   see comes back with a null name and id (rule C4): the row says "Someone"
//   or "A chat", never an id, and can still be changed or removed.
// - POST /shares { principal_type, principal_id, role, include_subpages }.
//   With "Include sub-pages" on (the default) the share reaches every
//   sub-page the sharer can edit.
// - PATCH /shares/:shareId { role, include_subpages }: lowering reaches the
//   sub-pages too; raising changes this page only.
// - DELETE /shares/:shareId { include_subpages }.
// Raising across sub-pages, or adding sub-pages to a share made without them,
// takes a fresh share: POST answers 409 ALREADY_SHARED for someone already
// on the page, so the dialog says to remove the share and share again.

import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { Hash, User, X } from 'lucide-react';
import { api } from '@/lib/api';
import { AppDialog } from '@/components/overlay-primitives';
import { documentSharesKey, fetchScopedJson, membersKey, sendWrite, spacesKey, type Refusal, type SessionScope } from './document-keys';

export type ShareRole = 'view' | 'comment' | 'edit';
type Share = {
  id: string; principal_type: 'user' | 'space'; principal_id: string | null; role: ShareRole | 'full';
  name: string | null; shared_by: string | null; created_at: string;
};
type Member = { id: string; name: string | null; kind?: string };
type Space = { id: string; name: string | null; type: string };
type Candidate = { type: 'user' | 'space'; id: string; label: string };

const ROLES: ShareRole[] = ['view', 'comment', 'edit'];
const ROLE_LABEL: Record<ShareRole, string> = { view: 'Can view', comment: 'Can comment', edit: 'Can edit' };

/** The note the dialog always carries about sub-pages (F9's rules). */
export const SUBPAGES_NOTE = 'Raising a role changes this page only. To give its sub-pages the new role, or to add sub-pages to a share made without them, remove the share and share again with “Include sub-pages” on.';

/** What a refused share, change or removal says. */
export function shareRefusalText(refusal: Refusal): string {
  switch (refusal.code) {
    case 'ROLE_TOO_HIGH': return 'A share can give at most “Can edit”.';
    case 'SELF_SHARE': return 'You can’t share a document with yourself.';
    case 'PRINCIPAL_CANNOT_HOLD_ACCESS': return 'That person or chat can’t be given access to this document.';
    case 'ALREADY_SHARED': return 'This page is already shared with them. To change its sub-pages too, remove the share and share again.';
    default: break;
  }
  if (refusal.status === 403) return 'You need edit access to share this document.';
  if (refusal.status === 404) return 'This document is no longer available.';
  return refusal.message;
}

const shareLabel = (share: Share) => share.name
  ? (share.principal_type === 'space' ? `#${share.name}` : share.name)
  : (share.principal_type === 'space' ? 'A chat' : 'Someone');

/** Sub-page counts from a write's answer, said plainly; '' when there are none. */
function subpageSummary(body: Record<string, unknown>, verb: string): string {
  const done = Number(body.shared_subpages ?? body.lowered_subpages ?? body.removed_subpages ?? 0) || 0;
  const skipped = Number(body.skipped_subpages ?? 0) || 0;
  const parts: string[] = [];
  if (done > 0) parts.push(`${verb} ${done} ${done === 1 ? 'sub-page' : 'sub-pages'} too.`);
  if (skipped > 0) parts.push(`${skipped} ${skipped === 1 ? 'sub-page' : 'sub-pages'} you can’t edit ${skipped === 1 ? 'was' : 'were'} left as ${skipped === 1 ? 'it was' : 'they were'}.`);
  return parts.join(' ');
}

export function DocumentShareDialog({ documentId, scope, selfId, onClose }: {
  documentId: string;
  /** The signed-in session's cache scope: every read here is cached under it. */
  scope: SessionScope;
  selfId: string | null;
  onClose: () => void;
}) {
  const shares = useSWR<{ shares: Share[] }>(documentSharesKey(scope, documentId), fetchScopedJson);
  const members = useSWR<Member[]>(membersKey(scope), fetchScopedJson);
  const spaces = useSWR<Space[]>(spacesKey(scope), fetchScopedJson);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Candidate | null>(null);
  const [role, setRole] = useState<ShareRole>('view');
  const [subpages, setSubpages] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'error' | 'done'; text: string } | null>(null);
  const base = `/api/documents/${encodeURIComponent(documentId)}/shares`;

  const candidates = useMemo(() => {
    const taken = new Set((shares.data?.shares ?? []).map((share) => `${share.principal_type}:${share.principal_id ?? ''}`));
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const people: Candidate[] = (Array.isArray(members.data) ? members.data : [])
      .filter((m) => m.id !== selfId && m.kind !== 'system' && m.name && !taken.has(`user:${m.id}`))
      .map((m) => ({ type: 'user' as const, id: m.id, label: m.name! }));
    const chats: Candidate[] = (Array.isArray(spaces.data) ? spaces.data : [])
      .filter((s) => s.type !== 'dm' && s.type !== 'agent_conversation' && s.name && !taken.has(`space:${s.id}`))
      .map((s) => ({ type: 'space' as const, id: s.id, label: `#${s.name}` }));
    return [...people, ...chats].filter((c) => c.label.toLowerCase().includes(q)).slice(0, 8);
  }, [members.data, spaces.data, shares.data, query, selfId]);

  const run = async (write: () => Promise<Response>, fallback: string, done: (body: Record<string, unknown>) => string) => {
    if (busy) return false;
    setBusy(true);
    setNote(null);
    const outcome = await sendWrite<Record<string, unknown>>(write, fallback);
    setNote(outcome.ok ? { tone: 'done', text: done(outcome.body) } : { tone: 'error', text: shareRefusalText(outcome.refusal) });
    // Success or not, read the list again: someone else may have changed it.
    await shares.mutate();
    setBusy(false);
    return outcome.ok;
  };

  const share = async () => {
    if (!picked) return;
    const who = picked.label;
    const ok = await run(
      () => api.post(base, { principal_type: picked.type, principal_id: picked.id, role, include_subpages: subpages }),
      'Could not share the document',
      (body) => [`Shared with ${who}.`, subpageSummary(body, 'Shared')].filter(Boolean).join(' '),
    );
    if (ok) { setPicked(null); setQuery(''); }
  };

  const changeRole = (target: Share, next: ShareRole) => run(
    () => api.patch(`${base}/${encodeURIComponent(target.id)}`, { role: next, include_subpages: subpages }),
    'Could not change the role',
    (body) => [`${shareLabel(target)} now has “${ROLE_LABEL[next]}” here.`, subpageSummary(body, 'Changed')].filter(Boolean).join(' '),
  );

  const remove = (target: Share) => run(
    () => api.delete(`${base}/${encodeURIComponent(target.id)}`, { include_subpages: subpages }),
    'Could not remove the share',
    (body) => [`Removed ${shareLabel(target)}.`, subpageSummary(body, 'Removed from')].filter(Boolean).join(' '),
  );

  const field = { background: 'var(--surface)', border: '1px solid var(--outline-variant)', color: 'var(--on-surface)' } as const;
  return (
    <AppDialog onClose={onClose} title="Share" width={480}>
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          {picked ? (
            <div className="flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-[13px]" style={field}>
              {picked.type === 'space' ? <Hash size={14} className="flex-shrink-0" /> : <User size={14} className="flex-shrink-0" />}
              <span className="min-w-0 flex-1 truncate">{picked.label}</span>
              <button type="button" onClick={() => setPicked(null)} aria-label="Choose someone else" className="flex h-7 w-7 items-center justify-center rounded-md">
                <X size={14} />
              </button>
            </div>
          ) : (
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Add people or chats"
              aria-label="Add people or chats"
              className="w-full min-w-0 rounded-lg px-2.5 py-2 text-[13px]"
              style={field}
            />
          )}
          {!picked && candidates.length > 0 && (
            <ul role="listbox" aria-label="Matches" className="flex max-h-48 min-w-0 flex-col overflow-y-auto rounded-lg py-1" style={field}>
              {candidates.map((candidate) => (
                <li key={`${candidate.type}:${candidate.id}`} role="option" aria-selected={false}>
                  <button type="button" onClick={() => setPicked(candidate)} className="flex min-h-[36px] w-full min-w-0 items-center gap-2 px-2.5 text-left text-[13px]">
                    {candidate.type === 'space' ? <Hash size={14} className="flex-shrink-0" /> : <User size={14} className="flex-shrink-0" />}
                    <span className="truncate">{candidate.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!picked && query.trim() && candidates.length === 0 && members.data && spaces.data && (
            <p className="text-[12px]" style={{ color: 'var(--on-surface-variant)' }}>No one matches.</p>
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <select aria-label="Role for the new share" value={role} onChange={(event) => setRole(event.target.value as ShareRole)} disabled={busy}
              className="min-h-[36px] rounded-md px-2 text-[13px]" style={field}>
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
            <label className="flex min-h-[36px] items-center gap-1.5 text-[13px]" style={{ color: 'var(--on-surface)' }}>
              <input type="checkbox" checked={subpages} onChange={(event) => setSubpages(event.target.checked)} disabled={busy} />
              Include sub-pages
            </label>
            <button type="button" onClick={() => { void share(); }} disabled={busy || !picked}
              className="ml-auto min-h-[36px] rounded-md px-4 text-[13px] font-semibold text-white disabled:opacity-50" style={{ background: 'var(--primary-container)' }}>
              {busy ? 'Saving…' : 'Share'}
            </button>
          </div>
          <p className="text-[12px] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>{SUBPAGES_NOTE}</p>
        </div>
        {note && (
          <p role={note.tone === 'error' ? 'alert' : 'status'} className="text-[12px]"
            style={{ color: note.tone === 'error' ? 'var(--error, #b3261e)' : 'var(--on-surface-variant)' }}>
            {note.text}
          </p>
        )}
        <section aria-label="Shared with" className="flex min-w-0 flex-col gap-1">
          <h3 className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: 'var(--outline)' }}>Shared with</h3>
          {shares.error && !shares.data ? (
            <p role="alert" className="text-[13px]" style={{ color: 'var(--on-surface-variant)' }}>Could not load the shares.</p>
          ) : !shares.data ? (
            <p className="text-[13px]" style={{ color: 'var(--outline)' }}>Loading…</p>
          ) : shares.data.shares.length === 0 ? (
            <p className="text-[13px]" style={{ color: 'var(--on-surface-variant)' }}>Not shared beyond the drive yet.</p>
          ) : (
            <ul className="flex min-w-0 flex-col">
              {shares.data.shares.map((item) => (
                <li key={item.id} className="flex min-w-0 flex-wrap items-center gap-2 py-1.5 text-[13px]" style={{ color: 'var(--on-surface)' }}>
                  {item.principal_type === 'space' ? <Hash size={14} className="flex-shrink-0" /> : <User size={14} className="flex-shrink-0" />}
                  <span className="min-w-0 flex-1 truncate">{shareLabel(item)}</span>
                  <select aria-label={`Role for ${shareLabel(item)}`} value={item.role} disabled={busy}
                    onChange={(event) => { void changeRole(item, event.target.value as ShareRole); }}
                    className="min-h-[32px] rounded-md px-2 text-[12px]" style={field}>
                    {item.role === 'full' && <option value="full" disabled>Full access</option>}
                    {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                  </select>
                  <button type="button" disabled={busy} onClick={() => { void remove(item); }} aria-label={`Remove ${shareLabel(item)}`}
                    className="min-h-[32px] rounded-md px-2 text-[12px] disabled:opacity-50" style={{ color: 'var(--on-surface-variant)' }}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </AppDialog>
  );
}
