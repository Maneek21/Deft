// Document versions (spec 5.6; plan Task F8): automatic, named, agent,
// restore, import and moved versions, the version list, viewing a version
// and restoring one.
//
// A version row holds the document's content as JSON (`content_json`, with
// block ids), the title it had, who made it (`created_by`, and
// `agent_user_id` for an agent's) and its size. Versions keep JSON only:
// `ydoc_state` stays null, because comparing versions (S-tasks) works on
// blocks and the Postgres disk is small. Rows are never changed afterwards
// (history is never rewritten); only S-tasks' content removal touches them.
//
// Who sees history: every read and write here needs can edit on the
// document (the spec's Call; consult rule C4: someone with can comment or can
// view, guests included, sees only the current document). A document the
// caller can't open is a 404, checked first, so nothing here says whether a
// document or a version exists; then a role below edit is 403
// FORBIDDEN_ROLE; then a version that isn't the document's is 404
// VERSION_NOT_FOUND.
//
// Automatic versions come from a stored listener (onDocumentStored, F7):
// on a derived store, when the document has no automatic version from the
// last 10 minutes (measured from the last automatic version, by the version
// clock), the store's JSON is saved, credited to the store's first editor
// (the one with most updates) and first agent, unless the newest version of
// any kind already holds exactly that content. A derived store comes at most
// once a minute for a live document, on unload, at shutdown and on every
// non-socket write.
//
// Named versions copy the current content: readCurrentDocument (collab
// server), which encodes a loaded document's live copy, so every edit the
// server has accepted is in the version, stored yet or not; a document
// nobody has open is read from its row. Making one needs no size check: it
// copies the state the document already has.
//
// Restore goes through the one writer (rule C2): writeDocument with the
// person as actor, reason 'restore' and the default required role (edit), so
// the writer checks access again and applies the 2 MB cap (TOO_LARGE). The
// whole document is replaced with the version's JSON (applyJsonToYDoc), in
// one Yjs transaction that everyone connected receives. Its history commits
// with it, in the write's own transaction (writeDocument's `inTransaction`),
// so content and history commit or roll back together:
// - the content just before the restore (pending live edits included) is a
//   `restore` version named "Before restore from {date}", with no author,
//   unless the newest version already holds exactly that content. Nothing is
//   lost, and it is no automatic version, so the 10-minute window is untouched;
// - the document's title becomes the version's title (a version from before
//   titles were recorded leaves it as it is);
// - a `restore` version named "Restored from {date}" records the restored
//   content and title.
// {date} is the restored version's time, in UTC. Automatic versions from the
// restore's own stores are skipped while it runs, so the restored content
// isn't saved twice. (Called from inside a stored-listener run, a write's
// listeners run after that run, once the pause has ended; nothing calls it
// from there today.) A changed title is announced after the commit
// (`document:updated`, rule C4).
//
// `document_attachments.in_current` (consult change) is kept by a second
// stored listener: on every derived store, for that document only, a row is
// current exactly when its file id is in the stored content (an image's
// `fileId`, at any depth). Rows are never added here: linking a file to a
// document is the upload's job (F10), so an id someone types into the
// content grants nothing. Listener runs can come late, after later stores, so
// the flags are never taken from the event's JSON: every update (the
// listener's and the job's, reconcileDocumentAttachments) reads the latest
// stored content_json with the row FOR SHARE and writes the flags in the
// same transaction, so no store lands in between and no run writes stale
// flags, whatever order they come in. The content is already committed when
// the listener runs, so if its update fails, a durable job,
// `document-attachments-reconcile`, does the same work later. It is keyed
// `…:<documentId>:<revision of the store whose listener failed>` (rule C1),
// so a new failure never folds into a job that has already run.
//
// startDocumentVersioning registers both listeners; the API's entry point
// (server.ts) calls it at startup. Logs are fixed text; a failing listener
// is logged by runStoredListeners.
import { and, desc, eq, gt, sql, type SQL } from 'drizzle-orm';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import * as Y from 'yjs';
import { documentAttachments, documents, documentVersions, type DocumentVersionKind } from '@deft/db/documents';
import { applyJsonToYDoc, ensureBlockIds, yDocToJson } from '@deft/doc-schema';
import { onDocumentStored, type DocumentStoredEvent, type JSONContent } from '../collab/persistence.js';
import { readCurrentDocument } from '../collab/server.js';
import { db } from './db.js';
import { documentRoleFor, roleAtLeast } from './document-access.js';
import { emitDocumentUpdated } from './document-access-events.js';
import { DocumentRefusal } from './documents.js';
import { DocumentWriteRefused, writeDocument } from './document-writer.js';
import { enqueue, QUEUE_NAMES } from './queues.js';

