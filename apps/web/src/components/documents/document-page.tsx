'use client';

// The document page, /d/<id> (spec 5.3 and 5.4; plan Task F12).
//
// Reads GET /api/documents/:id (F5's redacted projection: hidden folders and
// parent pages are null, hidden ancestors are one "Shared with you"), cached
// under the signed-in session (document-keys.ts), and re-read when
// `document:updated` names it.
//
// Live editing (lib/collab-provider.ts): while the API says `live`, the page
// opens one provider for the document and shows the live editor once it has
// synced. Editing needs edit on the document, a read-write connection (the
// server makes view and comment read-only) and a connection that is live or
// merely offline (changes made offline sync on reconnect). Otherwise:
// - live editing off (`live: false`, or 4503), busy (4429), crowded (4430),
//   or a paused workspace (4503 `paused`): the stored JSON, read-only, with no
//   toolbar, read again every 15 s;
// - too large (4413/1009): this Y.Doc is thrown away and the document opens
//   again from the server, with "This document is too large. Split it into
//   sub-pages.";
// - no access (4403/4404 on the live connection, or 403/404 from either the
//   document's read or the read-only copy's): "You no longer have access to
//   this document.", the live connection closes, the cached copies are
//   dropped and nothing of the document stays on screen (rule C4).
// The title can be edited only by an editor while the page isn't read-only.
//
// Header: breadcrumb, presence, History and Share (edit and up), ⋯ (copy
// link; move and delete for editors). Presence and carets name people by user
// id through the members list (the people rule), else "A collaborator"
// (lib/collab-people.ts). The right panel's Changes tab is the version list
// (edit and up); on a phone the panel is a bottom sheet. The editors load
// through next/dynamic (document-lazy.tsx).

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import useSWR, { useSWRConfig } from 'swr';
import type { JSONContent } from '@tiptap/core';
import { X } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { getSocket } from '@/lib/socket';
import { isNoAccess } from '@/lib/drive-actions';
import { createDocumentProvider, READ_ONLY_RETRY_MS, READ_ONLY_STATUSES, type CollabStatus } from '@/lib/collab-provider';
import { collaboratorName } from '@/lib/collab-people';
import { announceDocumentUpdated } from '@/lib/document-events';
import type { DocumentUser } from '@/lib/editor/document-extensions';
import { AppDialog } from '@/components/overlay-primitives';
import { canEditRole, DocumentHeader, EditedLine, type BreadcrumbItem, type DocRole, type PresenceUser } from './document-header';
import { LazyDocumentEditor, LazyDocumentReadOnly } from './document-lazy';
import { DocumentRightPanel, type PanelTab } from './document-right-panel';
import { DocumentShareDialog } from './document-share-dialog';
import { DocumentMoveDialog } from './document-move-dialog';
import { documentContentKey, documentKey, fetchScopedJson, membersKey, sendWrite } from './document-keys';

export type DocumentView = {
  id: string;
  title: string;
  icon: string | null;
  drive: { id: string; name: string | null; kind: string | null };
  folder_id: string | null;
  parent_document_id: string | null;
  breadcrumb: BreadcrumbItem[];
  role: DocRole;
  last_edited_by: string | null;
  last_edited_at: string | null;
  is_template: boolean;
  live: boolean;
  content_json?: JSONContent | null;
};

/** Caret colours (#RRGGBB, which CollaborationCaret requires). */
const CARET_COLORS = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2', '#dc2626', '#4f46e5'];

/** One person's caret colour, the same in every tab and on every device. */
export function caretColor(userId: string): string {
  let hash = 0;
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return CARET_COLORS[hash % CARET_COLORS.length]!;
}

/** What the page says about the live connection, if anything. */
export function collabNotice(status: CollabStatus, everLive: boolean): string | null {
  switch (status) {
    case 'busy': return 'Busy, try again. Live editing is full right now, so this is a read-only copy. It tries again every 15 seconds.';
    case 'crowded': return 'Busy, try again. Too many people have this document open, so this is a read-only copy for now.';
    case 'live_off': return 'Live editing is off. This is a read-only copy.';
    case 'read_only': return 'This workspace is paused.';
    case 'offline': return everLive ? 'You’re offline. Your changes will sync when you reconnect.' : 'Can’t connect right now. This is a read-only copy; trying again.';
    case 'connecting': return everLive ? 'Reconnecting…' : null;
    default: return null;
  }
}

type Session = ReturnType<typeof createDocumentProvider>;
type Collab = { session: Session; status: CollabStatus; everLive: boolean; readOnlyScope: boolean };

/**
 * One live connection for the document while `documentId` is set. A too-large
 * refusal throws the Y.Doc away and opens a fresh one from the server.
 */
