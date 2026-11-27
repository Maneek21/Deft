// Agent edit suggestions (spec 5.7; plan Task M6, with the 25 Nov consult's
// changes): an agent's edit to a document that waits for the person who
// asked, who reviews it block by block, applies some or all of it, or
// rejects it. Where an edit lands is M5's (lib/document-edit-landing.ts);
// M7 wires the tools, and calls proposeDocumentEdit in the transaction that
// stores the `edit_document` action.
//
// A suggestion (document_suggestions, upgrade .156) belongs to one pending
// `edit_document` agent action. It keeps the document's content when it was
// proposed (base_json, read live: pending live edits included, never the
// lagging content_json) and its revision (base_revision), the operations
// (M4's DocumentEditOp), the content they give (proposed_json, with the new
// blocks' ids seeded by the action id, as the edit engine seeds them) and
// the top-level blocks they change. The action's params name the
// suggestion (`suggestion_id`) and never carry document text (rule C4).
//
// Who sees what (the 13 Nov rule and the consult): only the asker reviews,
// applies or rejects, with no owner or admin fallback; anyone else who can
// open the document gets 403 NOT_REQUESTER, anyone who can't a 404. The list
// shows everyone who can view the document how many suggestions wait and for
// whom: { pending, asker_name }, the name through the people-visibility
// rules ("A collaborator" for someone hidden from the viewer). base_json and
// proposed_json are read only for the asker, by reviewSuggestion; no audit
// or log line carries them.
//
// Conflicts: a changed block conflicts when its hash in the current document
// differs from its hash in base_json (a block the edit adds never does). The
// asker may apply a conflicted block anyway: they chose, and it replaces
// what is there now. Applying uses the reviewed result block by block, never
// the operations replayed (fix round 2): a chosen block the proposal has
// replaces the current one, or, when someone has deleted it since, goes back
// after its previous sibling in the proposal (M4's undo placement, the end
// when that neighbour isn't there or coming); a chosen block the proposal
// deletes is deleted, or counts as applied when it is already gone.
//
// Applying, from the document (POST /api/documents/:id/suggestions/:sid/apply
// { block_ids, revision }) or from the chat card, the Inbox or MCP, goes
// through the approval resolver's approveAction (lib/agent-approval-
// resolver.ts) as the asker. It holds the action's approval lease for the
// whole approval and, under it, after the reviewer rule and the source
// rooms, prepareSuggestionForApproval makes one atomic claim: pending to
// 'applying' with the blocks chosen (every block, from the card) and the
// revision they were reviewed at (the suggestion's own, from the card), only
// while the document is still at it. The claim carries a new claim token,
// and every later write by that request (putting the claim back, the
// executor's outcome, a failure's cancellation) matches it, so a request
// whose claim was taken over, or whose lease was lost, changes nothing (409
// SUGGESTION_ALREADY_RESOLVING). Only the lease holder claims: the claim is
// written on the lease's own connection, the session holding the lock, so it
// commits only while that lock is held (fix round 3). A request that loses
// the race waits for the lease (at most 10 s on the apply path) and then
// finds the action decided. A claim is taken over only once it is older than
// two minutes with its action still pending, and only by a request holding
// the lease. A moved document is 409 REVISION_CHANGED from the review, or
// REVIEW_IN_DOCUMENT from the card, which sends the asker to the review. A
// claim whose approval stops short goes back to pending before the lease is
// released.
//
// The executor (executeDocumentEditAction, the `edit_document` case of
// executeAction; moved here from M7) applies the claimed blocks with M4's
// engine (applyDocumentEditDirect with only the selected blocks), so the
// result is a direct edit of those blocks: the same `agent` version and
// credit, highlight, audit and undo. It writes through writeDocument with
// expectedRevision = reviewed_revision (rule C2) and reason 'suggestion',
// which a suggest-only drive allows. Before writing it checks again that the
// asker can still edit the document and, for an action from a chat, still
// keeps that chat (requesterKeepsSourceRoomsSql). The outcome commits with
// the content: 'accepted' when every changed block was applied, otherwise
// 'partially_accepted'. A document that moved on between the check and the
// write (REVISION_CHANGED), a busy live server (BUSY) or a claim that no
// longer carries this approval's token leaves the action pending again (the
// resolver reopens it, and puts back only a claim of its own); any other
// failure closes the suggestion ('cancelled') with the approval's error.
//
// Every terminal path calls syncSuggestionWithAction in its own transaction:
// approval (the executor), rejection (rejectAction), the 14-day expiry
// (expireStaleSuggestions), the room rule (lost-room-action-cancellation.ts)
// and access loss (cancelLostDocumentSuggestionsInTx, registered with
// onAccessLossInTx, so it runs in every access-loss transaction: chat member
// removed, workspace access ended, shares and drive members removed or
// lowered, documents moved or deleted). The 24-hour approval TTL
// (lib/attention-maintenance.ts) leaves `edit_document` actions alone.
//
// The daily job (workers/handlers/document-suggestion-expiry.ts) expires
// suggestions pending for 14 days: the action is closed as the room rule
// closes actions, and a `named` version note "Defty's suggestion from {date}
// expired without review" ({date} as d MMM yyyy, UTC) records it without
// changing the content. It also sweeps suggestions whose asker lost edit by a
// path no hook covers, and puts back in step a suggestion whose action ended
// some other way.
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, lte, sql, type SQL } from 'drizzle-orm';
import * as Y from 'yjs';
import { agentActions, agentEmployees, users } from '@deft/db/schema';
import { documents, documentSuggestions, documentVersions, type DocumentSuggestionStatus } from '@deft/db/documents';
import { blockHash, topLevelBlocks } from '@deft/doc-schema';
import { deriveContent, type JSONContent } from '../collab/persistence.js';
import { readCurrentDocument } from '../collab/server.js';
import { resolveAttentionBySource } from './attention.js';
import { db, writeUnderDbAdvisoryLease, type DbAdvisoryLease } from './db.js';
import { DEFTY_EMAIL } from './defty-identity.js';
import { documentRoleFor, roleAtLeast } from './document-access.js';
import { DOCUMENT_ACCESS_LOST_RESOLUTION, onAccessLossInTx, type DocumentAccessChange } from './document-access-change.js';
import { applyDocumentEditDirect, applyOpsToJson, DocumentEditRefused, type DocumentEditOp } from './document-edit.js';
import { createVersionInTx, HIDDEN_PERSON_NAME } from './document-versions.js';
import { DocumentRefusal } from './documents.js';
import { DocumentWriteRefused } from './document-writer.js';
import { requesterKeepsSourceRoomsSql } from './module-action-visibility.js';
import { canSeePerson, peopleViewer, visiblePersonIds } from './people-visibility.js';
import { markWorkIntentsExpiredForActions } from './work-intents.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;
type SuggestionRow = typeof documentSuggestions.$inferSelect;

/** The agent action a suggestion belongs to (M7's tool). */
export const DOCUMENT_EDIT_ACTION = 'edit_document';
/** A suggestion nobody reviews expires after this long. */
export const SUGGESTION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Recorded on an action whose suggestion expired. Names nobody and quotes nothing. */
export const SUGGESTION_EXPIRED_REASON = 'Expired: nobody reviewed this suggestion within 14 days';
/** Recorded on an action cancelled because the person who asked can no longer edit the document. */
export const SUGGESTION_ACCESS_LOST_REASON = 'Cancelled: the person who asked can no longer edit this document';
/**
 * A claim older than this whose approval never started was left by a request
 * that ended: the next approval of the action may take it over, and the daily
 * repair puts it back. Both write on their lease's own connection (fix round
 * 3), so only a writer that really holds the lease takes a claim over; age
 * alone never lets a request that lost its lease overwrite the holder's claim.
 */