export type VersionKind = DocumentVersionKind;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

/** At most one automatic version per document in this window, measured from the last one. */
export const AUTO_VERSION_EVERY_MS = 10 * 60 * 1000;
/** The version list's page size: the default and the most one page may ask for. */
export const VERSION_PAGE_DEFAULT = 100;
export const VERSION_PAGE_MAX = 200;

/** One snapshot for a history read: the role and the rows. */
const READ_SNAPSHOT: PgTransactionConfig = { isolationLevel: 'repeatable read', accessMode: 'read only' };

let versionClock: () => Date = () => new Date();

/** Replaces the clock that stamps versions and measures the automatic window. Returns the restore. */
export function setVersionClockForTest(now: () => Date): () => void {
  const previous = versionClock;
  versionClock = now;
  return () => { versionClock = previous; };
}

const notFound = () => new DocumentRefusal(404, 'NOT_FOUND', 'Document not found');
const versionNotFound = () => new DocumentRefusal(404, 'VERSION_NOT_FOUND', 'Version not found');

/** History needs can edit: 404 when the caller can't open the document, then 403 below edit. */
async function assertHistoryAccess(x: Executor, orgId: string, userId: string, documentId: string): Promise<void> {
  const role = await documentRoleFor(userId, orgId, documentId, x);
  if (!role) throw notFound();
  if (!roleAtLeast(role, 'edit')) throw new DocumentRefusal(403, 'FORBIDDEN_ROLE', 'Version history needs can edit');
}

// ---------------------------------------------------------------------------
// Content

/** The document JSON of `doc`, with block ids, or null when it holds content outside the schema. */
function jsonOfDoc(doc: Y.Doc): JSONContent | null {
  try {
    return ensureBlockIds(yDocToJson(doc));
  } catch {
    return null;
  }
}

/** The document JSON of a Yjs state, or null when it holds content outside the schema. */
function jsonOfState(state: Uint8Array): JSONContent | null {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return jsonOfDoc(doc);
  } catch {
    return null;
  } finally {
    doc.destroy();
  }
}

/** The file ids the document's content uses: every image's `fileId`, at any depth. */
export function documentFileIds(json: JSONContent): Set<string> {
  const ids = new Set<string>();
  const stack: JSONContent[] = [json];
  while (stack.length) {
    const node = stack.pop()!;
    const fileId: unknown = node.attrs?.fileId;
    if (node.type === 'image' && typeof fileId === 'string' && fileId !== '') ids.add(fileId);
    if (node.content) stack.push(...node.content);
  }
  return ids;
}

/** True when the document's newest version, of any kind, holds exactly `json`. */
async function newestVersionHolds(x: Executor, orgId: string, documentId: string, json: JSONContent): Promise<boolean> {
  const [newest] = await x.select({ same: sql<boolean>`${documentVersions.content_json} = ${JSON.stringify(json)}::jsonb` })
    .from(documentVersions)
    .where(and(eq(documentVersions.org_id, orgId), eq(documentVersions.document_id, documentId)))
    .orderBy(desc(documentVersions.created_at), desc(documentVersions.id))
    .limit(1);
  return newest?.same === true;
}

// ---------------------------------------------------------------------------
// Creating versions

export type CreateVersionInput = {
  orgId: string; documentId: string; kind: VersionKind; name?: string | null; createdBy: string | null;
  agentUserId?: string | null; actionId?: string | null; editDetails?: unknown;
  /** The content; else taken from `ydoc`; else the document's current content (the header). */
  json?: JSONContent; ydoc?: Y.Doc;
  /** Default: the version clock. The notes move passes its source time as SQL, so it is kept exactly. */
  createdAt?: Date | SQL;
  /** The title the version records; default the document's title now. The notes move keeps each old version's own title. */
  title?: string | null;
};

