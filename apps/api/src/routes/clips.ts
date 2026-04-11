// Clip routes — upload, process, retrieve, play async voice/video clips
import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { clips, messages, users } from '@deft/db/schema';
import { enqueue, QUEUE_NAMES } from '../lib/queues.js';
import { getIO } from '../socket.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const clipRoutes = new Hono();

const CLIP_DIR = join(process.cwd(), '..', '..', 'uploads', 'clips');

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
      space_id: spaceId || null,
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
      space_id: spaceId || contextId,
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
    io?.to(`space:${spaceId || contextId}`).emit('message:new', {
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
      space_id: spaceId || contextId,
      parent_id: parentId || null,
    });

    // Enqueue transcription + summarization job
    await enqueue(QUEUE_NAMES.AGENT_JOBS, 'clip-process', {
      clip_id: clip!.id,
      org_id: user.org_id,
      message_id: msg!.id,
      space_id: spaceId || contextId,
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
    console.error('[clips] Upload failed:', err);
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

    if (!clip) {
      return c.json({ error: 'Clip not found', code: 'NOT_FOUND' }, 404);
    }

    return c.json(clip);
  } catch (err) {
    console.error('[clips] Get failed:', err);
    return c.json({ error: 'Failed to get clip', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/clips/:id/audio — stream clip audio
clipRoutes.get('/:id/audio', async (c) => {
  try {
    const clipId = c.req.param('id');

    const [clip] = await db.select()
      .from(clips)
      .where(eq(clips.id, clipId))
      .limit(1);

    if (!clip || clip.is_deleted) {
      return c.json({ error: 'Clip not found', code: 'NOT_FOUND' }, 404);
    }

    const filePath = join(CLIP_DIR, clip.file_key);

    try {
      const data = await readFile(filePath);
      return new Response(data, {
        headers: {
          'Content-Type': clip.mime_type,
          'Content-Disposition': `inline; filename="clip-${clipId}.webm"`,
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    } catch {
      return c.json({ error: 'Clip file not found on disk', code: 'FILE_MISSING' }, 404);
    }
  } catch (err) {
    console.error('[clips] Audio serve failed:', err);
    return c.json({ error: 'Failed to serve clip', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/clips/space/:spaceId — list clips in a space
clipRoutes.get('/space/:spaceId', async (c) => {
  try {
    const user = c.get('user');
    const spaceId = c.req.param('spaceId');

    const result = await db.select()
      .from(clips)
      .where(and(
        eq(clips.org_id, user.org_id),
        eq(clips.space_id, spaceId),
        eq(clips.is_deleted, false),
      ))
      .orderBy(desc(clips.created_at))
      .limit(50);

    return c.json(result);
  } catch (err) {
    console.error('[clips] List failed:', err);
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

    if (!clip) {
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
    console.error('[clips] Delete failed:', err);
    return c.json({ error: 'Failed to delete clip', code: 'INTERNAL_ERROR' }, 500);
  }
});
