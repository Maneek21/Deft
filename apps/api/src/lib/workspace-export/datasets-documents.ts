// Drives and documents in the workspace export (spec 5.11 step 6; plan Task
// F17). The DRIVES_DOCUMENTS group sits next to NOTES_WIKI_EVENTS
// (datasets-knowledge.ts); later tasks add comments (S1) and drive files
// (P1) to it.
//
// What the datasets hold:
// - the whole workspace: every live drive with its folders and members, and
//   every live document in it with its shares, versions and file links;
// - one person: the documents the one access check lets them open
//   (visibleDocumentIdSql, lib/document-access-sql.ts), the drives it lets
//   them view (visibleDriveIdSql) and those drives' folders. Of drive members
//   and shares, only the rows that name the person, as the member scope
//   keeps only the shares of a person's own notes. A document's folder and
//   parent page are named only when the person can see them, as GET
//   /api/documents/:id shows them (viewerDocumentColumns). History (version
//   bodies and authors, and the files only older content shows) and who
//   wrote a document (its created_by and last_edited_by) only for the
//   documents they can edit, and never for a guest, whatever their role
//   (spec 5.6; the 25 Nov consult; F17 fix round 1).
// Nothing deleted is in either: not a document in a drive's trash, a deleted
// folder or drive, or a document in a deleted drive. Deleting a folder moves
// its documents up to its parent folder or the drive root (deleteFolder,
// lib/documents.ts), so they are exported there; the ones it held in the
// trash stay out, as no deleted note is (NOT_INCLUDED). A note, note
// folder or canvas the notes move turned into a document or folder counts as
// deleted once that is (legacySourceLiveSql): deleting the document reaches
// its old row too.
//
// Planning memory (document-access-planning-db.test.ts): a statement holds at
// most one copy of each check it needs (the document check at view, at edit
// for history and authors, and the drive check). The documents and drives a
// statement keeps are a MATERIALIZED CTE, each checked once, then matched by
// id.
//
// Rows that hold a whole document (documents and versions, and the Markdown
// copies in render.ts) are fetched BODY_FETCH_LIMIT at a time.
//
// Like the access check, this module imports no database module: the export
// runs on its own snapshot (workspace-export-db.test.ts).
import { sql, type SQL } from 'drizzle-orm';
import { visibleDocumentIdSql, visibleDriveIdSql, type DocRole } from '../document-access-sql.js';
import { documentAttachmentReadableSql, fileReadableThroughDocumentSql, type DocumentAttachmentRefs } from '../document-attachment-access.js';
import { isGuestRole } from '../people-visibility-sql.js';
import { BODY_FETCH_LIMIT, col, type Dataset } from './datasets.js';
import { memberId, userKnown, workspaceAuthor, workspaceUser, type ExportContext } from './scope.js';

/** A guest never gets a document's history, whatever their role on it. */
function historyForbidden(ctx: ExportContext): boolean {
  return ctx.scope.kind === 'member' && isGuestRole(ctx.scope.role);
}

/** A live document of `orgId` in a live drive: one the whole-workspace export holds. */
function liveDocumentSql(orgId: string, ref: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM documents live_document
    JOIN drives live_home ON live_home.id = live_document.drive_id AND live_home.org_id = live_document.org_id
    WHERE live_document.id = ${ref} AND live_document.org_id = ${orgId} AND live_document.is_deleted = false AND live_home.is_deleted = false)`;
}

/** A live folder of `orgId` in a live drive. */
function liveDocFolderSql(orgId: string, ref: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM doc_folders live_folder
    JOIN drives live_home ON live_home.id = live_folder.drive_id AND live_home.org_id = live_folder.org_id
    WHERE live_folder.id = ${ref} AND live_folder.org_id = ${orgId} AND live_folder.is_deleted = false AND live_home.is_deleted = false)`;
}

/**
 * False for a note, note folder or chat canvas (`ref`) that the notes move
 * (F14) turned into a document or folder (note_document_map) once that, or
 * any page a long note was split into (`details.parts`), is deleted or gone.
 * The move leaves the old rows as they were, read-only, so this is how
 * deleting the document reaches its old row in the export too (the consult's
 * change to F17). True for a source that never moved.
 */