const STALE_CLAIM_MS = 2 * 60 * 1000;
/** How long an apply from the document review waits for the action's approval lease. */
let applyLeaseWaitMs = 10_000;
export function suggestionApplyLeaseWaitMs(): number { return applyLeaseWaitMs; }
/** Test seam: the apply path's lease deadline. */
export function _setSuggestionApplyLeaseWaitForTest(ms: number): void { applyLeaseWaitMs = ms; }
/** Test seam: awaited inside preparation, after the lease check and just before the claim's write. */
let claimPauseForTest: ((actionId: string) => Promise<void>) | null = null;
export function _setSuggestionClaimPauseForTest(hook: ((actionId: string) => Promise<void>) | null): void { claimPauseForTest = hook; }
/** Rows handled per transaction by the daily passes; the next day takes the rest. */
const BATCH = 500;

const OPEN_STATUSES: DocumentSuggestionStatus[] = ['pending', 'applying'];

// ---------------------------------------------------------------------------
// Refusals (routes/documents.ts answers them with their status and code)

const notFound = () => new DocumentRefusal(404, 'NOT_FOUND', 'Suggestion not found');
const notRequester = () => new DocumentRefusal(403, 'NOT_REQUESTER', NOT_REQUESTER_MESSAGE);
const resolving = () => new DocumentRefusal(409, 'SUGGESTION_ALREADY_RESOLVING', 'This suggestion is already being applied, or has been settled');
const invalidBlocks = () => new DocumentRefusal(400, 'VALIDATION_ERROR', 'Choose changes from this suggestion');

const REVIEW_IN_DOCUMENT_MESSAGE = 'The document changed since this suggestion was made. Review it in the document.';
const REVISION_CHANGED_MESSAGE = 'The document changed since you reviewed this suggestion. Review it again.';
const NOTHING_TO_APPLY_MESSAGE = 'None of the changes you chose can be applied any more. Review the suggestion again.';
const RESOLVING_MESSAGE = 'This suggestion is already being applied, or has been settled';

/** Why approving an edit suggestion stopped before anything changed; the action is still pending. */
export type SuggestionApprovalCode = 'REVIEW_IN_DOCUMENT' | 'REVISION_CHANGED' | 'SUGGESTION_ALREADY_RESOLVING' | 'NOTHING_TO_APPLY' | 'BUSY';
export type SuggestionApprovalRefusal = { code: SuggestionApprovalCode; message: string };

const SUGGESTION_APPROVAL_CODES: ReadonlySet<string> = new Set<SuggestionApprovalCode>([
  'REVIEW_IN_DOCUMENT', 'REVISION_CHANGED', 'SUGGESTION_ALREADY_RESOLVING', 'NOTHING_TO_APPLY', 'BUSY',
]);

/** True for the codes above: the routes answer them with 409 (503 for BUSY). */
export function isSuggestionApprovalCode(code: string): code is SuggestionApprovalCode {
  return SUGGESTION_APPROVAL_CODES.has(code);
}

// ---------------------------------------------------------------------------
// Content

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The document's current content with block ids, as a store derives it (the live state when loaded); null when missing or outside the schema. */
async function currentContent(x: Executor, orgId: string, documentId: string): Promise<JSONContent | null> {
  const state = await readCurrentDocument(documentId, orgId, x);
  if (!state) return null;
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return deriveContent(doc).json;
  } catch {
    return null;
  } finally {
    doc.destroy();
  }
}

/** The top-level blocks of `json` by id. */
function blocksById(json: unknown): Map<string, JSONContent> {
  if (!isRecord(json)) return new Map();
  return new Map(topLevelBlocks(json as JSONContent).map((block) => [block.id, block.node]));
}

/** `ops` when every entry is a well-formed operation (M4's DocumentEditOp), else VALIDATION_ERROR. */
function checkedOps(ops: unknown): DocumentEditOp[] {
  const fail = () => new DocumentRefusal(400, 'VALIDATION_ERROR', 'The edit holds an operation that is not valid');
  if (!Array.isArray(ops) || ops.length === 0) throw fail();
  return ops.map((op): DocumentEditOp => {
    if (!isRecord(op)) throw fail();
    const kind = op.op;
    const blockId = typeof op.block_id === 'string' && op.block_id.length > 0 ? op.block_id : null;
    const markdown = typeof op.markdown === 'string' ? op.markdown : null;
    if (kind === 'append' && markdown !== null) return { op: 'append', markdown };
    if (kind === 'delete' && blockId !== null) return { op: 'delete', block_id: blockId };
    if ((kind === 'replace' || kind === 'insert_after') && blockId !== null && markdown !== null) return { op: kind, block_id: blockId, markdown };
    throw fail();
  });
}

function summaryOf(params: unknown): string {
  return isRecord(params) && typeof params.summary === 'string' ? params.summary.trim() : '';
}

// ---------------------------------------------------------------------------
// Proposing

/**
 * Stores the agent's operations as a suggestion of the pending
 * `edit_document` action `actionId`, in the caller's transaction (M7: the
 * one that stores the action): the current content as the base, at its
 * revision, and the content the operations give. The asker needs edit on the
 * document (M5 refuses an edit for someone who can't make it). An operation
 * naming a block that isn't there refuses the whole suggestion
 * (DocumentEditRefused, BLOCK_NOT_FOUND), as a direct edit does. The action's
 * params gain `suggestion_id`.
 */
export async function proposeDocumentEdit(tx: Tx, i: { orgId: string; documentId: string; actionId: string; askerId: string;
  agentUserId: string; ops: DocumentEditOp[] }): Promise<{ suggestionId: string }> {
  const ops = checkedOps(i.ops);
  const [action] = await tx.select({ action: agentActions.action, status: agentActions.approval_status, params: agentActions.params })
    .from(agentActions).where(and(eq(agentActions.id, i.actionId), eq(agentActions.org_id, i.orgId))).limit(1).for('update');
  if (!action || action.action !== DOCUMENT_EDIT_ACTION || action.status !== 'pending') {
    throw new DocumentRefusal(409, 'INVALID_STATE', 'This edit is not waiting for review');
  }
  const params = isRecord(action.params) ? action.params : {};
  if (params.document_id !== undefined && params.document_id !== i.documentId) {
    throw new DocumentRefusal(400, 'VALIDATION_ERROR', 'The edit names another document');
  }
  const [agent] = await tx.select({ kind: users.kind }).from(users).where(eq(users.id, i.agentUserId)).limit(1);
  if (agent?.kind !== 'agent') throw new DocumentRefusal(400, 'VALIDATION_ERROR', 'Only an agent suggests edits');
  const role = await documentRoleFor(i.askerId, i.orgId, i.documentId, tx);
  if (!role) throw new DocumentRefusal(404, 'NOT_FOUND', 'Document not found');
  if (!roleAtLeast(role, 'edit')) throw new DocumentRefusal(403, 'FORBIDDEN_ROLE', 'Suggesting an edit needs can edit');

  // The revision first: content read after it is at least as new, so a later store only ever sends the asker to review.
  const [doc] = await tx.select({ revision: documents.revision }).from(documents)
    .where(and(eq(documents.id, i.documentId), eq(documents.org_id, i.orgId), eq(documents.is_deleted, false))).limit(1);
  if (!doc) throw new DocumentRefusal(404, 'NOT_FOUND', 'Document not found');
  const base = await currentContent(tx, i.orgId, i.documentId);
  if (!base) throw new DocumentWriteRefused('INVALID_CONTENT');
  const preview = applyOpsToJson(base, ops, { idSeed: i.actionId });
  if (preview.missingBlockIds.length > 0) throw new DocumentEditRefused('BLOCK_NOT_FOUND', preview.missingBlockIds);
  if (preview.changedBlockIds.length === 0) throw new DocumentRefusal(400, 'VALIDATION_ERROR', 'The edit changes nothing');

  const [created] = await tx.insert(documentSuggestions).values({
    org_id: i.orgId,
    document_id: i.documentId,
    action_id: i.actionId,
    asker_user_id: i.askerId,
    agent_user_id: i.agentUserId,
    base_json: base,
    base_revision: doc.revision,
    ops,
    proposed_json: preview.json,
    changed_block_ids: preview.changedBlockIds,
  }).returning({ id: documentSuggestions.id });
  await tx.update(agentActions)
    .set({ params: { ...params, document_id: i.documentId, suggestion_id: created!.id }, updated_at: new Date() })
    .where(and(eq(agentActions.id, i.actionId), eq(agentActions.org_id, i.orgId)));
  return { suggestionId: created!.id };
}

