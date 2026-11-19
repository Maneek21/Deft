import { createHash } from 'node:crypto';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { sql, type SQL } from 'drizzle-orm';
import { localStorageKeyPath } from '../file-store.js';
import { readableSpaceSql } from '../space-visibility.js';
import { col } from './datasets.js';
import { exportableTask } from './datasets-content.js';
import { memberId, workspaceAuthor, type ExportContext } from './scope.js';
import type { Snapshot } from './snapshot.js';
import { assertArchivePath, type ArchiveWriter } from './writer.js';

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
      EXISTS (SELECT 1 FROM files other WHERE lower(other.storage_key) = lower(f.storage_key)
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
  let name = filename.normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/gu, '_');
  if (name.length > 150) {
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    name = name.slice(0, 150 - extension.length) + extension;
  }
  // After shortening: no trailing dot or space, and never a device name.
  name = name.replace(/[. ]+$/u, '').trim();
  const path = `attachments/${safeId}/${name || 'file'}`;
  try {
    assertArchivePath(path);
    return path;
  } catch {
    return `attachments/${safeId}/_${name || 'file'}`.replace(/[. ]+$/u, '');
  }
}

/** Test seams around each attachment read; none runs in normal use. */
export type CopyHooks = Readonly<{
  /** Before the stored file is first looked at. */
  beforeFileRead?: (fileId: string) => Promise<void>;
  /** After the checks, before the file is opened. */
  beforeOpen?: (fileId: string) => Promise<void>;
  /** After the first chunk has been copied. */
  duringRead?: (fileId: string) => Promise<void>;
  /**
   * Test seam: replaces the shared-database decision, so the one-workspace
   * path can be tested in a database that holds several workspaces.
   */
  sharedDatabase?: () => boolean;
}>;

const SHARED = { reason: 'Its stored file is also named by another workspace, so its owner cannot be established.' };
const NOT_COPIED = { reason: 'This database holds more than one workspace, so attachment files were not copied. An operator can copy them with --allow-shared-uploads.' };

const identity = (info: { dev: number; ino: number }) => `${info.dev}:${info.ino}`;

/**
 * True unless this database plainly holds only this workspace. Shared means:
 * - any other workspace row, in any state; or
 * - this workspace's own row missing; or
 * - any row, in any table with an org_id column, that names another
 *   workspace id (including rows left by a workspace that no longer exists).
 * Anything unexpected counts as shared.
 *
 * This is evidence from the database only. Bytes on disk that no row
 * describes cannot be attributed by it. Automatic copying therefore assumes
 * the uploads folder serves this database alone, which holds by
 * construction in a hosted cell. A row of this workspace that names such a
 * file is trusted as this workspace's.
 */
export async function databaseIsShared(snapshot: Snapshot, orgId: string): Promise<boolean> {
  const [base] = await snapshot.all<{ shared: boolean }>(sql`SELECT ((SELECT count(*) FROM orgs) <> 1
    OR NOT EXISTS (SELECT 1 FROM orgs WHERE id = ${orgId})) AS shared`);
  if (base?.shared !== false) return true;
  const tables = await snapshot.all<{ table_name: string }>(sql`SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = current_schema() AND c.column_name = 'org_id' ORDER BY c.table_name`);
  for (const { table_name: table } of tables) {
    const [found] = await snapshot.all<{ other: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM ${sql.identifier(table)}
      WHERE org_id IS NOT NULL AND org_id::text <> ${orgId}) AS other`);
    if (found?.other !== false) return true;
  }
  return false;
}

/**
 * Every file another workspace's stored name reaches, resolved the way the
 * file store resolves names (following symbolic links), and identified by the
 * file itself. A name that cannot be resolved for any reason other than "no
 * such file" stops the export. Only used with --allow-shared-uploads.
 */
async function foreignFileIdentities(snapshot: Snapshot, ctx: ExportContext, uploadsRoot: string): Promise<Set<string>> {
  const identities = new Set<string>();
  for await (const row of snapshot.rows<{ storage_key: string }>(sql`SELECT DISTINCT storage_key FROM files
      WHERE org_id IS DISTINCT FROM ${ctx.orgId}`)) {
    let source: string;
    try { source = localStorageKeyPath(uploadsRoot, row.storage_key); } catch { continue; } // the file store cannot reach it either
    const info = await stat(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw new Error(`Cannot establish which file another workspace's stored name reaches (${error.code ?? 'error'}); export stopped.`);
    });
    if (info) identities.add(identity(info));
  }
  return identities;
}

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
async function copyFile(writer: ArchiveWriter, uploadsRoot: string, row: FileRow, hooks: CopyHooks, foreign: ReadonlySet<string>): Promise<{ path: string; sha256: string } | { reason: string }> {
  if (row.processing_status === 'blocked') return { reason: 'Blocked by the attachment safety check; bytes not included.' };
  if (row.storage_shared) return SHARED;
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
  if (foreign.has(identity(before))) return SHARED;
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
    return { path, sha256: digest.slice('sha256:'.length) };
  } finally {
    await handle.close();
  }
}

