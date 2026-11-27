import { logId } from '../../lib/log-metadata.js';
// Handler: cross-reference — scans messages or documents for task identifiers
// (e.g. PROJ-42) and creates cross_references + task comments linking them.
// Notes are documents now (F15): a queued note job reads the document the
// note moved to, and records the reference from that document.
// A scan of Defty's write names Defty and the person who asked (`askerId`,
// plan Task M4; lib/document-cross-references.ts). Defty has no employee to
// re-authorize, so the asker is re-authorized instead and every access check
// is made as the asker; the reference and any comment are still Defty's. An
// asker on a job for anyone but Defty is refused, so no one else's checks change.
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import {
  crossReferences,
  tasks,
  projects,
  taskComments,
  spaces,
  messages,
  spaceMembers,
  orgMembers,
  agentEmployees,
  users,
} from '@deft/db/schema';
import { eq, and } from 'drizzle-orm';
import { documents, drives } from '@deft/db/documents';
import { DEFTY_EMAIL } from '../../lib/defty-identity.js';
import { visibleDocumentCondition } from '../../lib/document-access.js';
import { mappedTargetId } from '../../lib/legacy-notes.js';
import { visibleTaskCondition } from '../../lib/task-visibility.js';
import { toPlainText } from '../../lib/plain-text.js';
import { taskKeyMatch, taskKeysIn } from '../../lib/task-key.js';

interface CrossReferenceJobData {
  // Message-sourced (legacy shape)
  messageId?: string;
  spaceId?: string;
  // Document-sourced; 'note' is an old queued job, read as its document (F15).
  sourceType?: 'message' | 'note' | 'document';
  sourceId?: string;
  noteId?: string;
  content: string;
  orgId: string;
  userId: string;
  /** Who Defty wrote for, when `userId` is Defty's: access is checked as this person. */
  askerId?: string;
}

export async function handleCrossReference(job: JobData): Promise<void> {
  const data = job.data as CrossReferenceJobData;
  const { orgId, userId } = data;

  // Resolve source: explicit sourceType takes priority, else fall back to
  // messageId (legacy enqueue shape from messages.ts).
  const sourceType: 'message' | 'document' = data.sourceType === 'note' || data.sourceType === 'document' ? 'document' : 'message';
  let sourceId: string;
  if (data.sourceType === 'note') {
    const noteId = data.sourceId || data.noteId || '';
    sourceId = noteId ? (await mappedTargetId(orgId, 'note', noteId)) ?? '' : '';
  } else if (data.sourceType === 'document') {
    sourceId = data.sourceId || '';
  } else {
    sourceId = data.sourceId || data.messageId || '';
  }
  if (!sourceId) return;

  // Defty writing for someone: checked as the asker (the header). Anyone else naming an asker is refused.
  const askerId = typeof data.askerId === 'string' && data.askerId !== userId ? data.askerId : null;
  if (askerId !== null) {
    const [defty] = await db.select({ id: users.id }).from(users)
      .where(and(eq(users.id, userId), eq(users.email, DEFTY_EMAIL), eq(users.kind, 'agent')))
      .limit(1);
    if (!defty) return;
  }
  const accessUserId = askerId ?? userId;

  // Jobs may execute after a member is offboarded or an employee is paused.
  // Re-authorize the queued actor (for Defty, the asker) before performing any durable write.
  const [activeHuman] = await db
    .select({ id: orgMembers.id })
    .from(orgMembers)
    .innerJoin(users, and(
      eq(users.id, orgMembers.user_id),
      eq(users.is_agent, false),
    ))
    .where(and(
      eq(orgMembers.org_id, orgId),
      eq(orgMembers.user_id, accessUserId),
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
        eq(agentEmployees.user_id, accessUserId),
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
  if (sourceType === 'document') {
    const [document] = await db
      .select({
        text: documents.content_text,
        drive_kind: drives.kind,
      })
      .from(documents)
      .innerJoin(drives, and(eq(drives.id, documents.drive_id), eq(drives.org_id, documents.org_id)))
      .where(and(eq(documents.id, sourceId), visibleDocumentCondition(accessUserId, orgId)))
      .limit(1);
    if (!document) return;

    plainContent = document.text;
    // Only a document in an open drive (every full member can read it) leaves
    // the org-wide comment, as only an org-visible note did.
    sourceMayCreateComment = document.drive_kind === 'open';
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
        eq(spaceMembers.user_id, accessUserId),
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

  // Distinct task keys in the source. A prefix may hold digits (R9G-1), so
  // each key is matched whole, the way task search matches it.
  const uniqueRefs = taskKeysIn(plainContent);
  if (uniqueRefs.length === 0) return;

  for (const ref of uniqueRefs) {
    try {
      // Resolve only a live task in this org that the source actor can see.
      const [task] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .innerJoin(projects, eq(tasks.project_id, projects.id))
        .where(and(
          eq(projects.org_id, orgId),
          taskKeyMatch(ref, { exact: true }),
          eq(projects.is_deleted, false),
          eq(projects.is_archived, false),
          eq(tasks.org_id, orgId),
          eq(tasks.is_deleted, false),
          visibleTaskCondition(accessUserId),
        ))
        .limit(1);

      if (!task) {
        console.warn(`[cross-reference] unresolved-ref <redacted>=${logId(sourceId)} prefix=<redacted> number=<redacted>`
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
      // generic pointer for org-wide sources; never copy private or shared
      // document text, or private/DM message text, into the target.
      if (!sourceMayCreateComment) continue;
      const commentLabel = sourceType === 'document'
        ? 'Referenced from a document in an open drive'
        : 'Referenced from a public-space message';
      await db.insert(taskComments).values({
        org_id: orgId,
        task_id: task.id,
        user_id: userId,
        content: commentLabel,
      });

      console.log(`[cross-reference] Linked <redacted> ${logId(sourceId)} -> task <redacted> (${logId(task.id)})`);
    } catch (err) {
      console.error("[cross-reference] Failed to process ref <redacted>:");
    }
  }
}
