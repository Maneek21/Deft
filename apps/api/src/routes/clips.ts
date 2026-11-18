import { emitCurrentMessageToSpaceViewers } from '../lib/agent-message-run-details.js';
// Clip routes — upload, process, retrieve, play async voice/video clips
import { Hono } from 'hono';
import { eq, and, desc, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { clips, messages, projects, spaceMembers, spaces, tasks, users } from '@deft/db/schema';
import { enqueue, QUEUE_NAMES } from '../lib/queues.js';
import { getIO } from '../socket.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { visibleTaskCondition } from '../lib/task-visibility.js';
import { unjoinedPublicSpaceReadableSql } from '../lib/space-membership.js';

export const clipRoutes = new Hono();

const CLIP_DIR = join(process.cwd(), '..', '..', 'uploads', 'clips');

async function canAccessMessage(messageId: string, orgId: string, userId: string) {
  const [row] = await db.select({ id: messages.id, space_id: messages.space_id })
    .from(messages)
    .innerJoin(spaceMembers, and(
      eq(messages.space_id, spaceMembers.space_id),
      eq(spaceMembers.user_id, userId),
    ))
    .innerJoin(spaces, and(
      eq(messages.space_id, spaces.id),
      eq(spaces.org_id, orgId),
    ))
    .where(and(
      eq(messages.id, messageId),
      eq(messages.org_id, orgId),
      eq(messages.is_deleted, false),
      eq(spaces.is_archived, false),
    ))
    .limit(1);
  return row ?? null;
}

async function canAccessTask(taskId: string, orgId: string, userId: string) {
  const [row] = await db.select({ id: tasks.id })
    .from(tasks)
    .innerJoin(projects, eq(tasks.project_id, projects.id))
    .where(and(
      eq(tasks.id, taskId),
      eq(tasks.org_id, orgId),
      eq(tasks.is_deleted, false),
      eq(projects.org_id, orgId),
      eq(projects.is_deleted, false),
      eq(projects.is_archived, false),
      visibleTaskCondition(userId),
    ))
    .limit(1);
  return Boolean(row);
}

/**
 * `member`: the caller is in the space (every write, and the default).
 * `read`: the caller is in the space, or is a member of the workspace (never
 * a guest) reading a public space before joining it.
 */
type SpaceAccess = 'member' | 'read';

/** For a query or subquery that selects from `spaces`: the space is not archived and the caller has `access` to it. */
function spaceAccessSql(userId: string, access: SpaceAccess): SQL {
  const member = sql`EXISTS (SELECT 1 FROM ${spaceMembers}
    WHERE ${spaceMembers.space_id} = ${spaces.id} AND ${spaceMembers.user_id} = ${userId})`;
  return access === 'read'
    ? sql`(${spaces.is_archived} = false AND (${member} OR ${unjoinedPublicSpaceReadableSql(userId)}))`
    : sql`(${spaces.is_archived} = false AND ${member})`;
}

async function canAccessSpace(spaceId: string, orgId: string, userId: string, access: SpaceAccess = 'member') {
  const [row] = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(
      eq(spaces.id, spaceId),
      eq(spaces.org_id, orgId),
      spaceAccessSql(userId, access),
    ))
    .limit(1);
  return Boolean(row);
}

async function projectExists(projectId: string, orgId: string) {
  const [row] = await db.select({ id: projects.id })
    .from(projects)
    .where(and(
      eq(projects.id, projectId),
      eq(projects.org_id, orgId),
      eq(projects.is_deleted, false),
      eq(projects.is_archived, false),
    ))
    .limit(1);
  return Boolean(row);
}

/**
 * The clip access rule as one condition, for a query that selects from
 * `clips`. A clip follows the first of these it has: its chat message (which
 * must not be deleted), its space, then its context (space, thread, task or
 * project); a clip with none of them is its creator's. Lists and counts use
 * this condition directly, so their work does not grow with the number of
 * clips or spaces.
 */