/** The version's title (the override, else the document's), and its content as `i` names it (the header): `json`, else `ydoc`'s, else the current content. */
async function versionSource(x: Executor, i: CreateVersionInput): Promise<{ title: string | null; json: JSONContent }> {
  const where = and(eq(documents.id, i.documentId), eq(documents.org_id, i.orgId));
  const [found] = await x.select({ title: documents.title }).from(documents).where(where).limit(1);
  if (!found) throw notFound();
  const row = { title: i.title !== undefined ? i.title : found.title };
  if (i.json !== undefined) return { title: row.title, json: i.json };
  if (i.ydoc !== undefined) return { title: row.title, json: ensureBlockIds(yDocToJson(i.ydoc)) };
  // The live state, every accepted edit included; the stored copy only when that state holds content outside the schema.
  // Through `x`: inside nameVersion's transaction, a second pool connection could wait behind the transactions holding them all.
  const state = await readCurrentDocument(i.documentId, i.orgId, x);
  const json = state ? jsonOfState(state) : null;
  if (json) return { title: row.title, json };
  const [stored] = await x.select({ content_json: documents.content_json }).from(documents).where(where).limit(1);
  if (!stored) throw notFound();
  return { title: row.title, json: stored.content_json as JSONContent };
}

async function insertVersion(x: Executor, i: CreateVersionInput): Promise<{ id: string }> {
  const { title, json } = await versionSource(x, i);
  const text = JSON.stringify(json);
  const isAgentAction = i.kind === 'agent' && Boolean(i.actionId);
  const insert = x.insert(documentVersions).values({
    org_id: i.orgId,
    document_id: i.documentId,
    kind: i.kind,
    name: i.name ?? null,
    title,
    content_json: json,
    size_bytes: Buffer.byteLength(text, 'utf8'),
    created_by: i.createdBy,
    agent_user_id: i.agentUserId ?? null,
    action_id: i.actionId ?? null,
    edit_details: i.editDetails === undefined ? null : i.editDetails,
    created_at: i.createdAt ?? versionClock(),
  });
  // An agent edit stores at most one version per action (the unique index), so a retried edit gets the first one back.
  const [created] = isAgentAction
    ? await insert.onConflictDoNothing({ target: [documentVersions.document_id, documentVersions.action_id], where: sql`kind = 'agent'` })
      .returning({ id: documentVersions.id })
    : await insert.returning({ id: documentVersions.id });
  if (created) return created;
  const [existing] = await x.select({ id: documentVersions.id }).from(documentVersions).where(and(
    eq(documentVersions.org_id, i.orgId), eq(documentVersions.document_id, i.documentId), eq(documentVersions.kind, 'agent'),
    eq(documentVersions.action_id, i.actionId!),
  )).limit(1);
  if (!existing) throw new Error('the agent version was neither stored nor found');
  return existing;
}

/**
 * Saves a version of the document (in workspace `orgId`, else 404): `json`,
 * or the JSON of `ydoc`, or the current content. Checks no access: callers do.
 * An `agent` version with an `actionId` is stored once per action; a retry
 * returns the first.
 */
export async function createVersion(i: CreateVersionInput): Promise<{ id: string }> {
  return insertVersion(db, i);
}

/** createVersion in the caller's transaction, so the version commits or rolls back with the caller's other writes (the notes move). */
export async function createVersionInTx(tx: Tx, i: CreateVersionInput): Promise<{ id: string }> {
  return insertVersion(tx, i);
}

// ---------------------------------------------------------------------------
// The stored listeners

/** Documents being restored (`orgId:documentId` → how many restores): their automatic versions wait. */
const restoring = new Map<string, number>();
const docKey = (orgId: string, documentId: string) => `${orgId}:${documentId}`;

