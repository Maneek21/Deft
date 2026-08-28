import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  attachmentDerivatives,
  files,
  messageAttachments,
  taskAttachments,
} from '@deft/db/schema';
import { db } from './db.js';
import { localFileStore } from './file-store.js';
import { processAttachment } from './attachment-processor.js';

export const MAX_AGENT_ATTACHMENT_FILES = 10;

export type AttachmentReadMode = 'text' | 'image_question';

export type AttachmentManifest = {
  id: string;
  name: string;
  declared_type: string;
  detected_type: string | null;
  size_bytes: number;
  kind: string;
  processing_status: 'pending' | 'ready' | 'blocked' | 'failed';
  processing_error: string | null;
  read_modes: AttachmentReadMode[];
};

export type AttachmentFileRecord = Pick<
  typeof files.$inferSelect,
  | 'id'
  | 'org_id'
  | 'filename'
  | 'mime_type'
  | 'detected_mime_type'
  | 'size_bytes'
  | 'storage_key'
  | 'attachment_kind'
  | 'content_sha256'
  | 'processing_status'
  | 'processing_error'
  | 'processed_at'
  | 'created_at'
>;

const fileColumns = {
  id: files.id,
  org_id: files.org_id,
  filename: files.filename,
  mime_type: files.mime_type,
  detected_mime_type: files.detected_mime_type,
  size_bytes: files.size_bytes,
  storage_key: files.storage_key,
  attachment_kind: files.attachment_kind,
  content_sha256: files.content_sha256,
  processing_status: files.processing_status,
  processing_error: files.processing_error,
  processed_at: files.processed_at,
  created_at: files.created_at,
};

async function derivativeKindsByFile(orgId: string, fileIds: string[]): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  if (fileIds.length === 0) return result;
  const rows = await db.select({
    file_id: attachmentDerivatives.file_id,
    kind: attachmentDerivatives.kind,
  }).from(attachmentDerivatives).where(and(
    eq(attachmentDerivatives.org_id, orgId),
    inArray(attachmentDerivatives.file_id, fileIds),
  ));
  for (const row of rows) {
    const kinds = result.get(row.file_id) ?? new Set<string>();
    kinds.add(row.kind);
    result.set(row.file_id, kinds);
  }
  return result;
}

export function toAttachmentManifest(
  file: AttachmentFileRecord,
  derivativeKinds: ReadonlySet<string> = new Set(),
): AttachmentManifest {
  const readModes: AttachmentReadMode[] = [];
  if (file.processing_status === 'ready') {
    if (derivativeKinds.has('text')) readModes.push('text');
    if (file.attachment_kind === 'image') readModes.push('image_question');
  }
  return {
    id: file.id,
    name: file.filename,
    declared_type: file.mime_type,
    detected_type: file.detected_mime_type,
    size_bytes: file.size_bytes,
    kind: file.attachment_kind,
    processing_status: file.processing_status,
    processing_error: file.processing_error,
    read_modes: readModes,
  };
}

export async function loadMessageAttachmentRecords(params: {
  messageId: string;
  orgId: string;
}): Promise<AttachmentFileRecord[]> {
  const typed = await db.select(fileColumns)
    .from(messageAttachments)
    .innerJoin(files, and(
      eq(messageAttachments.file_id, files.id),
      eq(messageAttachments.org_id, files.org_id),
    ))
    .where(and(
      eq(messageAttachments.message_id, params.messageId),
      eq(messageAttachments.org_id, params.orgId),
    ))
    .orderBy(asc(messageAttachments.position), asc(messageAttachments.created_at))
    .limit(MAX_AGENT_ATTACHMENT_FILES);

  const seen = new Set(typed.map((row) => row.id));
  if (typed.length >= MAX_AGENT_ATTACHMENT_FILES) return typed;
  const legacy = await db.select(fileColumns)
    .from(files)
    .where(and(eq(files.message_id, params.messageId), eq(files.org_id, params.orgId)))
    .orderBy(asc(files.created_at))
    .limit(MAX_AGENT_ATTACHMENT_FILES);
  return [...typed, ...legacy.filter((row) => !seen.has(row.id))]
    .slice(0, MAX_AGENT_ATTACHMENT_FILES);
}

/** Batch form for bounded inbox/thread payloads without per-message queries. */
export async function manifestsByMessageId(params: {
  messageIds: string[];
  orgId: string;
}): Promise<Map<string, AttachmentManifest[]>> {
  const messageIds = [...new Set(params.messageIds)].slice(0, 200);
  const result = new Map<string, AttachmentManifest[]>();
  for (const messageId of messageIds) result.set(messageId, []);
  if (messageIds.length === 0) return result;

  const typed = await db.select({
    message_id: messageAttachments.message_id,
    ...fileColumns,
  }).from(messageAttachments).innerJoin(files, and(
    eq(messageAttachments.file_id, files.id),
    eq(messageAttachments.org_id, files.org_id),
  )).where(and(
    eq(messageAttachments.org_id, params.orgId),
    inArray(messageAttachments.message_id, messageIds),
  )).orderBy(
    asc(messageAttachments.message_id),
    asc(messageAttachments.position),
    asc(messageAttachments.created_at),
  );

  const legacy = await db.select({
    message_id: files.message_id,
    ...fileColumns,
  }).from(files).where(and(
    eq(files.org_id, params.orgId),
    inArray(files.message_id, messageIds),
  )).orderBy(asc(files.message_id), asc(files.created_at));

  const recordsByMessage = new Map<string, AttachmentFileRecord[]>();
  for (const messageId of messageIds) recordsByMessage.set(messageId, []);
  for (const row of typed) {
    const records = recordsByMessage.get(row.message_id);
    if (records && records.length < MAX_AGENT_ATTACHMENT_FILES) records.push(row);
  }
  for (const row of legacy) {
    if (!row.message_id) continue;
    const records = recordsByMessage.get(row.message_id);
    if (!records || records.length >= MAX_AGENT_ATTACHMENT_FILES) continue;
    if (!records.some((record) => record.id === row.id)) records.push(row);
  }

  const allRecords = [...recordsByMessage.values()].flat();
  const kinds = await derivativeKindsByFile(params.orgId, allRecords.map((file) => file.id));
  for (const [messageId, records] of recordsByMessage) {
    result.set(messageId, records.map((file) => toAttachmentManifest(file, kinds.get(file.id))));
  }
  return result;
}

