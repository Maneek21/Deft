import { sql } from 'drizzle-orm';
import { db } from './db.js';
import { localFileStore, type FileStore } from './file-store.js';

export const STAGED_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

export function stagedAttachmentExpiry(now = new Date()): Date {
  return new Date(now.getTime() + STAGED_ATTACHMENT_TTL_MS);
}

function resultRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  if (result && typeof result === 'object' && 'rows' in result && Array.isArray(result.rows)) {
    return result.rows as Array<Record<string, unknown>>;
  }
  return [];
}

export type AttachmentSweepResult = {
  deletedRows: number;
  deletedBytes: number;
  orphanedStorageKeys: string[];
};

/**
 * Deletes only expired, still-unclaimed uploads. Database rows are removed
 * before storage bytes so a storage failure can leave an operator-cleanable
 * orphan, but can never leave a live attachment pointing at missing bytes.
 */
export async function sweepExpiredStagedAttachments(params: {
  now?: Date;
  store?: FileStore;
} = {}): Promise<AttachmentSweepResult> {
  const now = params.now ?? new Date();
  const store = params.store ?? localFileStore;
  const result = await db.execute(sql`
    DELETE FROM files AS file
    WHERE file.staged_expires_at IS NOT NULL
      AND file.staged_expires_at <= ${now}
      AND file.message_id IS NULL
      AND file.task_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM message_attachments
        WHERE message_attachments.org_id = file.org_id
          AND message_attachments.file_id = file.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM task_attachments
        WHERE task_attachments.org_id = file.org_id
          AND task_attachments.file_id = file.id
      )
    RETURNING file.storage_key
  `);
  const storageKeys = resultRows(result)
    .map((row) => row.storage_key)
    .filter((key): key is string => typeof key === 'string');
  const orphanedStorageKeys: string[] = [];
  let deletedBytes = 0;
  for (const storageKey of storageKeys) {
    try {
      await store.delete(storageKey);
      deletedBytes += 1;
    } catch {
      orphanedStorageKeys.push(storageKey);
    }
  }
  return { deletedRows: storageKeys.length, deletedBytes, orphanedStorageKeys };
}
