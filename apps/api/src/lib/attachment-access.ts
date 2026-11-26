import { and, eq, inArray, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import { documentAttachments, documents, documentShares, driveMembers, drives } from '@deft/db/documents';
import {
  files,
  messageAttachments,
  messages,
  notes,
  noteShares,
  projects,
  spaceMembers,
  spaces,
  orgMembers,
  webSessions,
  taskWatchers,
  taskAssignees,
  taskAttachments,
  tasks,
} from '@deft/db/schema';
import { noteFiles } from '@deft/db/note-files';
import { db } from './db.js';
import { documentAttachmentReadableSql } from './document-attachment-access.js';
import { visibleTaskCondition } from './task-visibility.js';
import { visibleNoteCondition, visibleNoteConditionFromLockedGrants } from './note-visibility.js';
import { unjoinedPublicSpaceReadableSql } from './space-membership.js';

/**
 * The message exists, is not deleted and the caller is in its space. With
 * `access: 'read'` the caller may instead be a member of the workspace (never
 * a guest) reading a public space before joining it. Attaching a file to a
 * message is a write and keeps the default.
 */
export async function canAccessAttachmentMessage(
  messageId: string,
  orgId: string,
  userId: string,
  access: 'member' | 'read' = 'member',
): Promise<boolean> {
  const [row] = await db.select({ id: messages.id })
    .from(messages)
    .innerJoin(spaces, and(eq(messages.space_id, spaces.id), eq(spaces.org_id, orgId)))
    .leftJoin(spaceMembers, and(
      eq(messages.space_id, spaceMembers.space_id),
      eq(spaceMembers.user_id, userId),
    ))
    .where(and(
      eq(messages.id, messageId),
      eq(messages.org_id, orgId),
      eq(messages.is_deleted, false),
      access === 'read'
        ? or(isNotNull(spaceMembers.id), unjoinedPublicSpaceReadableSql(userId))
        : isNotNull(spaceMembers.id),
    ))
    .limit(1);
  return Boolean(row);
}

export async function canAccessAttachmentTask(
  taskId: string,
  orgId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db.select({ id: tasks.id })
    .from(tasks)
    .innerJoin(projects, and(eq(tasks.project_id, projects.id), eq(projects.org_id, orgId)))
    .where(and(
      eq(tasks.id, taskId),
      eq(tasks.org_id, orgId),
      eq(tasks.is_deleted, false),
      visibleTaskCondition(userId),
    ))
    .limit(1);
  return Boolean(row);
}

/**
 * A file on no task or message that a note shows (note_files, kept in step
 * with the note's content by note-file-claims.ts) is read by everyone who can
 * read that note: the note is in the same workspace, not deleted, and visible
 * to the caller under the note rule (note-visibility.ts, role-aware).
 */
export async function canReadAttachmentThroughNote(
  fileId: string,
  orgId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db.select({ id: notes.id })
    .from(noteFiles)
    .innerJoin(notes, and(eq(notes.id, noteFiles.note_id), eq(notes.org_id, noteFiles.org_id)))
    .where(and(
      eq(noteFiles.org_id, orgId),
      eq(noteFiles.file_id, fileId),
      eq(notes.is_deleted, false),
      visibleNoteCondition(userId),
    ))
    .limit(1);
  return Boolean(row);
}

/**
 * For a query over document_attachments: the link admits `userId`
 * (document-attachment-access.ts: view while the file is in the document,
 * edit otherwise).
 */
function documentImageReadableSql(userId: string, orgId: string): SQL {
  return documentAttachmentReadableSql(userId, orgId, {
    documentId: sql`${documentAttachments.document_id}`, inCurrent: sql`${documentAttachments.in_current}`,
  });
}

/**
 * A file uploaded into a document (or linked to one by the notes move) is
 * read through its documents (document_attachments) and nothing else: null
 * when no document links it; otherwise true when any one of them admits the
 * caller (documentImageReadableSql), false when none does.
 */
export async function canReadAttachmentThroughDocument(fileId: string, orgId: string, userId: string): Promise<boolean | null> {
  const [row] = await db.select({
    linked: sql<boolean>`count(*) > 0`,
    readable: sql<boolean>`coalesce(bool_or(${documentImageReadableSql(userId, orgId)}), false)`,
  })
    .from(documentAttachments)
    .where(and(eq(documentAttachments.org_id, orgId), eq(documentAttachments.file_id, fileId)));
  if (!row?.linked) return null;
  return row.readable === true;
}

/**
 * Resolves the current attachment target before returning metadata. Typed
 * links are authoritative once present; legacy columns remain a read fallback
 * throughout the compatibility window. Multiple typed targets fail closed.
 * A file on no task or message that documents link is decided by those
 * documents alone (canReadAttachmentThroughDocument), its uploader included.
 */
export async function getVisibleAttachment(fileId: string, orgId: string, userId: string) {
  const [file] = await db.select()
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.org_id, orgId)))
    .limit(1);
  if (!file) return null;

  const [messageLinks, taskLinks] = await Promise.all([
    db.select({ message_id: messageAttachments.message_id })
      .from(messageAttachments)
      .where(and(
        eq(messageAttachments.org_id, orgId),
        eq(messageAttachments.file_id, fileId),
      )),
    db.select({ task_id: taskAttachments.task_id })
      .from(taskAttachments)
      .where(and(
        eq(taskAttachments.org_id, orgId),
        eq(taskAttachments.file_id, fileId),
      )),
  ]);

  if (messageLinks.length + taskLinks.length > 0) {
    if (messageLinks.length + taskLinks.length !== 1) return null;
    if (messageLinks[0]) {
      return await canAccessAttachmentMessage(messageLinks[0].message_id, orgId, userId, 'read') ? file : null;
    }
    return await canAccessAttachmentTask(taskLinks[0]!.task_id, orgId, userId) ? file : null;
  }

  if (file.task_id) {
    return await canAccessAttachmentTask(file.task_id, orgId, userId) ? file : null;
  }
  if (file.message_id) {
    return await canAccessAttachmentMessage(file.message_id, orgId, userId, 'read') ? file : null;
  }
  // In documents: whoever one of them admits, and nobody else.
  const throughDocument = await canReadAttachmentThroughDocument(fileId, orgId, userId);
  if (throughDocument !== null) return throughDocument ? file : null;
  // On no task, message or document: its uploader, or a reader of a note that shows it.
  if (file.uploaded_by === userId) return file;
  return await canReadAttachmentThroughNote(fileId, orgId, userId) ? file : null;
}

