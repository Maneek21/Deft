import { and, asc, eq, inArray } from 'drizzle-orm';
import { files, messageAttachments } from '@deft/db/schema';
import { db } from './db.js';

export const MAX_MESSAGE_ATTACHMENTS = 10;

export type MessageAttachment = {
  id: string;
  name: string;
  type: string;
  size: number;
  url: string;
};

type FileAttachmentRecord = Pick<
  typeof files.$inferSelect,
  'id' | 'filename' | 'mime_type' | 'size_bytes'
>;

export function toMessageAttachment(file: FileAttachmentRecord): MessageAttachment {
  return {
    id: file.id,
    name: file.filename,
    type: file.mime_type,
    size: file.size_bytes,
    url: `/api/files/${file.id}`,
  };
}

/**
 * Older clients embedded file references in message text. Treat only the ID as
 * a claim request; every other marker field is untrusted display data and is
 * ignored in favor of the canonical files row.
 */
export function extractLegacyAttachmentIds(content: string): string[] {
  const ids: string[] = [];
  const pattern = /\[\[file:([^:\]\s]+):/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    if (match[1]) ids.push(match[1]);
  }
  return ids;
}

export function normalizeAttachmentIds(explicitIds: string[] | undefined, content: string): string[] {
  return Array.from(new Set([
    ...(explicitIds ?? []),
    ...extractLegacyAttachmentIds(content),
  ]));
}

export async function getMessageAttachments(
  messageIds: string[],
  orgId: string,
): Promise<Map<string, MessageAttachment[]>> {
  const result = new Map<string, MessageAttachment[]>();
  if (messageIds.length === 0) return result;

  const linkedRows = await db.select({
    message_id: messageAttachments.message_id,
    id: files.id,
    filename: files.filename,
    mime_type: files.mime_type,
    size_bytes: files.size_bytes,
  })
    .from(messageAttachments)
    .innerJoin(files, and(
      eq(messageAttachments.file_id, files.id),
      eq(messageAttachments.org_id, files.org_id),
    ))
    .where(and(
      eq(messageAttachments.org_id, orgId),
      inArray(messageAttachments.message_id, messageIds),
    ))
    .orderBy(asc(messageAttachments.position), asc(messageAttachments.created_at));

  const linkedIds = new Set<string>();
  for (const row of linkedRows) {
    const attachments = result.get(row.message_id) ?? [];
    attachments.push(toMessageAttachment(row));
    result.set(row.message_id, attachments);
    linkedIds.add(row.id);
  }

  // Compatibility fallback for pre-migration rows. Dual-written files are
  // skipped so callers see each attachment exactly once.
  const legacyRows = await db.select({
    message_id: files.message_id,
    id: files.id,
    filename: files.filename,
    mime_type: files.mime_type,
    size_bytes: files.size_bytes,
  })
    .from(files)
    .where(and(
      eq(files.org_id, orgId),
      inArray(files.message_id, messageIds),
    ))
    .orderBy(asc(files.created_at));

  for (const row of legacyRows) {
    if (!row.message_id || linkedIds.has(row.id)) continue;
    const attachments = result.get(row.message_id) ?? [];
    attachments.push(toMessageAttachment(row));
    result.set(row.message_id, attachments);
  }
  return result;
}