export function legacySourceLiveSql(orgId: string, sourceType: 'note' | 'note_folder' | 'canvas', ref: SQL): SQL {
  const live = sourceType === 'note_folder' ? liveDocFolderSql : liveDocumentSql;
  return sql`NOT EXISTS (SELECT 1 FROM note_document_map moved_source
    WHERE moved_source.org_id = ${orgId} AND moved_source.source_type = ${sourceType} AND moved_source.source_id = ${ref}
      AND (NOT ${live(orgId, col('moved_source.target_id'))}
        OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(moved_source.details->'parts') = 'array'
            THEN moved_source.details->'parts' ELSE '[]'::jsonb END) AS moved_part(id)
          WHERE NOT ${live(orgId, col('moved_part.id'))})))`;
}

/** The ids (`id`) of the documents the export holds; for the member scope, those the person holds at least `min` on. */
function exportedDocumentIdsSql(ctx: ExportContext, min: DocRole = 'view'): SQL {
  const userId = memberId(ctx);
  if (userId) {
    return sql`SELECT exported_document.id FROM documents exported_document
      WHERE exported_document.org_id = ${ctx.orgId} AND exported_document.is_deleted = false
        AND ${visibleDocumentIdSql(userId, ctx.orgId, col('exported_document.id'), min)}`;
  }
  return sql`SELECT exported_document.id FROM documents exported_document
    JOIN drives exported_home ON exported_home.id = exported_document.drive_id AND exported_home.org_id = exported_document.org_id
    WHERE exported_document.org_id = ${ctx.orgId} AND exported_document.is_deleted = false AND exported_home.is_deleted = false`;
}

/** The documents whose history the export holds: every one, or those the person can edit; none for a guest. */
function historyDocumentIdsSql(ctx: ExportContext): SQL {
  return historyForbidden(ctx) ? sql`SELECT NULL::text AS id WHERE false` : exportedDocumentIdsSql(ctx, 'edit');
}

/**
 * Who wrote a document (`userRef`, a column of the document `documentId`):
 * for the whole workspace the author as workspaceAuthor names them; for a
 * person, only on a document they can edit (the `history_documents` CTE,
 * historyDocumentIdsSql, which the statement must define), and never for a
 * guest. Otherwise null.
 */
function documentAuthor(ctx: ExportContext, documentId: SQL, userRef: SQL): SQL {
  if (!memberId(ctx)) return workspaceAuthor(ctx, userRef);
  if (historyForbidden(ctx)) return sql`NULL::text`;
  return sql`CASE WHEN ${documentId} IN (SELECT history_documents.id FROM history_documents) THEN ${workspaceAuthor(ctx, userRef)} END`;
}

/** The `history_documents` CTE documentAuthor reads, where it reads one: a person's export that isn't a guest's. */
function authorsCte(ctx: ExportContext): SQL {
  return memberId(ctx) && !historyForbidden(ctx) ? sql`, history_documents AS MATERIALIZED (${historyDocumentIdsSql(ctx)})` : sql``;
}

/** The ids of the drives the export holds: every live drive, or those the person can view. */
function exportedDriveIdsSql(ctx: ExportContext): SQL {
  const userId = memberId(ctx);
  return sql`SELECT exported_drive.id FROM drives exported_drive
    WHERE exported_drive.org_id = ${ctx.orgId} AND exported_drive.is_deleted = false
      ${userId ? sql`AND ${visibleDriveIdSql(userId, ctx.orgId, col('exported_drive.id'))}` : sql``}`;
}

/**
 * The person or chat a drive member or share row names (`alias`): for the
 * member scope only the person themselves; for the whole workspace a person
 * of this workspace or one of its chats, never anyone else's id.
 */
function exportedPrincipal(ctx: ExportContext, alias: string): SQL {
  const userId = memberId(ctx);
  const type = col(`${alias}.principal_type`);
  const id = col(`${alias}.principal_id`);
  if (userId) return sql`${type} = 'user' AND ${id} = ${userId}`;
  return sql`((${type} = 'user' AND ${userKnown(ctx, id)})
    OR (${type} = 'space' AND EXISTS (SELECT 1 FROM spaces principal_space WHERE principal_space.id = ${id} AND principal_space.org_id = ${ctx.orgId})))`;
}

/**
 * True when the export may show the file link `link` (a document_attachments
 * row): for the whole workspace, a live document's; for a person, as GET
 * /api/files decides (view while the file is in the document, edit when only
 * older versions show it; lib/document-attachment-access.ts), except that a
 * guest gets a file only while it is in the document.
 */
function documentLinkReadableSql(ctx: ExportContext, link: DocumentAttachmentRefs): SQL {
  const userId = memberId(ctx);
  if (!userId) return liveDocumentSql(ctx.orgId, link.documentId);
  if (historyForbidden(ctx)) return sql`(${link.inCurrent} AND ${visibleDocumentIdSql(userId, ctx.orgId, link.documentId)})`;
  return documentAttachmentReadableSql(userId, ctx.orgId, link);
}