export class AttachmentDownloadAuthorityError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'INVALID_TOKEN' | 'FILE_BLOCKED', readonly status: 401 | 404 | 423) {
    super(code === 'INVALID_TOKEN' ? 'Invalid or expired token' : code === 'FILE_BLOCKED' ? 'File is blocked by attachment safety policy' : 'File not found');
  }
}

/** The bytes have already been read without holding authority locks. Serialize
 * the final current parent and exact session decision before handing them off.
 * File UPDATE also fences FK-backed link insertion into an unlinked upload. */
export async function authorizeAttachmentDownload(params: Readonly<{
  org_id: string; user_id: string; sid: string; jwt_expires_at: number;
  file: typeof files.$inferSelect; signal: AbortSignal;
}>) {
  const missing = () => new AttachmentDownloadAuthorityError('NOT_FOUND', 404);
  return db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL lock_timeout = '250ms'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '2s'`);
    params.signal.throwIfAborted();
    const [member] = await tx.select({ active: orgMembers.is_active }).from(orgMembers).where(and(
      eq(orgMembers.org_id, params.org_id), eq(orgMembers.user_id, params.user_id))).for('share');
    if (!member?.active) throw new AttachmentDownloadAuthorityError('INVALID_TOKEN', 401);
    // A note's save locks the note, then the files it links or releases. Take
    // the notes that link this file first, in the same order, so a save and a
    // download of the same image wait for each other instead of timing out.
    await tx.select({ id: notes.id }).from(notes).where(and(eq(notes.org_id, params.org_id), inArray(notes.id,
      tx.select({ id: noteFiles.note_id }).from(noteFiles).where(and(eq(noteFiles.org_id, params.org_id), eq(noteFiles.file_id, params.file.id))))))
      .orderBy(notes.id).for('share');
    // An upload into a document locks its drive, then the document, then
    // writes the file and its link (routes/upload.ts, in lib/drive-locks.ts's
    // order). Take the drives, then the documents, that link this file before
    // the file, in that order, each in id order. Every change to a drive's
    // members, links, default role, freezing or deletion locks the drive FOR
    // UPDATE, and every share change, move and delete of a document locks the
    // document, so those wait for this decision or it reads them.
    const linkedDocumentIds = tx.select({ id: documentAttachments.document_id }).from(documentAttachments).where(and(
      eq(documentAttachments.org_id, params.org_id), eq(documentAttachments.file_id, params.file.id)));
    const lockedDrives = await tx.select({ id: drives.id }).from(drives).where(and(eq(drives.org_id, params.org_id), inArray(drives.id,
      tx.select({ id: documents.drive_id }).from(documents).where(and(eq(documents.org_id, params.org_id), inArray(documents.id, linkedDocumentIds))))))
      .orderBy(drives.id).for('share');
    const lockedDocuments = lockedDrives.length === 0 ? [] : await tx.select({ id: documents.id, drive_id: documents.drive_id }).from(documents)
      .where(and(eq(documents.org_id, params.org_id), inArray(documents.id, linkedDocumentIds))).orderBy(documents.id).for('share');
    const [file] = await tx.select().from(files).where(and(eq(files.org_id, params.org_id), eq(files.id, params.file.id))).for('update');
    if (!file || file.storage_key !== params.file.storage_key || file.size_bytes !== params.file.size_bytes
      || file.content_sha256 !== params.file.content_sha256) throw missing();
    if (file.processing_status === 'blocked') throw new AttachmentDownloadAuthorityError('FILE_BLOCKED', 423);
    const messageLinks = await tx.select({ id: messageAttachments.message_id }).from(messageAttachments).where(and(
      eq(messageAttachments.org_id, params.org_id), eq(messageAttachments.file_id, file.id))).for('share');
    const taskLinks = await tx.select({ id: taskAttachments.task_id }).from(taskAttachments).where(and(
      eq(taskAttachments.org_id, params.org_id), eq(taskAttachments.file_id, file.id))).for('share');
    // The file's UPDATE lock fences new document links (their foreign key);
    // these SHARE locks fence `in_current` changing.
    const documentLinks = await tx.select({ id: documentAttachments.document_id }).from(documentAttachments).where(and(
      eq(documentAttachments.org_id, params.org_id), eq(documentAttachments.file_id, file.id))).for('share');
    const typed = messageLinks.length + taskLinks.length;
    if (typed > 1) throw missing();
    const messageId = typed ? messageLinks[0]?.id : file.task_id ? undefined : file.message_id;
    const taskId = typed ? taskLinks[0]?.id : file.task_id;
    if (messageId) {
      let [parent] = await tx.select({ id: messages.id }).from(messages)
        .innerJoin(spaces, and(eq(messages.space_id, spaces.id), eq(spaces.org_id, params.org_id)))
        .innerJoin(spaceMembers, and(eq(spaceMembers.space_id, spaces.id), eq(spaceMembers.user_id, params.user_id)))
        .where(and(eq(messages.id, messageId), eq(messages.org_id, params.org_id), eq(messages.is_deleted, false))).for('share');
      if (!parent) {
        // Not in the space: a member of the workspace (never a guest) may still
        // read a public space before joining it. The message and space rows are
        // SHARE-locked; the caller's org membership row already is (above).
        [parent] = await tx.select({ id: messages.id }).from(messages)
          .innerJoin(spaces, and(eq(messages.space_id, spaces.id), eq(spaces.org_id, params.org_id)))
          .where(and(eq(messages.id, messageId), eq(messages.org_id, params.org_id), eq(messages.is_deleted, false),
            unjoinedPublicSpaceReadableSql(params.user_id))).for('share');
      }
      if (!parent) throw missing();
    } else if (taskId) {
      // UPDATE prevents concurrent FK-backed watcher/assignee insertion after
      // the grant inventory; existing relationship rows remain SHARE-locked.
      const [task] = await tx.select().from(tasks).where(and(eq(tasks.org_id, params.org_id), eq(tasks.id, taskId))).for('update');
      if (!task || task.is_deleted) throw missing();
      await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.id, task.project_id), eq(projects.org_id, params.org_id))).for('share');
      await tx.select({ user_id: taskWatchers.user_id }).from(taskWatchers).where(and(eq(taskWatchers.task_id, taskId), eq(taskWatchers.user_id, params.user_id))).for('share');
      await tx.select({ user_id: taskAssignees.user_id }).from(taskAssignees).where(and(eq(taskAssignees.task_id, taskId), eq(taskAssignees.user_id, params.user_id))).for('share');
      const [visible] = await tx.select({ id: tasks.id }).from(tasks)
        .innerJoin(projects, and(eq(tasks.project_id, projects.id), eq(projects.org_id, params.org_id)))
        .where(and(eq(tasks.id, taskId), eq(tasks.org_id, params.org_id), eq(tasks.is_deleted, false), visibleTaskCondition(params.user_id)));
      if (!visible) throw missing();
    } else if (documentLinks.length > 0) {
      // In documents: only through them, the uploader included. The drives
      // and documents are SHARE-locked above, the caller's org_members row at
      // the start (a departure, a role change or an agent's pause updates
      // it), and here the caller's seats in the chats those drives and
      // documents grant to, so a removal from one waits too. A document that
      // moved to a drive not locked above, or a link to a document not locked
      // there, counts for nothing.
      const lockedDriveIds = new Set(lockedDrives.map((drive) => drive.id));
      const documentIds = lockedDocuments.filter((document) => lockedDriveIds.has(document.drive_id)).map((document) => document.id);
      if (documentIds.length === 0) throw missing();
      const driveIds = [...new Set(lockedDocuments.map((document) => document.drive_id))].filter((id) => lockedDriveIds.has(id));
      const grantingChats = sql`(SELECT ${driveMembers.principal_id} FROM ${driveMembers}
        WHERE ${driveMembers.org_id} = ${params.org_id} AND ${driveMembers.principal_type} = 'space' AND ${inArray(driveMembers.drive_id, driveIds)}
        UNION SELECT ${documentShares.principal_id} FROM ${documentShares}
        WHERE ${documentShares.org_id} = ${params.org_id} AND ${documentShares.principal_type} = 'space' AND ${inArray(documentShares.document_id, documentIds)})`;
      await tx.select({ space_id: spaceMembers.space_id }).from(spaceMembers)
        .where(and(eq(spaceMembers.user_id, params.user_id), sql`${spaceMembers.space_id} IN ${grantingChats}`))
        .orderBy(spaceMembers.space_id).for('share');
      const [admitted] = await tx.select({ id: documentAttachments.document_id }).from(documentAttachments).where(and(
        eq(documentAttachments.org_id, params.org_id), eq(documentAttachments.file_id, file.id),
        inArray(documentAttachments.document_id, documentIds), documentImageReadableSql(params.user_id, params.org_id))).limit(1);
      if (!admitted) throw missing();
    } else if (file.uploaded_by !== params.user_id) {
      // On no task or message and not the caller's upload: only a reader of a
      // note that shows it. The file row is UPDATE-locked above, which fences
      // new links (their foreign key); the links, the notes, and the caller's
      // shares and space memberships those notes could grant through are
      // SHARE-locked, so an unshare, a removal, a delete or a visibility change
      // in flight is decided before this read or waits for it. The decision
      // counts only the grant rows locked here, never one inserted since.
      const links = await tx.select({ note_id: noteFiles.note_id }).from(noteFiles).where(and(
        eq(noteFiles.org_id, params.org_id), eq(noteFiles.file_id, file.id))).for('share');
      if (links.length === 0) throw missing();
      const noteIds = links.map((link) => link.note_id);
      const linked = await tx.select({ id: notes.id, space_id: notes.visibility_space_id }).from(notes).where(and(
        inArray(notes.id, noteIds), eq(notes.org_id, params.org_id))).for('share');
      const shares = await tx.select({ note_id: noteShares.note_id }).from(noteShares).where(and(
        inArray(noteShares.note_id, noteIds), eq(noteShares.shared_with_user_id, params.user_id))).for('share');
      const spaceIds = [...new Set(linked.map((note) => note.space_id).filter((id): id is string => Boolean(id)))];
      const memberships = spaceIds.length === 0 ? [] : await tx.select({ space_id: spaceMembers.space_id }).from(spaceMembers)
        .where(and(inArray(spaceMembers.space_id, spaceIds), eq(spaceMembers.user_id, params.user_id))).for('share');
      const [visible] = await tx.select({ id: notes.id }).from(notes).where(and(
        inArray(notes.id, linked.map((note) => note.id)), eq(notes.org_id, params.org_id), eq(notes.is_deleted, false),
        visibleNoteConditionFromLockedGrants(params.user_id, {
          sharedNoteIds: shares.map((share) => share.note_id),
          memberSpaceIds: memberships.map((membership) => membership.space_id),
        }))).limit(1);
      if (!visible) throw missing();
    }
    // SID is last. Parent/member/link locks protect all preceding decisions
    // through its possible wait; sample both deadlines after the final query.
    const [session] = await tx.select({ expires_at: webSessions.expires_at, revoked_at: webSessions.revoked_at }).from(webSessions).where(and(
      eq(webSessions.id, params.sid), eq(webSessions.org_id, params.org_id), eq(webSessions.user_id, params.user_id))).for('share');
    params.signal.throwIfAborted();
    const deadline = Math.min(params.jwt_expires_at, session?.expires_at.getTime() ?? 0);
    if (!session || session.revoked_at || deadline <= Date.now()) throw new AttachmentDownloadAuthorityError('INVALID_TOKEN', 401);
    return { file, expires_at: deadline };
  });
}
