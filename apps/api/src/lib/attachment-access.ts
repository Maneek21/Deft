import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
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
import { visibleTaskCondition } from './task-visibility.js';
import { visibleNoteCondition } from './note-visibility.js';
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
 * Resolves the current attachment target before returning metadata. Typed
 * links are authoritative once present; legacy columns remain a read fallback
 * throughout the compatibility window. Multiple typed targets fail closed.
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
  // On no task or message: its uploader, or a reader of a note that shows it.
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
    const [file] = await tx.select().from(files).where(and(eq(files.org_id, params.org_id), eq(files.id, params.file.id))).for('update');
    if (!file || file.storage_key !== params.file.storage_key || file.size_bytes !== params.file.size_bytes
      || file.content_sha256 !== params.file.content_sha256) throw missing();
    if (file.processing_status === 'blocked') throw new AttachmentDownloadAuthorityError('FILE_BLOCKED', 423);
    const messageLinks = await tx.select({ id: messageAttachments.message_id }).from(messageAttachments).where(and(
      eq(messageAttachments.org_id, params.org_id), eq(messageAttachments.file_id, file.id))).for('share');
    const taskLinks = await tx.select({ id: taskAttachments.task_id }).from(taskAttachments).where(and(
      eq(taskAttachments.org_id, params.org_id), eq(taskAttachments.file_id, file.id))).for('share');
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
    } else if (file.uploaded_by !== params.user_id) {
      // On no task or message and not the caller's upload: only a reader of a
      // note that shows it. The file row is UPDATE-locked above, which fences
      // new links (their foreign key); the links, the notes, and the caller's
      // shares and space memberships those notes could grant through are
      // SHARE-locked, so an unshare, a removal, a delete or a visibility change
      // in flight is decided before this read or waits for it.
      const links = await tx.select({ note_id: noteFiles.note_id }).from(noteFiles).where(and(
        eq(noteFiles.org_id, params.org_id), eq(noteFiles.file_id, file.id))).for('share');
      if (links.length === 0) throw missing();
      const noteIds = links.map((link) => link.note_id);
      const linked = await tx.select({ id: notes.id, space_id: notes.visibility_space_id }).from(notes).where(and(
        inArray(notes.id, noteIds), eq(notes.org_id, params.org_id))).for('share');
      await tx.select({ note_id: noteShares.note_id }).from(noteShares).where(and(
        inArray(noteShares.note_id, noteIds), eq(noteShares.shared_with_user_id, params.user_id))).for('share');
      const spaceIds = [...new Set(linked.map((note) => note.space_id).filter((id): id is string => Boolean(id)))];
      if (spaceIds.length > 0) {
        await tx.select({ id: spaceMembers.id }).from(spaceMembers).where(and(
          inArray(spaceMembers.space_id, spaceIds), eq(spaceMembers.user_id, params.user_id))).for('share');
      }
      const [visible] = await tx.select({ id: notes.id }).from(notes).where(and(
        inArray(notes.id, noteIds), eq(notes.org_id, params.org_id), eq(notes.is_deleted, false),
        visibleNoteCondition(params.user_id))).limit(1);
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