async function whileRestoring<T>(orgId: string, documentId: string, fn: () => Promise<T>): Promise<T> {
  const key = docKey(orgId, documentId);
  restoring.set(key, (restoring.get(key) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    const left = (restoring.get(key) ?? 1) - 1;
    if (left > 0) restoring.set(key, left);
    else restoring.delete(key);
  }
}

/** The automatic version (the header). */
async function saveAutomaticVersion(e: DocumentStoredEvent): Promise<void> {
  if (restoring.has(docKey(e.orgId, e.documentId))) return;
  const now = versionClock();
  const [recent] = await db.select({ id: documentVersions.id }).from(documentVersions).where(and(
    eq(documentVersions.org_id, e.orgId), eq(documentVersions.document_id, e.documentId), eq(documentVersions.kind, 'auto'),
    gt(documentVersions.created_at, new Date(now.getTime() - AUTO_VERSION_EVERY_MS)),
  )).limit(1);
  if (recent) return;
  if (await newestVersionHolds(db, e.orgId, e.documentId, e.json)) return;
  await insertVersion(db, {
    orgId: e.orgId, documentId: e.documentId, kind: 'auto', createdBy: e.editorIds[0] ?? null, agentUserId: e.agentUserIds[0] ?? null,
    editDetails: { editor_ids: e.editorIds, agent_user_ids: e.agentUserIds, action_ids: e.actionIds },
    json: e.json, createdAt: now,
  });
}

/** The durable job that puts a document's `in_current` flags right after the stored listener failed (the header). */
export const DOCUMENT_ATTACHMENTS_RECONCILE_JOB = 'document-attachments-reconcile';

/** Sets `in_current` on the document's attachment rows to match `json`, changing only the rows that differ. */
async function setInCurrent(x: Executor, orgId: string, documentId: string, json: JSONContent): Promise<void> {
  const inContent = sql`${documentAttachments.file_id} = ANY(${sql.param([...documentFileIds(json)])}::text[])`;
  await x.update(documentAttachments).set({ in_current: inContent }).where(and(
    eq(documentAttachments.org_id, orgId), eq(documentAttachments.document_id, documentId),
    sql`${documentAttachments.in_current} IS DISTINCT FROM (${inContent})`,
  ));
}

/**
 * `in_current` after a store (the header): recomputed from the latest stored
 * content, never from the event's JSON, which a later store may already have
 * replaced. On failure, the reconcile job, keyed by this store's own revision
 * (rule C1), so a failure never folds into a job for an earlier store that may
 * already have run; a duplicate does no harm, since every run reads the
 * latest content.
 */
async function syncAttachmentsInCurrent(e: DocumentStoredEvent): Promise<void> {
  try {
    await reconcileDocumentAttachments(e.orgId, e.documentId);
    return;
  } catch {
    // Queued below; if queueing fails too, runStoredListeners logs it.
  }
  await enqueue(QUEUE_NAMES.AGENT_JOBS, DOCUMENT_ATTACHMENTS_RECONCILE_JOB, { org_id: e.orgId, document_id: e.documentId }, {
    orgId: e.orgId, dedupeKey: `${DOCUMENT_ATTACHMENTS_RECONCILE_JOB}:${e.documentId}:${e.revision}`, maxAttempts: 5,
  });
  console.error('[documents] a document’s attachment flags could not be updated; a reconcile job was queued');
}

/**
 * `in_current` from the document's latest stored content_json, the one way
 * the flags are written (the stored listener and the reconcile job): in one
 * transaction, the row read FOR SHARE, so a store waits until the flags are
 * written and its own listener then recomputes them. Whatever order runs
 * come in, the last to write read the latest content. Idempotent; a document
 * with no attachment rows, or one that is gone, has nothing to put right.
 */
export async function reconcileDocumentAttachments(orgId: string, documentId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [attached] = await tx.select({ id: documentAttachments.id }).from(documentAttachments)
      .where(and(eq(documentAttachments.org_id, orgId), eq(documentAttachments.document_id, documentId))).limit(1);
    if (!attached) return;
    const [row] = await tx.select({ content_json: documents.content_json }).from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.org_id, orgId))).for('share');
    if (!row) return;
    await setInCurrent(tx, orgId, documentId, row.content_json as JSONContent);
  });
}

let stopListening: (() => void) | null = null;

/** Registers the stored listeners (automatic versions, in_current) once. Returns the stop. */
export function startDocumentVersioning(): () => void {
  if (!stopListening) {
    const offAttachments = onDocumentStored(syncAttachmentsInCurrent);
    const offVersions = onDocumentStored(saveAutomaticVersion);
    stopListening = () => {
      offAttachments();
      offVersions();
      stopListening = null;
    };
  }
  return stopListening;
}

// ---------------------------------------------------------------------------
// Reading history

const summaryColumns = {
  id: documentVersions.id,
  kind: documentVersions.kind,
  name: documentVersions.name,
  title: documentVersions.title,
  created_by: documentVersions.created_by,
  agent_user_id: documentVersions.agent_user_id,
  created_at: documentVersions.created_at,
  size_bytes: documentVersions.size_bytes,
};