export async function loadTaskAttachmentRecords(params: {
  taskId: string;
  orgId: string;
}): Promise<AttachmentFileRecord[]> {
  const typed = await db.select(fileColumns)
    .from(taskAttachments)
    .innerJoin(files, and(
      eq(taskAttachments.file_id, files.id),
      eq(taskAttachments.org_id, files.org_id),
    ))
    .where(and(
      eq(taskAttachments.task_id, params.taskId),
      eq(taskAttachments.org_id, params.orgId),
    ))
    .orderBy(asc(taskAttachments.position), asc(taskAttachments.created_at))
    .limit(MAX_AGENT_ATTACHMENT_FILES);
  const seen = new Set(typed.map((row) => row.id));
  const legacy = await db.select(fileColumns)
    .from(files)
    .where(and(eq(files.task_id, params.taskId), eq(files.org_id, params.orgId)))
    .orderBy(asc(files.created_at))
    .limit(MAX_AGENT_ATTACHMENT_FILES);
  return [...typed, ...legacy.filter((row) => !seen.has(row.id))]
    .slice(0, MAX_AGENT_ATTACHMENT_FILES);
}

export async function manifestsForRecords(records: AttachmentFileRecord[]): Promise<AttachmentManifest[]> {
  if (records.length === 0) return [];
  const kinds = await derivativeKindsByFile(records[0]!.org_id, records.map((file) => file.id));
  return records.map((file) => toAttachmentManifest(file, kinds.get(file.id)));
}

export async function getAttachmentDerivative(params: {
  fileId: string;
  orgId: string;
  kind: string;
}) {
  const [row] = await db.select().from(attachmentDerivatives).where(and(
    eq(attachmentDerivatives.file_id, params.fileId),
    eq(attachmentDerivatives.org_id, params.orgId),
    eq(attachmentDerivatives.kind, params.kind),
  )).limit(1);
  return row ?? null;
}

/** Lazily upgrades legacy `pending` rows through the same bounded processor. */
export async function ensureAttachmentProcessed(
  file: AttachmentFileRecord,
): Promise<AttachmentFileRecord> {
  if (file.processing_status !== 'pending') return file;

  let bytes: Buffer;
  try {
    bytes = await localFileStore.get(file.storage_key);
  } catch {
    const [updated] = await db.update(files).set({
      processing_status: 'failed',
      processing_error: 'file_unavailable',
      processed_at: new Date(),
    }).where(and(
      eq(files.id, file.id),
      eq(files.org_id, file.org_id),
      eq(files.processing_status, 'pending'),
    )).returning(fileColumns);
    return updated ?? { ...file, processing_status: 'failed', processing_error: 'file_unavailable' };
  }

  const processed = processAttachment({
    filename: file.filename,
    declaredMimeType: file.mime_type,
    bytes,
  });
  const [updated] = await db.transaction(async (tx) => {
    const rows = await tx.update(files).set({
      detected_mime_type: processed.detectedMimeType,
      attachment_kind: processed.kind,
      content_sha256: processed.contentSha256,
      processing_status: processed.status,
      processing_error: processed.error,
      processed_at: new Date(),
    }).where(and(
      eq(files.id, file.id),
      eq(files.org_id, file.org_id),
      eq(files.processing_status, 'pending'),
    )).returning(fileColumns);
    if (processed.derivative) {
      await tx.insert(attachmentDerivatives).values({
        org_id: file.org_id,
        file_id: file.id,
        kind: processed.derivative.kind,
        mime_type: processed.derivative.mimeType,
        content: processed.derivative.content,
        size_bytes: processed.derivative.sizeBytes,
        metadata: processed.derivative.metadata,
      }).onConflictDoUpdate({
        target: [attachmentDerivatives.file_id, attachmentDerivatives.kind],
        set: {
          mime_type: processed.derivative.mimeType,
          content: processed.derivative.content,
          size_bytes: processed.derivative.sizeBytes,
          metadata: processed.derivative.metadata,
          updated_at: new Date(),
        },
      });
    }
    return rows;
  });
  if (updated) return updated;
  const [current] = await db.select(fileColumns).from(files).where(and(
    eq(files.id, file.id),
    eq(files.org_id, file.org_id),
  )).limit(1);
  return current ?? file;
}
