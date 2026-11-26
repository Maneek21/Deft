import { sql, type SQL } from 'drizzle-orm';
import { readableSpaceSql } from '../space-visibility.js';
import { visibleTaskCondition } from '../task-visibility.js';
import { col, type Dataset } from './datasets.js';
import { unmovedLegacySourceSql } from './datasets-documents.js';
import { memberId, spaceReadable, workspaceAuthor, type ExportContext } from './scope.js';

const PRIVATE_ASSISTANT = 'deft.private_defty_message.v1';

/**
 * A message the export contains: in this workspace, not deleted, not agent
 * plumbing (tool results, hidden rows), in a space of this workspace, and for
 * the member scope readable as `loadMessagesForReader` decides. `ref` must not
 * be a column of a table named `messages` or `spaces`.
 */
export function exportableMessage(ctx: ExportContext, ref: SQL): SQL {
  const userId = memberId(ctx);
  return sql`EXISTS (SELECT 1 FROM messages JOIN spaces ON spaces.id = messages.space_id AND spaces.org_id = ${ctx.orgId}
    WHERE messages.id = ${ref} AND messages.org_id = ${ctx.orgId} AND messages.is_deleted = false
      AND coalesce(messages.metadata->>'kind', '') <> 'tool_result'
      AND coalesce(messages.metadata->>'hidden', '') <> 'true'
      AND ${userId ? readableSpaceSql(userId, sql`messages.space_id`, sql`messages.org_id`) : sql`true`})`;
}

/** A task the export contains: in this workspace and project, not deleted, and for the member scope visible as task detail decides. */
export function exportableTask(ctx: ExportContext, ref: SQL): SQL {
  const userId = memberId(ctx);
  return sql`EXISTS (SELECT 1 FROM tasks JOIN projects ON projects.id = tasks.project_id AND projects.org_id = ${ctx.orgId}
    WHERE tasks.id = ${ref} AND tasks.org_id = ${ctx.orgId} AND tasks.is_deleted = false
      AND ${userId ? visibleTaskCondition(userId) : sql`true`})`;
}

