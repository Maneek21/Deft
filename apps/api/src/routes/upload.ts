import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { files } from '@deft/db/schema';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const uploadRoutes = new Hono();
export const fileServingRoutes = new Hono();

const UPLOAD_DIR = join(process.cwd(), 'uploads');

// POST /api/upload — multipart file upload (protected)
uploadRoutes.post('/', async (c) => {
  try {
    const user = c.get('user');
    const body = await c.req.parseBody();
    const file = body['file'];

    if (!file || typeof file === 'string') {
      return c.json({ error: 'No file provided', code: 'VALIDATION_ERROR' }, 400);
    }

    if (file.size > 50 * 1024 * 1024) {
      return c.json({ error: 'File too large (max 50MB)', code: 'FILE_TOO_LARGE' }, 400);
    }

    const originalName = file.name;
    const uniqueName = `${randomUUID()}-${originalName}`;
    const buffer = Buffer.from(await file.arrayBuffer());

    // Ensure uploads directory exists
    await mkdir(UPLOAD_DIR, { recursive: true });

    const filePath = join(UPLOAD_DIR, uniqueName);
    await writeFile(filePath, buffer);

    const taskId = c.req.query('task_id') || null;
    const messageId = c.req.query('message_id') || null;

    const [inserted] = await db.insert(files).values({
      org_id: user.org_id,
      uploaded_by: user.id,
      filename: originalName,
      mime_type: file.type || 'application/octet-stream',
      size_bytes: file.size,
      storage_key: uniqueName,
      task_id: taskId,
      message_id: messageId,
    }).returning();

    return c.json({
      id: inserted!.id,
      name: inserted!.filename,
      type: inserted!.mime_type,
      size: inserted!.size_bytes,
      url: `/api/files/${inserted!.id}`,
    }, 201);
  } catch (err) {
    console.error('Failed to upload file:', err instanceof Error ? err.message : err, err instanceof Error ? err.stack : '');
    return c.json({ error: 'Failed to upload file', code: 'INTERNAL_ERROR', detail: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// GET /api/files/:id — serve a file (publicly accessible, no auth)
fileServingRoutes.get('/:id', async (c) => {
  try {
    const fileId = c.req.param('id');

    const [fileRecord] = await db.select()
      .from(files)
      .where(eq(files.id, fileId))
      .limit(1);

    if (!fileRecord) {
      return c.json({ error: 'File not found', code: 'NOT_FOUND' }, 404);
    }

    const filePath = join(UPLOAD_DIR, fileRecord.storage_key);

    try {
      const data = await readFile(filePath);
      return new Response(data, {
        headers: {
          'Content-Type': fileRecord.mime_type,
          'Content-Disposition': `inline; filename="${fileRecord.filename}"`,
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    } catch {
      return c.json({ error: 'File not found on disk', code: 'FILE_MISSING' }, 404);
    }
  } catch (err) {
    console.error('Failed to serve file:', err);
    return c.json({ error: 'Failed to serve file', code: 'INTERNAL_ERROR' }, 500);
  }
});
