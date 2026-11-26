'use client';

// The Changes tab: a document's version list (spec 5.6; plan Tasks F8 and
// F12). Only someone who can edit sees it (F8's routes all need edit).
// - GET /api/documents/:id/versions lists newest first, a page at a time;
//   "Show older" continues from the page's `next_before`.
// - View opens a version's content (GET …/versions/:vid) read-only.
// - Restore (POST …/versions/:vid/restore) goes through the one writer, which
//   first saves the content just before as an automatic version, then saves
//   a "Restored from …" version, so history keeps both. A restore the writer
//   can't take now (503 BUSY) says "Busy, try again"; 413 is too large; 403
//   lost edit.
// - "Name this version" (POST …/versions { name }) names the current content.
// Who made a version shows only when the viewer may see that person (the
// members list follows the people rule); otherwise nothing is said.

import { useState, type FormEvent } from 'react';
import useSWR from 'swr';
import useSWRInfinite from 'swr/infinite';
import { History } from 'lucide-react';
import type { JSONContent } from '@tiptap/core';
import { api } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/time';
import { DocumentReadOnly } from './document-editor';
import { documentVersionKey, documentVersionPages, fetchScopedJson, sendWrite, type Refusal, type SessionScope } from './document-keys';

export type VersionKind = 'auto' | 'named' | 'agent' | 'restore' | 'import' | 'moved';
export type VersionSummary = {
  id: string; kind: VersionKind; name: string | null; title: string | null; created_by: string | null; agent_user_id: string | null;
  created_at: string; size_bytes: number;
};
type VersionPage = { versions: VersionSummary[]; next_before: string | null };

const KIND_LABEL: Record<VersionKind, string> = {
  auto: 'Automatic save', named: 'Named version', agent: 'Agent edit', restore: 'Restored', import: 'Imported', moved: 'Moved from Notes',
};

/** How a version is named in the list: its own name, else what made it. */
export function versionLabel(version: Pick<VersionSummary, 'kind' | 'name'>): string {
  return version.name?.trim() || KIND_LABEL[version.kind] || 'Version';
}

/** What a refused restore says (F8's writer refusals). */
export function restoreRefusalText(refusal: Refusal): string {
  if (refusal.status === 503 || refusal.code === 'BUSY') return 'Busy, try again';
  if (refusal.status === 413 || refusal.code === 'TOO_LARGE') return 'This version is too large to restore. Split the document into sub-pages first.';
  if (refusal.status === 403) return 'You need edit access to restore a version.';
  if (refusal.status === 404) return 'That version is no longer available.';
  if (refusal.code === 'REVISION_CHANGED') return 'The document changed while restoring. Try again.';
  return refusal.message;
}

function VersionPreview({ scope, documentId, versionId }: { scope: SessionScope; documentId: string; versionId: string }) {
  const { data, error } = useSWR<{ version: VersionSummary & { content_json: JSONContent } }>(
    documentVersionKey(scope, documentId, versionId), fetchScopedJson, { revalidateOnFocus: false },
  );
  if (error) return <p role="alert" className="text-[12px]" style={{ color: 'var(--on-surface-variant)' }}>Could not open this version.</p>;
  if (!data) return <p className="text-[12px]" style={{ color: 'var(--outline)' }}>Loading…</p>;
  return (
    <div className="max-h-[40vh] overflow-y-auto rounded-lg px-3 py-2 text-[13px]" style={{ background: 'var(--surface)', border: '1px solid var(--outline-variant)' }}>
      <DocumentReadOnly content={data.version.content_json} />
    </div>
  );
}

