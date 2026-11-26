'use client';

// "Attach document" in the chat composer's + menu (plan Task F13): pick up
// to five documents you can open, from your recent documents or from a
// drive, to post with the message. The message stores their ids only; the
// titles shown here are the poster's own view.

import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { Check, FileText, X } from 'lucide-react';
import { api } from '@/lib/api';
import { AppDialog } from '../overlay-primitives';

export type PickedDocument = { id: string; title: string };

/** The most documents one message can carry (the API refuses more). */
export const MAX_MESSAGE_DOCUMENTS = 5;

type ListedDocument = { id: string; title: string; icon: string | null };
type ListedDrive = { id: string; name: string; role: string | null; frozen: boolean };

async function fetchJson<T>(path: string): Promise<T> {
  const res = await api.get(path);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json() as Promise<T>;
}

export function DocumentPicker({
  alreadyPicked, onPick, onClose,
}: {
  alreadyPicked: readonly PickedDocument[];
  onPick: (documents: PickedDocument[]) => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState<string>('recent');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<PickedDocument[]>([]);
  const room = MAX_MESSAGE_DOCUMENTS - alreadyPicked.length;

  const recent = useSWR<{ documents: ListedDocument[] }>(source === 'recent' ? '/api/documents/recent' : null, fetchJson);
  const drives = useSWR<{ drives: ListedDrive[] }>('/api/drives', fetchJson);
  const tree = useSWR<{ documents: ListedDocument[] }>(source !== 'recent' ? `/api/drives/${source}/tree` : null, fetchJson);
  const openable = (drives.data?.drives ?? []).filter((drive) => drive.role !== null && !drive.frozen);
  const active = source === 'recent' ? recent : tree;

  const listed = useMemo(() => {
    const words = query.trim().toLowerCase();
    const taken = new Set(alreadyPicked.map((doc) => doc.id));
    return (active.data?.documents ?? [])
      .filter((doc) => !taken.has(doc.id))
      .filter((doc) => !words || (doc.title || 'Untitled').toLowerCase().includes(words));
  }, [active.data, alreadyPicked, query]);

  const toggle = (doc: ListedDocument) => {
    setPicked((current) => {
      if (current.some((item) => item.id === doc.id)) return current.filter((item) => item.id !== doc.id);
      if (current.length >= room) return current;
      return [...current, { id: doc.id, title: doc.title.trim() || 'Untitled' }];
    });
  };

  const fieldStyle = { background: 'var(--surface)', border: '1px solid var(--outline-variant)', color: 'var(--on-surface)' } as const;
  return (
    <AppDialog
      onClose={onClose}
      title="Attach a document"
      description={room > 0 ? `Pick up to ${room} document${room === 1 ? '' : 's'} to post with your message.` : 'A message can carry five documents.'}
      width={480}
      footer={(
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="min-h-[36px] rounded-md px-3 text-[13px]" style={{ color: 'var(--on-surface-variant)' }}>
            Cancel
          </button>
          <button
            type="button"
            disabled={picked.length === 0}
            onClick={() => { onPick(picked); onClose(); }}
            className="min-h-[36px] rounded-md px-3 text-[13px] font-semibold text-white disabled:opacity-50"
            style={{ background: 'var(--primary-container)' }}
          >
            {picked.length > 1 ? `Attach ${picked.length} documents` : 'Attach'}
          </button>
        </div>
      )}
    >
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-wrap gap-2">
          <select aria-label="Where to look" value={source} onChange={(e) => setSource(e.target.value)}
            className="min-h-[36px] min-w-0 max-w-full rounded-md px-2 text-[13px]" style={fieldStyle}>
            <option value="recent">Recent documents</option>
            {openable.map((drive) => <option key={drive.id} value={drive.id}>{drive.name}</option>)}
          </select>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by title"
            aria-label="Filter by title"
            className="min-h-[36px] min-w-0 flex-1 rounded-md px-2 text-[13px]"
            style={fieldStyle}
          />
        </div>
        <div className="max-h-[320px] min-h-[120px] overflow-y-auto" role="listbox" aria-multiselectable="true" aria-label="Documents">
          {active.error && <p className="px-2 py-2 text-[13px]" style={{ color: 'var(--on-surface-variant)' }}>Couldn&apos;t load documents.</p>}
          {!active.error && !active.data && <p className="px-2 py-2 text-[13px]" style={{ color: 'var(--on-surface-variant)' }}>Loading…</p>}
          {active.data && listed.length === 0 && (
            <p className="px-2 py-2 text-[13px]" style={{ color: 'var(--on-surface-variant)' }}>No documents found.</p>
          )}
          {listed.map((doc) => {
            const selected = picked.some((item) => item.id === doc.id);
            const full = !selected && picked.length >= room;
            return (
              <button
                key={doc.id}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={full}
                onClick={() => toggle(doc)}
                className="flex min-h-[40px] w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left disabled:opacity-50"
                style={{ background: selected ? 'var(--accent-muted)' : 'transparent' }}
              >
                <span className="flex-shrink-0 text-[13px] leading-none">{doc.icon ?? <FileText size={14} strokeWidth={1.5} style={{ color: 'var(--outline)' }} />}</span>
                <span className="min-w-0 flex-1 truncate text-[13px]" style={{ color: 'var(--on-surface)' }}>{doc.title.trim() || 'Untitled'}</span>
                {selected && <Check size={14} strokeWidth={2} className="flex-shrink-0" style={{ color: 'var(--primary)' }} />}
              </button>
            );
          })}
        </div>
      </div>
    </AppDialog>
  );
}

/** The documents waiting to be posted with the next message, above the composer. */
export function PendingDocuments({ documents, onRemove }: { documents: readonly PickedDocument[]; onRemove: (id: string) => void }) {
  if (documents.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap gap-2 px-3 pt-1.5 md:px-4" data-testid="pending-documents">
      {documents.map((doc) => (
        <div key={doc.id} className="flex min-w-0 max-w-full items-center gap-1.5 rounded-lg px-2 py-1 text-[11px]" style={{ background: 'var(--surface-container)' }}>
          <FileText size={12} className="flex-shrink-0" style={{ color: 'var(--muted)' }} />
          <span className="max-w-[160px] truncate" style={{ color: 'var(--foreground-secondary)' }}>{doc.title}</span>
          <button type="button" aria-label={`Remove ${doc.title}`} onClick={() => onRemove(doc.id)} className="p-0.5" style={{ color: 'var(--muted)' }}>
            <X size={10} strokeWidth={1.5} />
          </button>
        </div>
      ))}
    </div>
  );
}