export function accessibleClipSql(orgId: string, userId: string, access: SpaceAccess = 'member'): SQL {
  const message = (messageId: SQLWrapper) => sql`EXISTS (SELECT 1 FROM ${messages}
    INNER JOIN ${spaces} ON ${spaces.id} = ${messages.space_id} AND ${spaces.org_id} = ${orgId}
    WHERE ${messages.id} = ${messageId} AND ${messages.org_id} = ${orgId} AND ${messages.is_deleted} = false
      AND ${spaceAccessSql(userId, access)})`;
  const space = (spaceId: SQLWrapper) => sql`EXISTS (SELECT 1 FROM ${spaces}
    WHERE ${spaces.id} = ${spaceId} AND ${spaces.org_id} = ${orgId} AND ${spaceAccessSql(userId, access)})`;
  const task = sql`EXISTS (SELECT 1 FROM ${tasks}
    INNER JOIN ${projects} ON ${projects.id} = ${tasks.project_id}
    WHERE ${tasks.id} = ${clips.context_id} AND ${tasks.org_id} = ${orgId} AND ${tasks.is_deleted} = false
      AND ${projects.org_id} = ${orgId} AND ${projects.is_deleted} = false AND ${projects.is_archived} = false
      AND ${visibleTaskCondition(userId)!})`;
  const project = sql`EXISTS (SELECT 1 FROM ${projects}
    WHERE ${projects.id} = ${clips.context_id} AND ${projects.org_id} = ${orgId}
      AND ${projects.is_deleted} = false AND ${projects.is_archived} = false)`;
  return sql`(${clips.org_id} = ${orgId} AND ${clips.is_deleted} = false AND CASE
    WHEN ${clips.message_id} IS NOT NULL THEN ${message(clips.message_id)}
    WHEN ${clips.space_id} IS NOT NULL THEN ${space(clips.space_id)}
    WHEN ${clips.context_type} = 'space' THEN ${space(clips.context_id)}
    WHEN ${clips.context_type} = 'thread' THEN ${message(clips.context_id)}
    WHEN ${clips.context_type} = 'task' THEN ${task}
    WHEN ${clips.context_type} = 'project' THEN ${project}
    ELSE ${clips.created_by} = ${userId} END)`;
}

/** True when the caller may use this clip (see `accessibleClipSql`). Reading passes `'read'`; deleting keeps the default. */
export async function canAccessClip(clip: { id: string }, orgId: string, userId: string, access: SpaceAccess = 'member') {
  const [row] = await db.select({ id: clips.id })
    .from(clips)
    .where(and(eq(clips.id, clip.id), accessibleClipSql(orgId, userId, access)))
    .limit(1);
  return Boolean(row);
}

async function serializeClipForViewer(
  clip: typeof clips.$inferSelect,
  orgId: string,
  userId: string,
) {
  if (clip.context_type !== 'task' || await canAccessTask(clip.context_id, orgId, userId)) {
    return clip;
  }

  // A clip can be visible through its destination space even when its linked
  // task is restricted. Keep the playable clip visible without exposing the
  // restricted task's direct identifier.
  return { ...clip, context_id: null };
}

