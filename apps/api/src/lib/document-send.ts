import { createHash, createHmac } from 'node:crypto';
import { extname } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  agentActions,
  attachmentDerivatives,
  files,
  messageAttachments,
  messages,
  spaceMembers,
  spaces,
  users,
} from '@deft/db/schema';
import { db } from './db.js';
import { localFileStore } from './file-store.js';
import { processAttachment } from './attachment-processor.js';
import { toMessageAttachment } from './message-attachments.js';
import { getIO } from '../socket.js';
import { logAuditEvent } from './audit.js';
import { invalidatePlatformContextCacheFor } from './mcp-tools/context.js';

export const DOCUMENT_SEND_ACTION = 'document_send';
export const MAX_AGENT_DOCUMENT_BYTES = 64 * 1024;

const MIME_EXTENSIONS: Record<string, readonly string[]> = {
  'text/markdown': ['.md', '.markdown'],
  'text/plain': ['.txt'],
  'text/csv': ['.csv'],
};

const TargetSchema = z.union([
  z.object({ space_id: z.string().trim().min(1).max(128) }).strict(),
  z.object({ thread_id: z.string().trim().min(1).max(128) }).strict(),
  z.object({ user_id: z.string().trim().min(1).max(128) }).strict(),
]);

export const DocumentSendInputSchema = z.object({
  filename: z.string().trim().min(1).max(128),
  mime_type: z.enum(['text/markdown', 'text/plain', 'text/csv']),
  content: z.string().min(1),
  caption: z.string().trim().min(1).max(2_000).optional(),
  source_message_id: z.string().trim().min(1).max(128),
  target: TargetSchema.optional(),
  space_id: z.string().trim().min(1).max(128).optional(),
  thread_id: z.string().trim().min(1).max(128).optional(),
  user_id: z.string().trim().min(1).max(128).optional(),
  idempotency_key: z.string().trim().min(1).max(128).optional(),
}).passthrough();

export type DocumentSendInput = z.infer<typeof DocumentSendInputSchema>;

export type PreparedDocumentSend = {
  filename: string;
  mime_type: 'text/markdown' | 'text/plain' | 'text/csv';
  content: string;
  caption: string;
  source_message_id: string;
  source_space_id: string;
  source_user_id: string;
  space_id?: string;
  thread_id?: string;
  user_id?: string;
  resolved_space_id: string | null;
  parent_id: string | null;
  target_user_id: string | null;
  size_bytes: number;
  content_sha256: string;
  preview_digest: string;
  idempotency_key: string;
};

function namespacedSha256(namespace: string, value: string): string {
  // The HMAC key is a public, versioned namespace for domain separation, not an authentication secret.
  return createHmac('sha256', namespace).update(value).digest('hex');
}

function stableUuid(seed: string): string {
  const chars = namespacedSha256('deft.document-send.uuid.v1', seed).slice(0, 32).split('');
  chars[12] = '4';
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function cleanFilename(value: string): string {
  const filename = value.replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!filename || filename === '.' || filename === '..') throw new Error('Document filename is invalid');
  return filename;
}

