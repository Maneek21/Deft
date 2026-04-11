import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { customEmoji } from '@deft/db/schema';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const emojiRoutes = new Hono();

const EMOJI_DIR = join(process.cwd(), '..', '..', 'uploads', 'emoji');
const NAME_REGEX = /^[a-zA-Z0-9_]+$/;
const MAX_SIZE = 256 * 1024; // 256KB

// GET /api/emoji — list all custom emoji for org
emojiRoutes.get('/', async (c) => {
  const user = c.get('user');

  const emoji = await db.select()
    .from(customEmoji)
    .where(eq(customEmoji.org_id, user.org_id));

  return c.json(emoji);
});

// POST /api/emoji — upload custom emoji (multipart: name + file)
emojiRoutes.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.parseBody();

  const name = body['name'];
  const file = body['file'];

  if (!name || typeof name !== 'string') {
    return c.json({ error: 'name is required', code: 'VALIDATION_ERROR' }, 400);
  }

  if (!NAME_REGEX.test(name)) {
    return c.json({ error: 'Name must be alphanumeric and underscores only', code: 'VALIDATION_ERROR' }, 400);
  }

  if (!file || typeof file === 'string') {
    return c.json({ error: 'Image file is required', code: 'VALIDATION_ERROR' }, 400);
  }

  if (file.size > MAX_SIZE) {
    return c.json({ error: 'Image must be under 256KB', code: 'FILE_TOO_LARGE' }, 400);
  }

  // Check name uniqueness within org
  const [existing] = await db.select({ id: customEmoji.id })
    .from(customEmoji)
    .where(and(eq(customEmoji.org_id, user.org_id), eq(customEmoji.name, name)))
    .limit(1);

  if (existing) {
    return c.json({ error: 'Emoji name already taken', code: 'NAME_TAKEN' }, 409);
  }

  // Save file
  await mkdir(EMOJI_DIR, { recursive: true });

  const ext = file.name?.split('.').pop() || 'png';
  const filename = `${randomUUID()}.${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(join(EMOJI_DIR, filename), buffer);

  const imageUrl = `/api/files/emoji/${filename}`;

  const [emoji] = await db.insert(customEmoji).values({
    org_id: user.org_id,
    name,
    image_url: imageUrl,
    uploaded_by: user.id,
  }).returning();

  return c.json(emoji, 201);
});

// DELETE /api/emoji/:id — delete (creator or admin only)
emojiRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  // Check ownership
  const [emoji] = await db.select()
    .from(customEmoji)
    .where(and(eq(customEmoji.id, id), eq(customEmoji.org_id, user.org_id)))
    .limit(1);

  if (!emoji) {
    return c.json({ error: 'Emoji not found', code: 'NOT_FOUND' }, 404);
  }

  // Allow deletion by creator or any org member (admin check can be added later)
  if (emoji.uploaded_by !== user.id) {
    return c.json({ error: 'Only the creator can delete this emoji', code: 'FORBIDDEN' }, 403);
  }

  await db.delete(customEmoji)
    .where(eq(customEmoji.id, id));

  return c.json({ success: true });
});
