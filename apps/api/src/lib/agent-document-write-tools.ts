// Defty's document write tools (spec 5.7; plan Task M7, with the 25 Nov
// consult's changes): create_document and edit_document, and the one chat
// exception to "Defty's chat writes wait for approval".
//
// create_document { title, markdown?, drive_id?, folder_id?, parent_document_id? },
// tier quick, is an ordinary registered write: from chat it waits for the
// one-click approval card like every other Defty chat write. Approved, it
// creates the document as the person who asked (createDocumentInTx: in the
// drive, folder or under the page named, else their My drive, with F5's role
// checks), from the Markdown, with any image the Markdown names linked when
// that person may link it and shown as the placeholder otherwise (F15's
// note-tool-images rule). Its stored params then name the document and keep
// neither the title nor the Markdown (rule C4).
//
// edit_document { document_id, ops, summary, mode? }, tier quick, is decided
// here when Defty calls it in a chat (decideDocumentEdit, called by the
// runner, lib/agent-runner.ts):
// - an agent employee's call is refused (EMPLOYEE_EDITS_VIA_MCP, fix round
//   2): this path edits for an asker only as Defty; an employee edits
//   through its own MCP connection, with its own access (M8);
// - background work (heartbeats, triggers, any run with nobody asking)
//   refuses it as `unprompted`, before anything else is read;
// - the asker must be able to open the document (else DOCUMENT_NOT_FOUND,
//   telling nothing of it);
// - then M5's decideEditLanding (lib/document-edit-landing.ts) decides, with
//   the trust level (the workspace's, orgs.trust_level; for an agent
//   employee, the lower of that and its own), the asker's role, the drive,
//   the asker's setting, whether another person has the document open, the
//   model's `mode` (requestOverride: it can only lower the landing) and the
//   asker's own triggering message (askerMessageText, passed by the caller:
//   never document text, a tool result or the model's arguments);
// - a call isDestructiveAction classes destructive never goes straight in
//   (chatEditLanding);
// - the operations are checked against the document as it is now (pending
//   live edits included), so a block id that isn't there is the model's to
//   correct before anything is stored.
// The runner then applies a direct edit at once (executeActionDirect, source
// `document_edit_exception`, and M4's applyDocumentEditDirect through the
// executor in lib/document-suggestions.ts), queues a suggestion as a pending
// action (persistAgentReplyWithActions calls M6's proposeDocumentEdit in the
// same transaction), or answers the refusal. The action's params are only
// { document_id, summary, suggestion_id? }: the operations live in the
// suggestion, or in the agent version's edit_details (rule C4).
import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import * as Y from 'yjs';
import { agentActions, agentEmployees, orgs } from '@deft/db/schema';
import { documents, documentSuggestions, documentVersions, drives } from '@deft/db/documents';
import { EMPTY_DOCUMENT, markdownToJson } from '@deft/doc-schema';
import { deriveContent, type JSONContent } from '../collab/persistence.js';
import { readCurrentDocument } from '../collab/server.js';
import type { executeAction as ExecuteActionFn, executeActionDirect as ExecuteActionDirectFn } from './agent-actions.js';
import { isDestructiveAction, type TrustLevel } from './agent-approval.js';
import { getActiveAgentToolPolicy } from './agent-tool-policy.js';
import { logAuditEvent } from './audit.js';
import { db } from './db.js';
import { createDocumentInputForStorage, editDocumentInputForStorage, storableRef } from './document-audience.js';
import { documentRoleFor } from './document-access.js';
import { applyOpsToJson, type DocumentEditOp } from './document-edit.js';
import {
  agentEditModeFor, decideEditLanding, otherHumansOpen, type EditLanding, type EditLandingInput,
} from './document-edit-landing.js';
import { DIRECT_EDIT_CANCELLED, DIRECT_EDIT_SUGGESTED, DOCUMENT_EDIT_ACTION } from './document-suggestions.js';
import { createDocumentInTx, DocumentRefusal } from './documents.js';
import { deftyUserId } from './legacy-notes.js';
import { linkToolImagesInTx, ToolImageChanged, toolImages } from './note-tool-images.js';

export { DOCUMENT_EDIT_ACTION, editDocumentInputForStorage, createDocumentInputForStorage };

/** The agent action that creates a document. */
export const CREATE_DOCUMENT_ACTION = 'create_document';

/** The refusal copy the model is given (plain English, shown to the asker). */
export const EDIT_REFUSAL_COPY = {
  asker_cannot_edit: 'You can only comment on this document',
  unprompted: 'Nobody asked for this edit, so I can only comment',
} as const;

/** An agent employee's edit_document call on Defty's chat path (fix round 2): its edits go through its own connection. */
export const EMPLOYEE_EDIT_REFUSAL = 'This agent edits documents through its own connection, not on someone\'s behalf.';

/** The most operations one edit may carry. */
const MAX_EDIT_OPS = 200;
/** The longest summary kept (it names the agent version). */
const MAX_SUMMARY = 300;

const isRecord = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------
// Trust

const TRUST_RANK: Record<TrustLevel, number> = { conservative: 0, standard: 1, autonomous: 2 };

/** A stored trust level, or Conservative for anything that isn't one (fail closed). */
function trustOf(value: unknown): TrustLevel {
  return typeof value === 'string' && Object.hasOwn(TRUST_RANK, value) ? value as TrustLevel : 'conservative';
}