function useCollab(documentId: string | null, onStatus: (status: CollabStatus) => void) {
  const [collab, setCollab] = useState<Collab | null>(null);
  const [generation, setGeneration] = useState(0);
  const [tooLarge, setTooLarge] = useState(false);
  const onStatusRef = useRef(onStatus);
  useEffect(() => { onStatusRef.current = onStatus; });

  useEffect(() => {
    if (!documentId) return;
    let session: Session | null = null;
    session = createDocumentProvider({
      documentId,
      onStatus: (status) => {
        onStatusRef.current(status);
        if (status === 'too_large') {
          setTooLarge(true);
          setCollab(null);
          setGeneration((value) => value + 1);
          return;
        }
        setCollab((prev) => (prev && prev.session === session ? {
          ...prev,
          status,
          everLive: prev.everLive || status === 'live',
          readOnlyScope: status === 'live' ? prev.session.provider.authorizedScope === 'readonly' : prev.readOnlyScope,
        } : prev));
      },
    });
    setCollab({ session, status: 'connecting', everLive: false, readOnlyScope: false });
    return () => {
      session?.destroy();
      setCollab(null);
    };
  }, [documentId, generation]);

  return { collab, tooLarge, dismissTooLarge: () => setTooLarge(false) };
}

const COLOR = /^#[0-9a-fA-F]{6}$/;
const NEUTRAL = '#6b7280';

type Present = { id: string; color: string };

/**
 * Everyone else with the document open, one entry per person, from awareness:
 * the user id the server set and a colour. Names come later, from the members
 * list. The viewer's own other tabs are left out.
 */
function usePresence(session: Session | null, selfId: string | null): Present[] {
  // Kept with the session it was read from, so a closed session's people never show.
  const [seenIn, setSeenIn] = useState<{ session: Session; people: Present[] } | null>(null);
  useEffect(() => {
    const awareness = session?.provider.awareness;
    if (!session || !awareness) return;
    const read = () => {
      const seen = new Map<string, Present>();
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.clientID) return;
        const user = (state as { user?: { id?: unknown; color?: unknown } }).user;
        if (!user || typeof user.id !== 'string' || !user.id || user.id === selfId) return;
        if (!seen.has(user.id)) seen.set(user.id, { id: user.id, color: typeof user.color === 'string' && COLOR.test(user.color) ? user.color : NEUTRAL });
      });
      setSeenIn({ session, people: [...seen.values()] });
    };
    read();
    awareness.on('change', read);
    return () => awareness.off('change', read);
  }, [session, selfId]);
  return seenIn && seenIn.session === session ? seenIn.people : NO_PRESENT;
}

const NO_PRESENT: Present[] = [];

function TitleField({ title, editable, onSave }: { title: string; editable: boolean; onSave: (next: string) => void }) {
  const className = 'w-full min-w-0 bg-transparent text-[1.75rem] font-bold leading-tight outline-none md:text-[2rem]';
  if (!editable) return <h1 className={`${className} break-words`} style={{ color: 'var(--on-surface)' }}>{title.trim() || 'Untitled'}</h1>;
  const commit = (value: string) => {
    if (value.trim() !== title.trim()) onSave(value.trim());
  };
  return (
    <input
      key={title}
      defaultValue={title}
      placeholder="Untitled"
      aria-label="Document title"
      maxLength={500}
      onBlur={(event) => commit(event.target.value)}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
      className={className}
      style={{ color: 'var(--on-surface)' }}
    />
  );
}

function Banner({ text, tone, onClose }: { text: string; tone: 'info' | 'warn'; onClose?: () => void }) {
  return (
    <div role={tone === 'warn' ? 'alert' : 'status'} className="mb-3 flex min-w-0 items-start gap-2 rounded-lg px-3 py-2 text-[13px]"
      style={{ background: tone === 'warn' ? 'var(--error-container, #fde8e7)' : 'var(--surface-container)', color: 'var(--on-surface)', border: '1px solid var(--outline-variant)' }}>
      <span className="min-w-0 flex-1 break-words">{text}</span>
      {onClose && (
        <button type="button" onClick={onClose} aria-label="Dismiss" className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md">
          <X size={14} />
        </button>
      )}
    </div>
  );
}

