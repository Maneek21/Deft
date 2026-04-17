// Handler: cross-reference — scans messages or notes for task identifiers
// (e.g. PROJ-42) and creates cross_references + task comments linking them.
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import { crossReferences, tasks, projects, taskComments, spaces, notes } from '@deft/db/schema';
import { eq, and } from 'drizzle-orm';

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
  const { content, orgId, userId } = data;

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

  // Strip HTML tags for scanning
  const plainContent = content.replace(/<[^>]+>/g, '');
  const matches = plainContent.match(TASK_ID_PATTERN);
  if (!matches) return;

  // De-duplicate identifiers in the same source
  const uniqueRefs = [...new Set(matches)];

  // Resolve source context label (space name for messages, note title for notes)
  let sourceLabel: string;
  if (sourceType === 'note') {
    const [n] = await db
      .select({ title: notes.title })
      .from(notes)
      .where(eq(notes.id, sourceId))
      .limit(1);
    sourceLabel = n?.title || 'note';
  } else {
    const spaceId = data.spaceId;
    if (!spaceId) {
      sourceLabel = 'chat';
    } else {
      const [space] = await db
        .select({ name: spaces.name })
        .from(spaces)
        .where(eq(spaces.id, spaceId))
        .limit(1);
      sourceLabel = space?.name || 'chat';
    }
  }

  const contextSnippet = plainContent.slice(0, 100);

  for (const ref of uniqueRefs) {
    try {
      const dashIdx = ref.lastIndexOf('-');
      const prefix = ref.slice(0, dashIdx);
      const number = parseInt(ref.slice(dashIdx + 1), 10);

      if (isNaN(number)) continue;

      // Look up the project by prefix
      const [project] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.org_id, orgId), eq(projects.prefix, prefix)))
        .limit(1);

      if (!project) continue;

      // Look up the task by project + number
      const [task] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.project_id, project.id), eq(tasks.number, number)))
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
          context: contextSnippet,
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

      // Add a comment on the task
      const excerpt = plainContent.slice(0, 120);
      const commentLabel = sourceType === 'note'
        ? `Referenced in note "${sourceLabel}"`
        : `Discussed in #${sourceLabel}`;
      await db.insert(taskComments).values({
        org_id: orgId,
        task_id: task.id,
        user_id: userId,
        content: `${commentLabel}: "${excerpt}"`,
      });

      console.log(`[cross-reference] Linked ${sourceType} ${sourceId} -> task ${ref} (${task.id})`);
    } catch (err) {
      console.error(`[cross-reference] Failed to process ref ${ref}:`, (err as Error).message);
    }
  }
}