/** The lower of the levels given (controller ruling 1: an employee gets the lower of the workspace's and its own). */
export function lowerTrustLevel(...levels: unknown[]): TrustLevel {
  return levels.map(trustOf).reduce((low, level) => (TRUST_RANK[level] < TRUST_RANK[low] ? level : low), 'autonomous' as TrustLevel);
}

/**
 * The trust level the chat exception reads: the workspace's (Defty), or the
 * lower of the workspace's and the employee's own. An employee that isn't
 * active counts as Conservative.
 */
export async function documentEditTrustLevel(orgId: string, agentEmployeeId?: string | null): Promise<TrustLevel> {
  const [org] = await db.select({ trust_level: orgs.trust_level }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  if (!agentEmployeeId) return lowerTrustLevel(org?.trust_level);
  const policy = await getActiveAgentToolPolicy(orgId, agentEmployeeId);
  return policy ? lowerTrustLevel(org?.trust_level, policy.trustLevel) : 'conservative';
}

// ---------------------------------------------------------------------------
// The landing

/** M5's landings, plus a direct landing lowered because the call is destructive (controller ruling 2). */
export type ChatEditLanding = EditLanding | { landing: 'suggest'; reason: 'destructive_call' };

/**
 * Where an edit_document call in a chat lands: M5's decideEditLanding, except
 * that a call isDestructiveAction classes destructive (`params`, the call's
 * own arguments) never goes straight in. Pure.
 */
export function chatEditLanding(input: EditLandingInput, params: unknown): ChatEditLanding {
  const landing = decideEditLanding(input);
  if (landing.landing === 'direct' && isDestructiveAction(DOCUMENT_EDIT_ACTION, params)) return { landing: 'suggest', reason: 'destructive_call' };
  return landing;
}

// ---------------------------------------------------------------------------
// The call

export type EditDocumentCall = { documentId: string; ops: DocumentEditOp[]; summary: string; mode: unknown };

/** The operations when every entry is one of M4's DocumentEditOp shapes, else null. */
function editOpsOf(value: unknown): DocumentEditOp[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EDIT_OPS) return null;
  const ops: DocumentEditOp[] = [];
  for (const op of value) {
    if (!isRecord(op)) return null;
    const blockId = typeof op.block_id === 'string' && op.block_id.length > 0 ? op.block_id : null;
    const markdown = typeof op.markdown === 'string' ? op.markdown : null;
    if (op.op === 'append' && markdown !== null) ops.push({ op: 'append', markdown });
    else if (op.op === 'delete' && blockId !== null) ops.push({ op: 'delete', block_id: blockId });
    else if ((op.op === 'replace' || op.op === 'insert_after') && blockId !== null && markdown !== null) ops.push({ op: op.op, block_id: blockId, markdown });
    else return null;
  }
  return ops;
}

/** The model's edit_document arguments, checked: null when they aren't a well-formed call. */
export function parseEditDocumentInput(input: unknown): EditDocumentCall | null {
  if (!isRecord(input)) return null;
  const documentId = typeof input.document_id === 'string' ? input.document_id.trim() : '';
  const summary = typeof input.summary === 'string' ? input.summary.trim().slice(0, MAX_SUMMARY) : '';
  const ops = editOpsOf(input.ops);
  if (!documentId || !summary || !ops) return null;
  return { documentId, ops, summary, mode: input.mode };
}

/** What an edit_document action's params are (rule C4): the document and the summary, and the suggestion once made. */
export function documentEditActionParams(params: unknown): { document_id: string; summary: string; suggestion_id?: string } {
  const record = isRecord(params) ? params : {};
  const suggestionId = storableRef(record.suggestion_id);
  return {
    document_id: storableRef(record.document_id) ?? '',
    summary: typeof record.summary === 'string' ? record.summary.trim().slice(0, MAX_SUMMARY) : '',
    ...(suggestionId ? { suggestion_id: suggestionId } : {}),
  };
}

