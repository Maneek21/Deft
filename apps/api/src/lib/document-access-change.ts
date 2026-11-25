// One access-loss path (consult rule C3). Every change that can lower
// someone's access to a drive or a document calls `applyAccessLossInTx(tx,
// change)` inside its own transaction, after the change itself, and
// `finishAccessLoss(change, result)` after the commit:
// - drive member removed or lowered; drive link removed; a drive's
//   default_role lowered; drive deleted (routes/drives.ts), or frozen (F6);
// - share removed or lowered (F9); document moved or deleted (F5);
// - chat member removed (routes/spaces.ts removeSpaceMember; archiving a chat
//   too, although an archived chat keeps granting its members, rule C7);
// - workspace access ended (routes/members.ts endWorkspaceAccess: removal,
//   deactivation, invite revocation), the change to guest, and an admin
//   demoted to member.
//
// Inside the transaction the registered hooks run (`onAccessLossInTx`): M6
// cancels the suggestions whose asker lost edit. They see the change, and
// what they do commits or rolls back with it. They return the ids of the
// agent actions they cancelled.
//
// After the commit, `finishAccessLoss`:
// - bumps the in-process access generation, which live connections compare
//   before applying an update (F7): a connection that cached its role at an
//   older generation re-checks it first. It moves only after the commit, so
//   that re-check sees the change;
// - emits the change (`emitDocumentAccessChanged`), so live connections
//   close or turn read-only, and listeners for lifecycle events act;
// - finishes the cancelled actions: their attention items resolve.
// It never throws: the change has committed by then.
import { db } from './db.js';
import { resolveAttentionBySource } from './attention.js';
import { emitDocumentAccessChanged, type DocumentAccessChange } from './document-access-events.js';

export type { DocumentAccessChange };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A loss applied inside a transaction, to finish after its commit. */
export type PendingAccessLoss = { change: DocumentAccessChange; result: { cancelledActionIds: string[] } };

/** Attention items of actions cancelled because their asker lost access resolve with this. */
export const DOCUMENT_ACCESS_LOST_RESOLUTION = 'document_access_lost';

type AccessLossHook = (tx: Tx, c: DocumentAccessChange) => Promise<string[]>;

const hooks: AccessLossHook[] = [];
let generation = 0;

/**
 * Runs every registered hook in the caller's transaction, after the change.
 * A hook that throws fails the transaction, so the change and what the hook
 * would have cancelled never part.
 */
export async function applyAccessLossInTx(tx: Tx, change: DocumentAccessChange): Promise<{ cancelledActionIds: string[] }> {
  const cancelled = new Set<string>();
  for (const hook of hooks) {
    for (const id of await hook(tx, change)) cancelled.add(id);
  }
  return { cancelledActionIds: [...cancelled] };
}

/** After the commit: bumps the access generation, emits the change and finishes the cancellations. Never throws. */
export async function finishAccessLoss(change: DocumentAccessChange, r: { cancelledActionIds: string[] }): Promise<void> {
  generation += 1;
  emitDocumentAccessChanged(change);
  for (const actionId of r.cancelledActionIds) {
    try {
      await resolveAttentionBySource({
        orgId: change.orgId, sourceType: 'agent_action', sourceId: actionId, resolution: DOCUMENT_ACCESS_LOST_RESOLUTION,
      });
    } catch {
      console.error('[document-access-change] resolving a cancelled action\'s attention items failed');
    }
  }
}

/** The in-process access generation: it moves after every committed access loss. */
export function currentAccessGeneration(): number {
  return generation;
}

/** Registers a hook that runs inside every access loss's transaction (M6: suggestion cancellation). */
export function onAccessLossInTx(hook: (tx: Tx, c: DocumentAccessChange) => Promise<string[]>): void {
  hooks.push(hook);
}