function ensureCsvIsInert(content: string): void {
  let field = '';
  let quoted = false;
  const finish = () => {
    if (/^[\t\r\n ]*[=+\-@]/.test(field)) {
      throw new Error('CSV formula-like cells are not allowed; use inert values instead');
    }
    field = '';
  };
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!;
    if (quoted) {
      if (char === '"' && content[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field.length === 0) quoted = true;
    else if (char === ',' || char === '\n' || char === '\r') {
      finish();
      if (char === '\r' && content[index + 1] === '\n') index += 1;
    } else field += char;
  }
  if (quoted) throw new Error('CSV has an unterminated quoted field');
  finish();
}

function normalizeDraft(input: unknown) {
  const parsed = DocumentSendInputSchema.parse(input);
  const filename = cleanFilename(parsed.filename);
  const extension = extname(filename).toLowerCase();
  if (!MIME_EXTENSIONS[parsed.mime_type]?.includes(extension)) {
    throw new Error(`Document filename extension does not match ${parsed.mime_type}`);
  }
  if (parsed.content.includes('\u0000')) throw new Error('Document content contains null bytes');
  const bytes = Buffer.from(parsed.content, 'utf8');
  if (bytes.byteLength > MAX_AGENT_DOCUMENT_BYTES) {
    throw new Error(`Document exceeds the ${MAX_AGENT_DOCUMENT_BYTES} byte reviewed-output limit`);
  }
  if (parsed.mime_type === 'text/csv') ensureCsvIsInert(parsed.content);
  const processing = processAttachment({
    filename,
    declaredMimeType: parsed.mime_type,
    bytes,
  });
  if (processing.status !== 'ready' || !processing.derivative) {
    throw new Error(`Document failed attachment safety processing${processing.error ? `: ${processing.error}` : ''}`);
  }

  const topLevelTargets = [parsed.space_id, parsed.thread_id, parsed.user_id].filter(Boolean);
  if (parsed.target && topLevelTargets.length > 0) {
    throw new Error('Document target must be supplied once');
  }
  if (topLevelTargets.length > 1) throw new Error('Document target must identify only one chat destination');
  const target = parsed.target
    ?? (parsed.space_id ? { space_id: parsed.space_id } : undefined)
    ?? (parsed.thread_id ? { thread_id: parsed.thread_id } : undefined)
    ?? (parsed.user_id ? { user_id: parsed.user_id } : undefined);
  const caption = (parsed.caption ?? `Shared ${filename}`).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (!caption) throw new Error('Document caption is empty');
  return { parsed, filename, bytes, processing, target, caption };
}

export function validateDocumentSendDraft(input: unknown): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Document send parameters are invalid');
  }
  const raw = input as Record<string, unknown>;
  normalizeDraft({
    ...raw,
    source_message_id: typeof raw.source_message_id === 'string' && raw.source_message_id.trim()
      ? raw.source_message_id
      : 'pending-source-message',
  });
}

async function actorCanAccessSpace(executor: any, params: {
  orgId: string;
  actorUserId: string;
  employeeId?: string;
  spaceId: string;
}): Promise<boolean> {
  const result = await executor.execute(sql`
    SELECT s.id
    FROM spaces s
    WHERE s.id = ${params.spaceId}
      AND s.org_id = ${params.orgId}
      AND s.is_archived = false
      AND EXISTS (
        SELECT 1 FROM org_members om
        WHERE om.org_id = ${params.orgId}
          AND om.user_id = ${params.actorUserId}
          AND om.is_active = true
      )
      AND (
        s.type = 'public'
        OR EXISTS (
          SELECT 1 FROM space_members sm
          WHERE sm.space_id = s.id AND sm.user_id = ${params.actorUserId}
        )
      )
      ${params.employeeId ? sql`AND EXISTS (
        SELECT 1 FROM agent_employees ae
        WHERE ae.id = ${params.employeeId}
          AND ae.org_id = ${params.orgId}
          AND ae.user_id = ${params.actorUserId}
          AND ae.is_active = true
          AND ae.is_deleted = false
      )` : sql``}
    LIMIT 1
  `);
  return result.rows.length > 0;
}

async function existingDmSpace(executor: any, orgId: string, userIdA: string, userIdB: string) {
  const result = await executor.execute(sql`
    SELECT s.id
    FROM spaces s
    WHERE s.org_id = ${orgId}
      AND s.type = 'dm'
      AND s.is_archived = false
      AND EXISTS (SELECT 1 FROM space_members sm WHERE sm.space_id = s.id AND sm.user_id = ${userIdA})
      AND EXISTS (SELECT 1 FROM space_members sm WHERE sm.space_id = s.id AND sm.user_id = ${userIdB})
      AND (SELECT count(*) FROM space_members sm WHERE sm.space_id = s.id) = 2
    ORDER BY s.created_at ASC
    LIMIT 1
  `);
  return (result.rows[0] as { id?: string } | undefined)?.id ?? null;
}

