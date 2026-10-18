import { and, eq } from 'drizzle-orm';
import { events, messageAttachments, messages, projects,
  spaces, taskAttachments, tasks } from '@deft/db/schema';
import { getVisibleAttachment } from './attachment-access.js';
import { liveHumanCalendarEventCondition } from './calendar-event-visibility.js';
import { db } from './db.js';
import type { NativeResourceDisplay, NativeResourceSubject } from './native-resource-types.js';

/** Legacy File parent columns have single-ID references; typed links only pin
 * the Message/Task org, not the parent Space/Project org. Check the complete
 * parent chain before projecting even a label. The existing owner helper still
 * decides the viewer's current membership/Task visibility. */
async function parentChainInOrganization(
  subject: NativeResourceSubject,
  file: NonNullable<Awaited<ReturnType<typeof getVisibleAttachment>>>,
): Promise<boolean> {
  const [messageLinks, taskLinks] = await Promise.all([
    db.select({ message_id: messageAttachments.message_id }).from(messageAttachments)
      .where(and(eq(messageAttachments.org_id, subject.org_id),
        eq(messageAttachments.file_id, file.id))).limit(2),
    db.select({ task_id: taskAttachments.task_id }).from(taskAttachments)
      .where(and(eq(taskAttachments.org_id, subject.org_id),
        eq(taskAttachments.file_id, file.id))).limit(2),
  ]);
  if (messageLinks.length + taskLinks.length > 1) return false;
  const messageId = messageLinks[0]?.message_id
    ?? (taskLinks.length === 0 && !file.task_id ? file.message_id : null);
  const taskId = taskLinks[0]?.task_id
    ?? (messageLinks.length === 0 && !file.message_id ? file.task_id : null);
  if (messageId) {
    const [parent] = await db.select({ id: messages.id }).from(messages)
      .innerJoin(spaces, and(eq(spaces.id, messages.space_id), eq(spaces.org_id, messages.org_id)))
      .where(and(eq(messages.id, messageId), eq(messages.org_id, subject.org_id),
        eq(messages.is_deleted, false)))
      .limit(1);
    return Boolean(parent);
  }
  if (taskId) {
    const [parent] = await db.select({ id: tasks.id }).from(tasks)
      .innerJoin(projects, and(eq(projects.id, tasks.project_id), eq(projects.org_id, tasks.org_id)))
      .where(and(eq(tasks.id, taskId), eq(tasks.org_id, subject.org_id),
        eq(tasks.is_deleted, false), eq(projects.is_deleted, false)))
      .limit(1);
    return Boolean(parent);
  }
  return messageLinks.length === 0 && taskLinks.length === 0
    && !file.message_id && !file.task_id;
}

/** Native Calendar remains the owner. A generic event is not a calendar item. */
export async function resolveNativeCalendarDisplay(
  subject: NativeResourceSubject,
  id: string,
): Promise<NativeResourceDisplay | null> {
  const [event] = await db.select({ title: events.title, updated_at: events.updated_at })
    .from(events)
    .where(and(
      eq(events.id, id),
      eq(events.event_type, 'calendar_event'),
      liveHumanCalendarEventCondition(subject.org_id, subject.user_id),
    ))
    .limit(1);
  if (!event) return null;
  return {
    label: event.title || 'Calendar event',
    updated_at: event.updated_at.toISOString(),
  };
}

/** Attachment visibility belongs to its current Message/Task parent, or to
 * the uploader while staged. Never project bytes, storage keys or derivatives. */
export async function resolveNativeFileDisplay(
  subject: NativeResourceSubject,
  id: string,
): Promise<NativeResourceDisplay | null> {
  const file = await getVisibleAttachment(id, subject.org_id, subject.user_id);
  if (!file || file.processing_status === 'blocked'
    || !(await parentChainInOrganization(subject, file))) return null;
  return { label: file.filename, updated_at: file.updated_at.toISOString() };
}
