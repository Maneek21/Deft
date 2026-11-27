/**
 * DFX2: when a person loses a room (removed from a space or DM, left it, the
 * space made private without them, or removed from the workspace or made a
 * guest of it), their pending assistant actions that came from that room
 * are closed with a recorded reason. Owners and admins keep the rows in the
 * action history; DFX1 (lib/module-action-visibility.ts) already hides them
 * from the person.
 *
 * Where it runs:
 * - Inside the transaction that ends the access (routes/spaces.ts,
 *   routes/members.ts), so the loss and the cancellation commit together and
 *   a later restore of the access cannot leave the proposal pending.
 * - A sweep in the attention maintenance job (every 15 minutes) for every
 *   other way a room can be lost, including any added later. It also repairs
 *   the receipts and attention items written after a commit that failed.
 *
 * Approval and loss together. The close locks each action row (SELECT ...
 * FOR UPDATE) and every pending-approval claim updates the same row with
 * `approval_status = 'pending'` in its WHERE, so one of them waits for the
 * other and then re-checks the row: exactly one wins. If the claim locked
 * the row first, the approval commits before the loss does (it was made
 * while the person had the room) and the close skips it. If the close locked
 * it first, the claim finds the row expired. Once the loss has committed, a
 * claim that starts later also fails on `requesterKeepsSourceRoomsSql`, which
 * the claims carry for paths no hook covers.
 *
 * An agent's document edit suggestion (`edit_document`, M6) closes with its
 * action: it is marked cancelled in the same transaction
 * (syncSuggestionWithAction, lib/document-suggestions.ts).
 */
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { actionReceipts, agentActions, attentionItems } from '@deft/db/schema';
import { db } from './db.js';
import { actionRequesterIdSql } from './agent-action-requester.js';
import { closedPendingActionParams, finishClosedModuleAction } from './agent-approval-resolver.js';
import { resolveAttentionBySource } from './attention.js';
import { DOCUMENT_EDIT_ACTION, syncSuggestionWithAction } from './document-suggestions.js';
import { DOCUMENT_DRAFT_ACTION, scrubDocumentDraftItems, settledDocumentDraftParamsSql } from './document-draft-params.js';
import { canonicalDeftyActionSql, MODULE_GOVERNED_WRITE_ACTION_NAMES, requesterKeepsSourceRoomsSql } from './module-action-visibility.js';
import { markWorkIntentsExpiredForActions } from './work-intents.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Recorded on the action (`error`) and on its receipt. Names no room. */
export const LOST_ROOM_CANCEL_REASON = 'Cancelled: the person who asked no longer has access to the conversation this came from';
/** Attention items of a closed action resolve with this. */
export const LOST_ROOM_ATTENTION_RESOLUTION = 'source_room_access_lost';

/** Rows closed per transaction; the sweep picks up the rest. */
const BATCH = 500;

/**
 * Governed App Run releases and record-mirror nominations keep their own
 * lifecycle (lib/app-run-approval-adapter.ts); closing only their action row
 * would leave the run out of step. Their writers create rows that name no
 * room today; the resolver pre-checks the requester's rooms before routing
 * them, but their own release is not fenced by it.
 */
const OWN_LIFECYCLE_ACTIONS = ['app_run_invoke', 'app_record_mirror_nominate'];

const lostRoomPendingSql = () => and(
  eq(agentActions.approval_status, 'pending'),
  sql`(${agentActions.agent_employee_id} IS NULL OR ${canonicalDeftyActionSql()} OR ${agentActions.source} = 'defty_capture')`,
  notInArray(agentActions.action, OWN_LIFECYCLE_ACTIONS),
  sql`NOT ${requesterKeepsSourceRoomsSql()}`,
)!;

/**
 * Close, in the caller's transaction, the pending Defty actions of `orgId`
 * (narrowed to `requesterId`'s) whose requester can no longer read a room
 * they came from. Run it after the access change in the same transaction:
 * the rule then sees the change. Returns the closed ids; pass them to
 * `finishLostRoomCancellations` after the commit.
 */
export async function closeLostRoomActionsInTx(tx: Tx, scope: { orgId: string; requesterId?: string; oneBatch?: boolean }): Promise<string[]> {
  // An access change closes every matching row before it commits; only the
  // background sweep stops after one batch.
  const closed: string[] = [];
  for (;;) {
    const batch = await closeOneBatch(tx, scope);
    closed.push(...batch.closed);
    if (scope.oneBatch || batch.seen < BATCH) return closed;
  }
}