// ---------------------------------------------------------------------------
// Status

/**
 * Settles the suggestion of agent action `actionId` with its action's
 * outcome, in the caller's transaction (every terminal path calls it):
 * 'approved' after the executor applied its blocks ('accepted' when every
 * changed block was applied, else 'partially_accepted'), 'rejected',
 * 'expired' or 'cancelled'. Only an open suggestion changes; approval and
 * rejection are the asker's, so they are recorded as resolved by the asker.
 * The claim token is cleared.
 *
 * `claimToken`: a write by the request that claimed the suggestion (its
 * approval, or that approval failing) changes it only while it still carries
 * that token (fix round 2, I1); a request whose claim was taken over changes
 * nothing. The other terminal paths (rejection, expiry, the room rule, lost
 * access, recovery of an interrupted approval) are decisions about the
 * action itself and settle the suggestion whoever holds the claim.
 */
export async function syncSuggestionWithAction(tx: Tx, actionId: string, status: 'approved' | 'rejected' | 'expired' | 'cancelled',
  claimToken?: string): Promise<void> {
  const now = new Date();
  const owned = claimToken === undefined ? undefined : eq(documentSuggestions.claim_token, claimToken);
  if (status === 'approved') {
    await tx.update(documentSuggestions).set({
      status: sql<DocumentSuggestionStatus>`CASE WHEN ${documentSuggestions.applied_block_ids} @> ${documentSuggestions.changed_block_ids}
        THEN 'accepted' ELSE 'partially_accepted' END`,
      claim_token: null,
      resolved_at: now,
      resolved_by: sql<string>`${documentSuggestions.asker_user_id}`,
      updated_at: now,
    }).where(and(eq(documentSuggestions.action_id, actionId), eq(documentSuggestions.status, 'applying'), owned));
    return;
  }
  await tx.update(documentSuggestions).set({
    status,
    claim_token: null,
    resolved_at: now,
    resolved_by: status === 'rejected' ? sql<string>`${documentSuggestions.asker_user_id}` : null,
    updated_at: now,
  }).where(and(eq(documentSuggestions.action_id, actionId), inArray(documentSuggestions.status, OPEN_STATUSES), owned));
}

/**
 * The claim `claimToken` back to pending, its choice and token dropped, while
 * its action is still pending (its approval never started): only the
 * request that made the claim does this, with its own token (fix round 2,
 * I1). A claim another request has since taken over is left alone.
 */
export async function releaseSuggestionClaimInTx(x: Executor, actionId: string, claimToken: string): Promise<void> {
  await x.execute(sql`UPDATE document_suggestions claimed
    SET status = 'pending', claim_token = NULL, selected_block_ids = NULL, reviewed_revision = NULL, updated_at = now()
    WHERE claimed.action_id = ${actionId} AND claimed.status = 'applying' AND claimed.claim_token = ${claimToken}
      AND EXISTS (SELECT 1 FROM agent_actions claim_action
        WHERE claim_action.id = claimed.action_id AND claim_action.org_id = claimed.org_id AND claim_action.approval_status = 'pending')`);
}

/**
 * A claim left by a request that ended (older than STALE_CLAIM_MS, its
 * action still pending) back to pending: the daily repair, on the action's
 * approval lease's own connection (writeUnderDbAdvisoryLease, fix round 3).
 */
async function releaseStaleClaimInTx(x: Executor, actionId: string): Promise<void> {
  await x.execute(sql`UPDATE document_suggestions stale
    SET status = 'pending', claim_token = NULL, selected_block_ids = NULL, reviewed_revision = NULL, updated_at = now()
    WHERE stale.action_id = ${actionId} AND stale.status = 'applying'
      AND stale.updated_at < now() - (${STALE_CLAIM_MS} * interval '1 millisecond')
      AND EXISTS (SELECT 1 FROM agent_actions stale_action
        WHERE stale_action.id = stale.action_id AND stale_action.org_id = stale.org_id AND stale_action.approval_status = 'pending')`);
}

/**
 * What the asker chose in the document review (applySuggestion): the blocks
 * (each one the suggestion changes, in its order) and the revision the review
 * was read at, or the suggestion's own when the apply named none
 * (`fromReview` false).
 */
export type SuggestionClaim = { selectedBlockIds: string[]; reviewedRevision: number; fromReview: boolean };

/** prepareSuggestionForApproval's answer: this request's claim token, or why it has none (no refusal: no suggestion). */
export type SuggestionClaimResult = { claimToken: string | null; refusal?: undefined } | { claimToken: null; refusal: SuggestionApprovalRefusal };

/**
 * Claims an `edit_document` action's suggestion for this approval, with a
 * new claim token that every later write by this request must match
 * (releaseSuggestionClaimInTx, syncSuggestionWithAction, the executor). The
 * approval resolver runs it under the action's approval `lease`, after the
 * reviewer rule and as late as it can before claiming the action (fix rounds
 * 1 and 2, I1). The claim is written on the lease's own connection
 * (writeUnderDbAdvisoryLease, fix round 3), so it commits only while this
 * request really holds the lease: a request that loses the race, or loses
 * its lease at any point before the write commits, never changes the row
 * and gets SUGGESTION_ALREADY_RESOLVING.
 *
 * With `request` (the document review) the claim takes the asker's blocks
 * and the revision they reviewed; without (the chat card, the Inbox, MCP) it
 * takes every block at the revision the suggestion was made on, which is
 * what the card showed. One statement claims it only while it is pending, or
 * holds a claim left by a request that ended (older than STALE_CLAIM_MS, its
 * action still pending), and only while the document is still at that
 * revision. Otherwise nothing changes and the answer is REVISION_CHANGED (the
 * review) or REVIEW_IN_DOCUMENT (the card), or SUGGESTION_ALREADY_RESOLVING
 * while another request holds a live claim or once it is settled. An action
 * with no suggestion goes on unclaimed, and the executor answers it.
 */
export async function prepareSuggestionForApproval(orgId: string, actionId: string, request: SuggestionClaim | null,
  lease: DbAdvisoryLease): Promise<SuggestionClaimResult> {
  const [s] = await db.select({
    id: documentSuggestions.id, changed: documentSuggestions.changed_block_ids, baseRevision: documentSuggestions.base_revision,
  }).from(documentSuggestions).where(and(eq(documentSuggestions.action_id, actionId), eq(documentSuggestions.org_id, orgId))).limit(1);
  if (!s) return { claimToken: null };
  const selected = request ? s.changed.filter((id) => request.selectedBlockIds.includes(id)) : s.changed;
  if (request && (selected.length === 0 || selected.length !== new Set(request.selectedBlockIds).size)) {
    return { claimToken: null, refusal: { code: 'NOTHING_TO_APPLY', message: NOTHING_TO_APPLY_MESSAGE } };
  }
  const revision = request ? request.reviewedRevision : s.baseRevision;
  const claimToken = randomUUID();
  if (claimPauseForTest) await claimPauseForTest(actionId);
  // Written on the lease's own connection (fix round 3): it commits only while
  // this request's session, and so its lock, is alive. A request whose lease
  // was lost at any point before the commit claims nothing, whatever it checked earlier.
  const written = await writeUnderDbAdvisoryLease(lease, (tx) => tx.update(documentSuggestions)
    .set({ status: 'applying', claim_token: claimToken, selected_block_ids: selected, reviewed_revision: revision, updated_at: new Date() })
    .where(and(
      eq(documentSuggestions.id, s.id),
      sql`(${documentSuggestions.status} = 'pending' OR (${documentSuggestions.status} = 'applying'
        AND ${documentSuggestions.updated_at} < now() - (${STALE_CLAIM_MS} * interval '1 millisecond')
        AND EXISTS (SELECT 1 FROM ${agentActions} WHERE ${agentActions.id} = ${documentSuggestions.action_id}
          AND ${agentActions.org_id} = ${documentSuggestions.org_id} AND ${agentActions.approval_status} = 'pending')))`,
      sql`EXISTS (SELECT 1 FROM ${documents} WHERE ${documents.org_id} = ${documentSuggestions.org_id}
        AND ${documents.id} = ${documentSuggestions.document_id} AND NOT ${documents.is_deleted} AND ${documents.revision} = ${revision})`,
    ))
    .returning({ id: documentSuggestions.id }));
  if (!written.held) return { claimToken: null, refusal: { code: 'SUGGESTION_ALREADY_RESOLVING', message: RESOLVING_MESSAGE } };
  if (written.value.length > 0) return { claimToken };
  const [after] = await db.select({ status: documentSuggestions.status }).from(documentSuggestions)
    .where(eq(documentSuggestions.id, s.id)).limit(1);
  return {
    claimToken: null,
    refusal: after?.status === 'pending'
      ? suggestionRetryRefusal('REVISION_CHANGED', request?.fromReview === true)
      : { code: 'SUGGESTION_ALREADY_RESOLVING', message: RESOLVING_MESSAGE },
  };
}