export async function prepareDocumentSend(params: {
  input: unknown;
  orgId: string;
  actorUserId: string;
  employeeId?: string;
}): Promise<PreparedDocumentSend> {
  const draft = normalizeDraft(params.input);
  const [source] = await db.select({
    id: messages.id,
    space_id: messages.space_id,
    user_id: messages.user_id,
    parent_id: messages.parent_id,
  }).from(messages).where(and(
    eq(messages.id, draft.parsed.source_message_id),
    eq(messages.org_id, params.orgId),
    eq(messages.is_deleted, false),
  )).limit(1);
  if (!source) throw new Error('Source message is unavailable');
  if (!(await actorCanAccessSpace(db, {
    orgId: params.orgId,
    actorUserId: params.actorUserId,
    ...(params.employeeId ? { employeeId: params.employeeId } : {}),
    spaceId: source.space_id,
  }))) throw new Error('Source message is not accessible to this agent');

  let resolvedSpaceId: string | null = source.space_id;
  let parentId: string | null = source.parent_id ?? null;
  let targetUserId: string | null = null;
  let targetShape: Pick<PreparedDocumentSend, 'space_id' | 'thread_id' | 'user_id'> = {};

  if (draft.target && 'space_id' in draft.target) {
    if (!(await actorCanAccessSpace(db, {
      orgId: params.orgId,
      actorUserId: params.actorUserId,
      ...(params.employeeId ? { employeeId: params.employeeId } : {}),
      spaceId: draft.target.space_id,
    }))) throw new Error('Target space is not accessible to this agent');
    resolvedSpaceId = draft.target.space_id;
    parentId = null;
    targetShape = { space_id: draft.target.space_id };
  } else if (draft.target && 'thread_id' in draft.target) {
    const [thread] = await db.select({ id: messages.id, space_id: messages.space_id })
      .from(messages)
      .where(and(
        eq(messages.id, draft.target.thread_id),
        eq(messages.org_id, params.orgId),
        eq(messages.is_deleted, false),
      )).limit(1);
    if (!thread || !(await actorCanAccessSpace(db, {
      orgId: params.orgId,
      actorUserId: params.actorUserId,
      ...(params.employeeId ? { employeeId: params.employeeId } : {}),
      spaceId: thread.space_id,
    }))) throw new Error('Target thread is not accessible to this agent');
    resolvedSpaceId = thread.space_id;
    parentId = thread.id;
    targetShape = { thread_id: thread.id };
  } else if (draft.target && 'user_id' in draft.target) {
    if (draft.target.user_id === params.actorUserId) throw new Error('Document target cannot be the sending agent itself');
    const target = await db.execute(sql`
      SELECT u.id
      FROM users u
      INNER JOIN org_members om ON om.user_id = u.id
      WHERE u.id = ${draft.target.user_id}
        AND om.org_id = ${params.orgId}
        AND om.is_active = true
      LIMIT 1
    `);
    if (target.rows.length === 0) throw new Error('Target user is not an active workspace member');
    targetUserId = draft.target.user_id;
    resolvedSpaceId = await existingDmSpace(db, params.orgId, params.actorUserId, targetUserId);
    parentId = null;
    targetShape = { user_id: targetUserId };
  }

  const contentSha256 = draft.processing.contentSha256;
  const digestInput = JSON.stringify({
    filename: draft.filename,
    mime_type: draft.parsed.mime_type,
    caption: draft.caption,
    content_sha256: contentSha256,
    source_message_id: source.id,
    target: targetShape,
  });
  const previewDigest = `sha256:${namespacedSha256('deft.document-send.preview.v1', digestInput)}`;
  const idempotencyKey = draft.parsed.idempotency_key
    ?? `document-send:${namespacedSha256('deft.document-send.idempotency.v1', `${params.orgId}:${params.actorUserId}:${previewDigest}`).slice(0, 48)}`;

  return {
    filename: draft.filename,
    mime_type: draft.parsed.mime_type,
    content: draft.parsed.content,
    caption: draft.caption,
    source_message_id: source.id,
    source_space_id: source.space_id,
    source_user_id: source.user_id,
    ...targetShape,
    resolved_space_id: resolvedSpaceId,
    parent_id: parentId,
    target_user_id: targetUserId,
    size_bytes: draft.bytes.byteLength,
    content_sha256: contentSha256,
    preview_digest: previewDigest,
    idempotency_key: idempotencyKey,
  };
}