export const MESSAGES_AND_TASKS: readonly Dataset[] = [
  {
    // Messages and thread replies. Encrypted private assistant conversations
    // are listed without their text (the key is not in the database).
    path: 'data/messages.jsonl',
    // A deleted or unreadable parent keeps its id (same workspace only) and is flagged parent_missing.
    query: (ctx) => sql`SELECT export_message.id, export_message.space_id,
        CASE WHEN EXISTS (SELECT 1 FROM messages parent_message WHERE parent_message.id = export_message.parent_id
          AND parent_message.org_id = ${ctx.orgId} AND parent_message.space_id = export_message.space_id)
          THEN export_message.parent_id END AS parent_id,
        (export_message.parent_id IS NOT NULL AND NOT ${exportableMessage(ctx, col('export_message.parent_id'))}) AS parent_missing,
        ${workspaceAuthor(ctx, col('export_message.user_id'))} AS user_id,
        CASE WHEN export_message.metadata->>'schema_version' = ${PRIVATE_ASSISTANT} THEN NULL ELSE export_message.content END AS content,
        (export_message.metadata->>'schema_version' = ${PRIVATE_ASSISTANT}) IS TRUE AS content_omitted,
        export_message.is_pinned, export_message.edited_at, export_message.created_at, export_message.updated_at
      FROM messages export_message
      WHERE export_message.org_id = ${ctx.orgId} AND ${exportableMessage(ctx, col('export_message.id'))}
      ORDER BY export_message.space_id, export_message.created_at, export_message.id`,
    omission: (row) => row.content_omitted
      ? { kind: 'message', id: String(row.id), reason: 'Encrypted private assistant conversation; this version of the export does not decrypt it.' }
      : null,
  },
  {
    path: 'data/reactions.jsonl',
    query: (ctx) => sql`SELECT export_reaction.message_id, export_reaction.user_id, export_reaction.emoji, export_reaction.created_at
      FROM reactions export_reaction
      WHERE ${exportableMessage(ctx, col('export_reaction.message_id'))}
        AND ${workspaceAuthor(ctx, col('export_reaction.user_id'))} IS NOT NULL
      ORDER BY export_reaction.message_id, export_reaction.created_at, export_reaction.id`,
  },
  {
    // One canvas per space: a TipTap document the space's members write together. A canvas the notes
    // move turned into a document is exported only as that document (unmovedLegacySourceSql, F15).
    path: 'data/canvases.jsonl',
    query: (ctx) => sql`SELECT export_canvas.space_id, export_canvas.title, export_canvas.content,
        ${workspaceAuthor(ctx, col('export_canvas.last_edited_by'))} AS last_edited_by,
        export_canvas.last_edited_at, export_canvas.created_at, export_canvas.updated_at
      FROM canvases export_canvas JOIN spaces export_space ON export_space.id = export_canvas.space_id
      WHERE export_canvas.org_id = ${ctx.orgId} AND export_space.org_id = ${ctx.orgId}
        AND ${spaceReadable(ctx, col('export_space.id'), col('export_space.org_id'))}
        AND ${unmovedLegacySourceSql(ctx.orgId, 'canvas', col('export_canvas.id'))}
      ORDER BY export_canvas.space_id`,
  },
  {
    // Every live project, and a deleted one only when an exported task is in it.
    path: 'data/projects.jsonl',
    query: (ctx) => sql`SELECT export_project.id, export_project.name, export_project.description, export_project.prefix,
        export_project.icon, export_project.color, ${workspaceAuthor(ctx, col('export_project.lead_id'))} AS lead_id,
        export_project.is_archived, export_project.is_deleted, export_project.created_at, export_project.updated_at
      FROM projects export_project
      WHERE export_project.org_id = ${ctx.orgId}
        AND (export_project.is_deleted = false OR EXISTS (SELECT 1 FROM tasks project_task
          WHERE project_task.project_id = export_project.id AND ${exportableTask(ctx, col('project_task.id'))}))
      ORDER BY export_project.created_at, export_project.id`,
  },
  {
    path: 'data/labels.jsonl',
    query: (ctx) => sql`SELECT id, name, color, created_at FROM labels WHERE org_id = ${ctx.orgId} ORDER BY created_at, id`,
  },
  {
    path: 'data/tasks.jsonl',
    query: (ctx) => sql`SELECT export_task.id, export_task.project_id,
        export_project.prefix || '-' || export_task.number AS reference, export_task.number, export_task.title, export_task.description,
        export_task.status, export_task.priority, ${workspaceAuthor(ctx, col('export_task.assignee_id'))} AS assignee_id,
        ${workspaceAuthor(ctx, col('export_task.created_by'))} AS created_by, export_task.due_date, export_task.start_date,
        export_task.estimation, export_task.recurrence, export_task.is_template,
        CASE WHEN ${exportableTask(ctx, col('export_task.parent_task_id'))} THEN export_task.parent_task_id END AS parent_task_id,
        coalesce(export_task.metadata->>'visibility', 'org') AS visibility,
        export_task.created_at, export_task.updated_at
      FROM tasks export_task JOIN projects export_project ON export_project.id = export_task.project_id
      WHERE export_task.org_id = ${ctx.orgId} AND export_project.org_id = ${ctx.orgId}
        AND ${exportableTask(ctx, col('export_task.id'))}
      ORDER BY export_task.project_id, export_task.number, export_task.id`,
  },
  ...(['task_assignees', 'task_watchers'] as const).map((table): Dataset => ({
    path: `data/${table}.jsonl`,
    query: (ctx) => sql`SELECT link.task_id, link.user_id, link.created_at FROM ${sql.raw(table)} link
      WHERE ${exportableTask(ctx, col('link.task_id'))} AND ${workspaceAuthor(ctx, col('link.user_id'))} IS NOT NULL
      ORDER BY link.task_id, link.created_at, link.user_id`,
  })),
  {
    path: 'data/task_labels.jsonl',
    query: (ctx) => sql`SELECT link.task_id, link.label_id FROM task_labels link
      JOIN labels export_label ON export_label.id = link.label_id AND export_label.org_id = ${ctx.orgId}
      WHERE ${exportableTask(ctx, col('link.task_id'))}
      ORDER BY link.task_id, link.label_id`,
  },
  {
    // Both ends must be exported tasks.
    path: 'data/task_relationships.jsonl',
    query: (ctx) => sql`SELECT link.id, link.source_task_id, link.target_task_id, link.type, link.created_at
      FROM task_relationships link
      WHERE ${exportableTask(ctx, col('link.source_task_id'))} AND ${exportableTask(ctx, col('link.target_task_id'))}
      ORDER BY link.created_at, link.id`,
  },
  {
    path: 'data/task_reactions.jsonl',
    query: (ctx) => sql`SELECT link.task_id, link.user_id, link.emoji, link.created_at FROM task_reactions link
      WHERE link.org_id = ${ctx.orgId} AND ${exportableTask(ctx, col('link.task_id'))}
        AND ${workspaceAuthor(ctx, col('link.user_id'))} IS NOT NULL
      ORDER BY link.task_id, link.created_at, link.id`,
  },
  {
    path: 'data/task_comments.jsonl',
    query: (ctx) => sql`SELECT comment.id, comment.task_id, ${workspaceAuthor(ctx, col('comment.user_id'))} AS user_id,
        comment.content, comment.created_at, comment.updated_at
      FROM task_comments comment
      WHERE comment.org_id = ${ctx.orgId} AND comment.is_deleted = false AND ${exportableTask(ctx, col('comment.task_id'))}
      ORDER BY comment.task_id, comment.created_at, comment.id`,
  },
];