/**
 * The executor's failures after which the action and the suggestion go back
 * to pending (the resolver reopens them): nothing was written.
 */
const RETRY_KEY = 'suggestion_retry';
/** SUGGESTION_ALREADY_RESOLVING: the suggestion no longer carries this request's claim token. */
export type RetryCode = 'REVISION_CHANGED' | 'BUSY' | 'NOTHING_TO_APPLY' | 'SUGGESTION_ALREADY_RESOLVING';

/** The executor's retry code in an approval's parsed result, or null. */
export function suggestionRetryOf(parsedResult: unknown): RetryCode | null {
  const inner = isRecord(parsedResult) && isRecord(parsedResult.result) ? parsedResult.result : null;
  const code = inner?.[RETRY_KEY];
  return code === 'REVISION_CHANGED' || code === 'BUSY' || code === 'NOTHING_TO_APPLY' || code === 'SUGGESTION_ALREADY_RESOLVING' ? code : null;
}

/** How a reopened approval answers: a review in the document is read again; anything else is sent to that review. */
export function suggestionRetryRefusal(code: RetryCode, fromReview: boolean): SuggestionApprovalRefusal {
  if (code === 'BUSY') return { code: 'BUSY', message: 'Documents are busy right now. Try again in a moment.' };
  if (code === 'NOTHING_TO_APPLY') return { code: 'NOTHING_TO_APPLY', message: NOTHING_TO_APPLY_MESSAGE };
  if (code === 'SUGGESTION_ALREADY_RESOLVING') return { code: 'SUGGESTION_ALREADY_RESOLVING', message: RESOLVING_MESSAGE };
  return fromReview
    ? { code: 'REVISION_CHANGED', message: REVISION_CHANGED_MESSAGE }
    : { code: 'REVIEW_IN_DOCUMENT', message: REVIEW_IN_DOCUMENT_MESSAGE };
}

// ---------------------------------------------------------------------------
// The executor

type ExecutorOutcome =
  | { success: true; result: { document_id: string; suggestion_id: string; status: DocumentSuggestionStatus; applied_block_ids: string[]; version_id: string } }
  | { success: true; result: { document_id: string; landing: 'direct'; changed_block_ids: string[]; version_id: string } }
  | { success: false; result: Record<string, unknown> | null; error: string };

/** Closes the suggestion after a failure the asker can't retry, while it carries this request's claim; the approval records the error. */
async function cancelAfterFailure(actionId: string, claimToken: string, error: string): Promise<ExecutorOutcome> {
  await db.transaction((tx) => syncSuggestionWithAction(tx, actionId, 'cancelled', claimToken));
  return { success: false, result: null, error };
}

const retry = (code: RetryCode, error: string): ExecutorOutcome => ({ success: false, result: { [RETRY_KEY]: code }, error });

/**
 * The `edit_document` executor (executeAction, lib/agent-actions.ts): applies
 * the action's suggestion claimed by this approval (`claimToken`, from the
 * resolver; the header). A suggestion that no longer carries the token was
 * taken over: nothing is written, and the approval reopens. Returns
 * references only: the document, the suggestion, its outcome, the blocks
 * applied and the agent version.
 *
 * `direct` (M7): the chat exception's direct edit (lib/agent-runner.ts,
 * executeActionDirect with source `document_edit_exception`). Its operations
 * come only from that call, never from the action's params, which hold
 * { document_id, summary } (rule C4); `recheck` decides the landing again
 * inside the write (fix round 1, I4). An action that has a suggestion is
 * never applied this way.
 */
export async function executeDocumentEditAction(i: { orgId: string; actionId: string; claimToken?: string; direct?: DirectDocumentEdit }): Promise<ExecutorOutcome> {
  const [s] = await db.select().from(documentSuggestions)
    .where(and(eq(documentSuggestions.action_id, i.actionId), eq(documentSuggestions.org_id, i.orgId))).limit(1);
  if (!s) {
    if (i.direct) return executeDirectDocumentEdit(i.orgId, i.actionId, i.direct);
    return { success: false, result: null, error: 'This edit has no suggestion to apply' };
  }
  if (i.direct) return { success: false, result: null, error: 'This edit is waiting as a suggestion' };
  const token = i.claimToken;
  if (!token || s.status !== 'applying' || s.claim_token !== token || !s.selected_block_ids?.length || s.reviewed_revision === null) {
    return retry('SUGGESTION_ALREADY_RESOLVING', RESOLVING_MESSAGE);
  }
  // Checked again at execution (consult): the asker still edits the document, and keeps the chat the action came from.
  if (!roleAtLeast(await documentRoleFor(s.asker_user_id, i.orgId, s.document_id), 'edit')) {
    return cancelAfterFailure(i.actionId, token, SUGGESTION_ACCESS_LOST_REASON);
  }
  const [action] = await db.select({ params: agentActions.params }).from(agentActions)
    .where(and(eq(agentActions.id, i.actionId), eq(agentActions.org_id, i.orgId), requesterKeepsSourceRoomsSql())).limit(1);
  if (!action) return cancelAfterFailure(i.actionId, token, 'Cancelled: the person who asked no longer has access to the conversation this came from');

  try {
    const applied = await applyDocumentEditDirect({
      orgId: i.orgId, documentId: s.document_id, agentUserId: s.agent_user_id, askerId: s.asker_user_id, actionId: i.actionId,
      ops: checkedOps(s.ops), summary: summaryOf(action.params), selectedBlockIds: s.selected_block_ids,
    }, {
      reason: 'suggestion',
      expectedRevision: s.reviewed_revision,
      // The reviewed result, block by block, never the operations replayed (fix round 2, N1).
      fromProposal: s.proposed_json as JSONContent,
      // The outcome commits with the content, or neither does, and only under this request's claim.
      inTransaction: async (tx, edit) => {
        const [claimed] = await tx.update(documentSuggestions)
          .set({ applied_block_ids: edit.changedBlockIds, updated_at: new Date() })
          .where(and(eq(documentSuggestions.id, s.id), eq(documentSuggestions.status, 'applying'), eq(documentSuggestions.claim_token, token)))
          .returning({ id: documentSuggestions.id });
        if (!claimed) throw new SuggestionNoLongerClaimed();
        await syncSuggestionWithAction(tx, i.actionId, 'approved', token);
      },
    });
    const [done] = await db.select({ status: documentSuggestions.status, applied: documentSuggestions.applied_block_ids })
      .from(documentSuggestions).where(eq(documentSuggestions.id, s.id)).limit(1);
    return {
      success: true,
      result: {
        document_id: s.document_id, suggestion_id: s.id, status: done?.status ?? 'accepted',
        applied_block_ids: done?.applied ?? applied.changedBlockIds, version_id: applied.versionId,
      },
    };
  } catch (error) {
    if (error instanceof DocumentWriteRefused && error.code === 'REVISION_CHANGED') return retry('REVISION_CHANGED', REVISION_CHANGED_MESSAGE);
    if (error instanceof DocumentWriteRefused && error.code === 'BUSY') return retry('BUSY', 'Documents are busy right now. Try again in a moment.');
    if (error instanceof DocumentEditRefused) return retry('NOTHING_TO_APPLY', NOTHING_TO_APPLY_MESSAGE);
    if (error instanceof SuggestionNoLongerClaimed) return retry('SUGGESTION_ALREADY_RESOLVING', RESOLVING_MESSAGE);
    if (error instanceof DocumentWriteRefused && error.code === 'FORBIDDEN') return cancelAfterFailure(i.actionId, token, SUGGESTION_ACCESS_LOST_REASON);
    if (error instanceof DocumentWriteRefused) return cancelAfterFailure(i.actionId, token, error.message);
    await cancelAfterFailure(i.actionId, token, 'failed');
    throw error;
  }
}

