// Reading and storing a document's live state (plan Task F7).
//
// A document row holds the live state (`ydoc_state`, the encoded Yjs update)
// and copies derived from it: `content_json` (with block ids, F1),
// `content_text`, and `search_vector` (filled by a trigger from the title and
// content_text). A new document has no live state until its first load, which
// builds it from `content_json` and writes it at once, so every later load
// starts from the same Yjs history and a client holding the first copy never
// sees its content doubled.
//
// Every store writes `ydoc_state` and `size_bytes` and bumps `revision`;
// derived copies are written by the stores that ask for them (collab/server.ts
// decides: at most once a minute for a live document, and when that minute
// ends with a change still underived; on unload, at shutdown and on every
// non-socket write). The stored listeners (`onDocumentStored`, which states
// the contract) hear each derived store after its row is written: S5
// authorship, F8 versions and H3 knowledge listen. A listener that fails is
// logged and never stops the store or the next listener.
//
// Block ids (F1): the derived JSON passes through ensureBlockIds. When that
// gives a block an id it didn't have, the ids are written back into the
// Y.Doc in place (applyJsonToYDoc, origin SYSTEM_ORIGIN), so the stored JSON
// and the live document agree. After that the ids are valid and unique, so
// the next derive changes nothing and nothing is written back again.
//
// Logs are fixed text: nothing a person wrote, and no ids.
import { isDeepStrictEqual } from 'node:util';
import { and, eq, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import * as Y from 'yjs';
import { documents } from '@deft/db/documents';
import { applyJsonToYDoc, ensureBlockIds, jsonToText, jsonToYDoc, yDocToJson } from '@deft/doc-schema';
import { db } from '../lib/db.js';
import { COLLAB_LIMITS } from './limits.js';

export type JSONContent = Parameters<typeof jsonToText>[0];

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Writer = Pick<typeof db, 'update' | 'select'> | Tx;

/**
 * The transaction origin of the server's own changes to a live document (block
 * ids written back, the size warning). Hocuspocus schedules no store for them
 * (`skipStoreHooks`): the store that makes them writes them.
 */
export const SYSTEM_ORIGIN = { source: 'local', skipStoreHooks: true, context: { deft: 'system' } } as const;

/**
 * The origin of a non-socket write applied to a live document after it was
 * stored (collab/server.ts write): already in the row, so it marks nothing to store.
 */
export const WRITER_ORIGIN = { source: 'local', skipStoreHooks: true, context: { deft: 'writer' } } as const;

export type DocumentStoredEvent = {
  orgId: string;
  documentId: string;
  /** The people whose live edits this store holds, most updates first (S5 relies on the order). */
  editorIds: string[];
  /** Agent users whose writes this store holds. */
  agentUserIds: string[];
  /** The agent actions whose writes this store holds. */
  actionIds: string[];
  previousJson: JSONContent;
  json: JSONContent;
  sizeBytes: number;
  at: Date;
};

type StoredListener = (e: DocumentStoredEvent) => Promise<void>;
const storedListeners = new Set<StoredListener>();

/**
 * Listens to every **derived** store, after its row is written. Returns the unsubscribe.
 *
 * The contract:
 * - A derived store writes content_json and content_text with the live state.
 *   A live document has at most one a minute (a change made inside the minute
 *   is derived when it ends, even if nobody edits again), plus one on unload
 *   and one at shutdown. Every non-socket write (writeDocument) is one.
 * - Each run carries every editor, agent and action seen since the previous
 *   run, editors ordered by how many updates they made, most first.
 * - A store of ydoc_state alone bumps `revision` and runs no listener.
 * - Runs for one document go one at a time, in the order of their stores.
 *   They run with no lock held, so a listener may call writeDocument, even on
 *   the same document: while the run is still in progress, that write
 *   returns once applied, and its own run comes after the current one. Work
 *   a listener starts that writes after the run has ended waits for that
 *   write's listeners, as any write does.
 */
export function onDocumentStored(fn: (e: DocumentStoredEvent) => Promise<void>): () => void {
  storedListeners.add(fn);
  return () => { storedListeners.delete(fn); };
}

/** Runs every stored listener in turn. Never throws: a failing listener is logged, without the event. */
export async function runStoredListeners(e: DocumentStoredEvent): Promise<void> {
  for (const listener of [...storedListeners]) {
    try {
      await listener(e);
    } catch {
      console.error('[collab] a document stored listener failed');
    }
  }
}

/** A document row as a load or a write needs it. */
export type DocumentStateRow = {
  orgId: string;
  driveId: string;
  revision: number;
  isDeleted: boolean;
  json: JSONContent;
  state: Uint8Array | null;
};

function stateRow(row: { org_id: string; drive_id: string; revision: number; is_deleted: boolean; content_json: unknown; ydoc_state: Buffer | null }): DocumentStateRow {
  return {
    orgId: row.org_id,
    driveId: row.drive_id,
    revision: Number(row.revision),
    isDeleted: row.is_deleted,
    json: row.content_json as JSONContent,
    state: row.ydoc_state ? new Uint8Array(row.ydoc_state) : null,
  };
}

const stateColumns = {
  org_id: documents.org_id, drive_id: documents.drive_id, revision: documents.revision, is_deleted: documents.is_deleted,
  content_json: documents.content_json, ydoc_state: documents.ydoc_state,
};

/** The document's row in `orgId`, or null. */
export async function readDocumentState(documentId: string, orgId: string, reader: Writer = db): Promise<DocumentStateRow | null> {
  const [row] = await reader.select(stateColumns).from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.org_id, orgId))).limit(1);
  return row ? stateRow(row) : null;
}