/** The document's current content with block ids (pending live edits included), or null. */
async function liveDocumentJson(orgId: string, documentId: string): Promise<JSONContent | null> {
  const state = await readCurrentDocument(documentId, orgId);
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

/**
 * The model's `mode`, as M5's requestOverride: null when it sent none,
 * 'direct' only when it sent exactly that, and 'suggest' for anything else
 * ("Suggest", "suggest ", a number: consult O-F7), so a lowering the model
 * meant in another form still lowers.
 */
function requestOverrideOf(mode: unknown): EditLandingInput['requestOverride'] {
  if (mode === undefined || mode === null) return null;
  return mode === 'direct' ? 'direct' : 'suggest';
}

export type DocumentEditDecision =
  /** A tool error for the model; nothing is stored. */
  | { kind: 'refuse'; reply: Record<string, unknown> }
  | {
    kind: 'direct' | 'suggest';
    landing: Exclude<ChatEditLanding, { landing: 'refuse' }>;
    call: EditDocumentCall;
    title: string;
    /** The action's params (rule C4). */
    actionParams: { document_id: string; summary: string };
  };

const refusal = (reason: 'unprompted' | 'asker_cannot_edit'): DocumentEditDecision => ({
  kind: 'refuse', reply: { landing: 'refuse', reason, error: EDIT_REFUSAL_COPY[reason] },
});

/**
 * Decides an edit_document call Defty made for `askerId` (the header). In the
 * order: background work is refused (`unprompted`); the call must be
 * well-formed; the asker must be able to open the document; M5's landing,
 * lowered for a destructive call; and the operations must name blocks the
 * document has now and change something.
 */
export async function decideDocumentEdit(i: {
  orgId: string; askerId: string; agentEmployeeId?: string | null; background: boolean; input: unknown; askerMessageText: string | null;
}): Promise<DocumentEditDecision> {
  if (i.background) return refusal('unprompted');
  const call = parseEditDocumentInput(i.input);
  if (!call) {
    return { kind: 'refuse', reply: {
      error: 'An edit needs document_id, a summary and one to 200 operations: replace, insert_after or delete name a block_id, and replace, insert_after and append carry markdown.',
      code: 'VALIDATION_ERROR',
    } };
  }
  const notFound: DocumentEditDecision = { kind: 'refuse', reply: { error: 'Document not found', code: 'DOCUMENT_NOT_FOUND' } };
  const role = await documentRoleFor(i.askerId, i.orgId, call.documentId);
  if (!role) return notFound;
  const [doc] = await db.select({
    title: documents.title, kind: drives.kind, owner: drives.owner_user_id, suggestOnly: drives.agent_suggest_only,
  }).from(documents)
    .innerJoin(drives, and(eq(drives.id, documents.drive_id), eq(drives.org_id, documents.org_id)))
    .where(and(eq(documents.id, call.documentId), eq(documents.org_id, i.orgId), eq(documents.is_deleted, false)))
    .limit(1);
  if (!doc) return notFound;

  const [trustLevel, mode, othersOpen] = await Promise.all([
    documentEditTrustLevel(i.orgId, i.agentEmployeeId),
    agentEditModeFor(i.orgId, i.askerId),
    otherHumansOpen({ orgId: i.orgId, documentId: call.documentId, askerId: i.askerId }),
  ]);
  const landing = chatEditLanding({
    trustLevel,
    askerId: i.askerId,
    askerRole: role,
    drive: { kind: doc.kind, ownerUserId: doc.owner, agentSuggestOnly: doc.suggestOnly },
    mode,
    requestOverride: requestOverrideOf(call.mode),
    askerMessageText: typeof i.askerMessageText === 'string' ? i.askerMessageText : null,
    otherHumansOpen: othersOpen,
  }, i.input);
  if (landing.landing === 'refuse') return refusal(landing.reason);

  const content = await liveDocumentJson(i.orgId, call.documentId);
  if (!content) return { kind: 'refuse', reply: { error: 'This document can\'t be edited right now', code: 'INVALID_CONTENT' } };
  const preview = applyOpsToJson(content, call.ops);
  if (preview.missingBlockIds.length > 0) {
    return { kind: 'refuse', reply: {
      error: 'Some blocks this edit names are not in the document. Read it again for the current block ids.',
      code: 'BLOCK_NOT_FOUND', block_ids: preview.missingBlockIds,
    } };
  }
  if (preview.changedBlockIds.length === 0) return { kind: 'refuse', reply: { error: 'This edit changes nothing', code: 'VALIDATION_ERROR' } };
  return {
    kind: landing.landing, landing, call, title: doc.title,
    actionParams: { document_id: call.documentId, summary: call.summary },
  };
}

/** What the model is told where an edit landed: the brief's outcome, with the document named (held to the room's audience by the runner). */
export function documentEditReply(decision: Extract<DocumentEditDecision, { kind: 'direct' | 'suggest' }>, actionId?: string): Record<string, unknown> {
  return {
    document_id: decision.call.documentId,
    title: decision.title,
    url: `/d/${decision.call.documentId}`,
    landing: decision.landing.landing,
    reason: decision.landing.reason,
    ...(decision.landing.landing === 'direct' && actionId ? { undo: { action_id: actionId } } : {}),
  };
}

/**
 * Closes a direct edit's action that came back waiting for approval (an
 * employee whose own trust was lowered between the decision and the write):
 * a pending edit_document action with no suggestion could never be applied,
 * so it expires (and gives up its request key) and a suggestion is queued instead.
 */
export async function expireUnsuggestedEditAction(orgId: string, actionId: string): Promise<void> {
  await db.update(agentActions)
    .set({ approval_status: 'expired', error: 'Superseded: this edit was queued as a suggestion', runtime_request_key: null, updated_at: new Date() })
    .where(and(eq(agentActions.id, actionId), eq(agentActions.org_id, orgId), eq(agentActions.approval_status, 'pending')));
}

// ---------------------------------------------------------------------------
// The landing decided again inside the write (fix round 1, I4)

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

let recheckHookForTest: ((documentId: string) => Promise<void>) | null = null;
/** Test seam: awaited inside the write, before the landing is decided again. */
export function _setDirectEditRecheckHookForTest(hook: ((documentId: string) => Promise<void>) | null): void {
  recheckHookForTest = hook;
}

let beforeDirectWriteHookForTest: ((documentId: string) => Promise<void>) | null = null;
/** Test seam (fix round 2, I4): awaited after a direct edit is decided, before its write starts. */
export function _setBeforeDirectEditWriteHookForTest(hook: ((documentId: string) => Promise<void>) | null): void {
  beforeDirectWriteHookForTest = hook;
}

/**
 * chatEditLanding again, read in the write's transaction `tx` (the document
 * row locked, after the writer's checks): the workspace's trust and, for an
 * employee, the lower of that and its own, read now; the asker's role,
 * setting and the drive, read now; whether another person is in the document;
 * and the same request (the model's mode, the asker's own message, the
 * call). A downgrade that committed before this read leaves the edit a
 * suggestion; one that commits after it orders after the edit.
 */
export async function chatEditLandingInTx(tx: Tx, i: {
  orgId: string; askerId: string; agentEmployeeId?: string | null; documentId: string; params: unknown;
  requestOverride: EditLandingInput['requestOverride']; askerMessageText: string | null;
}): Promise<ChatEditLanding> {
  if (recheckHookForTest) await recheckHookForTest(i.documentId);
  const role = await documentRoleFor(i.askerId, i.orgId, i.documentId, tx);
  const [doc] = await tx.select({ kind: drives.kind, owner: drives.owner_user_id, suggestOnly: drives.agent_suggest_only }).from(documents)
    .innerJoin(drives, and(eq(drives.id, documents.drive_id), eq(drives.org_id, documents.org_id)))
    .where(and(eq(documents.id, i.documentId), eq(documents.org_id, i.orgId), eq(documents.is_deleted, false))).limit(1);
  if (!doc || !role) return { landing: 'refuse', reason: 'asker_cannot_edit' };
  const [org] = await tx.select({ trust_level: orgs.trust_level }).from(orgs).where(eq(orgs.id, i.orgId)).limit(1);
  let trustLevel = lowerTrustLevel(org?.trust_level);
  if (i.agentEmployeeId) {
    const [employee] = await tx.select({ trust_level: agentEmployees.trust_level }).from(agentEmployees).where(and(
      eq(agentEmployees.id, i.agentEmployeeId), eq(agentEmployees.org_id, i.orgId), eq(agentEmployees.is_active, true), eq(agentEmployees.is_deleted, false),
    )).limit(1);
    trustLevel = employee ? lowerTrustLevel(trustLevel, employee.trust_level) : 'conservative';
  }
  return chatEditLanding({
    trustLevel,
    askerId: i.askerId,
    askerRole: role,
    drive: { kind: doc.kind, ownerUserId: doc.owner, agentSuggestOnly: doc.suggestOnly },
    mode: await agentEditModeFor(i.orgId, i.askerId, tx),
    requestOverride: i.requestOverride,
    askerMessageText: i.askerMessageText,
    otherHumansOpen: await otherHumansOpen({ orgId: i.orgId, documentId: i.documentId, askerId: i.askerId }, tx),
  }, i.params);
}

// ---------------------------------------------------------------------------
// One edit per request (fix round 1, I5)

/**
 * The key of one edit (consult O-F5): the triggering message, the document
 * and the operations (canonical JSON), hashed. A redelivered job runs the
 * model again and gets new tool_use ids, so the key never names them: the
 * same edit of the same document for the same message finds the action it
 * already made, and two different edits in one turn stay two. Stored as the
 * direct action's runtime_request_key (the column plans and runtime actions
 * use for the same purpose). Null without a triggering message (only chat
 * has one) or a well-formed call.
 */
export function documentEditRequestKey(orgId: string, messageId: string | null | undefined, input: unknown): string | null {
  const call = parseEditDocumentInput(input);
  if (!messageId || !call) return null;
  const ops = JSON.stringify(call.ops.map((op) => ('block_id' in op ? { op: op.op, block_id: op.block_id, ...('markdown' in op ? { markdown: op.markdown } : {}) }
    : { op: op.op, markdown: op.markdown })));
  return `document-edit:${createHash('sha256').update(`${orgId}\u0000${messageId}\u0000${call.documentId}\u0000${ops}`).digest('hex')}`;
}

type PriorEdit = {
  id: string; approval_status: string; executed_at: Date | null; error: string | null; params: unknown; approved_by_user_id: string | null;
};

/** The chat exception's own action for this request (source document_edit_exception, consult O-F6), if there is one. */
async function priorDocumentEdit(orgId: string, agentEmployeeId: string | null, key: string): Promise<PriorEdit | null> {
  const [row] = await db.select({
    id: agentActions.id, approval_status: agentActions.approval_status, executed_at: agentActions.executed_at,
    error: agentActions.error, params: agentActions.params, approved_by_user_id: agentActions.approved_by_user_id,
  }).from(agentActions).where(and(
    eq(agentActions.org_id, orgId),
    agentEmployeeId ? eq(agentActions.agent_employee_id, agentEmployeeId) : isNull(agentActions.agent_employee_id),
    eq(agentActions.runtime_request_key, key),
    eq(agentActions.action, DOCUMENT_EDIT_ACTION),
    eq(agentActions.source, DOCUMENT_EDIT_EXCEPTION_SOURCE),
  )).orderBy(asc(agentActions.created_at)).limit(1);
  return row ?? null;
}

/** The source of the chat exception's own edit actions. */
export const DOCUMENT_EDIT_EXCEPTION_SOURCE = 'document_edit_exception';

/** Consult O-F2: the request ended (its timeout, or its job lost the queue lease) before the edit was made. */
export const EDIT_CANCELLED = { error: 'The request ended before this edit was made, so nothing changed', code: 'CANCELLED' } as const;

// ---------------------------------------------------------------------------
// The call, as the runner makes it

/** What the runner does with an edit_document call. */
export type DocumentEditOutcome = {
  /** What the model is told (the runner holds it to the room's audience). */
  reply: Record<string, unknown>;
  failed: boolean;
  /** For the run's executed actions: a refusal, or an edit applied or attempted. */
  executed?: { actionId: string | null; success: boolean };
  /** A suggestion to queue: persist makes it from `params.ops`, or links `existingActionId`, whose suggestion exists. */
  pending?: { params: Record<string, unknown>; existingActionId?: string };
};

type DirectResult = { actionId: string; success: boolean; result?: unknown; error?: string; requiresApproval?: boolean };

/**
 * Runs one edit_document call Defty made in a chat (the header): background
 * work is refused, and so is a request that has ended (`abortSignal`,
 * consult O-F2: checked before the decision, before the write and inside
 * it); then, under a transaction-scoped lock on the request key (the
 * message, the document and the operations: consult O-F5, O-F8), the chat
 * exception's own action for this request is reused (fix round 1, I5: its
 * outcome answered again after the asker's access is checked, or an edit
 * that never finished written again through the same checks; one a person
 * approved is never touched, consult O-F6); otherwise the edit is decided,
 * and a direct one written through `executeDirect` with its landing decided
 * again inside the write (I4). The executors are passed in
 * (lib/agent-actions.ts imports this module).
 */
export async function runDocumentEditCall(i: {
  orgId: string; askerId: string; agentEmployeeId?: string; background: boolean; input: unknown; askerMessageText: string | null;
  conversationId: string | null; sourceMessageId?: string; toolUseId: string;
  executeDirect: typeof ExecuteActionDirectFn; executeExisting: typeof ExecuteActionFn;
  /** The request's own signal (agent-reply's timeout, or its job's lost lease): once it fires, nothing is written (consult O-F2). */
  abortSignal?: AbortSignal;
}): Promise<DocumentEditOutcome> {
  // Fix round 2: this path edits for an asker only as Defty. An agent employee
  // edits documents through its own MCP connection, with its own access (M8):
  // here it neither writes nor queues a suggestion on anyone's behalf.
  if (i.agentEmployeeId) {
    return { reply: { error: EMPLOYEE_EDIT_REFUSAL, code: 'EMPLOYEE_EDITS_VIA_MCP' }, failed: true, executed: { actionId: null, success: false } };
  }
  if (i.background) {
    const refused = refusal('unprompted') as Extract<DocumentEditDecision, { kind: 'refuse' }>;
    return { reply: refused.reply, failed: true, executed: { actionId: null, success: false } };
  }
  if (i.abortSignal?.aborted) return cancelledEdit();
  const key = documentEditRequestKey(i.orgId, i.sourceMessageId, i.input);
  if (!key) return decideAndRunEdit(i, null);
  // Consult O-F8: one request at a time per key, with a transaction-scoped
  // lock on the ordinary pool (released when this short transaction ends),
  // never an advisory-pool connection held for the whole decide-and-write.
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-document-edit:${key}`}, 0))`);
    return decideAndRunEdit(i, key);
  });
}