/** Thrown inside the write when the suggestion stopped being claimed (it was cancelled meanwhile): the write rolls back. */
class SuggestionNoLongerClaimed extends Error {
  constructor() { super('the suggestion is no longer claimed'); }
}

/** The agent an edit_document action writes as: its employee's own user, or Defty's (canonical) user. */
async function editingAgentUserId(orgId: string, agentEmployeeId: string | null): Promise<string | null> {
  if (agentEmployeeId) {
    const [employee] = await db.select({ user_id: agentEmployees.user_id }).from(agentEmployees)
      .where(and(eq(agentEmployees.id, agentEmployeeId), eq(agentEmployees.org_id, orgId))).limit(1);
    return employee?.user_id ?? null;
  }
  const [defty] = await db.select({ id: users.id }).from(users).where(and(eq(users.email, DEFTY_EMAIL), eq(users.kind, 'agent'))).limit(1);
  return defty?.id ?? null;
}

/** Where a direct edit lands when it is decided again inside the write (M7's chatEditLandingInTx). */
export type DirectEditLanding = { landing: 'direct' | 'suggest' | 'refuse'; reason: string };

/** The chat exception's direct edit, as the runner hands it to the executor (never stored). */
export type DirectDocumentEdit = {
  ops: DocumentEditOp[];
  /** Decides the landing again in the write's transaction, with the document row locked (fix round 1, I4). */
  recheck: (tx: Tx) => Promise<DirectEditLanding>;
};

/** The marker a direct edit's outcome carries when it was queued as a suggestion instead. */
export const DIRECT_EDIT_SUGGESTED = 'Queued as a suggestion: where this edit lands changed before it was written';

/** A direct edit whose request ended before its write (M7 consult O-F2: the recheck's `cancelled` landing): nothing was written. */
export const DIRECT_EDIT_CANCELLED = 'Cancelled: the request ended before this edit was written';

/** The error a landing decided again inside the write gives when it refuses. */
function recheckRefusal(landing: DirectEditLanding): string {
  return landing.reason === 'cancelled' ? DIRECT_EDIT_CANCELLED : 'You can only comment on this document';
}

/** Thrown inside the write when the landing decided again is no longer direct: the write rolls back. */
class NoLongerDirect extends Error {
  constructor(readonly landing: DirectEditLanding) { super('the edit no longer lands direct'); }
}

/**
 * The chat exception's direct edit (M7): M4's applyDocumentEditDirect with the
 * call's own operations, as the action's agent for the person who asked (the
 * writer checks their edit role again, and refuses a drive set to
 * suggestions only). Checked first, as an approved suggestion is: the asker
 * still keeps the chat the action came from. Inside the write, with the
 * document locked and after the writer's checks, the landing is decided
 * again (`recheck`: the workspace's and the employee's trust read now, the
 * asker's role, setting and the drive): when it is no longer direct nothing
 * is written, and the same action becomes a pending suggestion (fix round 1,
 * I4). The outcome is stamped on the action, references only; the version,
 * credit, highlight, audit and undo are M4's.
 */
async function executeDirectDocumentEdit(orgId: string, actionId: string, direct: DirectDocumentEdit): Promise<ExecutorOutcome> {
  const ops = direct.ops;
  const settle = async (outcome: ExecutorOutcome): Promise<ExecutorOutcome> => {
    await db.update(agentActions).set(outcome.success
      ? { result: outcome.result, after_state: { document_id: outcome.result.document_id, version_id: outcome.result.version_id }, executed_at: new Date() }
      : { error: outcome.error.slice(0, 2_000), executed_at: new Date() })
      .where(and(eq(agentActions.id, actionId), eq(agentActions.org_id, orgId)));
    return outcome;
  };
  const failed = (error: string): Promise<ExecutorOutcome> => settle({ success: false, result: null, error });
  const [action] = await db.select({ user_id: agentActions.user_id, params: agentActions.params, agent_employee_id: agentActions.agent_employee_id })
    .from(agentActions).where(and(eq(agentActions.id, actionId), eq(agentActions.org_id, orgId), requesterKeepsSourceRoomsSql())).limit(1);
  if (!action) return failed('Cancelled: the person who asked no longer has access to the conversation this came from');
  const params = isRecord(action.params) ? action.params : {};
  const documentId = typeof params.document_id === 'string' ? params.document_id : '';
  const agentUserId = await editingAgentUserId(orgId, action.agent_employee_id);
  if (!documentId || !agentUserId) return failed('This edit has no document to apply to');
  try {
    const applied = await applyDocumentEditDirect({
      orgId, documentId, agentUserId, askerId: action.user_id, actionId, ops: checkedOps(ops), summary: summaryOf(params),
    }, {
      beforeWrite: async (tx) => {
        const landing = await direct.recheck(tx);
        if (landing.landing !== 'direct') throw new NoLongerDirect(landing);
      },
    });
    return settle({ success: true, result: { document_id: documentId, landing: 'direct', changed_block_ids: applied.changedBlockIds, version_id: applied.versionId } });
  } catch (error) {
    if (error instanceof NoLongerDirect) {
      if (error.landing.landing === 'refuse') return failed(recheckRefusal(error.landing));
      return asSuggestion(error.landing);
    }
    if (error instanceof DocumentEditRefused) return failed('Some blocks this edit names are not in the document');
    // The writer refuses a drive set to suggestions only (and an asker who
    // lost their edit role) before `recheck` runs. Decided again, a landing
    // that is now a suggestion becomes one, as a trust downgrade does (fix
    // round 2, I4); one that refuses keeps the refusal.
    if (error instanceof DocumentWriteRefused && error.code === 'FORBIDDEN') return asSuggestion(null);
    if (error instanceof DocumentWriteRefused || error instanceof DocumentRefusal) return failed(error.message);
    throw error;
  }

  /**
   * Nothing was written: the same action waits as a suggestion only its asker
   * reviews, in one transaction with the action set back to pending. With no
   * `known` landing (the writer refused), it is decided again in that
   * transaction first, and anything but a suggestion is the refusal.
   */
  async function asSuggestion(known: DirectEditLanding | null): Promise<ExecutorOutcome> {
    const refused: { landing: DirectEditLanding | null } = { landing: null };
    try {
      const queued = await db.transaction(async (tx) => {
        const landing = known ?? await direct.recheck(tx);
        if (landing.landing !== 'suggest') { refused.landing = landing; return null; }
        const [back] = await tx.update(agentActions)
          .set({ approval_status: 'pending', approved_at: null, approved_by_user_id: null, updated_at: new Date() })
          .where(and(eq(agentActions.id, actionId), eq(agentActions.org_id, orgId), eq(agentActions.approval_status, 'approved'),
            sql`${agentActions.executed_at} IS NULL`))
          .returning({ id: agentActions.id });
        if (!back) throw new DocumentRefusal(409, 'INVALID_STATE', 'This edit is no longer waiting to be written');
        const { suggestionId } = await proposeDocumentEdit(tx, { orgId, documentId, actionId, askerId: action!.user_id, agentUserId: agentUserId!, ops });
        return { reason: landing.reason, suggestionId };
      });
      if (!queued) return failed(refused.landing ? recheckRefusal(refused.landing) : 'You can only comment on this document');
      return { success: false, result: { landing: 'suggest', reason: queued.reason, suggestion_id: queued.suggestionId }, error: DIRECT_EDIT_SUGGESTED };
    } catch (proposeError) {
      if (proposeError instanceof DocumentEditRefused) return failed('Some blocks this edit names are not in the document');
      if (proposeError instanceof DocumentRefusal || proposeError instanceof DocumentWriteRefused) return failed(proposeError.message);
      throw proposeError;
    }
  }
}