export function DocumentPage({ documentId }: { documentId: string }) {
  const router = useRouter();
  const { user, sessionCacheScope: scope } = useAuth();
  const { mutate: mutateCache } = useSWRConfig();
  const docKey = documentKey(scope, documentId);
  const contentKey = documentContentKey(scope, documentId);
  // Access lost, by the live connection (4403/4404) or a 403/404 on either read. Once set, it stays.
  const [lost, setLost] = useState(false);
  const loseAccess = useCallback(() => {
    setLost(true);
    // Nothing of the document stays cached in this tab, either.
    if (docKey) void mutateCache(docKey, undefined, { revalidate: false });
    if (contentKey) void mutateCache(contentKey, undefined, { revalidate: false });
  }, [docKey, contentKey, mutateCache]);
  const onReadError = useCallback((error: unknown) => { if (isNoAccess(error)) loseAccess(); }, [loseAccess]);
  const doc = useSWR<{ document: DocumentView }>(lost ? null : docKey, fetchScopedJson, {
    // While live editing is off the page shows the stored JSON: read it again on the retry interval.
    refreshInterval: (latest) => (latest?.document.live === false ? READ_ONLY_RETRY_MS : 0),
    onError: onReadError,
  });
  const document = doc.data?.document ?? null;
  const lostAccess = lost || (doc.error !== undefined && isNoAccess(doc.error));
  const live = document?.live === true && !lostAccess;
  const revalidate = doc.mutate;
  const onStatus = useCallback((status: CollabStatus) => {
    if (status === 'no_access') loseAccess();
    // A reconnect may follow a role change: read the document (and the role) again.
    if (status === 'live') void revalidate();
  }, [revalidate, loseAccess]);
  const { collab, tooLarge, dismissTooLarge } = useCollab(live ? documentId : null, onStatus);
  const present = usePresence(collab?.session ?? null, user?.id ?? null);
  const members = useSWR<Array<{ id: string; name: string | null }>>(membersKey(scope), fetchScopedJson, { revalidateOnFocus: false });
  const names = useMemo(() => new Map((Array.isArray(members.data) ? members.data : [])
    .filter((m) => typeof m.name === 'string' && m.name.trim()).map((m) => [m.id, m.name!] as const)), [members.data]);
  const presence = useMemo<PresenceUser[]>(() => present.map((person) => ({
    key: person.id, name: collaboratorName(names, person.id), color: person.color,
  })), [present, names]);

  const status: CollabStatus | null = !document ? null : live ? (collab?.status ?? 'connecting') : 'live_off';
  const everLive = collab?.everLive ?? false;
  const fallback = status !== null && (READ_ONLY_STATUSES.has(status) || (status === 'offline' && !everLive));
  const content = useSWR<{ document: DocumentView }>(live && fallback ? contentKey : null, fetchScopedJson, {
    refreshInterval: READ_ONLY_RETRY_MS,
    onError: onReadError,
  });
  const readOnlyJson = live ? content.data?.document.content_json : document?.content_json;

  const [panel, setPanel] = useState<PanelTab | null>(null);
  const [dialog, setDialog] = useState<'share' | 'move' | 'delete' | null>(null);
  const [message, setMessage] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  // `document:updated` (ids only, sent only to people who can view it): title, place or editor changed.
  useEffect(() => {
    if (!scope) return;
    const token = api.getAccessToken();
    if (!token) return;
    const socket = getSocket(token);
    const onUpdated = (payload: unknown) => {
      if (!payload || typeof payload !== 'object' || (payload as { id?: unknown }).id !== documentId) return;
      void revalidate();
      // Images waiting on the server's confirmation try again (lib/editor/blocks/document-image.tsx).
      announceDocumentUpdated(documentId);
    };
    socket.on('document:updated', onUpdated);
    return () => { socket.off('document:updated', onUpdated); };
  }, [scope, documentId, revalidate]);

  // Awareness carries only the id (the server sets it again) and the caret colour.
  const me = useMemo<DocumentUser | null>(() => (user ? { id: user.id, color: caretColor(user.id) } : null), [user]);
  const say = useCallback((text: string) => setMessage({ tone: 'warn', text }), []);

  if (!scope) return <div className="flex-1 p-4 text-[0.875rem]" style={{ color: 'var(--outline)' }}>Loading…</div>;
  if (lostAccess || (content.error !== undefined && isNoAccess(content.error)) || status === 'no_access') {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <p role="alert" className="text-[0.875rem]" style={{ color: 'var(--on-surface-variant)' }}>You no longer have access to this document.</p>
      </div>
    );
  }
  if (doc.error && !document) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <p role="alert" className="text-[0.875rem]" style={{ color: 'var(--on-surface-variant)' }}>Could not load this document. Check your connection and try again.</p>
      </div>
    );
  }
  if (!document) return <div className="flex-1 p-4 text-[0.875rem]" style={{ color: 'var(--outline)' }}>Loading…</div>;

  const canEdit = canEditRole(document.role);
  const editable = canEdit && !!collab && !collab.readOnlyScope && (status === 'live' || status === 'offline');
  // Paused, live editing off, busy or crowded: the page is read-only, the title too.
  const titleEditable = canEdit && !fallback;
  const notice = status ? collabNotice(status, everLive) : null;
  const encodedId = encodeURIComponent(documentId);

  const saveTitle = async (title: string) => {
    const outcome = await sendWrite(() => api.patch(`/api/documents/${encodedId}`, { title }), 'Could not rename the document');
    if (!outcome.ok) setMessage({ tone: 'warn', text: outcome.refusal.message });
    await revalidate();
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/d/${encodedId}`);
      setMessage({ tone: 'info', text: 'Link copied.' });
    } catch {
      setMessage({ tone: 'warn', text: 'Could not copy the link.' });
    }
  };

  const remove = async () => {
    if (deleting) return;
    setDeleting(true);
    const outcome = await sendWrite(() => api.delete(`/api/documents/${encodedId}`), 'Could not delete the document');
    setDeleting(false);
    setDialog(null);
    if (!outcome.ok) {
      setMessage({ tone: 'warn', text: outcome.refusal.message });
      return;
    }
    router.push(document.drive.name !== null ? `/drive/${encodeURIComponent(document.drive.id)}` : '/drive');
  };

  let body;
  if (fallback) {
    body = readOnlyJson ? <LazyDocumentReadOnly content={readOnlyJson} /> : <p className="text-[13px]" style={{ color: 'var(--outline)' }}>Loading…</p>;
  } else if (collab && everLive && me) {
    body = (
      <LazyDocumentEditor documentId={documentId} provider={collab.session.provider} ydoc={collab.session.ydoc} user={me}
        names={names} editable={editable} onNotice={say} />
    );
  } else {
    body = <p className="text-[13px]" style={{ color: 'var(--outline)' }}>Loading…</p>;
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <DocumentHeader
        title={document.title}
        breadcrumb={document.breadcrumb}
        role={document.role}
        presence={presence}
        status={status}
        onHistory={() => setPanel((open) => (open === 'changes' ? null : 'changes'))}
        onShare={() => setDialog('share')}
        onCopyLink={() => { void copyLink(); }}
        onMove={() => setDialog('move')}
        onDelete={() => setDialog('delete')}
      />
      <div className="flex min-h-0 min-w-0 flex-1">
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full min-w-0 max-w-3xl px-4 pb-16 pt-6 md:px-8">
            {tooLarge && <Banner tone="warn" text="This document is too large. Split it into sub-pages." onClose={dismissTooLarge} />}
            {notice && <Banner tone="info" text={notice} />}
            {message && <Banner tone={message.tone} text={message.text} onClose={() => setMessage(null)} />}
            <TitleField title={document.title} editable={titleEditable} onSave={(next) => { void saveTitle(next); }} />
            <div className="mb-6 mt-1">
              <EditedLine at={document.last_edited_at} by={document.last_edited_by ? names.get(document.last_edited_by) ?? null : null} />
            </div>
            {body}
          </div>
        </main>
        {panel && (
          <DocumentRightPanel
            tab={panel}
            onTab={setPanel}
            onClose={() => setPanel(null)}
            canSeeHistory={canEdit}
            documentId={documentId}
            scope={scope}
            names={names}
          />
        )}
      </div>
      {dialog === 'share' && canEdit && (
        <DocumentShareDialog documentId={documentId} scope={scope} selfId={user?.id ?? null} onClose={() => setDialog(null)} />
      )}
      {dialog === 'move' && canEdit && (
        <DocumentMoveDialog documentId={documentId} scope={scope} currentDriveId={document.drive.id}
          onMoved={() => { void revalidate(); setMessage({ tone: 'info', text: 'Moved.' }); }} onClose={() => setDialog(null)} />
      )}
      {dialog === 'delete' && canEdit && (
        <AppDialog
          onClose={() => setDialog(null)}
          title="Delete this document?"
          description="It moves to the drive’s trash with its sub-pages. Someone with edit access can restore it from there for 30 days."
          danger
          footer={(
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setDialog(null)} disabled={deleting} className="min-h-[36px] rounded-md px-3 text-[13px]" style={{ color: 'var(--on-surface-variant)' }}>Cancel</button>
              <button type="button" onClick={() => { void remove(); }} disabled={deleting}
                className="min-h-[36px] rounded-md px-4 text-[13px] font-semibold text-white disabled:opacity-50" style={{ background: 'var(--danger, #b3261e)' }}>
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          )}
        >
          <span />
        </AppDialog>
      )}
    </div>
  );
}