const cancelledEdit = (): DocumentEditOutcome => ({ reply: { ...EDIT_CANCELLED }, failed: true, executed: { actionId: null, success: false } });

/**
 * What an action this request made already did (fix round 2, I5), whatever
 * was recorded on the action itself: its agent version (the edit was
 * written), or its suggestion (it was queued as one).
 */
async function priorEditApplied(orgId: string, actionId: string): Promise<
  | { kind: 'version'; documentId: string; versionId: string; changedBlockIds: string[] }
  | { kind: 'suggestion' }
  | null
> {
  const [version] = await db.select({ id: documentVersions.id, document_id: documentVersions.document_id, edit_details: documentVersions.edit_details })
    .from(documentVersions)
    .where(and(eq(documentVersions.org_id, orgId), eq(documentVersions.kind, 'agent'), eq(documentVersions.action_id, actionId)))
    .limit(1);
  if (version) {
    const details: unknown = version.edit_details;
    const ids: unknown[] = isRecord(details) && Array.isArray(details.changed_block_ids) ? details.changed_block_ids : [];
    return { kind: 'version', documentId: version.document_id, versionId: version.id, changedBlockIds: ids.filter((id): id is string => typeof id === 'string') };
  }
  const [suggestion] = await db.select({ id: documentSuggestions.id }).from(documentSuggestions)
    .where(and(eq(documentSuggestions.org_id, orgId), eq(documentSuggestions.action_id, actionId))).limit(1);
  return suggestion ? { kind: 'suggestion' } : null;
}

