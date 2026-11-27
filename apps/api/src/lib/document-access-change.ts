// One access-loss path (consult rule C3). Every change that can lower
// someone's access to a drive or a document calls `applyAccessLossInTx(tx,
// change)` inside its own transaction, after the change itself, and
// `finishAccessLoss(change, result)` after the commit:
// - drive member removed or lowered; drive link removed; a drive's
//   default_role lowered; drive deleted (routes/drives.ts); a personal drive
//   frozen on departure, or handed on (lib/drives.ts, F6);
// - share removed or lowered (F9); document moved or deleted (F5);
// - chat member removed (routes/spaces.ts removeSpaceMember; archiving a chat
//   too, although an archived chat keeps granting its members, rule C7);
// - workspace access ended (lib/drives.ts endDriveAccessOnDepartureInTx,
//   from routes/members.ts endWorkspaceAccess: removal, deactivation, invite
//   revocation; and from deleting an agent employee), the change to guest,
//   and an admin demoted to member;
// - an agent employee paused (routes/agent-employees.ts, and the MCP
//   agent_employee_update_state tool): its user holds nothing while paused.
//
// Inside the transaction the registered hooks run (`onAccessLossInTx`): M6
// cancels the suggestions whose asker lost edit. They see the change, and
// what they do commits or rolls back with it. They return the ids of the
// agent actions they cancelled.
//
// Before the commit, applyAccessLossInTx also opens a barrier for the
// change's scope (accessLossBarrierCovers): while it is open, live editing
// re-reads the role of every frame it covers, so the moment between the
// commit and the generation moving is fenced too (F7).
//
// After the commit, `finishAccessLoss`:
// - bumps the in-process access generation, which live connections compare
//   before applying an update (F7): a connection that cached its role at an
//   older generation re-checks it first. It moves only after the commit, so
//   that re-check sees the change; then it closes the barrier;
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
 * Only finishAccessLoss closes a barrier. One whose finish never comes (the
 * transaction rolled back, or the caller failed after it) is retired after
 * this long, as a safety net: the generation is bumped first, so every live
 * connection reads its role again once, and then the barrier goes. Callers
 * may await other work between the commit and finishAccessLoss
 * (routes/spaces.ts, routes/members.ts), so this is far longer than that.
 * Until then an open barrier costs only extra role reads.
 */
export const ACCESS_LOSS_BARRIER_TIMEOUT_MS = 10 * 60_000;

/**
 * The access-loss barrier (F7, rule C3). The database commits a change before
 * finishAccessLoss moves the generation, so for a moment a cached role is
 * stale while the generation says nothing changed. applyAccessLossInTx opens
 * a barrier for the change's scope before its transaction commits, and
 * finishAccessLoss closes it after publishing the generation. While a barrier
 * covers a document and a person, live editing reads that person's role from
 * the database on every frame (accessLossBarrierCovers).
 */
type Barrier = { orgId: string; documentIds: Set<string> | null; userIds: Set<string> | null; timer: NodeJS.Timeout };

const barriers = new Set<Barrier>();
const barrierOf = new WeakMap<object, Barrier>();

function openBarrier(change: DocumentAccessChange): Barrier {
  const barrier: Barrier = {
    orgId: change.orgId,
    documentIds: change.documentIds ? new Set(change.documentIds) : null,
    userIds: change.userIds ? new Set(change.userIds) : null,
    timer: setTimeout(() => {
      generation += 1;
      barriers.delete(barrier);
    }, ACCESS_LOSS_BARRIER_TIMEOUT_MS),
  };
  barrier.timer.unref();
  barriers.add(barrier);
  return barrier;
}

function closeBarrier(barrier: Barrier | undefined): void {
  if (!barrier) return;
  clearTimeout(barrier.timer);
  barriers.delete(barrier);
}

/**
 * True while an access loss that can reach `userId` on the document
 * `documentId` of `orgId` is between its commit and its finish (or, after a
 * rollback, its timeout). A change naming documents covers only those; one
 * naming people covers only them; a drive, chat or workspace change with
 * neither covers every document of the workspace.
 */
export function accessLossBarrierCovers(orgId: string, documentId: string, userId: string): boolean {
  for (const barrier of barriers) {
    if (barrier.orgId !== orgId) continue;
    if (barrier.documentIds && !barrier.documentIds.has(documentId)) continue;
    if (barrier.userIds && !barrier.userIds.has(userId)) continue;
    return true;
  }
  return false;
}

/**
 * The modules whose hooks register when they load (M6's suggestions,
 * lib/document-suggestions.ts), loaded before the first loss runs the hooks,
 * so every process that applies a loss has them, whatever it imported. A
 * dynamic import: they import this module.
 */
let hookModules: Promise<unknown> | null = null;
function loadHookModules(): Promise<unknown> {
  hookModules ??= import('./document-suggestions.js').catch((error) => {
    hookModules = null;
    throw error;
  });
  return hookModules;
}

/**
 * Runs every registered hook in the caller's transaction, after the change.
 * A hook that throws fails the transaction, so the change and what the hook
 * would have cancelled never part. Opens the change's barrier first (before
 * the commit); finishAccessLoss with the returned result closes it.
 */
export async function applyAccessLossInTx(tx: Tx, change: DocumentAccessChange): Promise<{ cancelledActionIds: string[] }> {
  await loadHookModules();
  const barrier = openBarrier(change);
  const cancelled = new Set<string>();
  for (const hook of hooks) {
    for (const id of await hook(tx, change)) cancelled.add(id);
  }
  const result = { cancelledActionIds: [...cancelled] };
  barrierOf.set(result, barrier);
  return result;
}

/** applyAccessLossInTx, keeping the change with its result for finishAccessLoss after the commit. */
export async function accessLossInTx(tx: Tx, change: DocumentAccessChange): Promise<PendingAccessLoss> {
  return { change, result: await applyAccessLossInTx(tx, change) };
}

/**
 * After the commit: bumps the access generation, emits the change, closes the
 * barrier applyAccessLossInTx opened for `r`, and finishes the cancellations.
 * Never throws.
 */
export async function finishAccessLoss(change: DocumentAccessChange, r: { cancelledActionIds: string[] }): Promise<void> {
  generation += 1;
  emitDocumentAccessChanged(change);
  closeBarrier(barrierOf.get(r));
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