export type VersionSummary = {
  id: string; kind: VersionKind; name: string | null; title: string | null; created_by: string | null; agent_user_id: string | null;
  created_at: Date; size_bytes: number;
};

/**
 * The document's versions, newest first, `limit` at a time; `before` (a
 * version id of this document) continues after that version. `nextBefore`
 * is the id to continue from, or null on the last page. Needs edit.
 */
export async function listVersions(i: { orgId: string; userId: string; documentId: string; limit?: number; before?: string | null }): Promise<{
  versions: VersionSummary[]; nextBefore: string | null;
}> {
  const limit = Math.min(Math.max(i.limit ?? VERSION_PAGE_DEFAULT, 1), VERSION_PAGE_MAX);
  return db.transaction(async (tx) => {
    await assertHistoryAccess(tx, i.orgId, i.userId, i.documentId);
    const after = i.before
      ? sql`(${documentVersions.created_at}, ${documentVersions.id}) < (SELECT cursor_version.created_at, cursor_version.id
          FROM document_versions cursor_version
          WHERE cursor_version.id = ${i.before} AND cursor_version.org_id = ${i.orgId} AND cursor_version.document_id = ${i.documentId})`
      : undefined;
    const rows = await tx.select(summaryColumns).from(documentVersions)
      .where(and(eq(documentVersions.org_id, i.orgId), eq(documentVersions.document_id, i.documentId), after))
      .orderBy(desc(documentVersions.created_at), desc(documentVersions.id))
      .limit(limit + 1);
    const versions = rows.slice(0, limit);
    return { versions, nextBefore: rows.length > limit ? versions[versions.length - 1]!.id : null };
  }, READ_SNAPSHOT);
}

/** One version of the document, with its content. Needs edit. */
export async function getVersion(i: { orgId: string; userId: string; documentId: string; versionId: string }): Promise<
  VersionSummary & { content_json: JSONContent }
> {
  return db.transaction(async (tx) => {
    await assertHistoryAccess(tx, i.orgId, i.userId, i.documentId);
    const [row] = await tx.select({ ...summaryColumns, content_json: documentVersions.content_json }).from(documentVersions).where(and(
      eq(documentVersions.org_id, i.orgId), eq(documentVersions.document_id, i.documentId), eq(documentVersions.id, i.versionId),
    )).limit(1);
    if (!row) throw versionNotFound();
    return { ...row, content_json: row.content_json as JSONContent };
  }, READ_SNAPSHOT);
}

/** Saves the current content as a named version, by `userId`. Needs edit. */
export async function nameVersion(i: { orgId: string; userId: string; documentId: string; name: string }): Promise<VersionSummary> {
  return db.transaction(async (tx) => {
    await assertHistoryAccess(tx, i.orgId, i.userId, i.documentId);
    const { id } = await insertVersion(tx, { orgId: i.orgId, documentId: i.documentId, kind: 'named', name: i.name, createdBy: i.userId });
    const [row] = await tx.select(summaryColumns).from(documentVersions)
      .where(and(eq(documentVersions.org_id, i.orgId), eq(documentVersions.id, id))).limit(1);
    return row!;
  });
}

// ---------------------------------------------------------------------------
// Restoring

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const twoDigits = (n: number) => String(n).padStart(2, '0');