/**
 * Settles an approved action this request made whose outcome was never
 * recorded (the job died between the write and its settlement), from what it
 * did: written, the outcome the executor would have stamped (and its
 * receipt); queued as a suggestion, pending again. Returns the action as now.
 */
async function settleAppliedPriorEdit(
  i: Parameters<typeof runDocumentEditCall>[0], key: string, prior: PriorEdit, applied: NonNullable<Awaited<ReturnType<typeof priorEditApplied>>>,
): Promise<PriorEdit> {
  // Consult O-F6: only the chat exception's own direct action, which no person approved.
  const unsettled = and(eq(agentActions.id, prior.id), eq(agentActions.org_id, i.orgId), eq(agentActions.approval_status, 'approved'), isNull(agentActions.executed_at),
    eq(agentActions.source, DOCUMENT_EDIT_EXCEPTION_SOURCE), isNull(agentActions.approved_by_user_id));
  if (applied.kind === 'suggestion') {
    await db.update(agentActions).set({ approval_status: 'pending', approved_at: null, approved_by_user_id: null, updated_at: new Date() }).where(unsettled);
  } else {
    const result = { document_id: applied.documentId, landing: 'direct', changed_block_ids: applied.changedBlockIds, version_id: applied.versionId };
    const [settled] = await db.update(agentActions)
      .set({ result, after_state: { document_id: applied.documentId, version_id: applied.versionId }, executed_at: new Date(), updated_at: new Date() })
      .where(unsettled).returning({ id: agentActions.id });
    if (settled) {
      const { recordDirectActionReceipt } = await import('./direct-action-receipt.js');
      await recordDirectActionReceipt({
        actionId: prior.id, orgId: i.orgId, userId: i.askerId, action: DOCUMENT_EDIT_ACTION, agentEmployeeId: i.agentEmployeeId ?? null,
        outcome: { success: true, result },
      });
    }
  }
  return (await priorDocumentEdit(i.orgId, i.agentEmployeeId ?? null, key)) ?? prior;
}

