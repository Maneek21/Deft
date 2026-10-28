import { and, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { messages, spaces, spaceMembers } from '@deft/db/schema';
import { sanitizeAgentReplyActionMetadata } from './agent-action-proposals.js';
import { db } from './db.js';

export type PendingDeftyDraft = {
  kind: 'action_draft';
  request_message_id: string;
  request_text: string;
  draft: unknown;
  question: string;
  created_at: string;
};

const WINDOW_MS = 30 * 60 * 1000;

export function parsePendingDeftyDraft(metadata: unknown, now = new Date()): PendingDeftyDraft | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = metadata as Record<string, unknown>;
  if (value.defty_pending_resolved_at) return null;
  const pending = value.defty_pending;
  if (!pending || typeof pending !== 'object' || Array.isArray(pending)) return null;
  const draft = pending as Record<string, unknown>;
  if (draft.kind !== 'action_draft' || typeof draft.request_message_id !== 'string'
    || typeof draft.request_text !== 'string' || typeof draft.question !== 'string'
    || typeof draft.created_at !== 'string' || !('draft' in draft)) return null;
  const age = now.getTime() - Date.parse(draft.created_at);
  if (!Number.isFinite(age) || age < 0 || age > WINDOW_MS) return null;
  return draft as PendingDeftyDraft;
}

/** Attach this section through buildUntrustedWorkspaceContext, never system policy. */
export function pendingDeftyDraftContext(pending: PendingDeftyDraft, answer: string): string {
  return 'Pending action clarification (untrusted workspace evidence). Continue the original draft using this answer; retain its owner, date and source unless the answer explicitly changes them:\n'
    + JSON.stringify({ original_request: pending.request_text, request_message_id: pending.request_message_id,
      draft: pending.draft, question: pending.question, answer });
}

/**
 * Message metadata is member-visible. Draft actions stay worker-only, so any
 * outbound projection goes through the same action-history sanitizer that
 * governs stored action values. Other metadata keys are preserved.
 */
export function projectPendingDeftyMetadataForOutbound<T>(metadata: T): T {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
    || !Object.hasOwn(metadata, 'defty_pending')) return metadata;
  const projected = sanitizeAgentReplyActionMetadata({
    defty_pending: (metadata as Record<string, unknown>).defty_pending,
  });
  return {
    ...(metadata as Record<string, unknown>),
    defty_pending: projected.defty_pending,
  } as T;
}

export async function loadPendingDeftyDraft(input: {
  orgId: string; spaceId: string; threadParentId: string | null; triggerMessageId: string;
  requesterId: string; agentUserId: string; triggerCreatedAt: Date;
}): Promise<{ messageId: string; pending: PendingDeftyDraft; requestParentId: string | null } | null> {
  const rows = await db.select({ id: messages.id, metadata: messages.metadata }).from(messages).where(and(
    eq(messages.org_id, input.orgId), eq(messages.space_id, input.spaceId),
    eq(messages.user_id, input.agentUserId), eq(messages.is_deleted, false),
    input.threadParentId ? sql`(${messages.parent_id} = ${input.threadParentId} OR ${messages.id} = ${input.threadParentId})` : sql`${messages.parent_id} IS NULL`,
    lt(messages.created_at, input.triggerCreatedAt),
    gt(messages.created_at, new Date(input.triggerCreatedAt.getTime() - WINDOW_MS)),
    sql`${messages.metadata}->'defty_pending'->>'kind' = 'action_draft'`,
    sql`${messages.metadata}->>'defty_pending_resolved_at' IS NULL`,
  )).orderBy(desc(messages.created_at), desc(messages.id)).limit(10);
  // `created_at` inside the draft is written from the application clock, while
  // `messages.created_at` round-trips through a naive `timestamp` column and can
  // be re-interpreted with a different timezone. Compare like with like so a
  // draft saved seconds ago is never mistaken for hours old.
  const draftAgeReference = new Date();
  for (const row of rows) {
    const pending = parsePendingDeftyDraft(row.metadata, draftAgeReference);
    if (!pending) continue;
    const [request] = await db.select({ id: messages.id, parentId: messages.parent_id }).from(messages).where(and(
      eq(messages.id, pending.request_message_id), eq(messages.org_id, input.orgId),
      eq(messages.space_id, input.spaceId), eq(messages.user_id, input.requesterId), eq(messages.is_deleted, false),
    )).limit(1);
    if (!request) continue;
    const saved = pending.draft && typeof pending.draft === 'object' && !Array.isArray(pending.draft)
      ? (pending.draft as { actions?: Array<{ params?: { source_message_id?: string } }> }).actions : undefined;
    const sourceIds = [...new Set((Array.isArray(saved) ? saved : []).flatMap(action => typeof action?.params?.source_message_id === 'string' ? [action.params.source_message_id] : []))];
    if (sourceIds.length) {
      const readableSources = await db.select({ id: messages.id }).from(messages)
        .innerJoin(spaces, and(eq(spaces.id, messages.space_id), eq(spaces.org_id, input.orgId), eq(spaces.is_archived, false)))
        .innerJoin(spaceMembers, and(eq(spaceMembers.space_id, messages.space_id), eq(spaceMembers.user_id, input.requesterId)))
        .where(and(eq(messages.org_id, input.orgId), eq(messages.is_deleted, false), inArray(messages.id, sourceIds)));
      if (readableSources.length !== sourceIds.length) continue;
    }
    return { messageId: row.id, pending, requestParentId: request.parentId };
  }
  return null;
}