// POST /api/clips — upload a clip recording
clipRoutes.post('/', async (c) => {
  try {
    const user = c.get('user');
    const body = await c.req.parseBody();
    const file = body['file'];
    const contextType = (body['context_type'] as string) || 'space';
    const contextId = body['context_id'] as string;
    const spaceId = body['space_id'] as string | undefined;
    const parentId = body['parent_id'] as string | undefined; // thread parent message ID
    const durationStr = body['duration'] as string | undefined;

    if (!file || typeof file === 'string') {
      return c.json({ error: 'No file provided', code: 'VALIDATION_ERROR' }, 400);
    }

    if (!contextId) {
      return c.json({ error: 'context_id is required', code: 'VALIDATION_ERROR' }, 400);
    }

    // Max 50MB (5 min audio is typically 2-5MB, video up to 30MB)
    if (file.size > 50 * 1024 * 1024) {
      return c.json({ error: 'Clip too large (max 50MB)', code: 'FILE_TOO_LARGE' }, 400);
    }

    if (!['space', 'thread', 'task', 'project'].includes(contextType)) {
      return c.json({ error: 'Invalid context_type', code: 'VALIDATION_ERROR' }, 400);
    }

    const targetSpaceId = spaceId || (contextType === 'space' ? contextId : null);
    if (!targetSpaceId) {
      return c.json({ error: 'space_id is required for this clip context', code: 'VALIDATION_ERROR' }, 400);
    }
    const isMember = await canAccessSpace(targetSpaceId, user.org_id, user.id);
    if (!isMember) {
      return c.json({ error: 'Not a member of this space', code: 'FORBIDDEN' }, 403);
    }
    if (contextType === 'thread') {
      const parent = await canAccessMessage(contextId, user.org_id, user.id);
      if (!parent) return c.json({ error: 'Thread not found', code: 'NOT_FOUND' }, 404);
      if (targetSpaceId && parent.space_id !== targetSpaceId) {
        return c.json({ error: 'Thread is not in this space', code: 'VALIDATION_ERROR' }, 400);
      }
    }
    if (contextType === 'task' && !(await canAccessTask(contextId, user.org_id, user.id))) {
      return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);
    }
    if (contextType === 'project' && !(await projectExists(contextId, user.org_id))) {
      return c.json({ error: 'Project not found', code: 'NOT_FOUND' }, 404);
    }
    if (parentId) {
      const parent = await canAccessMessage(parentId, user.org_id, user.id);
      if (!parent) return c.json({ error: 'Parent message not found', code: 'NOT_FOUND' }, 404);
      if (targetSpaceId && parent.space_id !== targetSpaceId) {
        return c.json({ error: 'Parent message is not in this space', code: 'VALIDATION_ERROR' }, 400);
      }
    }

    // Look up user name
    const [userRecord] = await db.select({ name: users.name })
      .from(users).where(eq(users.id, user.id)).limit(1);
    const userName = userRecord?.name || 'Unknown';

    const buffer = Buffer.from(await file.arrayBuffer());
    const fileKey = `${randomUUID()}.webm`;

    // Ensure clips directory exists
    await mkdir(CLIP_DIR, { recursive: true });
    await writeFile(join(CLIP_DIR, fileKey), buffer);

    // Create clip record
    const [clip] = await db.insert(clips).values({
      org_id: user.org_id,
      space_id: targetSpaceId || null,
      context_type: contextType as any,
      context_id: contextId,
      mode: 'async',
      created_by: user.id,
      duration_s: durationStr ? parseInt(durationStr, 10) : null,
      file_key: fileKey,
      file_size: file.size,
      mime_type: file.type || 'audio/webm',
      status: 'transcribing',
      participants: [{ id: user.id, name: userName }],
    }).returning();

    // Post a placeholder message to the space/thread
    const placeholderContent = `[[clip:${clip!.id}:uploading]]`;
    const [msg] = await db.insert(messages).values({
      org_id: user.org_id,
      space_id: targetSpaceId || contextId,
      user_id: user.id,
      content: placeholderContent,
      parent_id: parentId || null,
      metadata: { clip_id: clip!.id, clip_status: 'processing' },
    }).returning();

    // Link message to clip
    await db.update(clips)
      .set({ message_id: msg!.id })
      .where(eq(clips.id, clip!.id));

    // Broadcast the message in real time
    const io = getIO();
    await emitCurrentMessageToSpaceViewers(io, targetSpaceId, 'message:new', {
      id: msg!.id,
      content: placeholderContent,
      user_id: user.id,
      user_name: userName,
      user_avatar: null,
      is_deleted: false,
      edited_at: null,
      created_at: msg!.created_at,
      reactions: [],
      reply_count: 0,
      latest_reply_at: null,
      file_ids: [],
      files: [],
      metadata: { clip_id: clip!.id, clip_status: 'processing' },
      space_id: targetSpaceId || contextId,
      parent_id: parentId || null,
    });

    // Enqueue transcription + summarization job
    await enqueue(QUEUE_NAMES.AGENT_JOBS, 'clip-process', {
      clip_id: clip!.id,
      org_id: user.org_id,
      message_id: msg!.id,
      space_id: targetSpaceId || contextId,
      file_key: fileKey,
      context_type: contextType,
      context_id: contextId,
      user_id: user.id,
      user_name: userName,
    });

    return c.json({
      id: clip!.id,
      message_id: msg!.id,
      status: 'transcribing',
    }, 201);
  } catch (err) {
    console.error('[clips] Upload failed:');
    return c.json({ error: 'Failed to upload clip', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/clips/:id — get clip details
clipRoutes.get('/:id', async (c) => {
  try {
    const user = c.get('user');
    const clipId = c.req.param('id');

    const [clip] = await db.select()
      .from(clips)
      .where(and(eq(clips.id, clipId), eq(clips.org_id, user.org_id)))
      .limit(1);

    if (!clip || !(await canAccessClip(clip, user.org_id, user.id, 'read'))) {
      return c.json({ error: 'Clip not found', code: 'NOT_FOUND' }, 404);
    }

    return c.json(await serializeClipForViewer(clip, user.org_id, user.id));
  } catch (err) {
    console.error('[clips] Get failed:');
    return c.json({ error: 'Failed to get clip', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/clips/:id/audio — stream clip audio
clipRoutes.get('/:id/audio', async (c) => {
  try {
    const user = c.get('user');
    const clipId = c.req.param('id');

    const [clip] = await db.select()
      .from(clips)
      .where(and(eq(clips.id, clipId), eq(clips.org_id, user.org_id)))
      .limit(1);

    if (!clip || !(await canAccessClip(clip, user.org_id, user.id, 'read'))) {
      return c.json({ error: 'Clip not found', code: 'NOT_FOUND' }, 404);
    }

    const filePath = join(CLIP_DIR, clip.file_key);

    try {
      const data = await readFile(filePath);
      return new Response(data, {
        headers: {
          'Content-Type': clip.mime_type,
          'Content-Disposition': `inline; filename="clip-${clipId}.webm"`,
          // Clip visibility follows mutable space membership. Never allow an
          // authenticated response to become a shared/public cache entry.
          'Cache-Control': 'private, no-store',
        },
      });
    } catch {
      return c.json({ error: 'Clip file not found on disk', code: 'FILE_MISSING' }, 404);
    }
  } catch (err) {
    console.error('[clips] Audio serve failed:');
    return c.json({ error: 'Failed to serve clip', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/clips/space/:spaceId — list clips in a space
clipRoutes.get('/space/:spaceId', async (c) => {
  try {
    const user = c.get('user');
    const spaceId = c.req.param('spaceId');

    // Reading: a member of the space, or a member of the workspace (never a
    // guest) reading a public space before joining it.
    const canRead = await canAccessSpace(spaceId, user.org_id, user.id, 'read');
    if (!canRead) {
      return c.json({ error: 'Not a member of this space', code: 'FORBIDDEN' }, 403);
    }

    // Being able to read the space is not enough: each clip must also pass
    // the check its own routes use (for example, its message was not deleted).
    const result = await db.select()
      .from(clips)
      .where(and(
        eq(clips.space_id, spaceId),
        accessibleClipSql(user.org_id, user.id, 'read'),
      ))
      .orderBy(desc(clips.created_at))
      .limit(50);

    return c.json(await Promise.all(
      result.map((clip) => serializeClipForViewer(clip, user.org_id, user.id)),
    ));
  } catch (err) {
    console.error('[clips] List failed:');
    return c.json({ error: 'Failed to list clips', code: 'INTERNAL_ERROR' }, 500);
  }
});

// DELETE /api/clips/:id — soft delete
clipRoutes.delete('/:id', async (c) => {
  try {
    const user = c.get('user');
    const clipId = c.req.param('id');

    const [clip] = await db.select()
      .from(clips)
      .where(and(eq(clips.id, clipId), eq(clips.org_id, user.org_id)))
      .limit(1);

    if (!clip || !(await canAccessClip(clip, user.org_id, user.id))) {
      return c.json({ error: 'Clip not found', code: 'NOT_FOUND' }, 404);
    }

    if (clip.created_by !== user.id) {
      return c.json({ error: 'Not authorized', code: 'UNAUTHORIZED' }, 403);
    }

    await db.update(clips)
      .set({ is_deleted: true })
      .where(eq(clips.id, clipId));

    return c.json({ ok: true });
  } catch (err) {
    console.error('[clips] Delete failed:');
    return c.json({ error: 'Failed to delete clip', code: 'INTERNAL_ERROR' }, 500);
  }
});