async function decideAndRunEdit(i: Parameters<typeof runDocumentEditCall>[0], key: string | null): Promise<DocumentEditOutcome> {
  if (i.abortSignal?.aborted) return cancelledEdit();
  const prior = key ? await priorDocumentEdit(i.orgId, i.agentEmployeeId ?? null, key) : null;
  // Consult O-F6: an action a person approved (its suggestion, accepted and
  // being applied, or applied) is theirs: never settled, set back or told as
  // a direct edit here.
  if (prior && prior.approved_by_user_id !== null) return replayPriorEdit(i, prior);
  if (prior && prior.approval_status === 'approved' && prior.executed_at === null) {
    // Fix round 2 (I5): an action this request made that already wrote (or
    // queued) its edit is answered and settled from that, before anything is
    // previewed or decided again: no second preview, landing or suggestion.
    const applied = await priorEditApplied(i.orgId, prior.id);
    if (applied) return replayPriorEdit(i, await settleAppliedPriorEdit(i, key!, prior, applied));
  }
  // A request already answered: its outcome, never a second edit.
  if (prior && !(prior.approval_status === 'approved' && prior.executed_at === null)) return replayPriorEdit(i, prior);

  const decision = await decideDocumentEdit({
    orgId: i.orgId, askerId: i.askerId, agentEmployeeId: i.agentEmployeeId, background: false, input: i.input, askerMessageText: i.askerMessageText,
  });
  if (decision.kind === 'refuse') return { reply: decision.reply, failed: true, executed: { actionId: null, success: false } };
  if (i.abortSignal?.aborted) return cancelledEdit();
  const queue = (landing: Exclude<ChatEditLanding, { landing: 'refuse' }>, existingActionId?: string): DocumentEditOutcome => ({
    reply: documentEditReply({ ...decision, kind: 'suggest', landing }),
    failed: false,
    pending: { params: { ...decision.actionParams, ops: decision.call.ops }, ...(existingActionId ? { existingActionId } : {}) },
  });
  // An unapplied action this request made is never left behind for a new one:
  // the write below decides again and, landing as a suggestion, makes that
  // action the suggestion (fix round 2, I5).
  if (decision.kind === 'suggest' && !prior) return queue(decision.landing);

  // Consult O-F2: inside the write too, a request that has ended writes nothing.
  const recheck = async (tx: Tx): Promise<ChatEditLanding | { landing: 'refuse'; reason: 'cancelled' }> => (i.abortSignal?.aborted
    ? { landing: 'refuse', reason: 'cancelled' }
    : chatEditLandingInTx(tx, {
      orgId: i.orgId, askerId: i.askerId, agentEmployeeId: i.agentEmployeeId, documentId: decision.call.documentId, params: i.input,
      requestOverride: requestOverrideOf(decision.call.mode), askerMessageText: i.askerMessageText,
    }));
  const documentEdit = { ops: decision.call.ops, recheck };
  if (beforeDirectWriteHookForTest) await beforeDirectWriteHookForTest(decision.call.documentId);
  // An edit this request started that never finished is written again under the same action
  // (the writer's already-applied check makes that safe); otherwise a new action.
  const direct: DirectResult = prior
    ? { actionId: prior.id, ...(await i.executeExisting(prior.id, DOCUMENT_EDIT_ACTION, decision.actionParams, i.orgId, i.askerId,
      { ...(i.agentEmployeeId ? { agentEmployeeId: i.agentEmployeeId } : {}), documentEdit })) }
    : await i.executeDirect(DOCUMENT_EDIT_ACTION, decision.actionParams, i.orgId, i.askerId, i.conversationId, 'quick', {
      agentEmployeeId: i.agentEmployeeId,
      source: 'document_edit_exception',
      ...(i.sourceMessageId ? { messageId: i.sourceMessageId } : {}),
      toolUseId: i.toolUseId,
      ...(key ? { runtimeRequestKey: key } : {}),
      documentEdit,
    });
  if (direct.requiresApproval) {
    // The employee's own trust was lowered meanwhile: a suggestion instead.
    await expireUnsuggestedEditAction(i.orgId, direct.actionId);
    return queue({ landing: 'suggest', reason: 'conservative_trust' });
  }
  if (direct.success) {
    // Written: decided direct inside the write, whatever the earlier decision said.
    const written = decision.kind === 'direct' ? decision : { ...decision, kind: 'direct' as const, landing: { landing: 'direct', reason: 'mode_direct' } as const };
    return { reply: documentEditReply(written, direct.actionId), failed: false, executed: { actionId: direct.actionId, success: true } };
  }
  if (direct.error === DIRECT_EDIT_CANCELLED) return { reply: { ...EDIT_CANCELLED }, failed: true, executed: { actionId: direct.actionId, success: false } };
  if (direct.error === DIRECT_EDIT_SUGGESTED) {
    // Decided again inside the write: no longer direct, so the same action now waits as a suggestion.
    const reason = isRecord(direct.result) && typeof direct.result.reason === 'string' ? direct.result.reason : 'conservative_trust';
    return queue({ landing: 'suggest', reason } as Exclude<ChatEditLanding, { landing: 'refuse' }>, direct.actionId);
  }
  return {
    reply: { error: direct.error ?? 'The edit could not be applied', code: 'EDIT_FAILED' },
    failed: true,
    executed: { actionId: direct.actionId, success: false },
  };
}