const exportedImageLink = { documentId: col('exported_image_link.document_id'), inCurrent: col('exported_image_link.in_current') };

/**
 * For the file list (attachments.ts), a file documents link: true when one
 * of its links is one the export may show (documentLinkReadableSql). For a
 * person who isn't a guest, F10's own form (fileReadableThroughDocumentSql),
 * which GET /api/files runs. OFFSET 0 keeps PostgreSQL from planning the
 * EXISTS twice (F10).
 */
export function exportedDocumentFileSql(ctx: ExportContext, fileId: SQL): SQL {
  const userId = memberId(ctx);
  if (userId && !historyForbidden(ctx)) return fileReadableThroughDocumentSql(userId, ctx.orgId, fileId);
  return sql`EXISTS (SELECT 1 FROM document_attachments exported_image_link
    WHERE exported_image_link.org_id = ${ctx.orgId} AND exported_image_link.file_id = ${fileId}
      AND ${documentLinkReadableSql(ctx, exportedImageLink)} OFFSET 0)`;
}

/** documents/<id>.md (render.ts): each exported document's title and content, read once more. */
export function documentMarkdownQuery(ctx: ExportContext): SQL {
  return sql`WITH exported_documents AS MATERIALIZED (${exportedDocumentIdsSql(ctx)})
    SELECT export_document.id, export_document.title, export_document.content_json
    FROM documents export_document
    WHERE export_document.org_id = ${ctx.orgId} AND export_document.id IN (SELECT exported_documents.id FROM exported_documents)
    ORDER BY export_document.created_at, export_document.id`;
}