/** "26 Nov 2026, 14:05 UTC": a version's time, in UTC (the server doesn't know the reader's zone). */
function versionTime(at: Date): string {
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}, ${twoDigits(at.getUTCHours())}:${twoDigits(at.getUTCMinutes())} UTC`;
}

/** "Restored from 26 Nov 2026, 14:05 UTC": the restored version's time. */
export function restoredVersionName(at: Date): string {
  return `Restored from ${versionTime(at)}`;
}

/** "Before restore from 26 Nov 2026, 14:05 UTC": the content a restore replaced, named after the restored version's time. */
export function beforeRestoreVersionName(at: Date): string {
  return `Before restore from ${versionTime(at)}`;
}

/**
 * Puts the version's content and title back through writeDocument (the
 * header), as `userId`, who needs edit, with its history in the same
 * transaction. 404 when the caller can't open the document, 403 below edit,
 * 404 VERSION_NOT_FOUND for a version that isn't the document's, 409
 * VERSION_CONTENT_REMOVED for one whose content was removed, 409
 * SPLIT_HISTORY for a moved version of a note split into pages (F14). The writer may
 * refuse (DocumentWriteRefused): FORBIDDEN, TOO_LARGE, BUSY or
 * INVALID_CONTENT. A refusal or any other failure changes nothing: no
 * content, title or version. Returns the new `restore` version.
 */
/** True for a document made from a split note (F14): its map row records more than one part. */
async function isSplitNoteDocument(orgId: string, documentId: string): Promise<boolean> {
  const [row] = (await db.execute(sql`SELECT EXISTS (SELECT 1 FROM note_document_map split_map
    WHERE split_map.org_id = ${orgId} AND split_map.target_type = 'document' AND split_map.target_id = ${documentId}
      AND jsonb_typeof(split_map.details->'parts') = 'array' AND jsonb_array_length(split_map.details->'parts') > 1) AS split`))
    .rows as Array<{ split: boolean }>;
  return row?.split === true;
}

export async function restoreVersion(i: { orgId: string; documentId: string; versionId: string; userId: string }): Promise<{ versionId: string }> {
  await assertHistoryAccess(db, i.orgId, i.userId, i.documentId);
  const [version] = await db.select({
    id: documentVersions.id, content_json: documentVersions.content_json, title: documentVersions.title,
    created_at: documentVersions.created_at, content_removed_at: documentVersions.content_removed_at, kind: documentVersions.kind,
  }).from(documentVersions).where(and(
    eq(documentVersions.org_id, i.orgId), eq(documentVersions.document_id, i.documentId), eq(documentVersions.id, i.versionId),
  )).limit(1);
  if (!version) throw versionNotFound();
  if (version.content_removed_at) throw new DocumentRefusal(409, 'VERSION_CONTENT_REMOVED', 'This version’s content was removed from history');
  // A note too large for live editing was split into pages when it moved (F14), and its whole-note history sits on
  // the first page: restoring one of those versions would rewrite only that page, so it can be viewed, not restored.
  if (version.kind === 'moved' && await isSplitNoteDocument(i.orgId, i.documentId)) {
    throw new DocumentRefusal(409, 'SPLIT_HISTORY', 'This note was split into pages when it moved. Earlier versions can be viewed and copied, not restored.');
  }
  const json = version.content_json as JSONContent;

  const outcome: { versionId: string | null; titleChanged: boolean } = { versionId: null, titleChanged: false };
  await whileRestoring(i.orgId, i.documentId, () => writeDocument({
    orgId: i.orgId,
    documentId: i.documentId,
    actor: { kind: 'user', userId: i.userId },
    reason: 'restore',
    mutate: (doc) => {
      try {
        applyJsonToYDoc(doc, json);
      } catch {
        // The version holds a node or mark the schema no longer has.
        throw new DocumentWriteRefused('INVALID_CONTENT');
      }
    },
    // The history and the title commit with the content, or not at all.
    inTransaction: async (tx, { beforeJson, afterJson }) => {
      const at = versionClock();
      if (beforeJson && !(await newestVersionHolds(tx, i.orgId, i.documentId, beforeJson))) {
        await insertVersion(tx, {
          orgId: i.orgId, documentId: i.documentId, kind: 'restore', name: beforeRestoreVersionName(version.created_at), createdBy: null,
          editDetails: { before_restore_of: version.id }, json: beforeJson, createdAt: new Date(at.getTime() - 1),
        });
      }
      if (version.title !== null) {
        const changed = await tx.update(documents).set({ title: version.title })
          .where(and(eq(documents.id, i.documentId), eq(documents.org_id, i.orgId), sql`${documents.title} IS DISTINCT FROM ${version.title}`))
          .returning({ id: documents.id });
        outcome.titleChanged = changed.length > 0;
      }
      const created = await insertVersion(tx, {
        orgId: i.orgId, documentId: i.documentId, kind: 'restore', name: restoredVersionName(version.created_at), createdBy: i.userId,
        editDetails: { restored_version_id: version.id }, json: afterJson, createdAt: at,
      });
      outcome.versionId = created.id;
    },
  }));
  if (outcome.titleChanged) {
    try {
      await emitDocumentUpdated(i.orgId, [i.documentId]);
    } catch {
      console.error('[documents] announcing a restored title failed');
    }
  }
  return { versionId: outcome.versionId! };
}
