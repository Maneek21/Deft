// The edit engine (spec 5.7; plan Task M4 with the 25 Nov consult's
// changes): block-id operations on a document, applied straight in for an
// agent, credited, highlighted, audited, and undone block by block. Defty's
// write tools (M5–M7) build on it; where an edit lands is M5's to decide.
//
// Operations name top-level blocks by id (the ids read_document shows):
// `replace` keeps the target's id (comments anchored on it stay anchored)
// and any further blocks its Markdown holds follow it with new ids;
// `insert_after` and `append` add blocks with new ids; `delete` removes one.
// An id written in the Markdown (`<!-- block:… -->`) never becomes a block's
// id. applyOpsToJson is the pure form, for previews and tests: with an
// `idSeed` (the action id, as applyDocumentEditDirect passes) the new ids
// are the same on every call, so `selectedBlockIds`, the changed blocks to
// keep, can name blocks the edit adds.
//
// A direct edit is one write through the one writer (rule C2):
// writeDocument with the agent as actor (Defty carries the asker, and the
// writer checks the asker's role), reason `agent_edit`, the default
// required role (edit). The operations run on the content the writer hands
// `mutate`, the document as it is now (pending live edits included), never
// on content_json, which lags the live state. Only the changed top-level
// blocks are touched: each is swapped for a copy built with jsonToYDoc, or
// inserted or deleted, so typing elsewhere in the document survives, and the
// change reaches everyone connected as one Yjs transaction (one undo step).
// When an id the operations name isn't there, the whole edit is refused
// (DocumentEditRefused, BLOCK_NOT_FOUND, with the ids) and nothing is written.
//
// Credit: in the write's own transaction, an `agent` version by the asker,
// with the agent and the action id, and edit_details { action_id,
// agent_user_id, asker_user_id, summary, changed_block_ids, before (each
// changed block before the edit, null for an added one), after_hashes (each
// changed block's blockHash after it, null for a deleted one),
// previous_sibling_ids (each deleted block's previous top-level block, null
// for the first) }. Names are never stored where a reader may not see the
// person (review I3, people-visibility rules): the version is named "Agent
// edit: {summary}", and F8's version list and detail show "{agent}, at
// {asker}'s request: {summary}" resolved for each viewer, "A collaborator"
// for someone hidden from them (document-versions.ts). Automatic versions are
// paused around the write, as a restore pauses them. Highlight: the live
// document's Y map `deft_meta`, key `agent_highlights`, gets { blockIds,
// agentUserId, askerUserId, until: server time + 30 minutes, ISO 8601 }
// appended, people by id only (the editor resolves names per viewer, as F12's
// presence does), and entries whose time has passed are dropped. Audit:
// logAuditEvent `edit_document` with the action id only, never content.
//
// Retry-safe: an action already applied to the document (its `agent`
// version, at most one per action by F2's partial unique index) writes
// nothing and returns that version. The check is the writer's `beforeMutate`
// (review I1, I2): inside the write, with the document row locked, after
// every writer check (the asker's role, the drive setting, Defty's identity)
// and before anything changes or is measured. So two runs at once write once,
// a retry is never refused BLOCK_NOT_FOUND or TOO_LARGE for the first run's
// change, and a retry by an actor or asker who has lost the right gets the
// writer's refusal, never the first run's references.
//
// An accepted suggestion (M6, lib/document-suggestions.ts) is applied by the
// same function, with only the blocks the asker chose (`selectedBlockIds`)
// and AgentEditWriteOptions: reason 'suggestion' (allowed on a drive set to
// suggestions only), the revision the asker reviewed (`expectedRevision`),
// the reviewed result applied block by block rather than the operations
// replayed (`fromProposal`, applyProposalToJson: a chosen block someone
// deleted since goes back where the proposal has it, as undo places deleted
// blocks), and the suggestion's outcome committed in the same transaction.
// So its version, credit, highlight, audit and undo are a direct edit's.
//
// Undo (POST /api/documents/agent-edits/:actionId/undo): through the one
// writer as the person undoing, reason `restore`, needs edit. For each block
// the edit changed, compared with the live document: a block whose hash is
// still the edit's is put back as it was before (an added one removed); a
// deleted block still missing goes back after its previous sibling (at the
// start when it was first); a block already as it was before needs nothing;
// any other is conflicted and left alone. When a deleted run's outside
// neighbour is gone, the run's first block goes to the end and the rest
// follow it in order (review I4). A `restore` version records the undo, and
// the undone blocks leave the highlight. An undo already made (checked in
// `beforeMutate`) restores nothing and reports no conflicts; when nothing can
// be restored nothing is written.
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import * as Y from 'yjs';
import { documentVersions } from '@deft/db/documents';
import { blockHash, DOCUMENT_FRAGMENT, jsonToYDoc, markdownToJson, topLevelBlocks } from '@deft/doc-schema';
import { deriveContent, type JSONContent } from '../collab/persistence.js';
import { logAuditEvent } from './audit.js';
import { db } from './db.js';
import { documentRoleFor, roleAtLeast } from './document-access.js';
import { createVersionInTx, withAutomaticVersionsPaused } from './document-versions.js';
import { DocumentRefusal } from './documents.js';
import { DocumentWriteRefused, writeDocument } from './document-writer.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export type DocumentEditOp =
  | { op: 'replace'; block_id: string; markdown: string }
  | { op: 'insert_after'; block_id: string; markdown: string }
  | { op: 'append'; markdown: string }
  | { op: 'delete'; block_id: string };

