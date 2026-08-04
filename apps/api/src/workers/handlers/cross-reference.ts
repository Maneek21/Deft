// Handler: cross-reference — scans messages or notes for task identifiers
// (e.g. PROJ-42) and creates cross_references + task comments linking them.
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import {
  crossReferences,
  tasks,
  projects,
  taskComments,
  spaces,
  notes,
  messages,
  spaceMembers,
  orgMembers,
  agentEmployees,
  users,
} from '@deft/db/schema';
import { eq, and } from 'drizzle-orm';
import { visibleNoteCondition } from '../../lib/note-visibility.js';
import { visibleTaskCondition } from '../../lib/task-visibility.js';
import { toPlainText } from '../../lib/plain-text.js';

interface CrossReferenceJobData {
  // Message-sourced (legacy shape)
  messageId?: string;
  spaceId?: string;
  // Note-sourced (Task 5.1)
  sourceType?: 'message' | 'note';
  sourceId?: string;
  noteId?: string;
  content: string;
  orgId: string;
  userId: string;
}

const TASK_ID_PATTERN = /([A-Z]+-\d+)/g;

export async function handleCrossReference(job: JobData): Promise<void> {
  const data = job.data as CrossReferenceJobData;
  const { orgId, userId } = data;

  // Resolve source: explicit sourceType takes priority, else fall back to
  // messageId (legacy enqueue shape from messages.ts).
  let sourceType: 'message' | 'note' = data.sourceType ?? 'message';
  let sourceId: string;
  if (data.sourceType === 'note') {
    sourceId = data.sourceId || data.noteId || '';
  } else {
    sourceId = data.sourceId || data.messageId || '';
  }
  if (!sourceId) return;

  // Jobs may execute after a member is offboarded or an employee is paused.
  // Re-authorize the queued actor before performing any durable write.
  const [activeHuman] = await db
    .select({ id: orgMembers.id })
    .from(orgMembers)
    .innerJoin(users, and(
      eq(users.id, orgMembers.user_id),
      eq(users.is_agent, false),
    ))
    .where(and(
      eq(orgMembers.org_id, orgId),
      eq(orgMembers.user_id, userId),
      eq(orgMembers.is_active, true),
    ))
    .limit(1);
  let activeEmployee: { id: string } | undefined;
  if (!activeHuman) {
    [activeEmployee] = await db
      .select({ id: agentEmployees.id })
      .from(agentEmployees)
      .where(and(
        eq(agentEmployees.org_id, orgId),
        eq(agentEmployees.user_id, userId),
        eq(agentEmployees.is_active, true),
        eq(agentEmployees.is_deleted, false),
      ))
      .limit(1);
  }
  if (!activeHuman && !activeEmployee) return;

  // Reload the source from the database instead of trusting queued content.
  // This both closes stale-job leaks and proves the actor may still see it.
  let plainContent: string;
  let sourceMayCreateComment = false;
  if (sourceType === 'note') {
    const [note] = await db
      .select({
        content: notes.content,
        visibility: notes.visibility,
      })
      .from(notes)
      .where(and(
        eq(notes.id, sourceId),
        eq(notes.org_id, orgId),
        eq(notes.is_deleted, false),
        visibleNoteCondition(userId),
      ))
      .limit(1);
    if (!note) return;

    plainContent = toPlainText(note.content);
    sourceMayCreateComment = note.visibility === 'org';
  } else {
    const [message] = await db
      .select({
        content: messages.content,
        space_type: spaces.type,
      })
      .from(messages)
      .innerJoin(spaces, and(
        eq(messages.space_id, spaces.id),
        eq(spaces.org_id, orgId),
      ))
      .innerJoin(spaceMembers, and(
        eq(spaceMembers.space_id, messages.space_id),
        eq(spaceMembers.user_id, userId),
      ))
      .where(and(
        eq(messages.id, sourceId),
        eq(messages.org_id, orgId),
        eq(messages.is_deleted, false),
        eq(spaces.is_archived, false),
      ))
      .limit(1);
    if (!message) return;

    plainContent = toPlainText(message.content);
    sourceMayCreateComment = message.space_type === 'public';
  }

  const matches = plainContent.match(TASK_ID_PATTERN);
  if (!matches) return;

  // De-duplicate identifiers in the same source
  const uniqueRefs = [...new Set(matches)];

  for (const ref of uniqueRefs) {
    try {
      const dashIdx = ref.lastIndexOf('-');
      const prefix = ref.slice(0, dashIdx);
      const number = parseInt(ref.slice(dashIdx + 1), 10);

      if (isNaN(number)) continue;

      // Resolve only a live task in this org that the source actor can see.
      const [task] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .innerJoin(projects, eq(tasks.project_id, projects.id))
        .where(and(
          eq(projects.org_id, orgId),
          eq(projects.prefix, prefix),
          eq(projects.is_deleted, false),
          eq(projects.is_archived, false),
          eq(tasks.org_id, orgId),
          eq(tasks.number, number),
          eq(tasks.is_deleted, false),
          visibleTaskCondition(userId),
        ))
        .limit(1);

      if (!task) {
        console.warn(
          `[cross-reference] unresolved-ref ${sourceType}=${sourceId} prefix=${prefix} number=${number}`,
        );
        continue;
      }

      // Atomic insert — relies on unique index (source_type, source_id, target_type, target_id).
      // Returns empty array if a matching row already exists (duplicate); otherwise returns the inserted row.
      const inserted = await db
        .insert(crossReferences)
        .values({
          org_id: orgId,
          source_type: sourceType,
          source_id: sourceId,
          target_type: 'task',
          target_id: task.id,
          // Do not denormalize source text into an edge. Access to the source
          // can change independently from access to the target.
          context: null,
          created_by: userId,
        })
        .onConflictDoNothing({
          target: [
            crossReferences.source_type,
            crossReferences.source_id,
            crossReferences.target_type,
            crossReferences.target_id,
          ],
        })
        .returning({ id: crossReferences.id });

      if (inserted.length === 0) continue;

      // A task comment is visible to every viewer of the target. Only leave a
      // generic pointer for org-wide sources; never copy private/shared note or
      // private/DM message text into the target.
      if (!sourceMayCreateComment) continue;
      const commentLabel = sourceType === 'note'
        ? 'Referenced from an org-visible note'
        : 'Referenced from a public-space message';
      await db.insert(taskComments).values({
        org_id: orgId,
        task_id: task.id,
        user_id: userId,
        content: commentLabel,
      });

      console.log(`[cross-reference] Linked ${sourceType} ${sourceId} -> task ${ref} (${task.id})`);
    } catch (err) {
      console.error(`[cross-reference] Failed to process ref ${ref}:`, (err as Error).message);
    }
  }
}
