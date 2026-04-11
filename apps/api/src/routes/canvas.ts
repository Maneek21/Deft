import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { canvases } from '@deft/db/schema';
import { getIO } from '../socket.js';

export const canvasRoutes = new Hono();

// GET /api/spaces/:spaceId/canvas — get canvas (upsert: create empty if not exists)
canvasRoutes.get('/:spaceId/canvas', async (c) => {
  const user = c.get('user');
  const spaceId = c.req.param('spaceId');

  const [existing] = await db.select()
    .from(canvases)
    .where(eq(canvases.space_id, spaceId))
    .limit(1);

  if (existing) {
    return c.json(existing);
  }

  // Create empty canvas
  const [canvas] = await db.insert(canvases).values({
    org_id: user.org_id,
    space_id: spaceId,
    title: 'Canvas',
    content: null,
  }).returning();

  return c.json(canvas, 201);
});

// PATCH /api/spaces/:spaceId/canvas — update canvas
canvasRoutes.patch('/:spaceId/canvas', async (c) => {
  const user = c.get('user');
  const spaceId = c.req.param('spaceId');
  const body = await c.req.json();
  const { title, content } = body;

  const updates: Record<string, unknown> = {
    last_edited_by: user.id,
    last_edited_at: new Date(),
    updated_at: new Date(),
  };
  if (title !== undefined) updates.title = title;
  if (content !== undefined) updates.content = content;

  const [updated] = await db.update(canvases)
    .set(updates)
    .where(eq(canvases.space_id, spaceId))
    .returning();

  if (!updated) {
    return c.json({ error: 'Canvas not found', code: 'NOT_FOUND' }, 404);
  }

  const io = getIO();
  if (io) {
    io.to(`space:${spaceId}`).emit('canvas:updated', {
      space_id: spaceId,
      title: updated.title,
      content: updated.content,
      last_edited_by: user.id,
      last_edited_at: updated.last_edited_at,
    });
  }

  return c.json(updated);
});