/** BLOCK_NOT_FOUND: blocks the operations name aren't in the document (`blockIds`); nothing was written. */
export class DocumentEditRefused extends Error {
  constructor(readonly code: 'BLOCK_NOT_FOUND', readonly blockIds: string[]) {
    super('Some blocks the edit names are not in the document');
  }
}

/** How long an agent edit's highlight lasts. */
export const AGENT_HIGHLIGHT_MS = 30 * 60 * 1000;
const HIGHLIGHT_MAP = 'deft_meta';
const HIGHLIGHT_KEY = 'agent_highlights';

/** One entry of `deft_meta.agent_highlights`: people by id only (the header). */
type AgentHighlight = { blockIds: string[]; agentUserId: string; askerUserId: string; until: string };

/** The stored name of an agent version: it names nobody (the header). */
export function agentEditVersionName(summary: string): string {
  return summary ? `Agent edit: ${summary}` : 'Agent edit';
}

/** What an agent version's edit_details holds (the header). */
type EditDetails = {
  action_id: string;
  agent_user_id: string;
  asker_user_id: string;
  summary: string;
  changed_block_ids: string[];
  before: Record<string, JSONContent | null>;
  after_hashes: Record<string, string | null>;
  previous_sibling_ids: Record<string, string | null>;
};

/** `record[key]` when it is the record's own key (a block id may be any token, `constructor` included). */
function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

const idOf = (node: JSONContent): string | null => (typeof node.attrs?.id === 'string' ? node.attrs.id : null);
const withId = (node: JSONContent, id: string): JSONContent => ({ ...node, attrs: { ...node.attrs, id } });

