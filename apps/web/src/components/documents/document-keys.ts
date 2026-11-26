// SWR keys for the document page (plan Task F12). Everything here depends on
// who is asking, so every key carries the signed-in session's cache scope
// (lib/session-cache.ts: workspace, user, session and sign-in epoch): someone
// else signed in to the same tab reads under other keys and never sees what
// was cached for the person before (rule C4). No scope, no key: nothing is
// fetched while nobody is signed in.

import { api } from '@/lib/api';
import { HttpError } from '@/lib/drive-actions';
import { sessionSWRKey, sessionSWRPath } from '@/lib/session-cache';

export type SessionScope = string | null | undefined;

const enc = encodeURIComponent;
const scoped = (scope: SessionScope, path: string) => sessionSWRKey(scope ?? null, path);

export const documentKey = (scope: SessionScope, documentId: string) => scoped(scope, `/api/documents/${enc(documentId)}`);
/** The document with its stored JSON, for the read-only copy while live editing can't be used. */
export const documentContentKey = (scope: SessionScope, documentId: string) => scoped(scope, `/api/documents/${enc(documentId)}?content=1`);
export const documentSharesKey = (scope: SessionScope, documentId: string) => scoped(scope, `/api/documents/${enc(documentId)}/shares`);
export const documentVersionKey = (scope: SessionScope, documentId: string, versionId: string) =>
  scoped(scope, `/api/documents/${enc(documentId)}/versions/${enc(versionId)}`);
export const membersKey = (scope: SessionScope) => scoped(scope, '/api/members');
export const spacesKey = (scope: SessionScope) => scoped(scope, '/api/spaces');
export const drivesListKey = (scope: SessionScope) => scoped(scope, '/api/drives');
export const driveTreeListKey = (scope: SessionScope, driveId: string) => scoped(scope, `/api/drives/${enc(driveId)}/tree`);

/** useSWRInfinite's key function for the version list: newest first, each page after the last one's `next_before`. */
export function documentVersionPages(scope: SessionScope, documentId: string) {
  return (index: number, previous: { next_before: string | null } | null) => {
    if (index > 0 && !previous?.next_before) return null;
    const before = index === 0 ? '' : `?before=${enc(previous!.next_before!)}`;
    return scoped(scope, `/api/documents/${enc(documentId)}/versions${before}`);
  };
}

/** The fetcher for a scoped key: GET of the path it names. A refusal throws HttpError with its status. */
export async function fetchScopedJson<T>(key: string): Promise<T> {
  const res = await api.get(sessionSWRPath(key));
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: unknown } | null;
    throw new HttpError(res.status, typeof body?.error === 'string' && body.error.trim() ? body.error : `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

/** A refusal's message and code, or a plain message for a transport failure. */
export type Refusal = { status: number | null; code: string | null; message: string };

/** Sends a write and answers its body, or the refusal with its code. Never throws. */
export async function sendWrite<T = unknown>(request: () => Promise<Response>, fallback: string): Promise<{ ok: true; body: T } | { ok: false; refusal: Refusal }> {
  try {
    const res = await request();
    const body = await res.json().catch(() => null) as (T & { error?: unknown; code?: unknown }) | null;
    if (res.ok) return { ok: true, body: (body ?? {}) as T };
    const message = typeof body?.error === 'string' && body.error.trim() ? body.error : fallback;
    return { ok: false, refusal: { status: res.status, code: typeof body?.code === 'string' ? body.code : null, message } };
  } catch {
    return { ok: false, refusal: { status: null, code: null, message: 'Could not reach the server. Check your connection and try again.' } };
  }
}
