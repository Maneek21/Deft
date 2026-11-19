import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { sql, type SQL } from 'drizzle-orm';
import { localStorageKeyPath } from '../file-store.js';
import { readableSpaceSql } from '../space-visibility.js';
import { col } from './datasets.js';
import { exportableTask } from './datasets-content.js';
import { memberId, workspaceAuthor, type ExportContext } from './scope.js';
import type { Snapshot } from './snapshot.js';
import type { ArchiveWriter } from './writer.js';

const CHUNK_BYTES = 64 * 1024;

/** A message an attachment may hang off: not deleted, and for the member scope readable (canAccessAttachmentMessage 'read'). */
function attachableMessage(ctx: ExportContext, ref: SQL): SQL {
  const userId = memberId(ctx);
  return sql`EXISTS (SELECT 1 FROM messages JOIN spaces ON spaces.id = messages.space_id AND spaces.org_id = ${ctx.orgId}
    WHERE messages.id = ${ref} AND messages.org_id = ${ctx.orgId} AND messages.is_deleted = false
      AND ${userId ? readableSpaceSql(userId, sql`messages.space_id`, sql`messages.org_id`) : sql`true`})`;
}

/**
 * The files of this workspace the scope may see, decided as getVisibleAttachment
 * does: one typed link decides; more than one fails closed; otherwise the
 * legacy task column, then the legacy message column; a file attached to
 * nothing belongs to its uploader.
 */
function attachmentsQuery(ctx: ExportContext): SQL {
  const userId = memberId(ctx);
  return sql`SELECT * FROM (SELECT f.id, f.filename, f.mime_type, f.size_bytes, f.content_sha256, f.storage_key, f.processing_status,
      ${workspaceAuthor(ctx, col('f.uploaded_by'))} AS uploaded_by, f.created_at,
      EXISTS (SELECT 1 FROM files other WHERE lower(btrim(other.storage_key)) = lower(btrim(f.storage_key))
        AND other.org_id <> f.org_id) AS storage_shared,
      CASE
        WHEN typed.message_links + typed.task_links > 1 THEN 'ambiguous'
        WHEN typed.message_links = 1 THEN CASE WHEN ${attachableMessage(ctx, col('typed.message_id'))} THEN 'message' END
        WHEN typed.task_links = 1 THEN CASE WHEN ${exportableTask(ctx, col('typed.task_id'))} THEN 'task' END
        WHEN f.task_id IS NOT NULL THEN CASE WHEN ${exportableTask(ctx, col('f.task_id'))} THEN 'task' END
        WHEN f.message_id IS NOT NULL THEN CASE WHEN ${attachableMessage(ctx, col('f.message_id'))} THEN 'message' END
        WHEN ${userId ? sql`f.uploaded_by = ${userId}` : sql`true`} THEN 'unattached'
      END AS attached_as,
      CASE WHEN typed.message_links + typed.task_links > 0 THEN typed.message_id ELSE f.message_id END AS link_message_id,
      CASE WHEN typed.message_links + typed.task_links > 0 THEN typed.task_id ELSE f.task_id END AS link_task_id
    FROM files f
    CROSS JOIN LATERAL (SELECT
        (SELECT count(*) FROM message_attachments link WHERE link.org_id = ${ctx.orgId} AND link.file_id = f.id) AS message_links,
        (SELECT min(link.message_id) FROM message_attachments link WHERE link.org_id = ${ctx.orgId} AND link.file_id = f.id) AS message_id,
        (SELECT count(*) FROM task_attachments link WHERE link.org_id = ${ctx.orgId} AND link.file_id = f.id) AS task_links,
        (SELECT min(link.task_id) FROM task_attachments link WHERE link.org_id = ${ctx.orgId} AND link.file_id = f.id) AS task_id) typed
    WHERE f.org_id = ${ctx.orgId}) candidate
  WHERE candidate.attached_as IS NOT NULL ${userId ? sql`AND candidate.attached_as <> 'ambiguous'` : sql``}
  ORDER BY candidate.created_at, candidate.id`;
}

type FileRow = {
  id: string; filename: string; mime_type: string; size_bytes: number; content_sha256: string | null; storage_key: string;
  processing_status: string; uploaded_by: string | null; created_at: Date; storage_shared: boolean;
  attached_as: 'message' | 'task' | 'unattached' | 'ambiguous'; link_message_id: string | null; link_task_id: string | null;
};

/** A readable file name for the archive: the original name, with characters no file system accepts replaced. */
export function archiveFileName(id: string, filename: string): string {
  const safeId = /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : createHash('sha256').update(id).digest('hex');
  let name = filename.normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/gu, '_').replace(/[. ]+$/u, '').trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/iu.test(name)) name = `_${name}`;
  if (name.length > 150) {
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    name = name.slice(0, 150 - extension.length) + extension;
  }
  return `attachments/${safeId}/${name || 'file'}`;
}

/** Test seams around each attachment read; none runs in normal use. */
export type CopyHooks = Readonly<{
  /** Before the stored file is first looked at. */
  beforeFileRead?: (fileId: string) => Promise<void>;
  /** After the checks, before the file is opened. */
  beforeOpen?: (fileId: string) => Promise<void>;
  /** After the first chunk has been copied. */
  duringRead?: (fileId: string) => Promise<void>;
}>;