/** A UUID-shaped id from the sha256 of `seed` (as ensureBlockIds derives one): the same seed always gives the same id. */
function seededId(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Every id in the document, at any depth: a new block's id is never one of them. */
function idsIn(json: JSONContent): Set<string> {
  const ids = new Set<string>();
  const stack: JSONContent[] = [json];
  while (stack.length) {
    const node = stack.pop()!;
    const id = idOf(node);
    if (id !== null) ids.add(id);
    if (node.content) stack.push(...node.content);
  }
  return ids;
}

/** The top-level blocks the Markdown holds (an empty paragraph for none). */
function blocksOf(markdown: string): JSONContent[] {
  return markdownToJson(markdown).content ?? [];
}

// ---------------------------------------------------------------------------
// The operations on JSON

/**
 * Applies `ops` in order to the document's top-level blocks (the header).
 * Returns the new document, the ids of the blocks it changed (in the order
 * first changed: replaced, added and deleted), each changed block as it was
 * before (null for an added one) and the ids the operations name that aren't
 * there (each once, in order); those operations are skipped. A block this
 * edit added can't be named. With `idSeed`, new ids are the same on every
 * call; with `selectedBlockIds`, only the changes to those blocks are made.
 * `json` is not changed.
 */
export function applyOpsToJson(json: JSONContent, ops: DocumentEditOp[], opts: { idSeed?: string; selectedBlockIds?: readonly string[] } = {}):
  { json: JSONContent; changedBlockIds: string[]; before: Record<string, JSONContent | null>; missingBlockIds: string[] } {
  const original = json.content ?? [];
  const originalById = new Map<string, JSONContent>();
  for (const node of original) {
    const id = idOf(node);
    if (id !== null && !originalById.has(id)) originalById.set(id, node);
  }
  const working = [...original];
  const taken = idsIn(json);
  const selected = opts.selectedBlockIds ? new Set(opts.selectedBlockIds) : null;
  const keep = (id: string) => selected === null || selected.has(id);
  const before = new Map<string, JSONContent | null>();
  const changed: string[] = [];
  const missing: string[] = [];
  /** The last block this edit put after each anchor, so the next insert after it follows. */
  const lastAfter = new Map<string, string>();

  const freshId = (opIndex: number, n: number): string => {
    let id: string;
    if (opts.idSeed === undefined) {
      id = randomUUID();
      while (taken.has(id)) id = randomUUID();
    } else {
      const seed = `${opts.idSeed}\u0000${opIndex}\u0000${n}`;
      id = seededId(seed);
      for (let attempt = 1; taken.has(id); attempt += 1) id = seededId(`${seed}\u0000${attempt}`);
    }
    taken.add(id);
    return id;
  };
  const mark = (id: string, was: JSONContent | null) => {
    if (before.has(id)) return;
    before.set(id, was);
    changed.push(id);
  };
  const indexOf = (id: string) => working.findIndex((node) => idOf(node) === id);
  /** Inserts `nodes` (each with a fresh id) at `at`, the kept ones only; returns the last id inserted. */
  const insertAt = (at: number, nodes: JSONContent[], opIndex: number, firstN: number): string | null => {
    let last: string | null = null;
    nodes.forEach((node, k) => {
      const id = freshId(opIndex, firstN + k);
      if (!keep(id)) return;
      working.splice(at, 0, withId(node, id));
      at += 1;
      mark(id, null);
      last = id;
    });
    return last;
  };

  ops.forEach((op, opIndex) => {
    if (op.op === 'append') {
      insertAt(working.length, blocksOf(op.markdown), opIndex, 0);
      return;
    }
    const at = indexOf(op.block_id);
    if (at < 0 || !originalById.has(op.block_id)) {
      if (!missing.includes(op.block_id)) missing.push(op.block_id);
      return;
    }
    const was = originalById.get(op.block_id)!;
    if (op.op === 'delete') {
      if (!keep(op.block_id)) return;
      working.splice(at, 1);
      mark(op.block_id, was);
      return;
    }
    const nodes = blocksOf(op.markdown);
    if (op.op === 'replace') {
      const [first, ...rest] = nodes;
      if (first && keep(op.block_id)) {
        working[at] = withId(first, op.block_id);
        mark(op.block_id, was);
      }
      const last = insertAt(at + 1, rest, opIndex, 1);
      if (last) lastAfter.set(op.block_id, last);
      return;
    }
    const anchor = lastAfter.get(op.block_id);
    const after = anchor !== undefined && indexOf(anchor) >= 0 ? indexOf(anchor) : at;
    const last = insertAt(after + 1, nodes, opIndex, 0);
    if (last) lastAfter.set(op.block_id, last);
  });

  return { json: { ...json, content: working }, changedBlockIds: changed, before: Object.fromEntries(before), missingBlockIds: missing };
}

/**
 * Applies a reviewed result block by block (an accepted suggestion,
 * lib/document-suggestions.ts): for each of `selectedBlockIds`, in order,
 * `proposed` is the truth, whatever the operations that made it were.
 *
 * - A block in `proposed` and in `json` is replaced with the proposed one, in
 *   place.
 * - A block in `proposed` that `json` no longer has goes in with its id and
 *   proposed content after its previous sibling in `proposed` (first when it
 *   has none), as undo puts deleted blocks back. That sibling may itself be
 *   going in. When no waiting block can be placed, the root of a waiting
 *   chain (one whose previous sibling isn't waiting) goes to the end and the
 *   others follow it.
 * - A block `proposed` doesn't have (the proposal deletes it) is deleted, or,
 *   when it is already gone, counts as applied with nothing to do.
 *
 * Other blocks are untouched. The return value is applyOpsToJson's: every
 * selected block is a change, each as it was in `json` (null when it wasn't
 * there, so undo removes a block that went in). `json` is not changed.
 */
export function applyProposalToJson(json: JSONContent, proposed: JSONContent, selectedBlockIds: readonly string[]):
  { json: JSONContent; changedBlockIds: string[]; before: Record<string, JSONContent | null>; missingBlockIds: string[] } {
  const working = [...(json.content ?? [])];
  const proposedBlocks = proposed.content ?? [];
  const proposedAt = new Map<string, number>();
  proposedBlocks.forEach((node, at) => {
    const id = idOf(node);
    if (id !== null && !proposedAt.has(id)) proposedAt.set(id, at);
  });
  const indexOf = (id: string) => working.findIndex((node) => idOf(node) === id);
  const before = new Map<string, JSONContent | null>();
  const changed: string[] = [];
  const goingIn: Array<{ node: JSONContent; previous: string | null }> = [];

  for (const id of selectedBlockIds) {
    if (before.has(id)) continue;
    const at = proposedAt.get(id);
    const i = indexOf(id);
    if (at === undefined) {
      // The proposal deletes it.
      before.set(id, i >= 0 ? working[i]! : null);
      if (i >= 0) working.splice(i, 1);
    } else if (i >= 0) {
      before.set(id, working[i]!);
      working[i] = withId(proposedBlocks[at]!, id);
    } else {
      before.set(id, null);
      goingIn.push({ node: withId(proposedBlocks[at]!, id), previous: at > 0 ? idOf(proposedBlocks[at - 1]!) : null });
    }
    changed.push(id);
  }

  // Undo's placement (undoInDoc): after the previous sibling, which may be
  // going in too; a chain whose outside neighbour is gone starts at the end.
  let waiting = goingIn;
  while (waiting.length > 0) {
    const still: typeof goingIn = [];
    for (const entry of waiting) {
      const at = entry.previous === null ? 0 : indexOf(entry.previous) + 1;
      if (entry.previous !== null && at === 0) still.push(entry);
      else working.splice(at, 0, entry.node);
    }
    if (still.length === waiting.length) {
      const stillIds = new Set(still.map((entry) => idOf(entry.node)));
      const root = still.find((entry) => !stillIds.has(entry.previous)) ?? still[0]!;
      working.push(root.node);
      still.splice(still.indexOf(root), 1);
    }
    waiting = still;
  }

  return { json: { ...json, content: working }, changedBlockIds: changed, before: Object.fromEntries(before), missingBlockIds: [] };
}

// ---------------------------------------------------------------------------
// The live document

/** The document's JSON with block ids, written back into `doc` as a store does; INVALID_CONTENT outside the schema. */
function contentOf(doc: Y.Doc): JSONContent {
  try {
    return deriveContent(doc).json;
  } catch {
    throw new DocumentWriteRefused('INVALID_CONTENT');
  }
}

/** The top-level blocks' hashes, by id. */
function hashesOf(json: JSONContent): Map<string, string> {
  return new Map(topLevelBlocks(json).map((block) => [block.id, blockHash(block.node)]));
}

/** The position of the top-level block `id` in the fragment, or -1. */
function indexById(fragment: Y.XmlFragment, id: string): number {
  return fragment.toArray().findIndex((child) => child instanceof Y.XmlElement && child.getAttribute('id') === id);
}

/** A new, unattached element for one top-level block (plan: built in a scratch Y.Doc by jsonToYDoc). */
function elementFor(node: JSONContent): Y.XmlElement {
  const scratch = jsonToYDoc({ type: 'doc', content: [node] });
  try {
    return (scratch.getXmlFragment(DOCUMENT_FRAGMENT).get(0) as Y.XmlElement).clone();
  } finally {
    scratch.destroy();
  }
}

/**
 * Makes the fragment's top-level blocks follow `next` (applyOpsToJson's
 * result on the fragment's content), touching only the changed blocks: a
 * deleted one is removed; a replaced one is swapped in place; an added one
 * goes after the block before it in `next` (first when there is none).
 */
function applyToFragment(doc: Y.Doc, next: JSONContent, changedBlockIds: string[]): void {
  const fragment = doc.getXmlFragment(DOCUMENT_FRAGMENT);
  const blocks = next.content ?? [];
  const kept = new Set(blocks.map(idOf));
  const changed = new Set(changedBlockIds);
  doc.transact(() => {
    for (const id of changedBlockIds) {
      if (kept.has(id)) continue;
      const at = indexById(fragment, id);
      if (at >= 0) fragment.delete(at, 1);
    }
    let previous: string | null = null;
    for (const node of blocks) {
      const id = idOf(node)!;
      if (changed.has(id)) {
        const at = indexById(fragment, id);
        if (at >= 0) {
          fragment.delete(at, 1);
          fragment.insert(at, [elementFor(node)]);
        } else {
          fragment.insert(previous === null ? 0 : indexById(fragment, previous) + 1, [elementFor(node)]);
        }
      }
      previous = id;
    }
  });
}

function isHighlight(value: unknown): value is AgentHighlight {
  const h = value as AgentHighlight | null;
  return typeof h === 'object' && h !== null && Array.isArray(h.blockIds) && typeof h.agentUserId === 'string'
    && typeof h.askerUserId === 'string' && typeof h.until === 'string';
}

/** Sets the highlights: entries whose time has passed are dropped, then `change` gives the list to keep. */
function updateHighlights(doc: Y.Doc, change: (current: AgentHighlight[]) => AgentHighlight[]): void {
  const meta = doc.getMap(HIGHLIGHT_MAP);
  const stored: unknown = meta.get(HIGHLIGHT_KEY);
  const now = Date.now();
  const current = (Array.isArray(stored) ? stored : []).filter(isHighlight).filter((h) => Date.parse(h.until) > now);
  const next = change(current).filter((h) => h.blockIds.length > 0);
  doc.transact(() => {
    if (next.length > 0) meta.set(HIGHLIGHT_KEY, next);
    else if (meta.has(HIGHLIGHT_KEY)) meta.delete(HIGHLIGHT_KEY);
  });
}

/** Runs the edit on the live document `doc` (the header); returns its edit_details. */
function editInDoc(doc: Y.Doc, i: {
  actionId: string; agentUserId: string; askerId: string; summary: string; ops: DocumentEditOp[]; selectedBlockIds?: string[];
  fromProposal?: JSONContent;
}): EditDetails {
  const current = contentOf(doc);
  // An accepted suggestion applies its reviewed result block by block; a direct edit runs the operations.
  const result = i.fromProposal
    ? applyProposalToJson(current, i.fromProposal, i.selectedBlockIds ?? [])
    : applyOpsToJson(current, i.ops, { idSeed: i.actionId, selectedBlockIds: i.selectedBlockIds });
  if (result.missingBlockIds.length > 0) throw new DocumentEditRefused('BLOCK_NOT_FOUND', result.missingBlockIds);
  if (result.changedBlockIds.length === 0 && i.fromProposal) throw new DocumentEditRefused('BLOCK_NOT_FOUND', []);
  applyToFragment(doc, result.json, result.changedBlockIds);

  const after = hashesOf(contentOf(doc));
  const order = (current.content ?? []).map(idOf);
  const details: EditDetails = {
    action_id: i.actionId, agent_user_id: i.agentUserId, asker_user_id: i.askerId, summary: i.summary,
    changed_block_ids: result.changedBlockIds, before: result.before, after_hashes: {}, previous_sibling_ids: {},
  };
  const afterHashes = new Map<string, string | null>();
  const previousIds = new Map<string, string | null>();
  for (const id of result.changedBlockIds) {
    afterHashes.set(id, after.get(id) ?? null);
    if (!after.has(id)) {
      const at = order.indexOf(id);
      previousIds.set(id, at > 0 ? order[at - 1]! : null);
    }
  }
  details.after_hashes = Object.fromEntries(afterHashes);
  details.previous_sibling_ids = Object.fromEntries(previousIds);

  const shown = result.changedBlockIds.filter((id) => after.has(id));
  const until = new Date(Date.now() + AGENT_HIGHLIGHT_MS).toISOString();
  updateHighlights(doc, (list) => [...list, { blockIds: shown, agentUserId: i.agentUserId, askerUserId: i.askerId, until }]);
  return details;
}

// ---------------------------------------------------------------------------
// Direct edits

/** Thrown inside a write to roll it back: the action was already applied. */
class AlreadyApplied extends Error {
  constructor(readonly result: { versionId: string; changedBlockIds: string[] }) { super('already applied'); }
}

/** The action's agent version on this document, if it was applied. */
async function appliedEdit(x: Executor, orgId: string, documentId: string, actionId: string): Promise<{ versionId: string; changedBlockIds: string[] } | null> {
  const [row] = await x.select({ id: documentVersions.id, edit_details: documentVersions.edit_details }).from(documentVersions).where(and(
    eq(documentVersions.org_id, orgId), eq(documentVersions.document_id, documentId), eq(documentVersions.kind, 'agent'),
    eq(documentVersions.action_id, actionId),
  )).limit(1);
  if (!row) return null;
  const ids = (row.edit_details as Partial<EditDetails> | null)?.changed_block_ids;
  return { versionId: row.id, changedBlockIds: Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [] };
}

/**
 * How an accepted suggestion's write (lib/document-suggestions.ts, M6)
 * differs from a direct edit. The result is otherwise the same: one `agent`
 * version, credit, highlight, audit and undo, for the blocks applied.
 */
export type AgentEditWriteOptions = {
  /** 'suggestion' for an accepted suggestion, which a drive set to suggestions only allows. Default 'agent_edit'. */
  reason?: 'agent_edit' | 'suggestion';
  /** The writer refuses REVISION_CHANGED unless the document is still at this revision. */
  expectedRevision?: number;
  /** The reviewed result to apply block by block for `selectedBlockIds` (applyProposalToJson) instead of running the operations. */
  fromProposal?: JSONContent;
  /** The caller's work in the write's transaction, after the agent version: it commits or rolls back with the edit. */
  inTransaction?: (tx: Tx, applied: { versionId: string; changedBlockIds: string[] }) => Promise<void>;
  /**
   * The caller's check in the write's transaction, with the document row
   * locked and after every writer check (and the already-applied check),
   * before anything changes: whatever it throws rolls the write back and is
   * rethrown (M7 fix round 1, I4: the chat exception's landing, decided again).
   */
  beforeWrite?: (tx: Tx) => Promise<void>;
};

/**
 * Applies the agent's operations straight into the document (the header), at
 * the asker's request, as one write through writeDocument. Returns the agent
 * version and the changed block ids; an action already applied returns its
 * version and writes nothing, once the writer's checks have passed. Throws
 * DocumentEditRefused (BLOCK_NOT_FOUND) or the writer's DocumentWriteRefused
 * (FORBIDDEN, TOO_LARGE, BUSY, INVALID_CONTENT, and REVISION_CHANGED with
 * `opts.expectedRevision`), having written nothing.
 */
export async function applyDocumentEditDirect(i: { orgId: string; documentId: string; agentUserId: string; askerId: string;
  actionId: string; ops: DocumentEditOp[]; summary: string; selectedBlockIds?: string[] },
opts: AgentEditWriteOptions = {}): Promise<{ versionId: string; changedBlockIds: string[] }> {
  const summary = i.summary.trim();
  const outcome: { details: EditDetails | null; versionId: string | null } = { details: null, versionId: null };
  try {
    await withAutomaticVersionsPaused(i.orgId, i.documentId, () => writeDocument({
      orgId: i.orgId,
      documentId: i.documentId,
      actor: { kind: 'agent', userId: i.agentUserId, askerId: i.askerId, actionId: i.actionId },
      reason: opts.reason ?? 'agent_edit',
      expectedRevision: opts.expectedRevision,
      // After the writer's checks, with the row locked, before anything changes (the header).
      beforeMutate: async (tx) => {
        const already = await appliedEdit(tx, i.orgId, i.documentId, i.actionId);
        if (already) throw new AlreadyApplied(already);
        await opts.beforeWrite?.(tx);
      },
      mutate: (doc) => {
        outcome.details = editInDoc(doc, {
          actionId: i.actionId, agentUserId: i.agentUserId, askerId: i.askerId, summary, ops: i.ops, selectedBlockIds: i.selectedBlockIds,
          fromProposal: opts.fromProposal,
        });
      },
      // The credit commits with the content, or neither does.
      inTransaction: async (tx, { afterJson }) => {
        const created = await createVersionInTx(tx, {
          orgId: i.orgId, documentId: i.documentId, kind: 'agent', name: agentEditVersionName(summary), createdBy: i.askerId,
          agentUserId: i.agentUserId, actionId: i.actionId, editDetails: outcome.details, json: afterJson,
        });
        outcome.versionId = created.id;
        await opts.inTransaction?.(tx, { versionId: created.id, changedBlockIds: outcome.details!.changed_block_ids });
      },
    }));
  } catch (error) {
    if (error instanceof AlreadyApplied) return error.result;
    throw error;
  }
  await logAuditEvent({
    orgId: i.orgId, actorType: 'agent', actorId: i.agentUserId, action: 'edit_document', entityType: 'document', entityId: i.documentId,
    metadata: { action_id: i.actionId },
  });
  return { versionId: outcome.versionId!, changedBlockIds: outcome.details!.changed_block_ids };
}

// ---------------------------------------------------------------------------
// Undo

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** An agent version's edit_details, or null when it isn't one this engine wrote. */
function detailsOf(value: unknown): EditDetails | null {
  if (!isRecord(value) || typeof value.action_id !== 'string' || !isStringArray(value.changed_block_ids)) return null;
  if (!isRecord(value.before) || !isRecord(value.after_hashes)) return null;
  const text = (field: unknown) => (typeof field === 'string' ? field : '');
  return {
    action_id: value.action_id,
    agent_user_id: text(value.agent_user_id),
    asker_user_id: text(value.asker_user_id),
    summary: text(value.summary),
    changed_block_ids: value.changed_block_ids,
    before: value.before as Record<string, JSONContent | null>,
    after_hashes: value.after_hashes as Record<string, string | null>,
    previous_sibling_ids: (isRecord(value.previous_sibling_ids) ? value.previous_sibling_ids : {}) as Record<string, string | null>,
  };
}

/** Thrown inside an undo's write to roll it back. */
class UndoWritesNothing extends Error {
  constructor(readonly conflicted: string[]) { super('nothing to undo'); }
}

/** True when the action's edit of this document was already undone (its restore version). */
async function undoneAlready(x: Executor, orgId: string, documentId: string, actionId: string): Promise<boolean> {
  const [row] = await x.select({ id: documentVersions.id }).from(documentVersions).where(and(
    eq(documentVersions.org_id, orgId), eq(documentVersions.document_id, documentId), eq(documentVersions.kind, 'restore'),
    sql`${documentVersions.edit_details}->>'undo_of_action_id' = ${actionId}`,
  )).limit(1);
  return Boolean(row);
}

/** Undoes the edit in the live document `doc` (the header). */
function undoInDoc(doc: Y.Doc, details: EditDetails): { restored: string[]; conflicted: string[] } {
  const fragment = doc.getXmlFragment(DOCUMENT_FRAGMENT);
  const now = new Map(topLevelBlocks(contentOf(doc)).map((block) => [block.id, block.node]));
  const restored: string[] = [];
  const conflicted: string[] = [];
  const missing: string[] = [];
  doc.transact(() => {
    for (const id of details.changed_block_ids) {
      const afterHash = own(details.after_hashes, id) ?? null;
      const was = own(details.before, id) ?? null;
      const current = now.get(id);
      const currentHash = current ? blockHash(current) : null;
      if (was !== null && currentHash === blockHash(was)) continue; // already as it was
      if (afterHash === null) {
        // Deleted by the edit.
        if (was !== null && currentHash === null) missing.push(id);
        else if (was !== null) conflicted.push(id);
        continue;
      }
      if (currentHash === null && was === null) continue; // added by the edit, and gone already
      if (currentHash !== afterHash) {
        conflicted.push(id);
        continue;
      }
      const at = indexById(fragment, id);
      fragment.delete(at, 1);
      if (was !== null) fragment.insert(at, [elementFor(withId(was, id))]);
      restored.push(id);
    }
    // Deleted blocks go back after their previous sibling, which may be one of them.
    const putBack = (id: string, at: number) => {
      fragment.insert(at, [elementFor(withId(own(details.before, id)!, id))]);
      restored.push(id);
    };
    const previousOf = (id: string) => own(details.previous_sibling_ids, id) ?? null;
    let pending = missing;
    while (pending.length > 0) {
      const waiting: string[] = [];
      for (const id of pending) {
        const previous = previousOf(id);
        const at = previous === null ? 0 : indexById(fragment, previous) + 1;
        if (previous !== null && at === 0) waiting.push(id);
        else putBack(id, at);
      }
      if (waiting.length === pending.length) {
        // A run whose outside neighbour is gone: its first block goes to the
        // end (rather than not at all), and the rest follow it in order on
        // the next pass. Its first block is the one whose previous sibling
        // isn't itself waiting.
        const waitingIds = new Set(waiting);
        const root = waiting.find((id) => !waitingIds.has(previousOf(id)!)) ?? waiting[0]!;
        putBack(root, fragment.length);
        waiting.splice(waiting.indexOf(root), 1);
      }
      pending = waiting;
    }
    if (restored.length > 0) {
      const undone = new Set(restored);
      updateHighlights(doc, (list) => list.map((h) => ({ ...h, blockIds: h.blockIds.filter((id) => !undone.has(id)) })));
    }
  });
  return { restored, conflicted };
}

/** Undoes one document's edit as `userId`, through the one writer (the header). */
async function undoDocumentEdit(i: { orgId: string; actionId: string; userId: string },
  version: { id: string; documentId: string; name: string | null; details: EditDetails }): Promise<{ restored: string[]; conflicted: string[] }> {
  const outcome: { restored: string[]; conflicted: string[] } = { restored: [], conflicted: [] };
  try {
    await withAutomaticVersionsPaused(i.orgId, version.documentId, () => writeDocument({
      orgId: i.orgId,
      documentId: version.documentId,
      actor: { kind: 'user', userId: i.userId },
      reason: 'restore',
      requiredRole: 'edit',
      // An undo already made: nothing restored, no conflicts (checked after the writer's checks, with the row locked).
      beforeMutate: async (tx) => {
        if (await undoneAlready(tx, i.orgId, version.documentId, i.actionId)) throw new UndoWritesNothing([]);
      },
      mutate: (doc) => {
        const result = undoInDoc(doc, version.details);
        if (result.restored.length === 0) throw new UndoWritesNothing(result.conflicted);
        outcome.restored = result.restored;
        outcome.conflicted = result.conflicted;
      },
      inTransaction: async (tx, { afterJson }) => {
        await createVersionInTx(tx, {
          orgId: i.orgId, documentId: version.documentId, kind: 'restore', name: `Undo of ${version.name ?? 'an agent edit'}`, createdBy: i.userId,
          editDetails: {
            undo_of_action_id: i.actionId, undo_of_version_id: version.id, restored_block_ids: outcome.restored, conflicted_block_ids: outcome.conflicted,
          },
          json: afterJson,
        });
      },
    }));
  } catch (error) {
    if (error instanceof UndoWritesNothing) return { restored: [], conflicted: error.conflicted };
    throw error;
  }
  await logAuditEvent({
    orgId: i.orgId, actorType: 'user', actorId: i.userId, action: 'undo_document_edit', entityType: 'document', entityId: version.documentId,
    metadata: { action_id: i.actionId },
  });
  return outcome;
}

const editNotFound = () => new DocumentRefusal(404, 'NOT_FOUND', 'Edit not found');

/**
 * Undoes the agent action's direct edit (the header), as `userId`, who needs
 * edit on the document: 404 NOT_FOUND when there is no such edit or they
 * can't open its document, 403 FORBIDDEN_ROLE below edit, and the writer's
 * refusals. Returns the blocks put back and those left alone as conflicted.
 */
export async function undoAgentEdit(i: { orgId: string; actionId: string; userId: string }): Promise<{ restoredBlockIds: string[]; conflictedBlockIds: string[] }> {
  const rows = await db.select({
    id: documentVersions.id, document_id: documentVersions.document_id, name: documentVersions.name, edit_details: documentVersions.edit_details,
  }).from(documentVersions).where(and(
    eq(documentVersions.org_id, i.orgId), eq(documentVersions.kind, 'agent'), eq(documentVersions.action_id, i.actionId),
  )).orderBy(asc(documentVersions.created_at), asc(documentVersions.id));
  if (rows.length === 0) throw editNotFound();
  // Every document first, so a refusal changes nothing.
  for (const row of rows) {
    const role = await documentRoleFor(i.userId, i.orgId, row.document_id);
    if (!role) throw editNotFound();
    if (!roleAtLeast(role, 'edit')) throw new DocumentRefusal(403, 'FORBIDDEN_ROLE', 'Undoing an edit needs can edit');
  }
  const restoredBlockIds: string[] = [];
  const conflictedBlockIds: string[] = [];
  for (const row of rows) {
    const details = detailsOf(row.edit_details);
    if (!details) continue;
    const result = await undoDocumentEdit(i, { id: row.id, documentId: row.document_id, name: row.name, details });
    restoredBlockIds.push(...result.restored);
    conflictedBlockIds.push(...result.conflicted);
  }
  return { restoredBlockIds, conflictedBlockIds };
}