// ---------------------------------------------------------------------------
// Reading, applying and rejecting (routes/documents.ts)

/**
 * The suggestion when `userId` may act on it: 404 when there is none (in
 * their workspace, on `documentId` when given) or they can't open its
 * document; 403 NOT_REQUESTER for anyone but the person who asked.
 */
async function askersSuggestion(i: { orgId: string; suggestionId: string; userId: string; documentId?: string }): Promise<SuggestionRow> {
  const [row] = await db.select().from(documentSuggestions)
    .where(and(eq(documentSuggestions.id, i.suggestionId), eq(documentSuggestions.org_id, i.orgId))).limit(1);
  if (!row || (i.documentId !== undefined && row.document_id !== i.documentId)) throw notFound();
  if (!(await documentRoleFor(i.userId, i.orgId, row.document_id))) throw notFound();
  if (row.asker_user_id !== i.userId) throw notRequester();
  return row;
}

/** The refusal every review path gives someone other than the asker who can open the document. */
export const NOT_REQUESTER_MESSAGE = 'Only the person who asked for this edit can review it';

/**
 * How a review path that isn't the document routes (the chat card, the Inbox,
 * MCP, the resolver) refuses `userId` on action `actionId` (fix round 1):
 * 'NOT_REQUESTER' (403) when it is an edit suggestion someone else asked for
 * and `userId` can open its document; 'NOT_FOUND' (404) when they can't, so
 * nothing about it is told; null when it is no edit suggestion, or theirs.
 */
export async function suggestionReviewerRefusal(orgId: string, actionId: string, userId: string): Promise<'NOT_REQUESTER' | 'NOT_FOUND' | null> {
  const [action] = await db.select({ action: agentActions.action }).from(agentActions)
    .where(and(eq(agentActions.id, actionId), eq(agentActions.org_id, orgId))).limit(1);
  if (action?.action !== DOCUMENT_EDIT_ACTION) return null;
  const [s] = await db.select({ documentId: documentSuggestions.document_id, asker: documentSuggestions.asker_user_id })
    .from(documentSuggestions).where(and(eq(documentSuggestions.action_id, actionId), eq(documentSuggestions.org_id, orgId))).limit(1);
  if (!s || s.asker === userId) return null;
  return (await documentRoleFor(userId, orgId, s.documentId)) ? 'NOT_REQUESTER' : 'NOT_FOUND';
}

/** Each person's name as `viewerId` may read it (the people-visibility rules), "A collaborator" for someone hidden. */
async function namesFor(orgId: string, viewerId: string, ids: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const visible = await visiblePersonIds(await peopleViewer(orgId, viewerId));
  const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...new Set(ids)]));
  const byId = new Map(rows.map((row) => [row.id, row.name]));
  for (const id of ids) names.set(id, canSeePerson(visible, id) ? byId.get(id) ?? HIDDEN_PERSON_NAME : HIDDEN_PERSON_NAME);
  return names;
}

/** An open suggestion whose action has ended some other way shows that ending until the daily repair settles it. */
function shownStatus(status: DocumentSuggestionStatus, actionStatus: string | null): DocumentSuggestionStatus {
  if (!OPEN_STATUSES.includes(status)) return status;
  if (actionStatus === 'rejected') return 'rejected';
  if (actionStatus === 'expired' || actionStatus === null) return 'cancelled';
  return status;
}

export type SuggestionSummary = { id: string; status: DocumentSuggestionStatus; summary: string; created_at: Date; expires_at: Date; block_count: number };
export type SuggestionList = {
  /** The caller's own pending suggestions on the document, oldest first. */
  mine: SuggestionSummary[];
  /** Everyone else's, counted per person: no content, no ids. */
  others: Array<{ pending: number; asker_name: string }>;
};

/**
 * The pending suggestions on a document, for anyone who can open it (404
 * otherwise): the caller's own in full, and everyone else's only as how many
 * wait for whom (the header). People hidden from the caller are counted
 * together as "A collaborator".
 */
export async function listDocumentSuggestions(i: { orgId: string; documentId: string; userId: string }): Promise<SuggestionList> {
  if (!(await documentRoleFor(i.userId, i.orgId, i.documentId))) throw new DocumentRefusal(404, 'NOT_FOUND', 'Document not found');
  const rows = await db.select({
    id: documentSuggestions.id, asker: documentSuggestions.asker_user_id, created_at: documentSuggestions.created_at,
    changed: documentSuggestions.changed_block_ids, params: agentActions.params,
  }).from(documentSuggestions)
    .innerJoin(agentActions, and(eq(agentActions.id, documentSuggestions.action_id), eq(agentActions.org_id, documentSuggestions.org_id)))
    .where(and(
      eq(documentSuggestions.org_id, i.orgId), eq(documentSuggestions.document_id, i.documentId),
      eq(documentSuggestions.status, 'pending'), eq(agentActions.approval_status, 'pending'),
    ))
    .orderBy(asc(documentSuggestions.created_at), asc(documentSuggestions.id));
  const mine = rows.filter((row) => row.asker === i.userId).map((row) => ({
    id: row.id, status: 'pending' as const, summary: summaryOf(row.params), created_at: row.created_at,
    expires_at: new Date(row.created_at.getTime() + SUGGESTION_TTL_MS), block_count: row.changed.length,
  }));
  const theirs = rows.filter((row) => row.asker !== i.userId);
  const names = await namesFor(i.orgId, i.userId, theirs.map((row) => row.asker));
  const groups = new Map<string, { pending: number; asker_name: string }>();
  for (const row of theirs) {
    const name = names.get(row.asker) ?? HIDDEN_PERSON_NAME;
    // Everyone hidden is one group, so the list doesn't tell how many hidden people there are.
    const key = name === HIDDEN_PERSON_NAME ? '' : row.asker;
    const group = groups.get(key) ?? { pending: 0, asker_name: name };
    group.pending += 1;
    groups.set(key, group);
  }
  return { mine, others: [...groups.values()] };
}

export type SuggestionReview = { id: string; status: string; asker: { id: string; name: string };
  blocks: Array<{ block_id: string; before: JSONContent | null; after: JSONContent | null; conflict: boolean }> };

/**
 * The suggestion in full, for the person who asked (404 and 403 as
 * askersSuggestion): each changed block as it was when proposed (`before`,
 * null for an added one) and as the edit makes it (`after`, null for a
 * deleted one), and whether it changed since (`conflict`), with the document
 * revision the review was read at: applying passes it back.
 */
export async function reviewSuggestion(i: { orgId: string; suggestionId: string; userId: string; documentId?: string }): Promise<SuggestionReview & {
  revision: number; summary: string; created_at: Date; expires_at: Date;
}> {
  const row = await askersSuggestion(i);
  const [action] = await db.select({ status: agentActions.approval_status, params: agentActions.params }).from(agentActions)
    .where(and(eq(agentActions.id, row.action_id), eq(agentActions.org_id, i.orgId))).limit(1);
  const [asker] = await db.select({ name: users.name }).from(users).where(eq(users.id, row.asker_user_id)).limit(1);
  // The revision first, then the content: the content is at least as new as the revision the asker applies at.
  const [doc] = await db.select({ revision: documents.revision }).from(documents)
    .where(and(eq(documents.id, row.document_id), eq(documents.org_id, i.orgId))).limit(1);
  const current = blocksById(await currentContent(db, i.orgId, row.document_id));
  const base = blocksById(row.base_json);
  const proposed = blocksById(row.proposed_json);
  const blocks = row.changed_block_ids.map((id) => {
    const before = base.get(id) ?? null;
    const now = current.get(id);
    return {
      block_id: id,
      before,
      after: proposed.get(id) ?? null,
      conflict: before !== null && (now ? blockHash(now) : null) !== blockHash(before),
    };
  });
  return {
    id: row.id,
    status: shownStatus(row.status, action?.status ?? null),
    asker: { id: row.asker_user_id, name: asker?.name ?? HIDDEN_PERSON_NAME },
    blocks,
    revision: doc?.revision ?? 0,
    summary: summaryOf(action?.params),
    created_at: row.created_at,
    expires_at: new Date(row.created_at.getTime() + SUGGESTION_TTL_MS),
  };
}

