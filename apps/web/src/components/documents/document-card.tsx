'use client';

// A document posted into a chat (spec 5.3; plan Task F13). The message
// carries ids only (`metadata.documents = [{ id }]`); each viewer reads
// their own card from POST /api/documents/cards, which is null when they
// can't open the document (rule C4). Cards are fetched in batches of up to
// 50, whichever messages ask for them in the same tick.
//
// A card is cached under the signed-in session (keys.ts), and the batcher
// keeps each session's ids apart: a batch is sent, and its answer used, only
// while its session is still the one signed in. Someone who signs in after
// another in the same tab never sees the previous person's cards.

import { useEffect } from 'react';
import Link from 'next/link';
import useSWR, { mutate as swrMutate } from 'swr';
import { FileText, Lock } from 'lucide-react';
import { api } from '@/lib/api';
import { getActiveSessionCacheScope } from '@/lib/session-cache';
import { getSocket } from '@/lib/socket';
import { cardKey, CARDS_PATH, isCardKeyOf, type SessionScope } from './keys';
import { PostingPrompt } from './posting-prompt';

export type DocRole = 'full' | 'edit' | 'comment' | 'view';
export type DocumentCardData = { id: string; title: string; icon: string | null; drive_name: string | null; role: DocRole };

const MAX_BATCH = 50;

export const ROLE_LABEL: Record<DocRole, string> = { full: 'full access', edit: 'can edit', comment: 'can comment', view: 'can view' };

