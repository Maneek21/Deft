import { and, eq } from 'drizzle-orm';
import {
  files,
  messageAttachments,
  messages,
  projects,
  spaceMembers,
  taskAttachments,
  tasks,
} from '@deft/db/schema';
import { db } from './db.js';
import { visibleTaskCondition } from './task-visibility.js';

export async function canAccessAttachmentMessage(
  messageId: string,
  orgId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db.select({ id: messages.id })
    .from(messages)
    .innerJoin(spaceMembers, and(
      eq(messages.space_id, spaceMembers.space_id),
      eq(spaceMembers.user_id, userId),
    ))
    .where(and(
      eq(messages.id, messageId),
      eq(messages.org_id, orgId),
      eq(messages.is_deleted, false),
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
    .innerJoin(projects, eq(tasks.project_id, projects.id))
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
      return await canAccessAttachmentMessage(messageLinks[0].message_id, orgId, userId) ? file : null;
    }
    return await canAccessAttachmentTask(taskLinks[0]!.task_id, orgId, userId) ? file : null;
  }

  if (file.task_id) {
    return await canAccessAttachmentTask(file.task_id, orgId, userId) ? file : null;
  }
  if (file.message_id) {
    return await canAccessAttachmentMessage(file.message_id, orgId, userId) ? file : null;
  }
  return file.uploaded_by === userId ? file : null;
}