export function sanitizeDocumentSendParams(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Document send parameters are invalid');
  const raw = input as Record<string, unknown>;
  const content = typeof raw.content === 'string' ? raw.content : '';
  const sizeBytes = typeof raw.size_bytes === 'number' ? raw.size_bytes : Buffer.byteLength(content, 'utf8');
  const contentSha256 = typeof raw.content_sha256 === 'string'
    ? raw.content_sha256
    : `sha256:${createHash('sha256').update(content).digest('hex')}`;
  const filename = cleanFilename(String(raw.filename ?? ''));
  const mimeType = String(raw.mime_type ?? '');
  if (!MIME_EXTENSIONS[mimeType]) throw new Error('Document MIME type is invalid');
  return {
    filename,
    mime_type: mimeType,
    caption: typeof raw.caption === 'string' ? raw.caption.slice(0, 2_000) : `Shared ${filename}`,
    size_bytes: sizeBytes,
    content_sha256: contentSha256,
    content_preview: content ? content.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 800) : undefined,
    preview_digest: typeof raw.preview_digest === 'string' ? raw.preview_digest : undefined,
    idempotency_key: typeof raw.idempotency_key === 'string' ? raw.idempotency_key : undefined,
    source_message_id: typeof raw.source_message_id === 'string' ? raw.source_message_id : undefined,
    source_space_id: typeof raw.source_space_id === 'string' ? raw.source_space_id : undefined,
    source_user_id: typeof raw.source_user_id === 'string' ? raw.source_user_id : undefined,
    space_id: typeof raw.space_id === 'string' ? raw.space_id : undefined,
    thread_id: typeof raw.thread_id === 'string' ? raw.thread_id : undefined,
    user_id: typeof raw.user_id === 'string' ? raw.user_id : undefined,
    resolved_space_id: typeof raw.resolved_space_id === 'string' ? raw.resolved_space_id : undefined,
    parent_id: typeof raw.parent_id === 'string' ? raw.parent_id : undefined,
  };
}