/** The document ids a message carries, from its metadata, in order and without repeats. */
export function messageDocumentIds(metadata: unknown): string[] {
  const list = (metadata as { documents?: unknown } | null | undefined)?.documents;
  if (!Array.isArray(list)) return [];
  const ids: string[] = [];
  for (const entry of list) {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

type Waiter = { resolve: (card: DocumentCardData | null) => void; reject: (error: unknown) => void };
/** Session scope → document id → who waits for its card. */
let waiting = new Map<string, Map<string, Waiter[]>>();
let scheduled = false;

const sessionChanged = () => new Error('The signed-in session changed');

async function flushCards(): Promise<void> {
  scheduled = false;
  const batches = waiting;
  waiting = new Map();
  for (const [scope, batch] of batches) {
    const ids = [...batch.keys()];
    const settle = (chunk: string[], outcome: (waiter: Waiter, id: string) => void) => {
      for (const id of chunk) for (const waiter of batch.get(id) ?? []) outcome(waiter, id);
    };
    for (let at = 0; at < ids.length; at += MAX_BATCH) {
      const chunk = ids.slice(at, at + MAX_BATCH);
      // Sent, and used, only for the session signed in now.
      if (getActiveSessionCacheScope() !== scope) {
        settle(chunk, (waiter) => waiter.reject(sessionChanged()));
        continue;
      }
      try {
        const res = await api.post(CARDS_PATH, { ids: chunk });
        if (!res.ok) throw new Error(`Could not load documents (${res.status})`);
        const body = await res.json() as { cards?: Record<string, DocumentCardData | null> };
        if (getActiveSessionCacheScope() !== scope) throw sessionChanged();
        settle(chunk, (waiter, id) => waiter.resolve(body.cards?.[id] ?? null));
      } catch (error) {
        settle(chunk, (waiter) => waiter.reject(error));
      }
    }
  }
}

function loadCard(scope: string, id: string): Promise<DocumentCardData | null> {
  return new Promise((resolve, reject) => {
    const batch = waiting.get(scope) ?? new Map<string, Waiter[]>();
    waiting.set(scope, batch);
    const list = batch.get(id) ?? [];
    list.push({ resolve, reject });
    batch.set(id, list);
    if (!scheduled) {
      scheduled = true;
      setTimeout(() => { void flushCards(); }, 0);
    }
  });
}

/** This viewer's card for one document: undefined while loading or signed out, null when they can't open it. */
export function useDocumentCard(scope: SessionScope, id: string) {
  return useSWR<DocumentCardData | null>(cardKey(scope, id), () => loadCard(scope!, id), { revalidateOnFocus: false });
}

/**
 * Re-reads this session's cards when a document is shared with this viewer
 * (`document:shared`, sent only to people who can now open it), so a card
 * that said "You can't open this document." updates. Mount once per chat.
 */
export function useDocumentCardsRefresh(scope: SessionScope) {
  useEffect(() => {
    if (!scope) return;
    const token = localStorage.getItem('deft-access-token');
    if (!token) return;
    const socket = getSocket(token);
    const onShared = () => {
      void swrMutate((key) => isCardKeyOf(key, scope));
    };
    socket.on('document:shared', onShared);
    return () => { socket.off('document:shared', onShared); };
  }, [scope]);
}

/** One card: a link to the document, "You can't open this document." when `card` is null, a placeholder while undefined. */
export function DocumentCard({ card }: { card: DocumentCardData | null | undefined }) {
  const frame = 'mt-1.5 flex w-full max-w-[360px] min-w-0 items-center gap-2.5 rounded-lg px-3 py-2';
  const frameStyle = { background: 'var(--surface-container)', border: '1px solid var(--outline-variant)' } as const;
  if (card === undefined) {
    return (
      <div className={frame} style={frameStyle} aria-busy="true">
        <FileText size={16} strokeWidth={1.5} className="flex-shrink-0" style={{ color: 'var(--outline)' }} />
        <span className="text-[12px]" style={{ color: 'var(--on-surface-variant)' }}>Loading document…</span>
      </div>
    );
  }
  if (card === null) {
    return (
      <div className={frame} style={frameStyle} data-testid="document-card-hidden">
        <Lock size={15} strokeWidth={1.5} className="flex-shrink-0" style={{ color: 'var(--outline)' }} />
        <span className="text-[12px]" style={{ color: 'var(--on-surface-variant)' }}>You can&apos;t open this document.</span>
      </div>
    );
  }
  const home = card.drive_name ?? 'Shared with you';
  return (
    <Link href={`/d/${card.id}`} className={`${frame} hover:opacity-90`} style={frameStyle} data-testid="document-card">
      <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-[15px]" style={{ background: 'var(--surface-container-high)' }}>
        {card.icon ?? <FileText size={15} strokeWidth={1.5} style={{ color: 'var(--on-surface-variant)' }} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium" style={{ color: 'var(--on-surface)' }}>{card.title.trim() || 'Untitled'}</span>
        <span className="truncate text-[11px]" style={{ color: 'var(--on-surface-variant)' }}>{home} · {ROLE_LABEL[card.role]}</span>
      </span>
    </Link>
  );
}

function MessageDocumentCard({ scope, id }: { scope: SessionScope; id: string }) {
  const { data, error } = useDocumentCard(scope, id);
  if (error && data === undefined) {
    return (
      <div className="mt-1.5 text-[12px]" style={{ color: 'var(--on-surface-variant)' }}>Couldn&apos;t load this document.</div>
    );
  }
  return <DocumentCard card={data} />;
}

/**
 * The documents a message carries, each as this viewer's card, read under
 * `sessionScope` (the signed-in session's cache scope, useAuth). For the
 * poster, right after posting, `promptIds` names the documents to show the
 * posting prompt under, in the chat `spaceId` (PostingPrompt decides whether
 * it shows). The thread panel passes no prompt.
 */
export function MessageDocuments({
  metadata, sessionScope, spaceId, spaceName, isDm, promptIds, onPromptClosed,
}: {
  metadata: unknown;
  sessionScope: SessionScope;
  spaceId?: string;
  spaceName?: string;
  isDm?: boolean;
  promptIds?: readonly string[];
  onPromptClosed?: (documentId: string) => void;
}) {
  const ids = messageDocumentIds(metadata);
  if (ids.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col">
      {ids.map((id) => (
        <div key={id} className="min-w-0">
          <MessageDocumentCard scope={sessionScope} id={id} />
          {spaceId && promptIds?.includes(id) && (
            <PostingPrompt sessionScope={sessionScope} documentId={id} spaceId={spaceId} spaceName={spaceName ?? ''} isDm={isDm ?? false}
              onClose={() => onPromptClosed?.(id)} />
          )}
        </div>
      ))}
    </div>
  );
}