/**
 * The outcome of an action this request already made (I5), told again only
 * while the asker can still open the document: applied (with its undo id),
 * failed, waiting as a suggestion (linked to this reply), or settled.
 */
async function replayPriorEdit(i: Parameters<typeof runDocumentEditCall>[0], prior: PriorEdit): Promise<DocumentEditOutcome> {
  const params = documentEditActionParams(prior.params);
  const notFound: DocumentEditOutcome = { reply: { error: 'Document not found', code: 'DOCUMENT_NOT_FOUND' }, failed: true };
  if (!params.document_id || !(await documentRoleFor(i.askerId, i.orgId, params.document_id))) return notFound;
  const [doc] = await db.select({ title: documents.title }).from(documents)
    .where(and(eq(documents.id, params.document_id), eq(documents.org_id, i.orgId), eq(documents.is_deleted, false))).limit(1);
  if (!doc) return notFound;
  const named = { document_id: params.document_id, title: doc.title, url: `/d/${params.document_id}` };
  // Consult O-F6: a suggestion the person accepted is theirs, never told as a direct edit.
  if (prior.approved_by_user_id !== null) return { reply: { ...named, landing: 'suggest', reason: 'already_suggested' }, failed: false };
  if (prior.approval_status === 'approved' && !prior.error) {
    return { reply: { ...named, landing: 'direct', reason: 'already_applied', undo: { action_id: prior.id } }, failed: false,
      executed: { actionId: prior.id, success: true } };
  }
  if (prior.approval_status === 'approved') {
    return { reply: { error: prior.error ?? 'The edit could not be applied', code: 'EDIT_FAILED' }, failed: true, executed: { actionId: prior.id, success: false } };
  }
  if (prior.approval_status === 'pending') {
    const ops = parseEditDocumentInput(i.input)?.ops;
    return {
      reply: { ...named, landing: 'suggest', reason: 'already_suggested' },
      failed: false,
      ...(ops ? { pending: { params: { ...params, ops }, existingActionId: prior.id } } : {}),
    };
  }
  return { reply: { error: 'This edit was already settled', code: 'EDIT_ALREADY_SETTLED' }, failed: true };
}

// ---------------------------------------------------------------------------
// What a request already did, when its reply can't come from the run (consult O-F3)

/** The chat exception's edits a request made, as a reply that doesn't come from the run tells them. */
export type TriggerChatEdits = {
  /** One line per edit, for the room: no title or text of the document. */
  lines: string[];
  /** The edits that went straight in, for the reply's run record (references only). */
  executed: Array<{ actionId: string; action: typeof DOCUMENT_EDIT_ACTION; params: Record<string, unknown>; success: true; result: Record<string, unknown> }>;
  /** The edits that wait as a suggestion (one decided again inside its write), to link to the reply: its card and Inbox item. */
  pending: Array<{ action: typeof DOCUMENT_EDIT_ACTION; params: Record<string, unknown>; existing_action_id: string; tool_use_id: string | null; approval_tier: 'quick' }>;
};

/** The line a reply gives for an edit that went straight in (with its undo id) and for one waiting as a suggestion. */
export const TRIGGER_EDIT_DIRECT_LINE = (actionId: string) => `Before this stopped, one document edit went straight in. You can undo it (edit ${actionId}).`;
export const TRIGGER_EDIT_SUGGESTED_LINE = 'One document edit is waiting as a suggestion for you to review.';

/**
 * The chat exception's edits that `askerId`'s triggering message(s) made
 * (source document_edit_exception, `message_id` the trigger), for a reply
 * that replaces the run's own (the runner failed or timed out, or the room's
 * audience changed: consult O-F3). An edit that went straight in is told
 * with its undo id; one decided again inside its write and left as a
 * suggestion is linked to the reply. Nothing names the document.
 */
