import { Hono } from 'hono';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { attachmentDerivatives, files, messageAttachments, taskAttachments } from '@deft/db/schema';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  canAccessAttachmentMessage,
  canAccessAttachmentTask,
  getVisibleAttachment,
} from '../lib/attachment-access.js';
import { localFileStore } from '../lib/file-store.js';
import { MAX_ATTACHMENT_BYTES, processAttachment } from '../lib/attachment-processor.js';
import { stagedAttachmentExpiry } from '../lib/attachment-retention.js';

export const uploadRoutes = new Hono();
export const fileServingRoutes = new Hono();

// POST /api/upload — multipart file upload (protected)
uploadRoutes.post('/', async (c) => {
  try {
    const user = c.get('user');
    const body = await c.req.parseBody();
    const file = body['file'];

    if (!file || typeof file === 'string') {
      return c.json({ error: 'No file provided', code: 'VALIDATION_ERROR' }, 400);
    }

    if (file.size > MAX_ATTACHMENT_BYTES) {
      return c.json({ error: 'File too large (max 50MB)', code: 'FILE_TOO_LARGE' }, 400);
    }

    const taskId = c.req.query('task_id') || null;
    const messageId = c.req.query('message_id') || null;
    if (taskId && messageId) {
      return c.json({ error: 'A file can target either a task or a message', code: 'VALIDATION_ERROR' }, 400);
    }
    if (taskId && !(await canAccessAttachmentTask(taskId, user.org_id, user.id))) {
      return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);
    }
    if (messageId && !(await canAccessAttachmentMessage(messageId, user.org_id, user.id))) {
      return c.json({ error: 'Message not found', code: 'NOT_FOUND' }, 404);
    }

    const originalName = basename(file.name).replace(/[^\w.\-]/g, '_');
    const uniqueName = `${randomUUID()}-${originalName}`;
    const buffer = Buffer.from(await file.arrayBuffer());
    const processing = processAttachment({
      filename: originalName,
      declaredMimeType: file.type,
      bytes: buffer,
    });
    await localFileStore.put(uniqueName, buffer);

    let inserted: typeof files.$inferSelect | undefined;
    try {
      inserted = await db.transaction(async (tx) => {
        const [row] = await tx.insert(files).values({
          org_id: user.org_id,
          uploaded_by: user.id,
          filename: originalName,
          mime_type: file.type || 'application/octet-stream',
          size_bytes: file.size,
          storage_key: uniqueName,
          detected_mime_type: processing.detectedMimeType,
          attachment_kind: processing.kind,
          content_sha256: processing.contentSha256,
          processing_status: processing.status,
          processing_error: processing.error,
          processed_at: new Date(),
          staged_expires_at: taskId || messageId ? null : stagedAttachmentExpiry(),
          task_id: taskId,
          message_id: messageId,
        }).returning();
        if (!row) throw new Error('File insert returned no row');

        if (processing.derivative) {
          await tx.insert(attachmentDerivatives).values({
            org_id: user.org_id,
            file_id: row.id,
            kind: processing.derivative.kind,
            mime_type: processing.derivative.mimeType,
            content: processing.derivative.content,
            size_bytes: processing.derivative.sizeBytes,
            metadata: processing.derivative.metadata,
          });
        }

        if (messageId) {
          await tx.insert(messageAttachments).values({
            org_id: user.org_id,
            message_id: messageId,
            file_id: row.id,
            position: 0,
          });
        }
        if (taskId) {
          await tx.insert(taskAttachments).values({
            org_id: user.org_id,
            task_id: taskId,
            file_id: row.id,
            position: 0,
          });
        }
        return row;
      });
    } catch (error) {
      await localFileStore.delete(uniqueName);
      throw error;
    }

    return c.json({
      id: inserted!.id,
      name: inserted!.filename,
      type: inserted!.mime_type,
      size: inserted!.size_bytes,
      url: `/api/files/${inserted!.id}`,
      detected_type: inserted!.detected_mime_type,
      kind: inserted!.attachment_kind,
      processing_status: inserted!.processing_status,
      processing_error: inserted!.processing_error,
    }, 201);
  } catch (err) {
    console.error('Failed to upload file:', err instanceof Error ? err.message : err, err instanceof Error ? err.stack : '');
    return c.json({ error: 'Failed to upload file', code: 'INTERNAL_ERROR' }, 500);
  }
});

// DELETE /api/files/:id — delete an upload that has not been attached yet.
fileServingRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const fileId = c.req.param('id');
  const [deleted] = await db.delete(files)
    .where(and(
      eq(files.id, fileId),
      eq(files.org_id, user.org_id),
      eq(files.uploaded_by, user.id),
      isNull(files.message_id),
      isNull(files.task_id),
      sql`NOT EXISTS (
        SELECT 1 FROM message_attachments
        WHERE message_attachments.org_id = ${user.org_id}
          AND message_attachments.file_id = ${fileId}
      )`,
      sql`NOT EXISTS (
        SELECT 1 FROM task_attachments
        WHERE task_attachments.org_id = ${user.org_id}
          AND task_attachments.file_id = ${fileId}
      )`,
    ))
    .returning({ storage_key: files.storage_key });
  if (!deleted) return c.json({ error: 'File not found', code: 'NOT_FOUND' }, 404);

  try {
    await localFileStore.delete(deleted.storage_key);
    return c.json({ success: true, storage_cleanup: 'complete' });
  } catch (error) {
    console.warn('Attachment row deleted but storage cleanup must be retried:', error);
    return c.json({ success: true, storage_cleanup: 'pending' }, 202);
  }
});

// GET /api/files/:id — serve a file visible to the authenticated caller.
fileServingRoutes.get('/:id', async (c) => {
  try {
    const user = c.get('user');
    const fileId = c.req.param('id');

    const fileRecord = await getVisibleAttachment(fileId, user.org_id, user.id);
    if (!fileRecord) {
      return c.json({ error: 'File not found', code: 'NOT_FOUND' }, 404);
    }
    if (fileRecord.processing_status === 'blocked') {
      return c.json({ error: 'File is blocked by attachment safety policy', code: 'FILE_BLOCKED' }, 423);
    }

    try {
      const data = await localFileStore.get(fileRecord.storage_key);
      return new Response(new Uint8Array(data), {
        headers: {
          'Content-Type': fileRecord.detected_mime_type || 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(fileRecord.filename)}"`,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
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
