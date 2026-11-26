// Who may open a document over /collab (plan Task F7). A connection carries a
// web access token (the same short-lived token REST uses) and names one
// document, `doc:<documentId>`. The person needs an active session, an active
// membership of the session's workspace and a role on the document
// (documentRoleFor, lib/document-access.ts). View and comment connect
// read-only. A missing or deleted document is refused like a forbidden one,
// so the refusal never says whether the document exists.
import type { DocRole } from '../lib/document-access.js';
import { documentRoleFor, roleAtLeast } from '../lib/document-access.js';
import { requireActiveOrgMembership } from '../lib/org-membership.js';
import { verifyWebAccess } from '../lib/web-sessions.js';
import type { CollabCloseCode } from './limits.js';

export type CollabContext = { orgId: string; userId: string; sid: string; tokenExpiresAt: number; role: DocRole; readOnly: boolean };

/**
 * A /collab refusal: the connection closes with COLLAB_CLOSE[code]. It has no
 * message, so Hocuspocus, which logs hook errors that carry one, logs nothing.
 */
export class CollabRefusal extends Error {
  constructor(readonly code: CollabCloseCode) {
    super();
  }
}

const DOCUMENT_NAME = /^doc:([A-Za-z0-9_-]{1,200})$/;

/** The document id in a /collab document name, or null when the name isn't `doc:<id>`. */
export function documentIdOf(documentName: string): string | null {
  return DOCUMENT_NAME.exec(documentName)?.[1] ?? null;
}

/** True when `role` may change the document over /collab. */
export function canWrite(role: DocRole): boolean {
  return roleAtLeast(role, 'edit');
}

/**
 * The caller's context for `documentName`, or a CollabRefusal: `notFound` for
 * a name that isn't `doc:<id>`, `unauthenticated` for a token or session that
 * doesn't verify (or a membership that has ended), `forbidden` with no role.
 */
export async function authenticateCollab(i: { token: string; documentName: string }): Promise<CollabContext> {
  const documentId = documentIdOf(i.documentName);
  if (!documentId) throw new CollabRefusal('notFound');
  let payload: Awaited<ReturnType<typeof verifyWebAccess>>;
  try {
    payload = await verifyWebAccess(i.token);
    await requireActiveOrgMembership(payload.org_id, payload.id);
  } catch {
    throw new CollabRefusal('unauthenticated');
  }
  const role = await documentRoleFor(payload.id, payload.org_id, documentId);
  if (!role) throw new CollabRefusal('forbidden');
  return {
    orgId: payload.org_id,
    userId: payload.id,
    sid: payload.sid,
    tokenExpiresAt: payload.exp * 1000,
    role,
    readOnly: !canWrite(role),
  };
}
