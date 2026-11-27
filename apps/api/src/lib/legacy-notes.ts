// Notes and canvases after the move (spec 5.12; plan Task F15).
//
// The notes move (lib/drives-move/, F14) turned every note, note folder and
// chat canvas with content into a document or a folder, recorded one row per
// source in note_document_map, and the API listens only once a workspace has
// moved (lib/drives-move/startup.ts). The notes, note folders and canvases
// tables stay, read-only, for one release: nothing writes them any more.
//
// Everything that read notes reads documents now, through the one access
// check (lib/document-access.ts):
// - a legacy id (an old link, a tool argument, an app reference) is mapped
//   to its document first (mappedTargetId, documentIdForNoteRef), and the
//   read is authorized against that document's current access, never the
//   old note rule;
// - couldSeeLegacySource asks the rule notes had (lib/legacy-note-rule.ts)
//   one question only: whether someone could see a note or a canvas before
//   the move, which GET /api/documents/by-legacy asks so an old link still
//   finds its document (routes/documents.ts). It grants nothing else.
//
// Creating (createNoteDocumentInTx): the old note tools (Defty's and an
// agent's create_note, MCP note_create, an app destination) create a
// document where the move puts a note of the same visibility, so new and
// moved notes land in the same places:
// - private: the creator's My drive (F5's createDocumentInTx);
// - space: the creator's My drive, shared with the chat as "can view";
// - org: the Shared notes drive (F4's ensureSharedNotesDrive), in the
//   author's folder (the move's authorFolderInTx), with a "can edit" share
//   for the author, as the move places a workspace note. Shared notes'
//   default role is "can view", so a member can't create there through
//   createDocumentInTx: the document is created in their My drive (the role
//   check, the content check and the one row insert are F5's), then placed
//   in Shared notes in the same transaction. The locks come first, in F5's
//   order: the actor, then both drives FOR UPDATE in id order, as a move
//   between them takes them (lib/documents.ts moveDocument).
// For Defty the creator is the person who asked; an agent creates as its own
// user. Images the content names are linked to the document, or shown as a
// placeholder, in the create's transaction (lib/note-tool-images.ts). The
// post-commit step (`finish`) raises `created` with the drive the document
// ended in and sends `document:updated` to its viewers.
import { and, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import * as Y from 'yjs';
import { documents, drives, noteDocumentMap, type DocumentRow, type NoteMoveSourceType } from '@deft/db/documents';
import { agentActions, canvases, messages, noteFolders, notes, users } from '@deft/db/schema';
import {
  applyJsonToYDoc, EMPTY_DOCUMENT, htmlToJson, jsonToHtml, jsonToMarkdown, jsonToText, markdownToJson, yDocToJson,
} from '@deft/doc-schema';
import { readCurrentDocument, type CollabActor } from '../collab/server.js';
import { db } from './db.js';
import { DEFTY_EMAIL } from './defty-identity.js';
import { documentRoleFor, visibleDocumentCondition, type DocRole } from './document-access.js';
import { omittedText, storableRef } from './document-audience.js';
import { DocumentWriteRefused, writeDocument } from './document-writer.js';
import { emitDocumentAccessChanged, emitDocumentUpdated } from './document-access-events.js';
import { emitDocumentEvent } from './document-events.js';
import { createDocumentInTx, DocumentRefusal } from './documents.js';
import { lockActorInTx } from './drive-locks.js';
import { canHoldDocumentAccessLocked, ensurePersonalDrive, ensureSharedNotesDrive, PrincipalCannotHoldAccessError } from './drives.js';
import { authorFolderInTx, insertSharesInTx, nextRootPosition, ShareSet } from './drives-move/placement.js';
import { legacyNoteVisibleSql } from './legacy-note-rule.js';
import { linkToolImagesInTx, ToolImageChanged, toolImages } from './note-tool-images.js';
import { canReadSpace, requireSpaceMembership } from './space-membership.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Reader = Pick<typeof db, 'select'>;
export type JSONContent = Parameters<typeof jsonToText>[0];
export type NoteVisibility = 'private' | 'org' | 'space';

/** The answer an old note write gets: notes are documents now (routes/daily-notes.ts, canvas.ts). */
export const NOTES_MOVED = { error: 'Notes are documents now. Open it in Drive.', code: 'NOTES_MOVED' } as const;
export const CANVAS_MOVED = { error: 'This canvas is a document now. Open it in Drive.', code: 'CANVAS_MOVED' } as const;

/** The document or doc folder a source of `orgId` moved to, or null (not moved, or moved in another workspace). */
export async function mappedTargetId(orgId: string, sourceType: NoteMoveSourceType, sourceId: string, reader: Reader = db): Promise<string | null> {
  const [row] = await reader.select({ target_id: noteDocumentMap.target_id }).from(noteDocumentMap).where(and(
    eq(noteDocumentMap.org_id, orgId), eq(noteDocumentMap.source_type, sourceType), eq(noteDocumentMap.source_id, sourceId),
  )).limit(1);
  return row?.target_id ?? null;
}

/** mappedTargetId for many sources at once: source id to target id, for the ones that moved. */
export async function mappedTargetIds(orgId: string, sourceType: NoteMoveSourceType, sourceIds: readonly string[], reader: Reader = db): Promise<Map<string, string>> {
  const ids = [...new Set(sourceIds)];
  if (ids.length === 0) return new Map();
  const rows = await reader.select({ source_id: noteDocumentMap.source_id, target_id: noteDocumentMap.target_id }).from(noteDocumentMap)
    .where(and(eq(noteDocumentMap.org_id, orgId), eq(noteDocumentMap.source_type, sourceType), inArray(noteDocumentMap.source_id, ids)));
  return new Map(rows.map((row) => [row.source_id, row.target_id]));
}

/** For a statement: the document a legacy source (`sourceRef`, a column or value) of `orgId` moved to, or NULL. */
export function mappedTargetIdSql(orgId: string | SQL, sourceType: NoteMoveSourceType, sourceRef: SQL): SQL {
  return sql`(SELECT legacy_map.target_id FROM note_document_map legacy_map
    WHERE legacy_map.org_id = ${orgId} AND legacy_map.source_type = ${sourceType} AND legacy_map.source_id = ${sourceRef})`;
}

/** A document id as given, or the document a legacy note id moved to: what the old note tools accept. */
export async function documentIdForNoteRef(orgId: string, id: string, reader: Reader = db): Promise<string> {
  return (await mappedTargetId(orgId, 'note', id, reader)) ?? id;
}

/**
 * Whether `userId` could see the legacy source before the move, by the rule
 * notes and canvases had (the header): a live note they wrote, one shared
 * with them, a workspace note when they are a full member or an agent (never
 * a guest), a chat note of a chat they are in; a canvas of a chat they may
 * read. Asked only by GET /api/documents/by-legacy.
 */
export async function couldSeeLegacySource(orgId: string, userId: string, sourceType: string, sourceId: string): Promise<boolean> {
  if (sourceType === 'note') {
    const [row] = await db.select({ id: notes.id }).from(notes).where(and(
      eq(notes.id, sourceId), eq(notes.org_id, orgId), eq(notes.is_deleted, false), legacyNoteVisibleSql(userId),
    )).limit(1);
    return Boolean(row);
  }
  if (sourceType === 'note_folder') {
    const [row] = await db.select({ id: noteFolders.id }).from(noteFolders).where(and(
      eq(noteFolders.id, sourceId), eq(noteFolders.org_id, orgId), eq(noteFolders.user_id, userId), eq(noteFolders.is_deleted, false),
    )).limit(1);
    return Boolean(row);
  }
  if (sourceType === 'canvas') {
    const [row] = await db.select({ space_id: canvases.space_id }).from(canvases)
      .where(and(eq(canvases.id, sourceId), eq(canvases.org_id, orgId))).limit(1);
    return Boolean(row && await canReadSpace(row.space_id, userId, orgId));
  }
  return false;
}

/** The chat's canvas and the document it moved to: null when the chat has none; `documentId` null when it was empty and dropped. */
export async function canvasDocumentFor(orgId: string, spaceId: string): Promise<{ canvasId: string; documentId: string | null } | null> {
  const [canvas] = await db.select({ id: canvases.id }).from(canvases)
    .where(and(eq(canvases.space_id, spaceId), eq(canvases.org_id, orgId))).limit(1);
  if (!canvas) return null;
  return { canvasId: canvas.id, documentId: await mappedTargetId(orgId, 'canvas', canvas.id) };
}

/**
 * The content an old note tool was given, as a document: HTML (what Notes
 * stored, and what the tools describe) when it starts with a tag, read by
 * htmlToJson, which drops anything unsafe or outside the schema; otherwise
 * Markdown. Empty content is an empty document.
 */
export function noteContentJson(content: string | null | undefined): JSONContent {
  const text = content ?? '';
  if (!text.trim()) return structuredClone(EMPTY_DOCUMENT) as JSONContent;
  return /^\s*</.test(text) ? htmlToJson(text).json : markdownToJson(text);
}

/** A document's content as it is now (live edits included, F7's readCurrentDocument), else its stored copy. */
export async function documentJsonNow(orgId: string, documentId: string, stored: unknown): Promise<JSONContent> {
  try {
    const update = await readCurrentDocument(documentId, orgId);
    if (update) {
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, update);
        return yDocToJson(doc);
      } finally {
        doc.destroy();
      }
    }
  } catch {
    // Content outside the schema: the stored copy below.
  }
  return (stored ?? EMPTY_DOCUMENT) as JSONContent;
}

