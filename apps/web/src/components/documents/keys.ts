// SWR keys for documents in chat (plan Task F13). Every answer here depends
// on who is asking, so every key carries the signed-in session's cache scope
// (lib/session-cache.ts: workspace, user, session and sign-in epoch). A
// different person signed in to the same tab reads under another key, and
// never sees what was cached for the one before (rule C4). No scope, no key:
// nothing is fetched or shown while nobody is signed in.

import { mutate as swrMutate } from 'swr';
import { unstable_serialize } from 'swr/infinite';
import { api } from '@/lib/api';
import { sessionSWRKey, sessionSWRPath, sessionSWRScope } from '@/lib/session-cache';

export type SessionScope = string | null | undefined;

const enc = encodeURIComponent;

/** The path the card batcher answers; a card's key names one document under it. */
export const CARDS_PATH = '/api/documents/cards';

export const cardKey = (scope: SessionScope, documentId: string) => sessionSWRKey(scope ?? null, `${CARDS_PATH}#${enc(documentId)}`);

/** True for a card key of `scope`. */
export function isCardKeyOf(key: unknown, scope: SessionScope): boolean {
  if (!scope || typeof key !== 'string' || sessionSWRScope(key) !== scope) return false;
  return sessionSWRPath(key).startsWith(`${CARDS_PATH}#`);
}

export const audienceKey = (scope: SessionScope, documentId: string, spaceId: string) =>
  sessionSWRKey(scope ?? null, `/api/documents/${enc(documentId)}/audience?space_id=${enc(spaceId)}`);

/** A page of a chat's Docs tab: the first without a cursor, each later one after the cursor the page before gave. */
export const spaceDocumentsPageKey = (scope: SessionScope, spaceId: string, cursor: string | null) =>
  sessionSWRKey(scope ?? null, `/api/spaces/${enc(spaceId)}/documents${cursor ? `?cursor=${enc(cursor)}` : ''}`);

/** useSWRInfinite's key function for a chat's Docs tab. */
export function spaceDocumentsPages(scope: SessionScope, spaceId: string) {
  return (index: number, previous: { next_cursor: string | null } | null) => {
    if (index === 0) return spaceDocumentsPageKey(scope, spaceId, null);
    return previous?.next_cursor ? spaceDocumentsPageKey(scope, spaceId, previous.next_cursor) : null;
  };
}

/** Re-reads a chat's Docs tab, every page loaded (after a share or a link). */
export function revalidateSpaceDocuments(scope: SessionScope, spaceId: string) {
  return swrMutate(unstable_serialize(spaceDocumentsPages(scope, spaceId)));
}

export const recentDocumentsKey = (scope: SessionScope) => sessionSWRKey(scope ?? null, '/api/documents/recent');
export const drivesKey = (scope: SessionScope) => sessionSWRKey(scope ?? null, '/api/drives');
export const driveTreeKey = (scope: SessionScope, driveId: string) => sessionSWRKey(scope ?? null, `/api/drives/${enc(driveId)}/tree`);

/** The fetcher for a scoped key: GET of the path it names. */
export async function fetchScoped<T>(key: string): Promise<T> {
  const res = await api.get(sessionSWRPath(key));
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json() as Promise<T>;
}
