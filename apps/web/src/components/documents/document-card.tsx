'use client';

// A document posted into a chat (spec 5.3; plan Task F13). The message
// carries ids only (`metadata.documents = [{ id }]`); each viewer reads
// their own card from POST /api/documents/cards, which is null when they
// can't open the document (rule C4). Cards are fetched in batches of up to
// 50, whichever messages ask for them in the same tick.

import { useEffect } from 'react';
import Link from 'next/link';
import useSWR, { mutate as swrMutate } from 'swr';
import { FileText, Lock } from 'lucide-react';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { PostingPrompt } from './posting-prompt';

export type DocRole = 'full' | 'edit' | 'comment' | 'view';
export type DocumentCardData = { id: string; title: string; icon: string | null; drive_name: string | null; role: DocRole };

const CARD_KEY = 'document-card';
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
let waiting = new Map<string, Waiter[]>();
let scheduled = false;

async function flushCards(): Promise<void> {
  scheduled = false;
  const batch = waiting;
  waiting = new Map();
  const ids = [...batch.keys()];
  for (let at = 0; at < ids.length; at += MAX_BATCH) {
    const chunk = ids.slice(at, at + MAX_BATCH);
    try {
      const res = await api.post('/api/documents/cards', { ids: chunk });
      if (!res.ok) throw new Error(`Could not load documents (${res.status})`);
      const body = await res.json() as { cards?: Record<string, DocumentCardData | null> };
      for (const id of chunk) for (const waiter of batch.get(id) ?? []) waiter.resolve(body.cards?.[id] ?? null);
    } catch (error) {
      for (const id of chunk) for (const waiter of batch.get(id) ?? []) waiter.reject(error);
    }
  }
}

function loadCard(id: string): Promise<DocumentCardData | null> {
  return new Promise((resolve, reject) => {
    const list = waiting.get(id) ?? [];
    list.push({ resolve, reject });
    waiting.set(id, list);
    if (!scheduled) {
      scheduled = true;
      setTimeout(() => { void flushCards(); }, 0);
    }
  });
}

/** This viewer's card for one document: undefined while loading, null when they can't open it. */
export function useDocumentCard(id: string) {
  return useSWR<DocumentCardData | null>([CARD_KEY, id], () => loadCard(id), { revalidateOnFocus: false });
}

/**
 * Re-reads every card when a document is shared with this viewer
 * (`document:shared`, sent only to people who can now open it), so a card
 * that said "You can't open this document." updates. Mount once per chat.
 */
export function useDocumentCardsRefresh(sessionScope: string | null | undefined) {
  useEffect(() => {
    if (!sessionScope) return;
    const token = localStorage.getItem('deft-access-token');
    if (!token) return;
    const socket = getSocket(token);
    const onShared = () => {
      void swrMutate((key) => Array.isArray(key) && key[0] === CARD_KEY);
    };
    socket.on('document:shared', onShared);
    return () => { socket.off('document:shared', onShared); };
  }, [sessionScope]);
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

function MessageDocumentCard({ id }: { id: string }) {
  const { data, error } = useDocumentCard(id);
  if (error && data === undefined) {
    return (
      <div className="mt-1.5 text-[12px]" style={{ color: 'var(--on-surface-variant)' }}>Couldn&apos;t load this document.</div>
    );
  }
  return <DocumentCard card={data} />;
}

/**
 * The documents a message carries, each as this viewer's card. For the
 * poster, right after posting, `promptIds` names the documents to show the
 * posting prompt under (PostingPrompt decides whether it shows).
 */
export function MessageDocuments({
  metadata, spaceId, spaceName, isDm, promptIds, onPromptClosed,
}: {
  metadata: unknown;
  spaceId: string;
  spaceName: string;
  isDm: boolean;
  promptIds?: readonly string[];
  onPromptClosed?: (documentId: string) => void;
}) {
  const ids = messageDocumentIds(metadata);
  if (ids.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col">
      {ids.map((id) => (
        <div key={id} className="min-w-0">
          <MessageDocumentCard id={id} />
          {promptIds?.includes(id) && (
            <PostingPrompt documentId={id} spaceId={spaceId} spaceName={spaceName} isDm={isDm} onClose={() => onPromptClosed?.(id)} />
          )}
        </div>
      ))}
    </div>
  );
}