/** The approval resolver's answer as a refusal of the route: the action stayed pending, or was settled by someone else. */
function refusalOf(result: { status: string; code?: string; message?: string }): Error {
  if (result.status !== 'error') return resolving();
  switch (result.code) {
    case 'REVIEW_IN_DOCUMENT': return new DocumentRefusal(409, 'REVIEW_IN_DOCUMENT', REVIEW_IN_DOCUMENT_MESSAGE);
    case 'REVISION_CHANGED': return new DocumentRefusal(409, 'REVISION_CHANGED', REVISION_CHANGED_MESSAGE);
    case 'NOTHING_TO_APPLY': return new DocumentRefusal(409, 'NOTHING_TO_APPLY', NOTHING_TO_APPLY_MESSAGE);
    case 'BUSY': return new DocumentWriteRefused('BUSY');
    case 'NOT_REQUESTER': return notRequester();
    case 'FORBIDDEN': return new DocumentRefusal(403, 'FORBIDDEN', 'You can no longer act on this suggestion');
    case 'EXECUTE_FAILED': return new DocumentRefusal(409, 'SUGGESTION_NOT_APPLIED', 'This suggestion could not be applied, so it was closed. Ask again for a new one.');
    default: return resolving();
  }
}

/**
 * Applies the blocks `blockIds` (each one the suggestion changes, or 'all')
 * of the asker's suggestion, as reviewed at `revision` (the review's; when
 * left out, the revision the suggestion was made on, as the card does),
 * through approveAction (the header): the resolver claims the suggestion with
 * this choice while it holds the action's approval lease, so this request
 * never writes the row itself. 409 SUGGESTION_ALREADY_RESOLVING when another
 * apply or a decision came first; 409 REVISION_CHANGED (or
 * REVIEW_IN_DOCUMENT without `revision`) when the document has moved, with
 * the suggestion pending. Returns the outcome, the blocks applied and the
 * agent version.
 */
export async function applySuggestion(i: { orgId: string; suggestionId: string; userId: string; blockIds: string[] | 'all';
  revision?: number; documentId?: string }): Promise<{ status: 'accepted' | 'partially_accepted'; appliedBlockIds: string[]; versionId: string }> {
  const row = await askersSuggestion(i);
  // 'applying' goes on to the lease, which tells a live claim (409) from one a request left behind.
  if (row.status !== 'pending' && row.status !== 'applying') throw resolving();
  const chosen = i.blockIds === 'all' ? new Set(row.changed_block_ids) : new Set(i.blockIds);
  if (chosen.size === 0 || [...chosen].some((id) => !row.changed_block_ids.includes(id))) throw invalidBlocks();
  const selected = row.changed_block_ids.filter((id) => chosen.has(id));

  const { approveAction } = await import('./agent-approval-resolver.js');
  const result = await approveAction(row.action_id, i.userId, {
    suggestionClaim: { selectedBlockIds: selected, reviewedRevision: i.revision ?? row.base_revision, fromReview: i.revision !== undefined },
  });
  if (result.status === 'approved' && !result.decidedElsewhere) {
    const [done] = await db.select({ status: documentSuggestions.status, applied: documentSuggestions.applied_block_ids })
      .from(documentSuggestions).where(eq(documentSuggestions.id, row.id)).limit(1);
    const [version] = await db.select({ id: documentVersions.id }).from(documentVersions).where(and(
      eq(documentVersions.org_id, i.orgId), eq(documentVersions.document_id, row.document_id), eq(documentVersions.kind, 'agent'),
      eq(documentVersions.action_id, row.action_id),
    )).limit(1);
    const status = done?.status;
    if ((status === 'accepted' || status === 'partially_accepted') && version) {
      return { status, appliedBlockIds: done?.applied ?? [], versionId: version.id };
    }
    throw resolving();
  }
  throw refusalOf(result);
}

/** Rejects the asker's pending suggestion through rejectAction (404 and 403 as askersSuggestion; 409 once it is settled). */
export async function rejectSuggestion(i: { orgId: string; suggestionId: string; userId: string; documentId?: string }): Promise<void> {
  const row = await askersSuggestion(i);
  if (row.status !== 'pending') throw resolving();
  const { rejectAction } = await import('./agent-approval-resolver.js');
  const result = await rejectAction(row.action_id, i.userId);
  if (result.status === 'rejected' && !result.decidedElsewhere) return;
  throw refusalOf(result);
}

// ---------------------------------------------------------------------------
// Closing without a decision: access loss, expiry, repair

/** Closes each pending action and its suggestion in `tx`, the room rule's way; returns the ids closed. */
async function closeActionsInTx(tx: Tx, orgId: string, rows: Array<{ actionId: string; params: unknown }>, reason: string,
  outcome: 'expired' | 'cancelled'): Promise<string[]> {
  if (rows.length === 0) return [];
  // The work intent reads the params, so it closes first.
  await markWorkIntentsExpiredForActions({ orgId, actions: rows.map((row) => ({ id: row.actionId, params: row.params })), reason }, tx);
  const closed: string[] = [];
  for (const row of rows) {
    const [done] = await tx.update(agentActions)
      .set({ approval_status: 'expired', error: reason, updated_at: new Date() })
      .where(and(eq(agentActions.id, row.actionId), eq(agentActions.org_id, orgId), eq(agentActions.approval_status, 'pending')))
      .returning({ id: agentActions.id });
    if (!done) continue;
    await syncSuggestionWithAction(tx, row.actionId, outcome);
    closed.push(done.id);
  }
  return closed;
}

type LossScope = { orgId: string; userIds?: readonly string[]; documentIds?: readonly string[]; driveId?: string };

async function cancelLostInScope(tx: Tx, scope: LossScope): Promise<string[]> {
  if (scope.userIds?.length === 0 || scope.documentIds?.length === 0) return [];
  // The actions are locked first, as the room rule and the approval claims lock them: exactly one of a loss and a claim wins.
  const rows = await tx.select({
    actionId: agentActions.id, params: agentActions.params, documentId: documentSuggestions.document_id, askerId: documentSuggestions.asker_user_id,
  }).from(agentActions)
    .innerJoin(documentSuggestions, and(eq(documentSuggestions.action_id, agentActions.id), eq(documentSuggestions.org_id, agentActions.org_id)))
    .innerJoin(documents, and(eq(documents.org_id, documentSuggestions.org_id), eq(documents.id, documentSuggestions.document_id)))
    .where(and(
      eq(agentActions.org_id, scope.orgId), eq(agentActions.action, DOCUMENT_EDIT_ACTION), eq(agentActions.approval_status, 'pending'),
      inArray(documentSuggestions.status, OPEN_STATUSES),
      scope.userIds ? inArray(documentSuggestions.asker_user_id, [...scope.userIds]) : undefined,
      scope.documentIds ? inArray(documentSuggestions.document_id, [...scope.documentIds]) : undefined,
      scope.driveId ? eq(documents.drive_id, scope.driveId) : undefined,
    ))
    .orderBy(agentActions.id)
    .for('update', { of: agentActions });
  const lost: Array<{ actionId: string; params: unknown }> = [];
  for (const row of rows) {
    // Read in this transaction, after the change: the hook sees it.
    if (!roleAtLeast(await documentRoleFor(row.askerId, scope.orgId, row.documentId, tx), 'edit')) lost.push(row);
  }
  return closeActionsInTx(tx, scope.orgId, lost, SUGGESTION_ACCESS_LOST_REASON, 'cancelled');
}