export function DocumentHistoryPanel({ documentId, scope, names }: {
  documentId: string;
  /** The signed-in session's cache scope: every read here is cached under it. */
  scope: SessionScope;
  /** People the viewer may see, by id (the members list). */
  names: ReadonlyMap<string, string>;
}) {
  const pages = useSWRInfinite<VersionPage>(documentVersionPages(scope, documentId), fetchScopedJson, { revalidateFirstPage: true });
  const versions = pages.data?.flatMap((page) => page.versions) ?? [];
  const last = pages.data?.[pages.data.length - 1];
  const [viewing, setViewing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'error' | 'done'; text: string } | null>(null);
  const [name, setName] = useState('');
  const base = `/api/documents/${encodeURIComponent(documentId)}/versions`;

  const restore = async (version: VersionSummary) => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    const outcome = await sendWrite(() => api.post(`${base}/${encodeURIComponent(version.id)}/restore`), 'Could not restore this version');
    setBusy(false);
    setConfirming(null);
    if (!outcome.ok) {
      setNote({ tone: 'error', text: restoreRefusalText(outcome.refusal) });
      return;
    }
    setNote({ tone: 'done', text: `Restored “${versionLabel(version)}”. Everyone with the document open sees it now.` });
    void pages.mutate();
  };

  const saveName = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setNote(null);
    const outcome = await sendWrite(() => api.post(base, { name: trimmed }), 'Could not save this version');
    setBusy(false);
    if (!outcome.ok) {
      setNote({ tone: 'error', text: outcome.refusal.status === 503 ? 'Busy, try again' : outcome.refusal.message });
      return;
    }
    setName('');
    setNote({ tone: 'done', text: `Saved “${trimmed}”.` });
    void pages.mutate();
  };

  const who = (version: VersionSummary) => {
    const id = version.agent_user_id ?? version.created_by;
    const person = id ? names.get(id) : undefined;
    return person ? ` · by ${person}` : '';
  };

  return (
    <div className="flex min-w-0 flex-col gap-3 p-3">
      <form onSubmit={(event) => { void saveName(event); }} className="flex min-w-0 gap-2">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Name this version"
          aria-label="Name this version"
          maxLength={200}
          className="min-w-0 flex-1 rounded-lg px-2.5 py-1.5 text-[13px]"
          style={{ background: 'var(--surface)', border: '1px solid var(--outline-variant)', color: 'var(--on-surface)' }}
        />
        <button type="submit" disabled={busy || !name.trim()} className="flex-shrink-0 rounded-lg px-3 py-1.5 text-[13px] font-medium disabled:opacity-50"
          style={{ background: 'var(--surface-container-high, var(--surface))', color: 'var(--on-surface)' }}>
          Save
        </button>
      </form>
      {note && (
        <p role={note.tone === 'error' ? 'alert' : 'status'} className="text-[12px]"
          style={{ color: note.tone === 'error' ? 'var(--error, #b3261e)' : 'var(--on-surface-variant)' }}>
          {note.text}
        </p>
      )}
      {pages.error && !pages.data ? (
        <p role="alert" className="text-[13px]" style={{ color: 'var(--on-surface-variant)' }}>Could not load the history.</p>
      ) : !pages.data ? (
        <p className="text-[13px]" style={{ color: 'var(--outline)' }}>Loading…</p>
      ) : versions.length === 0 ? (
        <p className="text-[13px]" style={{ color: 'var(--on-surface-variant)' }}>No versions yet. One is saved after a pause in editing.</p>
      ) : (
        <ol className="flex min-w-0 flex-col gap-1">
          {versions.map((version) => {
            const label = versionLabel(version);
            const open = viewing === version.id;
            return (
              <li key={version.id} className="flex min-w-0 flex-col gap-1.5 rounded-lg px-2 py-2" style={{ background: open ? 'var(--surface-container)' : 'transparent' }}>
                <div className="flex min-w-0 items-start gap-2">
                  <History size={14} strokeWidth={1.5} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--outline)' }} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium" style={{ color: 'var(--on-surface)' }}>{label}</div>
                    <div className="truncate text-[12px]" style={{ color: 'var(--on-surface-variant)' }} title={formatDateTime(version.created_at)}>
                      {formatRelative(version.created_at)}{who(version)}
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1 pl-6">
                  <button type="button" onClick={() => setViewing(open ? null : version.id)} aria-expanded={open} aria-label={`${open ? 'Hide' : 'View'} ${label}`}
                    className="min-h-[32px] rounded-md px-2 text-[12px]" style={{ color: 'var(--primary)' }}>
                    {open ? 'Hide' : 'View'}
                  </button>
                  <button type="button" disabled={busy} onClick={() => { setNote(null); setConfirming(version.id); }} aria-label={`Restore ${label}`}
                    className="min-h-[32px] rounded-md px-2 text-[12px] disabled:opacity-50" style={{ color: 'var(--primary)' }}>
                    Restore
                  </button>
                </div>
                {confirming === version.id && (
                  <div className="ml-6 flex flex-col gap-2 rounded-lg p-2 text-[12px]" style={{ border: '1px solid var(--outline-variant)', color: 'var(--on-surface)' }}>
                    <span>Restore this version? The current text is saved as a version first.</span>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" disabled={busy} onClick={() => { void restore(version); }}
                        className="min-h-[32px] rounded-md px-3 font-semibold text-white disabled:opacity-50" style={{ background: 'var(--primary-container)' }}>
                        {busy ? 'Restoring…' : 'Yes, restore'}
                      </button>
                      <button type="button" disabled={busy} onClick={() => setConfirming(null)} className="min-h-[32px] rounded-md px-3" style={{ color: 'var(--on-surface-variant)' }}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {open && <div className="pl-6"><VersionPreview scope={scope} documentId={documentId} versionId={version.id} /></div>}
              </li>
            );
          })}
        </ol>
      )}
      {last?.next_before && (
        <button type="button" disabled={pages.isValidating} onClick={() => { void pages.setSize(pages.size + 1); }}
          className="self-start rounded-md px-2 py-1 text-[12px] disabled:opacity-50" style={{ color: 'var(--primary)' }}>
          Show older
        </button>
      )}
    </div>
  );
}