const MISSING = { reason: 'The file is missing from the uploads folder (deleted, or never stored).' };
const CHANGED = { reason: 'The file changed or was removed while it was being read.' };

const missingAsNull = <T>(promise: Promise<T>) => promise.catch((error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

/**
 * Copies one file's bytes into the archive, or says why not. Bytes are taken
 * only from a regular file directly inside the uploads folder:
 * - its real on-disk name must be exactly the stored name, so a padded,
 *   differently cased, short (8.3) or trailing-dot alias is refused;
 * - no other workspace's row may use that name in any case;
 * - it must have exactly one link, so a hard link to another file is refused;
 * - the file read must be the file checked, unchanged from before the read to
 *   after it;
 * - its bytes must match the recorded size and (when recorded) SHA-256.
 * Bytes are streamed in 64 KiB chunks.
 */
async function copyFile(writer: ArchiveWriter, uploadsRoot: string, row: FileRow, hooks: CopyHooks): Promise<{ path: string } | { reason: string }> {
  if (row.processing_status === 'blocked') return { reason: 'Blocked by the attachment safety check; bytes not included.' };
  if (row.storage_shared) return { reason: 'Its stored file name is also used by another workspace, so its owner cannot be established.' };
  let source: string;
  try {
    if (row.storage_key !== row.storage_key.trim() || row.storage_key.includes(':')) throw new Error('alias');
    source = localStorageKeyPath(uploadsRoot, row.storage_key);
  } catch {
    return { reason: 'Invalid stored file name.' };
  }
  await hooks.beforeFileRead?.(row.id);
  const before = await missingAsNull(lstat(source));
  if (!before) return MISSING;
  if (!before.isFile() || before.isSymbolicLink()) return { reason: 'Not a regular file in the uploads folder.' };
  if (before.nlink !== 1) return { reason: 'The stored file has more than one name (a hard link), so its owner cannot be established.' };
  const real = await missingAsNull(realpath(source));
  if (!real) return MISSING;
  if (dirname(real) !== uploadsRoot || basename(real) !== row.storage_key) {
    return { reason: 'The stored file name does not match a file in the uploads folder exactly.' };
  }
  await hooks.beforeOpen?.(row.id);
  const handle = await missingAsNull(open(source, 'r'));
  if (!handle) return MISSING;
  try {
    const opened = await handle.stat();
    const same = (other: { ino: number; dev: number; size: number; mtimeMs: number; nlink: number }) =>
      other.ino === before.ino && other.dev === before.dev && other.size === before.size && other.mtimeMs === before.mtimeMs && other.nlink === 1;
    if (!same(opened)) return CHANGED;
    if (opened.size !== row.size_bytes) return { reason: 'The stored bytes differ from the recorded size.' };
    const path = archiveFileName(row.id, row.filename);
    const file = await writer.open(path);
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of handle.createReadStream({ highWaterMark: CHUNK_BYTES, autoClose: false })) {
        hash.update(chunk as Buffer);
        bytes += (chunk as Buffer).length;
        await file.write(chunk as Buffer);
        if (bytes === (chunk as Buffer).length) await hooks.duringRead?.(row.id);
      }
    } catch (error) {
      await writer.discard(file);
      throw error;
    }
    // The same file, still in place and unmodified, after the last byte.
    const after = await handle.stat();
    const stillThere = await missingAsNull(lstat(source));
    if (!same(after) || !stillThere || !same(stillThere)) {
      await writer.discard(file);
      return CHANGED;
    }
    const digest = `sha256:${hash.digest('hex')}`;
    if (bytes !== row.size_bytes || (row.content_sha256 && row.content_sha256 !== digest)) {
      await writer.discard(file);
      return { reason: 'The stored bytes differ from the recorded size or checksum.' };
    }
    await file.close();
    return { path };
  } finally {
    await handle.close();
  }
}

/** Writes data/files.jsonl and the attachment bytes. Every file not included is listed in omissions.jsonl. */
export async function exportAttachments(snapshot: Snapshot, writer: ArchiveWriter, ctx: ExportContext, uploadsDir: string, hooks: CopyHooks = {}) {
  const uploadsRoot = await realpath(uploadsDir);
  const list = await writer.jsonl('data/files.jsonl');
  for await (const row of snapshot.rows<FileRow>(attachmentsQuery(ctx))) {
    const result = row.attached_as === 'ambiguous'
      ? { reason: 'Linked to more than one message or task, so Deft shows it to nobody.' }
      : await copyFile(writer, uploadsRoot, row, hooks);
    await list.write({
      id: row.id, filename: row.filename, mime_type: row.mime_type, size_bytes: row.size_bytes,
      sha256: row.content_sha256?.replace(/^sha256:/, '') ?? null, uploaded_by: row.uploaded_by, created_at: row.created_at,
      attached_to: row.attached_as === 'message' ? { message_id: row.link_message_id }
        : row.attached_as === 'task' ? { task_id: row.link_task_id } : null,
      included: 'path' in result, archive_path: 'path' in result ? result.path : null,
    });
    if ('reason' in result) await writer.omit({ kind: 'file', id: row.id, reason: result.reason });
  }
  await list.close();
  return { path: 'data/files.jsonl', records: list.records };
}
