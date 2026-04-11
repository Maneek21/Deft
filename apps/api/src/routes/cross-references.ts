import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { crossReferences, messages, tasks, projects, users, spaces } from '@deft/db/schema';

export const crossReferenceRoutes = new Hono();

// GET /api/tasks/:taskId/references — list cross-references pointing at a task
crossReferenceRoutes.get('/tasks/:taskId/references', async (c) => {
  try {
    const user = c.get('user');
    const taskId = c.req.param('taskId');

    const refs = await db
      .select({
        id: crossReferences.id,
        source_type: crossReferences.source_type,
        source_id: crossReferences.source_id,
        context: crossReferences.context,
        created_at: crossReferences.created_at,
        // Joined message fields
        message_content: messages.content,
        message_space_id: messages.space_id,
        // Author
        author_name: users.name,
        author_avatar: users.avatar_url,
        // Space
        space_name: spaces.name,
      })
      .from(crossReferences)
      .leftJoin(messages, and(
        eq(crossReferences.source_type, 'message'),
        eq(crossReferences.source_id, messages.id),
      ))
      .leftJoin(spaces, eq(messages.space_id, spaces.id))
      .leftJoin(users, eq(crossReferences.created_by, users.id))
      .where(
        and(
          eq(crossReferences.target_type, 'task'),
          eq(crossReferences.target_id, taskId),
          eq(crossReferences.org_id, user.org_id),
        ),
      )
      .orderBy(crossReferences.created_at);

    const result = refs.map((r) => ({
      id: r.id,
      source_type: r.source_type,
      source_id: r.source_id,
      context: r.context,
      created_at: r.created_at,
      message_preview: r.message_content
        ? r.message_content.replace(/<[^>]+>/g, '').slice(0, 200)
        : null,
      message_space_id: r.message_space_id,
      space_name: r.space_name,
      author_name: r.author_name,
      author_avatar: r.author_avatar,
    }));

    return c.json({ references: result });
  } catch (err) {
    console.error('Failed to fetch task references:', err);
    return c.json({ error: 'Failed to fetch references', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/messages/:messageId/references — list cross-references from a message
crossReferenceRoutes.get('/messages/:messageId/references', async (c) => {
  try {
    const user = c.get('user');
    const messageId = c.req.param('messageId');

    const refs = await db
      .select({
        id: crossReferences.id,
        target_type: crossReferences.target_type,
        target_id: crossReferences.target_id,
        context: crossReferences.context,
        created_at: crossReferences.created_at,
        // Joined task fields
        task_title: tasks.title,
        task_number: tasks.number,
        task_status: tasks.status,
        task_priority: tasks.priority,
        // Project prefix for full identifier
        project_prefix: projects.prefix,
      })
      .from(crossReferences)
      .leftJoin(tasks, and(
        eq(crossReferences.target_type, 'task'),
        eq(crossReferences.target_id, tasks.id),
      ))
      .leftJoin(projects, eq(tasks.project_id, projects.id))
      .where(
        and(
          eq(crossReferences.source_type, 'message'),
          eq(crossReferences.source_id, messageId),
          eq(crossReferences.org_id, user.org_id),
        ),
      )
      .orderBy(crossReferences.created_at);

    const result = refs.map((r) => ({
      id: r.id,
      target_type: r.target_type,
      target_id: r.target_id,
      context: r.context,
      created_at: r.created_at,
      task_title: r.task_title,
      task_identifier: r.project_prefix && r.task_number != null
        ? `${r.project_prefix}-${r.task_number}`
        : null,
      task_status: r.task_status,
      task_priority: r.task_priority,
    }));

    return c.json({ references: result });
  } catch (err) {
    console.error('Failed to fetch message references:', err);
    return c.json({ error: 'Failed to fetch references', code: 'INTERNAL_ERROR' }, 500);
  }
});