export const DRIVES_DOCUMENTS: readonly Dataset[] = [
  {
    path: 'data/drives.jsonl',
    query: (ctx) => sql`WITH exported_drives AS MATERIALIZED (${exportedDriveIdsSql(ctx)})
      SELECT export_drive.id, export_drive.name, export_drive.icon, export_drive.kind,
        ${workspaceUser(ctx, col('export_drive.owner_user_id'))} AS owner_user_id, export_drive.default_role,
        export_drive.agent_suggest_only, export_drive.knowledge_default, export_drive.frozen_at,
        ${workspaceUser(ctx, col('export_drive.created_by'))} AS created_by, export_drive.created_at, export_drive.updated_at
      FROM drives export_drive
      WHERE export_drive.org_id = ${ctx.orgId} AND export_drive.id IN (SELECT exported_drives.id FROM exported_drives)
      ORDER BY export_drive.created_at, export_drive.id`,
  },
  {
    path: 'data/drive_members.jsonl',
    query: (ctx) => sql`WITH exported_drives AS MATERIALIZED (${exportedDriveIdsSql(ctx)})
      SELECT drive_member.drive_id, drive_member.principal_type, drive_member.principal_id, drive_member.role, drive_member.is_link,
        ${workspaceUser(ctx, col('drive_member.added_by'))} AS added_by, drive_member.created_at
      FROM drive_members drive_member
      WHERE drive_member.org_id = ${ctx.orgId} AND drive_member.drive_id IN (SELECT exported_drives.id FROM exported_drives)
        AND ${exportedPrincipal(ctx, 'drive_member')}
      ORDER BY drive_member.drive_id, drive_member.created_at, drive_member.id`,
  },
  {
    // Folders carry no access of their own: each is in the export with its drive.
    path: 'data/doc_folders.jsonl',
    query: (ctx) => sql`WITH exported_drives AS MATERIALIZED (${exportedDriveIdsSql(ctx)})
      SELECT export_folder.id, export_folder.drive_id,
        CASE WHEN EXISTS (SELECT 1 FROM doc_folders parent_folder WHERE parent_folder.id = export_folder.parent_folder_id
            AND parent_folder.org_id = ${ctx.orgId} AND parent_folder.drive_id = export_folder.drive_id AND parent_folder.is_deleted = false)
          THEN export_folder.parent_folder_id END AS parent_folder_id,
        export_folder.name, export_folder.position, ${workspaceAuthor(ctx, col('export_folder.created_by'))} AS created_by,
        export_folder.created_at, export_folder.updated_at
      FROM doc_folders export_folder
      WHERE export_folder.org_id = ${ctx.orgId} AND export_folder.is_deleted = false
        AND export_folder.drive_id IN (SELECT exported_drives.id FROM exported_drives)
      ORDER BY export_folder.drive_id, export_folder.position, export_folder.id`,
  },
  {
    // The stored content as editor JSON (documents/<id>.md has it as Markdown). Never the live-editing state.
    // Who wrote it only for an editor who isn't a guest (documentAuthor).
    path: 'data/documents.jsonl',
    fetchLimit: BODY_FETCH_LIMIT,
    query: (ctx) => sql`WITH exported_documents AS MATERIALIZED (${exportedDocumentIdsSql(ctx)}),
        exported_drives AS MATERIALIZED (${exportedDriveIdsSql(ctx)})${authorsCte(ctx)}
      SELECT export_document.id, export_document.drive_id,
        CASE WHEN export_document.drive_id IN (SELECT exported_drives.id FROM exported_drives)
            AND EXISTS (SELECT 1 FROM doc_folders document_folder WHERE document_folder.id = export_document.folder_id
              AND document_folder.org_id = ${ctx.orgId} AND document_folder.drive_id = export_document.drive_id AND document_folder.is_deleted = false)
          THEN export_document.folder_id END AS folder_id,
        CASE WHEN export_document.parent_document_id IN (SELECT exported_documents.id FROM exported_documents)
          THEN export_document.parent_document_id END AS parent_document_id,
        export_document.title, export_document.icon, export_document.position, export_document.content_json, export_document.is_template,
        ${documentAuthor(ctx, col('export_document.id'), col('export_document.created_by'))} AS created_by,
        ${documentAuthor(ctx, col('export_document.id'), col('export_document.last_edited_by'))} AS last_edited_by,
        export_document.last_edited_at, export_document.created_at, export_document.updated_at
      FROM documents export_document
      WHERE export_document.org_id = ${ctx.orgId} AND export_document.id IN (SELECT exported_documents.id FROM exported_documents)
      ORDER BY export_document.created_at, export_document.id`,
  },
  {
    path: 'data/document_shares.jsonl',
    query: (ctx) => sql`WITH exported_documents AS MATERIALIZED (${exportedDocumentIdsSql(ctx)})
      SELECT document_share.document_id, document_share.principal_type, document_share.principal_id, document_share.role,
        ${workspaceUser(ctx, col('document_share.shared_by'))} AS shared_by, document_share.created_at
      FROM document_shares document_share
      WHERE document_share.org_id = ${ctx.orgId} AND document_share.document_id IN (SELECT exported_documents.id FROM exported_documents)
        AND ${exportedPrincipal(ctx, 'document_share')}
      ORDER BY document_share.document_id, document_share.created_at, document_share.id`,
  },
  {
    // Saved versions with their content, as GET /api/documents/:id/versions/:vid gives them to an editor. A
    // version whose content was removed from history keeps only its details. Its authors are history too: a row
    // is here only for an editor who isn't a guest.
    path: 'data/document_versions.jsonl',
    fetchLimit: BODY_FETCH_LIMIT,
    query: (ctx) => sql`WITH history_documents AS MATERIALIZED (${historyDocumentIdsSql(ctx)})
      SELECT export_version.id, export_version.document_id, export_version.kind, export_version.name, export_version.title,
        CASE WHEN export_version.content_removed_at IS NULL THEN export_version.content_json END AS content_json,
        export_version.size_bytes, ${workspaceAuthor(ctx, col('export_version.created_by'))} AS created_by,
        ${workspaceAuthor(ctx, col('export_version.agent_user_id'))} AS agent_user_id,
        export_version.content_removed_at, export_version.created_at
      FROM document_versions export_version
      WHERE export_version.org_id = ${ctx.orgId} AND export_version.document_id IN (SELECT history_documents.id FROM history_documents)
      ORDER BY export_version.document_id, export_version.created_at, export_version.id`,
  },
  {
    // The files a document uses (each listed in files.jsonl, with its bytes in attachments/). `in_current` is
    // false for a file only older versions show.
    path: 'data/document_attachments.jsonl',
    query: (ctx) => sql`SELECT document_file.document_id, document_file.file_id, document_file.in_current,
        ${workspaceAuthor(ctx, col('document_file.added_by'))} AS added_by, document_file.created_at
      FROM document_attachments document_file
      WHERE document_file.org_id = ${ctx.orgId}
        AND EXISTS (SELECT 1 FROM files linked_file WHERE linked_file.id = document_file.file_id AND linked_file.org_id = ${ctx.orgId})
        AND ${documentLinkReadableSql(ctx, { documentId: col('document_file.document_id'), inCurrent: col('document_file.in_current') })}
      ORDER BY document_file.document_id, document_file.created_at, document_file.id`,
  },
];