export type AttachmentOptions = Readonly<{
  hooks?: CopyHooks;
  /** Copy attachment bytes even when this database holds more than one workspace (operator's decision). */
  allowSharedUploads?: boolean;
}>;

export type AttachmentSummary = Readonly<{
  path: string; records: number;
  /** This database holds, or held, another workspace. */
  shared_database: boolean;
  /** Whether copying was allowed at all (one-workspace database, or the operator's flag). */
  copy_allowed: boolean;
  /** How many attachment files were actually copied into the archive. */
  files_copied: number;
}>;

/**
 * Writes data/files.jsonl and the attachment bytes. Every file not included
 * is listed in omissions.jsonl. In a database shared with other workspaces no
 * bytes are copied unless the operator allows it; then every other
 * workspace's stored name is resolved first, and any of our files that is one
 * of those files is refused.
 */
export async function exportAttachments(snapshot: Snapshot, writer: ArchiveWriter, ctx: ExportContext, uploadsDir: string,
  options: AttachmentOptions = {}): Promise<AttachmentSummary> {
  const uploadsRoot = await realpath(uploadsDir);
  const shared = options.hooks?.sharedDatabase ? options.hooks.sharedDatabase() : await databaseIsShared(snapshot, ctx.orgId);
  const copy = !shared || options.allowSharedUploads === true;
  const foreign = shared && copy ? await foreignFileIdentities(snapshot, ctx, uploadsRoot) : new Set<string>();
  const list = await writer.jsonl('data/files.jsonl');
  let filesCopied = 0;
  for await (const row of snapshot.rows<FileRow>(attachmentsQuery(ctx))) {
    const result = row.attached_as === 'ambiguous'
      ? { reason: 'Linked to more than one message or task, so Deft shows it to nobody.' }
      : !copy ? NOT_COPIED
        : await copyFile(writer, uploadsRoot, row, options.hooks ?? {}, foreign);
    await list.write({
      id: row.id, filename: row.filename, mime_type: row.mime_type, size_bytes: row.size_bytes,
      // The digest of the bytes in this archive; and, separately, the checksum Deft recorded (may be null).
      sha256: 'sha256' in result ? result.sha256 : null,
      recorded_sha256: row.content_sha256?.replace(/^sha256:/, '') ?? null,
      uploaded_by: row.uploaded_by, created_at: row.created_at,
      attached_to: row.attached_as === 'message' ? { message_id: row.link_message_id }
        : row.attached_as === 'task' ? { task_id: row.link_task_id } : null,
      included: 'path' in result, archive_path: 'path' in result ? result.path : null,
    });
    if ('reason' in result) await writer.omit({ kind: 'file', id: row.id, reason: result.reason });
    else filesCopied += 1;
  }
  await list.close();
  return { path: 'data/files.jsonl', records: list.records, shared_database: shared, copy_allowed: copy, files_copied: filesCopied };
}
