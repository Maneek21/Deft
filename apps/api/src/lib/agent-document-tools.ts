// Defty's document read tools: search_documents, read_document and
// list_drive (spec 5.7; plan Task M3).
//
// Each reads with the access of the person who asked (`askerId`, the
// `userId` executeToolCall is given): Defty's own user never passes the
// access check (lib/document-access-sql.ts). Every read goes through that
// check. Results carry no content of a document the asker can't open, and
// name a drive only where the asker can see it. In a shared conversation
// executeToolCall then holds each result to the conversation's audience
// (lib/document-audience.ts).
//
// Knowledge (consult rule C8): these tools read documents the asker can
// open whether or not their Knowledge switch is on (spec 5.8). They don't
// read or change what the wiki learned.
import { and, asc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { docFolders, documents, drives } from '@deft/db/documents';
import { ensureBlockIds, jsonToMarkdown, jsonToText, topLevelBlocks } from '@deft/doc-schema';
import { db } from './db.js';
import {
  documentRoleFor, driveRoleFor, visibleDocumentCondition, visibleDriveIdSql, type DocRole,
} from './document-access.js';
import { driveListQuery } from './drives.js';
import { documentIdForNoteRef, documentJsonNow, type JSONContent } from './legacy-notes.js';

export const SEARCH_DEFAULT_LIMIT = 8;
export const SEARCH_MAX_LIMIT = 20;
const QUERY_MAX_CHARS = 200;
/** The most Markdown a read returns: about 30,000 tokens, cut at a block. */
export const READ_MAX_MARKDOWN_CHARS = 120_000;
/** The most folders, and documents, a drive listing returns. */
export const LIST_MAX_ITEMS = 100;
/** The text a search snippet is cut from: the same prefix the search vector indexes past its first try. */
const SNIPPET_SOURCE_CHARS = 100_000;

type ToolError = { error: string; code: string };
const toolError = (code: string, error: string): ToolError => ({ error, code });

export type AgentDocumentRead = {
  id: string;
  title: string;
  /** The document's drive, where the asker can see it. */
  drive: { id: string; name: string } | null;
  role: DocRole;
  /** jsonToMarkdown with block ids: each top-level block after its `<!-- block:<id> -->` line. */
  markdown: string;
  /** The ids of the blocks in `markdown`, in order. */
  block_ids: string[];
  /** True when the document was longer than READ_MAX_MARKDOWN_CHARS and `markdown` stops at a block. */
  truncated: boolean;
  url: string;
};

/** The document as Markdown with block ids, at most READ_MAX_MARKDOWN_CHARS, cut before a block. */
function markdownForAgent(json: JSONContent): { markdown: string; blockIds: string[]; truncated: boolean } {
  const withIds = ensureBlockIds(json);
  const blockIds = topLevelBlocks(withIds).map((block) => block.id);
  let markdown: string;
  try {
    markdown = jsonToMarkdown(withIds, { blockIds: true });
  } catch {
    // Content outside the schema reads as its plain text, without block ids.
    const plain = jsonToText(withIds);
    return { markdown: plain.slice(0, READ_MAX_MARKDOWN_CHARS), blockIds: [], truncated: plain.length > READ_MAX_MARKDOWN_CHARS };
  }
  if (markdown.length <= READ_MAX_MARKDOWN_CHARS) return { markdown, blockIds, truncated: false };
  // Whole blocks only: stop before the last block that starts within the limit.
  const cut = markdown.lastIndexOf('\n\n<!-- block:', READ_MAX_MARKDOWN_CHARS);
  const kept = cut > 0 ? markdown.slice(0, cut) : markdown.slice(0, READ_MAX_MARKDOWN_CHARS);
  // The blocks in `kept`, found in order (each marker after the one before).
  const keptIds: string[] = [];
  let from = 0;
  for (const id of blockIds) {
    const at = kept.indexOf(`<!-- block:${id} -->`, from);
    if (at < 0) break;
    keptIds.push(id);
    from = at + 1;
  }
  return { markdown: kept, blockIds: keptIds, truncated: true };
}

/**
 * read_document: the document `documentId` (or the one an old note id moved
 * to) when `askerId` can open it, its content as it is now (live edits
 * included, F7's readCurrentDocument) as Markdown with block ids. Null when
 * they can't open it, or there is none.
 */
export async function readDocumentForAgent(orgId: string, askerId: string, documentId: string): Promise<AgentDocumentRead | null> {
  const id = await documentIdForNoteRef(orgId, documentId);
  const role = await documentRoleFor(askerId, orgId, id);
  if (!role) return null;
  const [row] = await db.select({
    id: documents.id, title: documents.title, content_json: documents.content_json, drive_id: documents.drive_id,
    drive_name: sql<string | null>`CASE WHEN ${visibleDriveIdSql(askerId, orgId, sql`${documents.drive_id}`)} THEN ${drives.name} END`,
  }).from(documents)
    .innerJoin(drives, and(eq(drives.id, documents.drive_id), eq(drives.org_id, documents.org_id)))
    .where(and(eq(documents.id, id), eq(documents.org_id, orgId), eq(documents.is_deleted, false)))
    .limit(1);
  if (!row) return null;
  const { markdown, blockIds, truncated } = markdownForAgent(await documentJsonNow(orgId, row.id, row.content_json));
  return {
    id: row.id,
    title: row.title,
    drive: row.drive_name === null ? null : { id: row.drive_id, name: row.drive_name },
    role,
    markdown,
    block_ids: blockIds,
    truncated,
    url: `/d/${row.id}`,
  };
}

export type DocumentSearch = { orgId: string; askerId: string; query: string; driveId?: string | null; limit: number };

/**
 * The statement search_documents runs. The documents `askerId` can open
 * whose search vector matches `query` (websearch syntax, the `simple`
 * configuration the vector is built with), best first, at most `limit`;
 * then, for those rows only, the drive's name where the asker can see the
 * drive, and a ts_headline snippet of the text. Exported for its planning
 * test.
 */
export function searchDocumentsQuery(input: DocumentSearch): SQL {
  const tsQuery = sql`websearch_to_tsquery('simple', ${input.query})`;
  return sql`SELECT hit.id, hit.title, hit.drive_id,
      CASE WHEN ${visibleDriveIdSql(input.askerId, input.orgId, sql.raw('hit.drive_id'))} THEN hit_drive.name END AS drive_name,
      ts_headline('simple', hit.snippet_source, ${tsQuery},
        'MaxFragments=2, MaxWords=24, MinWords=8, StartSel="**", StopSel="**"') AS snippet
    FROM (
      SELECT ${documents.id} AS id, ${documents.title} AS title, ${documents.drive_id} AS drive_id,
        left(${documents.content_text}, ${SNIPPET_SOURCE_CHARS}) AS snippet_source,
        ts_rank(${documents.search_vector}, ${tsQuery}) AS rank, ${documents.updated_at} AS updated_at
      FROM ${documents}
      WHERE ${visibleDocumentCondition(input.askerId, input.orgId)}
        AND ${documents.search_vector} @@ ${tsQuery}
        ${input.driveId ? sql`AND ${documents.drive_id} = ${input.driveId}` : sql``}
      ORDER BY rank DESC, ${documents.updated_at} DESC, ${documents.id}
      LIMIT ${input.limit}
    ) hit
    JOIN drives hit_drive ON hit_drive.id = hit.drive_id AND hit_drive.org_id = ${input.orgId}
    ORDER BY hit.rank DESC, hit.updated_at DESC, hit.id`;
}

export type DocumentSearchHit = { id: string; title: string; drive_id: string; drive_name: string | null; snippet: string; url: string };

/** search_documents: the documents the asker can open matching `query` (searchDocumentsQuery). */
export async function searchDocumentsForAgent(input: DocumentSearch): Promise<DocumentSearchHit[]> {
  const rows = (await db.execute(searchDocumentsQuery(input))).rows as Array<Omit<DocumentSearchHit, 'url'>>;
  return rows.map((row) => ({
    id: row.id, title: row.title, drive_id: row.drive_id, drive_name: row.drive_name ?? null, snippet: row.snippet ?? '', url: `/d/${row.id}`,
  }));
}

/**
 * The documents list_drive shows in a drive's folder (`folderId`, or the
 * drive's top level): those `askerId` can open, by position then title, at
 * most LIST_MAX_ITEMS + 1 (so the caller can tell there are more). Sub-pages
 * are listed too, with their parent. The caller has checked the asker can
 * see the drive. Exported for its planning test (`.toSQL()`).
 */
export function driveFolderDocumentsQuery(askerId: string, orgId: string, driveId: string, folderId: string | null) {
  return db.select({ id: documents.id, title: documents.title, parent_document_id: documents.parent_document_id }).from(documents)
    .where(and(
      eq(documents.drive_id, driveId),
      folderId === null ? isNull(documents.folder_id) : eq(documents.folder_id, folderId),
      visibleDocumentCondition(askerId, orgId),
    ))
    .orderBy(asc(documents.position), asc(documents.title), asc(documents.id))
    .limit(LIST_MAX_ITEMS + 1);
}

type ListedDrive = { id: string; name: string; kind: string; role: DocRole };

/**
 * list_drive. With no drive: the drives `askerId` can open, with their role
 * (driveListQuery; a private drive an owner or admin only sees listed is
 * left out). With a drive they can see: its folders and the documents they
 * can open in it, at the top level or in `folderId`.
 */
export async function listDriveForAgent(input: { orgId: string; askerId: string; driveId?: string | null; folderId?: string | null }): Promise<
  | { drives: ListedDrive[]; truncated: boolean }
  | { drive: ListedDrive; folder: { id: string; name: string } | null; folders: Array<{ id: string; name: string }>;
    documents: Array<{ id: string; title: string; parent_document_id: string | null; url: string }>; truncated: boolean }
  | ToolError
> {
  const { orgId, askerId } = input;
  if (!input.driveId) {
    if (input.folderId) return toolError('DRIVE_REQUIRED', 'folder_id needs its drive_id');
    const rows = (await db.execute(driveListQuery(askerId, orgId))).rows as Array<{ id: string; name: string; kind: string; role: DocRole | null }>;
    const openable = rows.filter((row): row is typeof row & { role: DocRole } => row.role !== null);
    return {
      drives: openable.slice(0, LIST_MAX_ITEMS).map((row) => ({ id: row.id, name: row.name, kind: row.kind, role: row.role })),
      truncated: openable.length > LIST_MAX_ITEMS,
    };
  }
  const driveId = input.driveId;
  const role = await driveRoleFor(askerId, orgId, driveId);
  if (!role) return toolError('DRIVE_NOT_FOUND', 'Drive not found, or you can\'t open it');
  const [drive] = await db.select({ id: drives.id, name: drives.name, kind: drives.kind }).from(drives)
    .where(and(eq(drives.id, driveId), eq(drives.org_id, orgId), eq(drives.is_deleted, false))).limit(1);
  if (!drive) return toolError('DRIVE_NOT_FOUND', 'Drive not found, or you can\'t open it');
  let folder: { id: string; name: string } | null = null;
  if (input.folderId) {
    const [found] = await db.select({ id: docFolders.id, name: docFolders.name }).from(docFolders).where(and(
      eq(docFolders.id, input.folderId), eq(docFolders.org_id, orgId), eq(docFolders.drive_id, driveId), eq(docFolders.is_deleted, false),
    )).limit(1);
    if (!found) return toolError('FOLDER_NOT_FOUND', 'Folder not found in this drive');
    folder = found;
  }
  const [folders, rows] = await Promise.all([
    db.select({ id: docFolders.id, name: docFolders.name }).from(docFolders).where(and(
      eq(docFolders.org_id, orgId), eq(docFolders.drive_id, driveId), eq(docFolders.is_deleted, false),
      folder ? eq(docFolders.parent_folder_id, folder.id) : isNull(docFolders.parent_folder_id),
    )).orderBy(asc(docFolders.position), asc(docFolders.name), asc(docFolders.id)).limit(LIST_MAX_ITEMS + 1),
    driveFolderDocumentsQuery(askerId, orgId, driveId, folder?.id ?? null),
  ]);
  return {
    drive: { ...drive, role },
    folder,
    folders: folders.slice(0, LIST_MAX_ITEMS),
    documents: rows.slice(0, LIST_MAX_ITEMS).map((row) => ({ ...row, url: `/d/${row.id}` })),
    truncated: folders.length > LIST_MAX_ITEMS || rows.length > LIST_MAX_ITEMS,
  };
}

type Citation = { type: string; id: string; title: string; url?: string };

const citationOf = (row: { id: string; title: string }): Citation => ({
  type: 'document', id: row.id, title: (row.title || 'Untitled').slice(0, 80), url: `/d/${row.id}`,
});

/**
 * Runs one of the three tools for `askerId` (executeToolCall's `userId`),
 * with plain refusals: what the asker can't open reads as not found.
 * Citations are `{ type: 'document', id, title, url }`.
 */
export async function runDocumentReadTool(toolName: 'search_documents' | 'read_document' | 'list_drive', params: Record<string, any>,
  orgId: string, askerId: string): Promise<{ result: unknown; citations: Citation[] }> {
  if (toolName === 'read_document') {
    const documentId = typeof params.document_id === 'string' ? params.document_id.trim() : '';
    if (!documentId) return { result: toolError('DOCUMENT_REQUIRED', 'document_id is required'), citations: [] };
    const read = await readDocumentForAgent(orgId, askerId, documentId);
    if (!read) return { result: toolError('DOCUMENT_NOT_FOUND', 'Document not found, or you can\'t open it'), citations: [] };
    return { result: read, citations: [citationOf(read)] };
  }
  if (toolName === 'search_documents') {
    const query = typeof params.query === 'string' ? params.query.trim().slice(0, QUERY_MAX_CHARS) : '';
    if (!query) return { result: toolError('QUERY_REQUIRED', 'query is required'), citations: [] };
    const asked = Number(params.limit);
    const limit = Number.isFinite(asked) ? Math.min(Math.max(Math.trunc(asked), 1), SEARCH_MAX_LIMIT) : SEARCH_DEFAULT_LIMIT;
    const driveId = typeof params.drive_id === 'string' && params.drive_id.trim() ? params.drive_id.trim() : null;
    const hits = await searchDocumentsForAgent({ orgId, askerId, query, driveId, limit });
    return { result: { documents: hits, count: hits.length }, citations: hits.map(citationOf) };
  }
  const driveId = typeof params.drive_id === 'string' && params.drive_id.trim() ? params.drive_id.trim() : null;
  const folderId = typeof params.folder_id === 'string' && params.folder_id.trim() ? params.folder_id.trim() : null;
  return { result: await listDriveForAgent({ orgId, askerId, driveId, folderId }), citations: [] };
}