/** The document's row in `orgId`, locked FOR UPDATE in `tx`, or null. */
export async function lockDocumentState(tx: Tx, documentId: string, orgId: string): Promise<DocumentStateRow | null> {
  const [row] = await tx.select(stateColumns).from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.org_id, orgId))).for('update');
  return row ? stateRow(row) : null;
}

/** Applies a row's live state to `doc`, or, before the first load, the state built from its content_json. */
export function applyRowToDoc(doc: Y.Doc, row: DocumentStateRow): void {
  if (row.state) {
    Y.applyUpdate(doc, row.state);
    return;
  }
  const built = jsonToYDoc(row.json);
  try {
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(built));
  } finally {
    built.destroy();
  }
}

/**
 * The first load's live state, written straight away (the header): only while
 * the row still has none. Content is unchanged, so `revision` isn't bumped.
 */
export async function writeInitialState(documentId: string, orgId: string, state: Uint8Array): Promise<void> {
  await db.update(documents)
    .set({ ydoc_state: Buffer.from(state), size_bytes: state.byteLength })
    .where(and(eq(documents.id, documentId), eq(documents.org_id, orgId), sql`${documents.ydoc_state} IS NULL`));
}

/** Derived copies of a document's live state. */
export type DerivedContent = { json: JSONContent; text: string };

/**
 * The document's JSON with block ids, and its text. New ids are written back
 * into `doc` (the header). Throws when the live state holds a node or mark
 * outside the schema (yDocToJson).
 */
export function deriveContent(doc: Y.Doc): DerivedContent {
  const json = yDocToJson(doc);
  const withIds = ensureBlockIds(json);
  if (!isDeepStrictEqual(withIds, json)) doc.transact(() => applyJsonToYDoc(doc, withIds), SYSTEM_ORIGIN);
  return { json: withIds, text: jsonToText(withIds) };
}

/**
 * True when the stored JSON is behind the live state (a store of ydoc_state
 * alone came after the last derived one), or when that can't be told because
 * the live state holds content outside the schema. Changes nothing.
 */
export function derivedIsBehind(doc: Y.Doc, storedJson: JSONContent): boolean {
  try {
    return !isDeepStrictEqual(ensureBlockIds(yDocToJson(doc)), storedJson);
  } catch {
    return true;
  }
}

const SIZE_WARNING_MAP = 'deft_meta';

/** Turns on `deft_meta.size_warning` in the live document once its state reaches docWarnBytes. */
export function markSizeWarning(doc: Y.Doc, encodedBytes: number): void {
  if (encodedBytes < COLLAB_LIMITS.docWarnBytes) return;
  const meta = doc.getMap(SIZE_WARNING_MAP);
  if (meta.get('size_warning') === true) return;
  doc.transact(() => meta.set('size_warning', true), SYSTEM_ORIGIN);
}

/**
 * Writes a store: the live state, its size and a revision bump, the derived
 * copies when given, and who edited last when someone did. Returns the new
 * revision, or null when the row is gone.
 */
export async function writeStore(writer: Writer, i: {
  documentId: string; orgId: string; state: Uint8Array; derived: DerivedContent | null;
  editedBy: string | null; editedAt: Date | null;
}): Promise<number | null> {
  const set: PgUpdateSetSource<typeof documents> = {
    ydoc_state: Buffer.from(i.state),
    size_bytes: i.state.byteLength,
    revision: sql`${documents.revision} + 1`,
  };
  if (i.derived) {
    set.content_json = i.derived.json;
    set.content_text = i.derived.text;
  }
  if (i.editedBy) {
    set.last_edited_by = i.editedBy;
    set.last_edited_at = i.editedAt ?? new Date();
  }
  const [row] = await writer.update(documents).set(set)
    .where(and(eq(documents.id, i.documentId), eq(documents.org_id, i.orgId)))
    .returning({ revision: documents.revision });
  return row ? Number(row.revision) : null;
}