async function resolveExecutionSpace(tx: any, params: {
  prepared: PreparedDocumentSend;
  actionId: string;
  orgId: string;
  actorUserId: string;
}): Promise<string> {
  if (!params.prepared.target_user_id) {
    if (!params.prepared.resolved_space_id) throw new Error('Document target space is unavailable');
    return params.prepared.resolved_space_id;
  }
  const targetUserId = params.prepared.target_user_id;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`document-dm:${params.orgId}:${[params.actorUserId, targetUserId].sort().join(':')}`}, 0))`);
  const target = await tx.execute(sql`
    SELECT 1 FROM org_members
    WHERE org_id = ${params.orgId} AND user_id = ${targetUserId} AND is_active = true
    LIMIT 1
  `);
  if (target.rows.length === 0) throw new Error('Target user is no longer an active workspace member');
  const existing = await existingDmSpace(tx, params.orgId, params.actorUserId, targetUserId);
  if (existing) return existing;

  const dmId = stableUuid(`deft:document-dm:${params.orgId}:${[params.actorUserId, targetUserId].sort().join(':')}`);
  await tx.insert(spaces).values({
    id: dmId,
    org_id: params.orgId,
    name: 'DM',
    type: 'dm',
    created_by: params.actorUserId,
  }).onConflictDoNothing();
  await tx.insert(spaceMembers).values([
    { space_id: dmId, user_id: params.actorUserId },
    { space_id: dmId, user_id: targetUserId },
  ]).onConflictDoNothing();
  return dmId;
}

export async function executeDocumentSend(params: {
  actionId: string;
  actionParams: unknown;
  orgId: string;
  actorUserId: string;
  employeeId?: string;
}) {
  const prepared = await prepareDocumentSend({
    input: params.actionParams,
    orgId: params.orgId,
    actorUserId: params.actorUserId,
    ...(params.employeeId ? { employeeId: params.employeeId } : {}),
  });
  const bytes = Buffer.from(prepared.content, 'utf8');
  const processing = processAttachment({
    filename: prepared.filename,
    declaredMimeType: prepared.mime_type,
    bytes,
  });
  if (processing.status !== 'ready' || !processing.derivative || processing.contentSha256 !== prepared.content_sha256) {
    throw new Error('Document content failed final safety validation');
  }
  const derivative = processing.derivative;
  const messageId = stableUuid(`deft:document-message:${params.actionId}`);
  const fileId = stableUuid(`deft:document-file:${params.actionId}`);
  const storageKey = `${fileId}-${prepared.filename}`;
  let wroteStorage = false;

  const commit = async () => db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`document-send:${params.orgId}:${params.actionId}`}, 0))`);

    const source = await tx.execute(sql`
      SELECT id FROM messages
      WHERE id = ${prepared.source_message_id}
        AND org_id = ${params.orgId}
        AND is_deleted = false
      FOR SHARE
    `);
    if (source.rows.length === 0) throw new Error('Source message was deleted before approval');
    if (!(await actorCanAccessSpace(tx, {
      orgId: params.orgId,
      actorUserId: params.actorUserId,
      ...(params.employeeId ? { employeeId: params.employeeId } : {}),
      spaceId: prepared.source_space_id,
    }))) throw new Error('Source message access was revoked before approval');

    const spaceId = await resolveExecutionSpace(tx, {
      prepared,
      actionId: params.actionId,
      orgId: params.orgId,
      actorUserId: params.actorUserId,
    });
    if (!(await actorCanAccessSpace(tx, {
      orgId: params.orgId,
      actorUserId: params.actorUserId,
      ...(params.employeeId ? { employeeId: params.employeeId } : {}),
      spaceId,
    }))) throw new Error('Document target access was revoked before approval');

    if (prepared.parent_id) {
      const parent = await tx.execute(sql`
        SELECT id FROM messages
        WHERE id = ${prepared.parent_id}
          AND org_id = ${params.orgId}
          AND space_id = ${spaceId}
          AND is_deleted = false
        FOR SHARE
      `);
      if (parent.rows.length === 0) throw new Error('Target thread was deleted before approval');
    }

    const [existingMessage] = await tx.select({
      id: messages.id,
      space_id: messages.space_id,
      user_id: messages.user_id,
      parent_id: messages.parent_id,
      metadata: messages.metadata,
    }).from(messages).where(and(eq(messages.id, messageId), eq(messages.org_id, params.orgId))).limit(1);
    const [existingFile] = await tx.select({
      id: files.id,
      message_id: files.message_id,
      content_sha256: files.content_sha256,
      filename: files.filename,
      storage_key: files.storage_key,
    }).from(files).where(and(eq(files.id, fileId), eq(files.org_id, params.orgId))).limit(1);
    const [existingLink] = await tx.select({ file_id: messageAttachments.file_id })
      .from(messageAttachments)
      .where(and(
        eq(messageAttachments.org_id, params.orgId),
        eq(messageAttachments.message_id, messageId),
        eq(messageAttachments.file_id, fileId),
      )).limit(1);
    const [existingDerivative] = await tx.select({ file_id: attachmentDerivatives.file_id })
      .from(attachmentDerivatives)
      .where(and(
        eq(attachmentDerivatives.org_id, params.orgId),
        eq(attachmentDerivatives.file_id, fileId),
        eq(attachmentDerivatives.kind, 'text'),
      )).limit(1);
    if (existingMessage || existingFile || existingLink || existingDerivative) {
      const metadata = existingMessage?.metadata as Record<string, unknown> | null;
      if (
        !existingMessage || !existingFile || !existingLink || !existingDerivative
        || existingMessage.space_id !== spaceId
        || existingMessage.user_id !== params.actorUserId
        || existingMessage.parent_id !== prepared.parent_id
        || metadata?.agent_action_id !== params.actionId
        || existingFile.message_id !== messageId
        || existingFile.content_sha256 !== prepared.content_sha256
        || existingFile.filename !== prepared.filename
        || existingFile.storage_key !== storageKey
      ) throw new Error('Document send replay found a partial or conflicting result');
      if (!(await localFileStore.stat(storageKey))) await localFileStore.put(storageKey, bytes);
      const result = {
        replayed: true,
        message_id: messageId,
        file_id: fileId,
        space_id: spaceId,
        parent_id: prepared.parent_id,
        filename: prepared.filename,
        mime_type: prepared.mime_type,
        size_bytes: prepared.size_bytes,
        content_sha256: prepared.content_sha256,
        url: `/api/files/${fileId}`,
      };
      await tx.update(agentActions).set({
        params: sanitizeDocumentSendParams(prepared),
        result,
        error: null,
        executed_at: new Date(),
      }).where(and(eq(agentActions.id, params.actionId), eq(agentActions.org_id, params.orgId)));
      return result;
    }

    await localFileStore.put(storageKey, bytes);
    wroteStorage = true;
    const [message] = await tx.insert(messages).values({
      id: messageId,
      org_id: params.orgId,
      space_id: spaceId,
      user_id: params.actorUserId,
      content: prepared.caption,
      parent_id: prepared.parent_id,
      metadata: {
        is_agent_reply: true,
        subtype: 'agent_document',
        agent_action_id: params.actionId,
        source_message_id: prepared.source_message_id,
      },
    }).returning();
    if (!message) throw new Error('Document message insert returned no row');
    await tx.insert(files).values({
      id: fileId,
      org_id: params.orgId,
      uploaded_by: params.actorUserId,
      filename: prepared.filename,
      mime_type: prepared.mime_type,
      size_bytes: prepared.size_bytes,
      storage_key: storageKey,
      detected_mime_type: processing.detectedMimeType,
      attachment_kind: processing.kind,
      content_sha256: processing.contentSha256,
      processing_status: processing.status,
      processing_error: processing.error,
      processed_at: new Date(),
      staged_expires_at: null,
      message_id: messageId,
    });
    await tx.insert(attachmentDerivatives).values({
      org_id: params.orgId,
      file_id: fileId,
      kind: derivative.kind,
      mime_type: derivative.mimeType,
      content: derivative.content,
      size_bytes: derivative.sizeBytes,
      metadata: derivative.metadata,
    });
    await tx.insert(messageAttachments).values({
      org_id: params.orgId,
      message_id: messageId,
      file_id: fileId,
      position: 0,
    });
    const result = {
      replayed: false,
      message_id: messageId,
      file_id: fileId,
      space_id: spaceId,
      parent_id: prepared.parent_id,
      filename: prepared.filename,
      mime_type: prepared.mime_type,
      size_bytes: prepared.size_bytes,
      content_sha256: prepared.content_sha256,
      url: `/api/files/${fileId}`,
    };
    await tx.update(agentActions).set({
      params: sanitizeDocumentSendParams(prepared),
      result,
      before_state: null,
      after_state: result,
      error: null,
      executed_at: new Date(),
    }).where(and(eq(agentActions.id, params.actionId), eq(agentActions.org_id, params.orgId)));
    return result;
  });

  let result: Awaited<ReturnType<typeof commit>>;
  try {
    result = await commit();
  } catch (error) {
    if (wroteStorage) {
      const [committed] = await db.select({ id: files.id }).from(files)
        .where(and(eq(files.id, fileId), eq(files.org_id, params.orgId), eq(files.content_sha256, prepared.content_sha256)))
        .limit(1)
        .catch(() => []);
      if (!committed) await localFileStore.delete(storageKey).catch(() => undefined);
    }
    throw error;
  }

  if (params.employeeId) invalidatePlatformContextCacheFor(params.employeeId);
  if (!result.replayed) {
    const [author] = await db.select({ name: users.name, avatar_url: users.avatar_url })
      .from(users).where(eq(users.id, params.actorUserId)).limit(1);
    try {
      const io = getIO();
      if (io) {
        io.to(`space:${result.space_id}`).emit('message:new', {
          id: result.message_id,
          org_id: params.orgId,
          space_id: result.space_id,
          user_id: params.actorUserId,
          content: prepared.caption,
          parent_id: result.parent_id,
          metadata: {
            is_agent_reply: true,
            subtype: 'agent_document',
            agent_action_id: params.actionId,
            source_message_id: prepared.source_message_id,
          },
          user_name: author?.name ?? 'Agent',
          user_avatar: author?.avatar_url ?? null,
          reactions: [],
          reply_count: 0,
          latest_reply_at: null,
          file_ids: [result.file_id],
          files: [toMessageAttachment({
            id: result.file_id,
            filename: result.filename,
            mime_type: result.mime_type,
            size_bytes: result.size_bytes,
          })],
        });
        if (result.parent_id) {
          const [stats] = await db.select({
            count: sql<number>`count(*)::int`,
            latest: sql<string>`to_char(max(${messages.created_at}), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
          }).from(messages).where(and(eq(messages.parent_id, result.parent_id), eq(messages.is_deleted, false)));
          io.to(`space:${result.space_id}`).emit('thread:updated', {
            parent_id: result.parent_id,
            reply_count: stats?.count ?? 1,
            latest_reply_at: stats?.latest ?? new Date().toISOString(),
          });
        }
      }
    } catch {
      // Realtime delivery is best-effort; persisted chat state remains canonical.
    }
    await logAuditEvent({
      orgId: params.orgId,
      actorType: 'agent',
      actorId: params.actorUserId,
      action: DOCUMENT_SEND_ACTION,
      entityType: 'message',
      entityId: result.message_id,
      beforeState: null,
      afterState: {
        message_id: result.message_id,
        file_id: result.file_id,
        space_id: result.space_id,
        content_sha256: result.content_sha256,
      },
      metadata: { action_id: params.actionId, filename: result.filename },
    }).catch(() => undefined);
  }
  return result;
}