/** Markdown for an agent or MCP read (F1's jsonToMarkdown); content it can't render reads as its plain text. */
export function documentMarkdown(json: JSONContent): string {
  try {
    return jsonToMarkdown(json);
  } catch {
    return jsonToText(json);
  }
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** HTML for an old notes client (what Notes stored); content outside the schema reads as its escaped text, a paragraph a line. */
export function documentHtml(json: JSONContent): string {
  try {
    return jsonToHtml(json);
  } catch {
    return jsonToText(json).split('\n').filter((line) => line.trim()).map((line) => `<p>${escapeHtml(line)}</p>`).join('');
  }
}

export type CreateNoteDocumentInput = {
  orgId: string; userId: string; title: string; json: JSONContent; visibility: NoteVisibility; spaceId?: string | null;
  icon?: string | null; isTemplate?: boolean;
};

const notFoundSpace = () => new DocumentRefusal(404, 'NOT_FOUND', 'Space not found');
const inactiveMember = () => new DocumentRefusal(403, 'ORG_MEMBERSHIP_INACTIVE', 'Not an active member of this workspace');

/** Locks the drives of `driveIds` FOR UPDATE in id order (F5's order for two drives). */
async function lockDrivesInIdOrderInTx(tx: Tx, orgId: string, driveIds: Array<string | null | undefined>): Promise<void> {
  for (const driveId of [...new Set(driveIds.filter((id): id is string => Boolean(id)))].sort()) {
    await tx.select({ id: drives.id }).from(drives).where(and(eq(drives.id, driveId), eq(drives.org_id, orgId))).for('update');
  }
}

/**
 * Creates a note's document in the caller's transaction (the header): where
 * the move puts a note of that visibility. `finish` runs after the commit.
 * Refusals are DocumentRefusal: a creator who can't hold access 403
 * ORG_MEMBERSHIP_INACTIVE, a chat they aren't in 404, content outside the
 * schema 400, too large 413.
 */
export async function createNoteDocumentInTx(tx: Tx, input: CreateNoteDocumentInput): Promise<{ document: DocumentRow; finish: () => Promise<void> }> {
  const { orgId, userId } = input;
  const spaceId = input.visibility === 'space' ? input.spaceId ?? null : null;
  if (input.visibility === 'space' && (!spaceId || !(await requireSpaceMembership(spaceId, userId, orgId, tx)))) throw notFoundSpace();
  // The images the creator may show, read first; linked once the document exists.
  const images = await toolImages(tx, { orgId, uploaderId: userId, documentId: null, json: input.json });
  let sharedNotesId: string | null = null;
  if (input.visibility === 'org') {
    // The lock order (the header): the actor and their rows, then both
    // drives FOR UPDATE in id order, then the placement writes. The drives'
    // ids are read unlocked first; a My drive made below (none was live) is
    // a new row nobody else can lock before this commits.
    await lockActorInTx(tx, { id: userId, org_id: orgId });
    if (!(await canHoldDocumentAccessLocked(tx, orgId, userId))) throw inactiveMember();
    sharedNotesId = (await ensureSharedNotesDrive(orgId, userId, tx)).id;
    const [personal] = await tx.select({ id: drives.id }).from(drives).where(and(
      eq(drives.org_id, orgId), eq(drives.owner_user_id, userId), eq(drives.kind, 'personal'), eq(drives.is_deleted, false),
      isNull(drives.frozen_at),
    )).limit(1);
    await lockDrivesInIdOrderInTx(tx, orgId, [personal?.id, sharedNotesId]);
    try {
      await ensurePersonalDrive(orgId, userId, tx, { lockForUpdate: true });
    } catch (error) {
      if (error instanceof PrincipalCannotHoldAccessError) throw inactiveMember();
      throw error;
    }
  }
  const created = await createDocumentInTx(tx, {
    orgId, userId, title: input.title, json: images.json, isTemplate: input.isTemplate ?? false,
  });
  await linkToolImagesInTx(tx, { orgId, uploaderId: userId, documentId: created.document.id, fileIds: images.link });
  let document = created.document;
  if (input.icon) {
    [document] = await tx.update(documents).set({ icon: input.icon })
      .where(and(eq(documents.id, document.id), eq(documents.org_id, orgId))).returning() as [DocumentRow];
  }
  const shares = new ShareSet();
  if (sharedNotesId) {
    const folderId = await authorFolderInTx(tx, orgId, sharedNotesId, userId);
    [document] = await tx.update(documents).set({
      drive_id: sharedNotesId, folder_id: folderId, position: await nextRootPosition(tx, orgId, sharedNotesId, folderId),
    }).where(and(eq(documents.id, document.id), eq(documents.org_id, orgId))).returning() as [DocumentRow];
    shares.add({ type: 'user', id: userId }, 'edit');
  }
  if (spaceId) shares.add({ type: 'space', id: spaceId }, 'view');
  if (shares.size > 0) await insertSharesInTx(tx, orgId, [document.id], shares, userId);
  const final = document;
  return {
    document: final,
    finish: async () => {
      try {
        emitDocumentEvent({ type: 'created', orgId, documentIds: [final.id], toDriveId: final.drive_id, actorId: userId });
        if (spaceId) emitDocumentAccessChanged({ orgId, documentIds: [final.id], spaceId });
        await emitDocumentUpdated(orgId, [final.id]);
      } catch {
        console.error('[legacy-notes] the created document could not be announced');
      }
    },
  };
}

/** createNoteDocumentInTx in its own transaction, then its post-commit step. */
export async function createNoteDocument(input: CreateNoteDocumentInput): Promise<DocumentRow> {
  const { document, finish } = await db.transaction((tx) => createNoteDocumentInTx(tx, input));
  await finish();
  return document;
}

// ---------------------------------------------------------------------------
// The old note and canvas tools (Defty, agents, MCP): the same names and
// parameters, reading and writing documents.

/**
 * The old note and canvas tools Defty still offers, each an alias now of the
 * document tool that replaces it (M7): their descriptions begin
 * "Deprecated:", and each use is logged. note_to_wiki stays until H3.
 */
export const DEPRECATED_NOTE_TOOLS = {
  search_notes: 'search_documents',
  read_note: 'read_document',
  create_note: 'create_document',
  read_canvas: 'read_document',
  write_canvas: 'edit_document',
} as const;

/**
 * Logs a use of an old note or canvas tool: `[deprecated] <old>: use <new>`.
 * Each line is a fixed string (the logs carry no dynamic value).
 */
export function logDeprecatedNoteTool(name: keyof typeof DEPRECATED_NOTE_TOOLS): void {
  switch (name) {
    case 'search_notes': console.warn('[deprecated] search_notes: use search_documents'); break;
    case 'read_note': console.warn('[deprecated] read_note: use read_document'); break;
    case 'create_note': console.warn('[deprecated] create_note: use create_document'); break;
    case 'read_canvas': console.warn('[deprecated] read_canvas: use read_document'); break;
    case 'write_canvas': console.warn('[deprecated] write_canvas: use edit_document'); break;
  }
}

/** A document a note tool lists: a short snippet of its text, never its content, and its link. */
export type NoteDocumentSummary = { id: string; title: string; drive_kind: string; updated_at: Date; snippet: string; url: string };

/**
 * search_notes and note_list: documents `userId` can open whose title or text
 * contains `query` (ILIKE, escaped), newest first. `scope`: `mine` those they
 * created, `org` those in open drives (a workspace note's home), `all` every
 * one. `templates` keeps only templates (true) or leaves them out (false).
 */
export async function searchNoteDocuments(input: NoteDocumentSearch): Promise<NoteDocumentSummary[]> {
  const rows = await noteDocumentsSearchQuery(input);
  return rows.map((row) => ({ ...row, url: `/d/${row.id}` }));
}

export type NoteDocumentSearch = {
  orgId: string; userId: string; query?: string; scope?: 'mine' | 'org' | 'all'; limit: number; templates?: boolean;
};

/** The statement searchNoteDocuments runs. Exported for its planning test. */
export function noteDocumentsSearchQuery(input: NoteDocumentSearch) {
  const query = input.query?.trim() ?? '';
  const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  return db.select({
    id: documents.id, title: documents.title, drive_kind: drives.kind, updated_at: documents.updated_at,
    snippet: sql<string>`substring(${documents.content_text} from 1 for 240)`,
  }).from(documents)
    .innerJoin(drives, and(eq(drives.id, documents.drive_id), eq(drives.org_id, documents.org_id)))
    .where(and(
      visibleDocumentCondition(input.userId, input.orgId),
      input.templates === undefined ? undefined : eq(documents.is_template, input.templates),
      input.scope === 'mine' ? eq(documents.created_by, input.userId) : input.scope === 'org' ? eq(drives.kind, 'open') : undefined,
      query ? sql`(${documents.title} ILIKE ${pattern} OR ${documents.content_text} ILIKE ${pattern})` : undefined,
    ))
    .orderBy(desc(documents.updated_at))
    .limit(input.limit);
}

export type NoteDocumentRead = {
  id: string; title: string; content: string; content_format: 'markdown'; drive_kind: string; is_template: boolean;
  created_at: Date; updated_at: Date; url: string; role: DocRole;
};

/** read_note and note_get: the document (or the one an old note id moved to) `userId` can open, its content as Markdown. */
export async function readNoteDocument(orgId: string, userId: string, id: string): Promise<NoteDocumentRead | null> {
  const documentId = await documentIdForNoteRef(orgId, id);
  const role = await documentRoleFor(userId, orgId, documentId);
  if (!role) return null;
  const [row] = await db.select({
    id: documents.id, title: documents.title, content_json: documents.content_json, drive_kind: drives.kind,
    is_template: documents.is_template, created_at: documents.created_at, updated_at: documents.updated_at,
  }).from(documents)
    .innerJoin(drives, and(eq(drives.id, documents.drive_id), eq(drives.org_id, documents.org_id)))
    .where(and(eq(documents.id, documentId), eq(documents.org_id, orgId), eq(documents.is_deleted, false))).limit(1);
  if (!row) return null;
  const { content_json, ...rest } = row;
  return {
    ...rest, content: documentMarkdown(await documentJsonNow(orgId, row.id, content_json)), content_format: 'markdown',
    url: `/d/${row.id}`, role,
  };
}

/**
 * note_to_wiki's rule (C13, kept from notes): a document `userId` can open
 * that they created, that sits in an open drive, or that is shared with a
 * chat they are in. A document shared with them alone isn't theirs to
 * publish to the whole workspace. For a query over `documents`.
 */
export function promotableDocumentSql(userId: string, orgId: string): SQL {
  return sql`(${visibleDocumentCondition(userId, orgId)} AND (
    ${documents.created_by} = ${userId}
    OR EXISTS (SELECT 1 FROM drives promotable_drive WHERE promotable_drive.id = ${documents.drive_id}
      AND promotable_drive.org_id = ${documents.org_id} AND promotable_drive.kind = 'open')
    OR EXISTS (SELECT 1 FROM document_shares promotable_share
      JOIN space_members promotable_seat ON promotable_seat.space_id = promotable_share.principal_id
      WHERE promotable_share.document_id = ${documents.id} AND promotable_share.org_id = ${documents.org_id}
        AND promotable_share.principal_type = 'space' AND promotable_seat.user_id = ${userId})))`;
}

/** The document a note_to_wiki names (a document id or an old note id), when `userId` may publish it, with its Markdown. */
export async function promotableNoteDocument(orgId: string, userId: string, id: string): Promise<{ id: string; title: string; markdown: string } | null> {
  const documentId = await documentIdForNoteRef(orgId, id);
  const [row] = await db.select({ id: documents.id, title: documents.title, content_json: documents.content_json }).from(documents)
    .where(and(eq(documents.id, documentId), promotableDocumentSql(userId, orgId))).limit(1);
  if (!row) return null;
  return { id: row.id, title: row.title, markdown: documentMarkdown(await documentJsonNow(orgId, row.id, row.content_json)) };
}

/** read_canvas: the chat's canvas document, when `userId` can open it; null when the chat has none (or it was empty). */
export async function readCanvasDocument(orgId: string, userId: string, spaceId: string): Promise<{
  id: string; document_id: string; title: string; content: string; content_format: 'markdown'; updated_at: Date; url: string;
} | null> {
  const canvas = await canvasDocumentFor(orgId, spaceId);
  if (!canvas?.documentId || !(await documentRoleFor(userId, orgId, canvas.documentId))) return null;
  const [row] = await db.select({ id: documents.id, title: documents.title, content_json: documents.content_json, updated_at: documents.updated_at })
    .from(documents).where(and(eq(documents.id, canvas.documentId), eq(documents.org_id, orgId), eq(documents.is_deleted, false))).limit(1);
  if (!row) return null;
  return {
    id: row.id, document_id: row.id, title: row.title, updated_at: row.updated_at, url: `/d/${row.id}`, content_format: 'markdown',
    content: documentMarkdown(await documentJsonNow(orgId, row.id, row.content_json)),
  };
}

/** Defty's own user: collab/server.ts's writer honours `askerId` for it alone. */
export async function deftyUserId(): Promise<string | null> {
  const [row] = await db.select({ id: users.id }).from(users).where(and(eq(users.email, DEFTY_EMAIL), eq(users.kind, 'agent'))).limit(1);
  return row?.id ?? null;
}

/**
 * Who an executed note or canvas tool writes as (writeDocument's actor): a
 * person through their own MCP client as themselves; an agent employee as
 * its own user; Defty as itself, for the person who asked (`userId`, the
 * action's requester).
 */
export async function noteToolActor(userId: string, options: { agentEmployeeId?: string | null; humanPrincipal?: boolean }): Promise<CollabActor> {
  if (options.humanPrincipal) return { kind: 'user', userId };
  if (options.agentEmployeeId) return { kind: 'agent', userId };
  const defty = await deftyUserId();
  if (!defty) throw new DocumentWriteRefused('FORBIDDEN');
  return { kind: 'agent', userId: defty, askerId: userId };
}

/**
 * Replaces a document's content through the one writer (rule C2), as an
 * agent edit: the actor's role is checked at write time, and a drive that
 * takes only suggestions refuses an agent. Content outside the schema is
 * INVALID_CONTENT. Images the content names are linked in the write's
 * transaction (`inTransaction`) as the person acting (Defty's asker, an
 * agent's own user) may link them, or shown as the placeholder
 * (lib/note-tool-images.ts).
 */
export async function replaceDocumentContent(input: { orgId: string; documentId: string; actor: CollabActor; json: JSONContent }): Promise<{ revision: number }> {
  const uploaderId = input.actor.askerId ?? input.actor.userId;
  const images = await toolImages(db, { orgId: input.orgId, uploaderId, documentId: input.documentId, json: input.json });
  return writeDocument({
    orgId: input.orgId,
    documentId: input.documentId,
    actor: input.actor,
    reason: 'agent_edit',
    mutate: (doc) => {
      try {
        applyJsonToYDoc(doc, images.json);
      } catch {
        throw new DocumentWriteRefused('INVALID_CONTENT');
      }
    },
    inTransaction: images.link.length === 0 ? undefined : (tx) => linkToolImagesInTx(tx, {
      orgId: input.orgId, uploaderId, documentId: input.documentId, fileIds: images.link,
    }),
  });
}

/** write_canvas: the chat's moved canvas document, or why there is none to write. */
export async function canvasDocumentToWrite(orgId: string, spaceId: string): Promise<{ documentId: string } | { error: string }> {
  const canvas = await canvasDocumentFor(orgId, spaceId);
  if (!canvas?.documentId) {
    return { error: 'This space has no canvas. Canvases are documents now: create a document and share it with the space.' };
  }
  return { documentId: canvas.documentId };
}

/** The tools whose executed content is a document's (B-I1). */
const DOCUMENT_CONTENT_TOOLS: ReadonlySet<string> = new Set(['create_note', 'write_canvas']);

/** What an executed tool's content is recorded as: the document it is now, and its size. */
function omittedToolContent(content: unknown, documentId: string | null) {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return { document_id: documentId, content_omitted: true, content_bytes: Buffer.byteLength(text) };
}

/**
 * An executed create_note or write_canvas call's input as run details keep
 * it (B-I1, at write time): its `content` omitted, naming the document from
 * the tool's result. Any other call, or one with no content or no document
 * in its result, is returned as it is.
 */
export function toolInputWithContentOmitted(action: string, toolInput: unknown, result: unknown): unknown {
  if (!DOCUMENT_CONTENT_TOOLS.has(action) || !toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return toolInput;
  const record = toolInput as Record<string, unknown>;
  const outcome = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  const documentId = typeof outcome.document_id === 'string' ? outcome.document_id
    : typeof outcome.canvas_document_id === 'string' ? outcome.canvas_document_id : null;
  if (!documentId) return toolInput;
  // Rebuilt from F15's fields every time (M7 fix round 1, I1): nothing else the
  // model sent, and no `content_omitted` marker of its own, is kept.
  const text = (key: string, max: number) => (typeof record[key] === 'string' ? { [key]: (record[key] as string).slice(0, max) } : {});
  const ref = (key: string) => (storableRef(record[key]) === null ? {} : { [key]: record[key] as string });
  return {
    ...(action === 'create_note'
      ? { ...text('title', 500), ...(['private', 'org', 'space'].includes(record.visibility as string) ? { visibility: record.visibility } : {}), ...ref('visibility_space_id') }
      : { ...text('space_name', 200), ...text('title', 500) }),
    ...ref('source_message_id'),
    ...(record.content === undefined || record.content === null ? {} : { content: omittedText(record.content, documentId) }),
  };
}

/**
 * After create_note or write_canvas executed (review finding B-I1): the
 * content it was given is the document's now, read through the document's
 * own access (rule C4). The stored action's `params.content`, and every copy
 * of it in the run details of the message the action came from (the tool
 * call's input in `agent_blocks`, `tool_calls`, the action graph, a draft),
 * become `{ document_id, content_omitted: true, content_bytes }`, so history
 * and run details, whose audiences include owners and admins without the
 * document and the requester once they lose it, keep no copy. Receipts
 * leave it out too (receipt-params.ts). A pending action's proposal keeps
 * its content: it isn't a document yet. A run that executes the tool itself
 * (agent-runner.ts's background mode) records the call without the content
 * as it writes it (toolInputWithContentOmitted).
 */
export async function omitExecutedToolContent(input: { orgId: string; actionId: string; documentId: string; content: unknown }): Promise<void> {
  if (input.content === undefined || input.content === null) return;
  const text = typeof input.content === 'string' ? input.content : JSON.stringify(input.content);
  const omitted = omittedToolContent(input.content, input.documentId);
  const [action] = await db.select({ params: agentActions.params, message_id: agentActions.message_id }).from(agentActions)
    .where(and(eq(agentActions.id, input.actionId), eq(agentActions.org_id, input.orgId))).limit(1);
  if (!action) return;
  const params = action.params && typeof action.params === 'object' && !Array.isArray(action.params)
    ? action.params as Record<string, unknown> : null;
  if (params && Object.hasOwn(params, 'content')) {
    await db.update(agentActions).set({ params: { ...params, content: omitted } as any })
      .where(and(eq(agentActions.id, input.actionId), eq(agentActions.org_id, input.orgId)));
  }
  if (!action.message_id || text === '') return;
  const [message] = await db.select({ metadata: messages.metadata }).from(messages)
    .where(and(eq(messages.id, action.message_id), eq(messages.org_id, input.orgId))).limit(1);
  if (!message?.metadata) return;
  let changed = false;
  // Every `content` that is this content: the tool's argument, wherever the run recorded it.
  const scrub = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(scrub);
    if (!value || typeof value !== 'object') return value;
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const same = key === 'content' && nested !== null && nested !== undefined
        && (typeof nested === 'string' ? nested === text : JSON.stringify(nested) === text);
      if (same) changed = true;
      out[key] = same ? omitted : scrub(nested);
    }
    return out;
  };
  const metadata = scrub(message.metadata);
  if (changed) {
    await db.update(messages).set({ metadata: metadata as any })
      .where(and(eq(messages.id, action.message_id), eq(messages.org_id, input.orgId)));
  }
}

/** A refusal from the writer or the documents library, as a tool's error text. */
export function noteToolError(error: unknown): string | null {
  if (error instanceof DocumentWriteRefused) {
    return error.code === 'FORBIDDEN' ? 'Not allowed to change this document (a drive set to suggestions only refuses agent edits)' : error.message;
  }
  if (error instanceof DocumentRefusal || error instanceof ToolImageChanged) return error.message;
  return null;
}
