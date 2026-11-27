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
import { and, eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { agentActions, agentEmployees, orgs } from '@deft/db/schema';
import { documents, drives } from '@deft/db/documents';
import { EMPTY_DOCUMENT, markdownToJson } from '@deft/doc-schema';
import { deriveContent, type JSONContent } from '../collab/persistence.js';
import { readCurrentDocument } from '../collab/server.js';
import { isDestructiveAction, type TrustLevel } from './agent-approval.js';
import { getActiveAgentToolPolicy } from './agent-tool-policy.js';
import { logAuditEvent } from './audit.js';
import { db } from './db.js';
import { createDocumentInputForStorage, editDocumentInputForStorage } from './document-audience.js';
import { documentRoleFor } from './document-access.js';
import { applyOpsToJson, type DocumentEditOp } from './document-edit.js';
import {
  agentEditModeFor, decideEditLanding, otherHumansOpen, type EditLanding, type EditLandingInput,
} from './document-edit-landing.js';
import { DOCUMENT_EDIT_ACTION } from './document-suggestions.js';
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
  return {
    document_id: typeof record.document_id === 'string' ? record.document_id : '',
    summary: typeof record.summary === 'string' ? record.summary.trim().slice(0, MAX_SUMMARY) : '',
    ...(typeof record.suggestion_id === 'string' ? { suggestion_id: record.suggestion_id } : {}),
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

/** The model's `mode`, as M5's requestOverride: exactly what it sent, or null when it sent none. */
function requestOverrideOf(mode: unknown): EditLandingInput['requestOverride'] {
  return mode === undefined || mode === null ? null : mode as EditLandingInput['requestOverride'];
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
 * so it expires and the runner queues a suggestion instead.
 */
export async function expireUnsuggestedEditAction(orgId: string, actionId: string): Promise<void> {
  await db.update(agentActions)
    .set({ approval_status: 'expired', error: 'Superseded: this edit was queued as a suggestion', updated_at: new Date() })
    .where(and(eq(agentActions.id, actionId), eq(agentActions.org_id, orgId), eq(agentActions.approval_status, 'pending')));
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