export async function chatEditsOfTrigger(orgId: string, askerId: string, triggerMessageIds: readonly string[]): Promise<TriggerChatEdits> {
  const ids = [...new Set(triggerMessageIds.filter(Boolean))];
  const found: TriggerChatEdits = { lines: [], executed: [], pending: [] };
  if (ids.length === 0) return found;
  const rows = await db.select({
    id: agentActions.id, approval_status: agentActions.approval_status, executed_at: agentActions.executed_at, error: agentActions.error,
    params: agentActions.params, result: agentActions.result, tool_use_id: agentActions.tool_use_id,
  }).from(agentActions).where(and(
    eq(agentActions.org_id, orgId), eq(agentActions.user_id, askerId), inArray(agentActions.message_id, ids),
    eq(agentActions.action, DOCUMENT_EDIT_ACTION), eq(agentActions.source, DOCUMENT_EDIT_EXCEPTION_SOURCE), isNull(agentActions.agent_employee_id),
  )).orderBy(asc(agentActions.created_at));
  for (const row of rows) {
    const params = documentEditActionParams(row.params);
    if (row.approval_status === 'approved' && row.executed_at !== null && !row.error) {
      found.lines.push(TRIGGER_EDIT_DIRECT_LINE(row.id));
      const result = isRecord(row.result) ? row.result : {};
      found.executed.push({
        actionId: row.id, action: DOCUMENT_EDIT_ACTION, params: { document_id: params.document_id }, success: true,
        result: { document_id: params.document_id, landing: 'direct', ...(typeof result.version_id === 'string' ? { version_id: result.version_id } : {}), undo: { action_id: row.id } },
      });
    } else if (row.approval_status === 'pending') {
      found.lines.push(TRIGGER_EDIT_SUGGESTED_LINE);
      found.pending.push({ action: DOCUMENT_EDIT_ACTION, params, existing_action_id: row.id, tool_use_id: row.tool_use_id, approval_tier: 'quick' });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// create_document's executor (lib/agent-actions.ts)

type CreateOutcome = { success: true; result: { document_id: string; url: string } } | { success: false; result: null; error: string };

const optionalId = (value: unknown): string | undefined | null =>
  value === undefined || value === null || value === '' ? undefined : typeof value === 'string' ? value : null;

/** The Markdown as a document; empty Markdown is an empty document. */
function markdownDocument(markdown: string): JSONContent {
  return markdown.trim() ? markdownToJson(markdown) as JSONContent : structuredClone(EMPTY_DOCUMENT) as JSONContent;
}

/**
 * Creates an approved create_document action's document (the header) as
 * `creatorId` (Defty's asker, or an agent's own user), then records the
 * action with references only: its result `{ document_id, url }`, and its
 * params without the title or the Markdown. Audits the action id.
 */
export async function createAgentDocument(i: {
  orgId: string; actionId: string; creatorId: string; agentEmployeeId?: string | null; params: Record<string, any>;
}): Promise<CreateOutcome> {
  const title = typeof i.params.title === 'string' ? i.params.title.trim() : '';
  if (!title) return { success: false, result: null, error: 'title is required' };
  if (i.params.markdown !== undefined && i.params.markdown !== null && typeof i.params.markdown !== 'string') {
    return { success: false, result: null, error: 'markdown must be text' };
  }
  const driveId = optionalId(i.params.drive_id);
  const folderId = optionalId(i.params.folder_id);
  const parentDocumentId = optionalId(i.params.parent_document_id);
  if (driveId === null || folderId === null || parentDocumentId === null) return { success: false, result: null, error: 'Invalid action target' };
  const json = markdownDocument(typeof i.params.markdown === 'string' ? i.params.markdown : '');

  let documentId: string;
  try {
    const { document, finish } = await db.transaction(async (tx) => {
      // The images the creator may show, read first; linked once the document exists (F15's rule).
      const images = await toolImages(tx, { orgId: i.orgId, uploaderId: i.creatorId, documentId: null, json });
      const created = await createDocumentInTx(tx, {
        orgId: i.orgId, userId: i.creatorId, title, json: images.json, driveId, folderId, parentDocumentId,
      });
      await linkToolImagesInTx(tx, { orgId: i.orgId, uploaderId: i.creatorId, documentId: created.document.id, fileIds: images.link });
      return created;
    });
    await finish();
    documentId = document.id;
  } catch (error) {
    if (error instanceof DocumentRefusal || error instanceof ToolImageChanged) return { success: false, result: null, error: error.message };
    throw error;
  }

  const result = { document_id: documentId, url: `/d/${documentId}` };
  await db.update(agentActions).set({
    result,
    after_state: { document_id: documentId },
    // The title and the Markdown are the document's now, read through its own access (rule C4).
    params: createDocumentInputForStorage(i.params, documentId) as Record<string, unknown>,
    executed_at: new Date(),
  }).where(and(eq(agentActions.id, i.actionId), eq(agentActions.org_id, i.orgId)));
  const agentUserId = i.agentEmployeeId
    ? (await db.select({ user_id: agentEmployees.user_id }).from(agentEmployees)
      .where(and(eq(agentEmployees.id, i.agentEmployeeId), eq(agentEmployees.org_id, i.orgId))).limit(1))[0]?.user_id ?? i.creatorId
    : (await deftyUserId()) ?? i.creatorId;
  await logAuditEvent({
    orgId: i.orgId, actorType: 'agent', actorId: agentUserId, action: CREATE_DOCUMENT_ACTION, entityType: 'document', entityId: documentId,
    metadata: { action_id: i.actionId },
  });
  return { success: true, result };
}