async function closeOneBatch(tx: Tx, scope: { orgId: string; requesterId?: string }): Promise<{ seen: number; closed: string[] }> {
  const rows = await tx.select().from(agentActions)
    .where(and(
      eq(agentActions.org_id, scope.orgId),
      lostRoomPendingSql(),
      scope.requesterId ? sql`${actionRequesterIdSql()} = ${scope.requesterId}` : undefined,
    ))
    .orderBy(agentActions.id)
    .limit(BATCH)
    .for('update');
  if (rows.length === 0) return { seen: 0, closed: [] };
  // The work intent reads the raw params, so it closes before they are scrubbed.
  await markWorkIntentsExpiredForActions({
    orgId: scope.orgId,
    actions: rows.map((row) => ({ id: row.id, params: row.params })),
    reason: LOST_ROOM_CANCEL_REASON,
  }, tx);
  const closed: string[] = [];
  for (const row of rows) {
    const scrubbed = closedPendingActionParams(row, LOST_ROOM_ATTENTION_RESOLUTION);
    const [done] = await tx.update(agentActions)
      .set({
        approval_status: 'expired',
        error: LOST_ROOM_CANCEL_REASON,
        updated_at: new Date(),
        ...(scrubbed ? { params: scrubbed, result: null, before_state: null, after_state: null, executed_at: new Date() } : {}),
        // A cancelled document draft keeps no title or Markdown (M7 fix round 1, I3).
        ...(row.action === DOCUMENT_DRAFT_ACTION ? { params: settledDocumentDraftParamsSql() } : {}),
      })
      .where(and(eq(agentActions.id, row.id), eq(agentActions.org_id, row.org_id), eq(agentActions.approval_status, 'pending')))
      .returning({ id: agentActions.id });
    if (!done) continue;
    // A document edit suggestion closes with its action (lib/document-suggestions.ts).
    if (row.action === DOCUMENT_EDIT_ACTION) await syncSuggestionWithAction(tx, row.id, 'cancelled');
    // A cancelled document draft's approval items name nothing, in this commit (M7 fix round 3, I3).
    if (row.action === DOCUMENT_DRAFT_ACTION) await scrubDocumentDraftItems(tx, [row.id]);
    closed.push(done.id);
  }
  return { seen: rows.length, closed };
}

/**
 * After the commit: module receipts and attention items of the closed rows.
 * Idempotent; a failure is logged without content and repaired by the sweep.
 */
export async function finishLostRoomCancellations(orgId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const rows = await db.select().from(agentActions)
      .where(and(eq(agentActions.org_id, orgId), inArray(agentActions.id, [...ids])));
    for (const row of rows) {
      if (await finishClosedModuleAction(row)) continue;
      await resolveAttentionBySource({
        orgId: row.org_id, sourceType: 'agent_action', sourceId: row.id, resolution: LOST_ROOM_ATTENTION_RESOLUTION,
      });
    }
  } catch {
    console.error('[lost-room-actions] finishing closed actions failed; the maintenance sweep will repair it');
  }
}

/**
 * The sweep: close what the access-change hooks did not (bounded per pass),
 * then repair artifacts of rows closed earlier whose finishing failed.
 * Returns the ids closed by this call.
 */
export async function cancelLostRoomActions(scope: { orgId?: string } = {}): Promise<string[]> {
  const orgs = await db.selectDistinct({ org_id: agentActions.org_id }).from(agentActions)
    .where(and(lostRoomPendingSql(), scope.orgId ? eq(agentActions.org_id, scope.orgId) : undefined))
    .limit(100);
  const closed: string[] = [];
  for (const { org_id: orgId } of orgs) {
    const ids = await db.transaction((tx) => closeLostRoomActionsInTx(tx, { orgId, oneBatch: true }));
    await finishLostRoomCancellations(orgId, ids);
    closed.push(...ids);
  }
  await repairLostRoomCancellations(scope.orgId);
  return closed;
}

/**
 * Closed rows whose receipt (module writes) or attention resolution did not
 * land (bounded). Never throws: a failure is logged and the next sweep retries.
 */
export async function repairLostRoomCancellations(orgId?: string): Promise<void> {
  try {
    await repairOnce(orgId);
  } catch {
    console.error('[lost-room-actions] repair of closed actions failed; the maintenance sweep will retry');
  }
}

async function repairOnce(orgId?: string): Promise<void> {
  const closedRow = and(
    eq(agentActions.approval_status, 'expired'),
    eq(agentActions.error, LOST_ROOM_CANCEL_REASON),
    orgId ? eq(agentActions.org_id, orgId) : undefined,
  );
  const missingReceipt = await db.select({ id: agentActions.id, org_id: agentActions.org_id }).from(agentActions)
    .where(and(
      closedRow,
      inArray(agentActions.action, [...MODULE_GOVERNED_WRITE_ACTION_NAMES]),
      sql`NOT EXISTS (SELECT 1 FROM ${actionReceipts} WHERE ${actionReceipts.action_id} = ${agentActions.id})`,
    ))
    .limit(100);
  const openItems = await db.selectDistinct({ id: agentActions.id, org_id: agentActions.org_id }).from(attentionItems)
    .innerJoin(agentActions, and(eq(agentActions.id, attentionItems.source_id), eq(agentActions.org_id, attentionItems.org_id)))
    .where(and(
      closedRow,
      eq(attentionItems.source_type, 'agent_action'),
      inArray(attentionItems.state, ['open_unseen', 'open_seen', 'acknowledged', 'snoozed']),
    ))
    .limit(100);
  const byOrg = new Map<string, Set<string>>();
  for (const row of [...missingReceipt, ...openItems]) {
    let ids = byOrg.get(row.org_id);
    if (!ids) byOrg.set(row.org_id, ids = new Set());
    ids.add(row.id);
  }
  for (const [rowOrg, ids] of byOrg) await finishLostRoomCancellations(rowOrg, [...ids]);
}
