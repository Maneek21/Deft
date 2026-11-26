// The one writer of document content outside live sockets (consult rule C2;
// plan Task F7): agent edits, applied suggestions, restores, imports,
// templates after creation and the move's later fixes all call
// writeDocument. Live editing writes through /collab (collab/server.ts).
//
// It holds a per-document in-process lock and, in one transaction holding the
// document row FOR UPDATE (never a drive, so it can't wait in a cycle with a
// move or a delete, which lock the drive and then the document):
// - re-checks the actor's role at write time: a person and a BYOA agent as
//   themselves, Defty (an actor with `askerId`) as the person who asked; a
//   system actor passes `requiredRole: null` and its reason, and only a
//   system actor may;
// - refuses an agent's `agent_edit` on a drive set to suggestions only
//   (`agent_suggest_only`): agents never hold a /collab connection, so this is
//   where that setting bites;
// - checks `expectedRevision` when given. Every store bumps the revision,
//   and pending live changes are stored first, so any change since the caller
//   read the revision refuses;
// - applies the 2 MB cap the sockets apply: the result must be within
//   docMaxBytes or no larger than before;
// - writes through the live document when it is loaded (everyone connected
//   sees the change after it commits), or from the row otherwise;
// - bumps `documents.revision` and runs the stored listeners before it
//   returns.
import { and, eq } from 'drizzle-orm';
import type * as Y from 'yjs';
import { drives } from '@deft/db/documents';
import { CollabWriteRefused, getCollabServer, type CollabActor } from '../collab/server.js';
import { documentRoleFor, roleAtLeast, type DocRole } from './document-access.js';

export type DocumentWriteReason = 'agent_edit' | 'suggestion' | 'restore' | 'import' | 'template' | 'move_fix';
export type DocumentWriteRefusalCode = 'FORBIDDEN' | 'REVISION_CHANGED' | 'TOO_LARGE';

const REFUSAL_MESSAGES: Record<DocumentWriteRefusalCode, string> = {
  FORBIDDEN: 'Not allowed to change this document',
  REVISION_CHANGED: 'The document changed since it was read',
  TOO_LARGE: 'The document would be too large',
};

export class DocumentWriteRefused extends Error {
  constructor(readonly code: DocumentWriteRefusalCode) {
    super(REFUSAL_MESSAGES[code]);
  }
}

export async function writeDocument(i: {
  orgId: string;
  documentId: string;
  actor: CollabActor;
  expectedRevision?: number;
  /** Default `edit`; a system actor passes null, with its reason. */
  requiredRole?: DocRole | null;
  mutate: (doc: Y.Doc) => void;
  reason: DocumentWriteReason;
}): Promise<{ revision: number; sizeBytes: number }> {
  const requiredRole = i.requiredRole === undefined ? 'edit' : i.requiredRole;
  if (requiredRole === null && i.actor.kind !== 'system') throw new DocumentWriteRefused('FORBIDDEN');
  const checkedAs = i.actor.askerId ?? i.actor.userId;
  try {
    const { revision, sizeBytes } = await getCollabServer().write({
      documentId: i.documentId,
      orgId: i.orgId,
      actor: i.actor,
      mutate: (doc) => { i.mutate(doc); },
      check: async (tx, row) => {
        if (requiredRole !== null && !roleAtLeast(await documentRoleFor(checkedAs, i.orgId, i.documentId, tx), requiredRole)) {
          throw new DocumentWriteRefused('FORBIDDEN');
        }
        if (i.actor.kind === 'agent' && i.reason === 'agent_edit') {
          const [drive] = await tx.select({ suggestOnly: drives.agent_suggest_only }).from(drives)
            .where(and(eq(drives.id, row.driveId), eq(drives.org_id, i.orgId))).limit(1);
          if (!drive || drive.suggestOnly) throw new DocumentWriteRefused('FORBIDDEN');
        }
        if (i.expectedRevision !== undefined && row.revision !== i.expectedRevision) throw new DocumentWriteRefused('REVISION_CHANGED');
      },
    });
    return { revision, sizeBytes };
  } catch (error) {
    if (error instanceof CollabWriteRefused) throw new DocumentWriteRefused(error.reason === 'too_large' ? 'TOO_LARGE' : 'FORBIDDEN');
    throw error;
  }
}
