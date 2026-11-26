// Who may read a file a document uses (document_attachments; plan Task F10
// and its 25 Nov consult change): the document access check
// (document-access-sql.ts) on any one document that links the file, at view
// while the file is in the document's current content (`in_current`, kept by
// lib/document-versions.ts from the latest stored content) and at edit, the
// role that reads history, otherwise. A fresh upload is linked with
// `in_current` false (routes/upload.ts), so it reaches viewers only once a
// store of the document holds it. Nothing else grants such a file: not its
// upload, not a note that shows it.
//
// One rule for every surface that serves or copies files:
// lib/attachment-access.ts (GET /api/files/:id, both gates) and the
// workspace export (lib/workspace-export/attachments.ts). Like
// document-access-sql.ts, this module imports no database module, so the
// export can use it on its own snapshot.
//
// Planning memory (document-access-planning-db.test.ts, the export's file
// list): the rule is asked as one check per link
// (visibleDocumentIdViewOrEditSql), not a view and an edit check side by
// side, and the EXISTS over the links ends in OFFSET 0. Without the OFFSET,
// PostgreSQL plans a correlated EXISTS in an expression twice (as a plain
// subplan and as a hashed alternative), nested access check included. The
// two together took the export's member file list from 34 to 21 MB of
// planning memory (measured, F10 fix round 2). The OFFSET changes no result.
import { sql, type SQL } from 'drizzle-orm';
import { visibleDocumentIdViewOrEditSql } from './document-access-sql.js';

/** The columns of one document_attachments row in the caller's statement. */
export type DocumentAttachmentRefs = { documentId: SQL; inCurrent: SQL };

/** True when the link `link` admits `userId` in `orgId`: view on its document while the file is in it, edit otherwise. */
export function documentAttachmentReadableSql(userId: string, orgId: string, link: DocumentAttachmentRefs): SQL {
  return visibleDocumentIdViewOrEditSql(userId, orgId, link.documentId, link.inCurrent);
}

const imageLink = { documentId: sql.raw('document_image_link.document_id'), inCurrent: sql.raw('document_image_link.in_current') };

/** For a statement with the file `fileId` (a value or a column): true when some document of `orgId` links it. */
export function fileInDocumentSql(orgId: string, fileId: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM document_attachments document_image_link
    WHERE document_image_link.org_id = ${orgId} AND document_image_link.file_id = ${fileId} OFFSET 0)`;
}

/** For a statement with the file `fileId`: true when a document of `orgId` that links it admits `userId` (documentAttachmentReadableSql). */
export function fileReadableThroughDocumentSql(userId: string, orgId: string, fileId: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM document_attachments document_image_link
    WHERE document_image_link.org_id = ${orgId} AND document_image_link.file_id = ${fileId}
      AND ${documentAttachmentReadableSql(userId, orgId, imageLink)} OFFSET 0)`;
}