/**
 * Cancels, in the caller's transaction and after its access change, the open
 * suggestions in `scope` whose asker can no longer edit their document, with
 * their actions (closed with SUGGESTION_ACCESS_LOST_REASON). Returns the
 * action ids; pass them to finishLostDocumentCancellations after the commit.
 */
export async function cancelLostDocumentSuggestionsInTx(tx: Tx, scope: { orgId: string; userId?: string; documentId?: string; driveId?: string }): Promise<string[]> {
  return cancelLostInScope(tx, {
    orgId: scope.orgId,
    userIds: scope.userId !== undefined ? [scope.userId] : undefined,
    documentIds: scope.documentId !== undefined ? [scope.documentId] : undefined,
    driveId: scope.driveId,
  });
}

/** After the commit: the cancelled actions' attention items resolve. Never throws. */
export async function finishLostDocumentCancellations(orgId: string, actionIds: readonly string[]): Promise<void> {
  for (const actionId of actionIds) {
    try {
      await resolveAttentionBySource({ orgId, sourceType: 'agent_action', sourceId: actionId, resolution: DOCUMENT_ACCESS_LOST_RESOLUTION });
    } catch {
      console.error('[document-suggestions] resolving a cancelled suggestion\'s attention items failed');
    }
  }
}

// Every access loss (rule C3) runs this in its own transaction; finishAccessLoss resolves the attention items after the commit.
onAccessLossInTx((tx: Tx, change: DocumentAccessChange) => cancelLostInScope(tx, {
  orgId: change.orgId, userIds: change.userIds, documentIds: change.documentIds, driveId: change.driveId,
}));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "Defty's suggestion from 27 Nov 2026 expired without review": the version note of an expired suggestion (UTC date). */
export function expiredSuggestionNote(createdAt: Date, byDefty: boolean): string {
  const date = `${createdAt.getUTCDate()} ${MONTHS[createdAt.getUTCMonth()]} ${createdAt.getUTCFullYear()}`;
  return `${byDefty ? 'Defty\'s' : 'An agent\'s'} suggestion from ${date} expired without review`;
}

/**
 * Expires the suggestions pending for 14 days at `now` (the header): each
 * action is closed (SUGGESTION_EXPIRED_REASON), the suggestion marked
 * 'expired', and a `named` version holding the current content records it.
 * A pending `edit_document` action that has no suggestion expires too.
 * Returns how many actions closed.
 */
export async function expireStaleSuggestions(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - SUGGESTION_TTL_MS);
  // 14 days or more (the tester's exactly-14-days case): an action expires once; a second pass finds it no longer pending.
  const stale = and(eq(agentActions.action, DOCUMENT_EDIT_ACTION), eq(agentActions.approval_status, 'pending'), lte(agentActions.created_at, cutoff));
  const orgs = await db.selectDistinct({ orgId: agentActions.org_id }).from(agentActions).where(stale).limit(100);
  let count = 0;
  for (const { orgId } of orgs) {
    const closed = await db.transaction(async (tx) => {
      const rows = await tx.select({
        actionId: agentActions.id, params: agentActions.params, suggestionId: documentSuggestions.id, documentId: documentSuggestions.document_id,
        suggestedAt: documentSuggestions.created_at, status: documentSuggestions.status, agentEmail: users.email, agentKind: users.kind,
      }).from(agentActions)
        .leftJoin(documentSuggestions, and(eq(documentSuggestions.action_id, agentActions.id), eq(documentSuggestions.org_id, agentActions.org_id)))
        .leftJoin(users, eq(users.id, documentSuggestions.agent_user_id))
        .where(and(eq(agentActions.org_id, orgId), stale))
        .orderBy(agentActions.id)
        .limit(BATCH)
        .for('update', { of: agentActions });
      // A suggestion being applied right now is left to its approval.
      const due = rows.filter((row) => row.status === null || row.status === 'pending');
      const ids = await closeActionsInTx(tx, orgId, due, SUGGESTION_EXPIRED_REASON, 'expired');
      const expired = new Set(ids);
      for (const row of due) {
        if (!expired.has(row.actionId) || !row.documentId || !row.suggestedAt) continue;
        await createVersionInTx(tx, {
          orgId, documentId: row.documentId, kind: 'named', createdBy: null,
          name: expiredSuggestionNote(row.suggestedAt, row.agentEmail === DEFTY_EMAIL && row.agentKind === 'agent'),
        });
      }
      return ids;
    });
    for (const actionId of closed) {
      try {
        await resolveAttentionBySource({ orgId, sourceType: 'agent_action', sourceId: actionId, resolution: 'expired' });
      } catch {
        console.error('[document-suggestions] resolving an expired suggestion\'s attention items failed');
      }
    }
    count += closed.length;
  }
  return count;
}

/** The sweep behind the access-loss hook: open suggestions whose asker lost edit by a path no hook covers. Returns the actions closed. */
export async function cancelLostDocumentSuggestions(): Promise<number> {
  const orgs = await db.selectDistinct({ orgId: documentSuggestions.org_id }).from(documentSuggestions)
    .where(inArray(documentSuggestions.status, OPEN_STATUSES)).limit(100);
  let count = 0;
  for (const { orgId } of orgs) {
    const ids = await db.transaction((tx) => cancelLostInScope(tx, { orgId }));
    await finishLostDocumentCancellations(orgId, ids);
    count += ids.length;
  }
  return count;
}

/**
 * Puts open suggestions back in step with their actions (bounded), each
 * under its action's approval lease, skipped while someone holds it: a claim
 * whose approval never started, older than STALE_CLAIM_MS, goes back to
 * pending; one whose action was rejected is 'rejected'; one whose action
 * expired, or was approved and ran without applying it, is 'cancelled'.
 */
export async function repairSuggestions(now: Date): Promise<void> {
  const staleClaim = new Date(now.getTime() - STALE_CLAIM_MS);
  const rows = await db.select({ actionId: documentSuggestions.action_id, actionStatus: agentActions.approval_status })
    .from(documentSuggestions)
    .innerJoin(agentActions, and(eq(agentActions.id, documentSuggestions.action_id), eq(agentActions.org_id, documentSuggestions.org_id)))
    .where(and(inArray(documentSuggestions.status, OPEN_STATUSES), outOfStepSql(staleClaim)))
    .orderBy(asc(documentSuggestions.created_at))
    .limit(BATCH);
  if (rows.length === 0) return;
  // Loaded when needed: the lease module imports the executor's module, which imports this one.
  const { tryWithApprovalLease } = await import('./agent-action-execution-lease.js');
  for (const row of rows) {
    await tryWithApprovalLease(row.actionId, { acquireTimeoutMs: 250 }, async (lease) => {
      if (row.actionStatus === 'pending') {
        // On the lease's own connection, as a claim is: a repair that lost its lease releases nothing.
        await writeUnderDbAdvisoryLease(lease, (tx) => releaseStaleClaimInTx(tx, row.actionId));
        return;
      }
      const outcome = row.actionStatus === 'rejected' ? 'rejected' : 'cancelled';
      await db.transaction((tx) => syncSuggestionWithAction(tx, row.actionId, outcome));
    });
  }
}

/** An open suggestion out of step with its action (repairSuggestions). An approval that applied it settled it in its own write. */
function outOfStepSql(staleClaim: Date): SQL {
  return sql`(
    (${documentSuggestions.status} = 'applying' AND ${agentActions.approval_status} = 'pending' AND ${documentSuggestions.updated_at} < ${staleClaim})
    OR ${agentActions.approval_status} IN ('rejected', 'expired')
    OR (${agentActions.approval_status} = 'approved' AND ${agentActions.executed_at} IS NOT NULL)
  )`;
}
