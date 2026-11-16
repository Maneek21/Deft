import { and, eq, inArray, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { messages } from '@deft/db/schema';
import type { CoreDatabaseTransaction } from './database-transaction.js';
import { readableSpaceSql } from './space-membership.js';

/** Include preview-only legacy evidence too; malformed declarations fail closed. */
export function captureEvidenceIds(primary: string, metadata: Record<string, unknown>): string[] | null {
  const ids: unknown[] = [primary];
  if (metadata.batch_message_ids !== undefined) {
    if (!Array.isArray(metadata.batch_message_ids)) return null;
    ids.push(...metadata.batch_message_ids);
  }
  if (metadata.batch_message_previews !== undefined) {
    if (!Array.isArray(metadata.batch_message_previews)) return null;
    ids.push(...metadata.batch_message_previews.map(row => row && typeof row === 'object' ? row.message_id : null));
  }
  if (ids.some(id => typeof id !== 'string' || !id.trim())) return null;
  return [...new Set(ids as string[])].sort();
}

/** Lock every contributing source until the proposal or wiki write commits. */
export async function lockCaptureEvidence(tx: CoreDatabaseTransaction, params: {
  orgId: string; spaceId: string; messageId: string; metadata: Record<string, unknown>;
}): Promise<boolean> {
  const ids = captureEvidenceIds(params.messageId, params.metadata);
  if (!ids) return false;
  const live = await tx.select({ id: messages.id }).from(messages).where(and(
    inArray(messages.id, ids), eq(messages.org_id, params.orgId),
    eq(messages.space_id, params.spaceId), eq(messages.is_deleted, false),
  )).orderBy(messages.id).for('share');
  return live.length === ids.length;
}

/** Additional evidence follows its own current source, not just the anchor. */
export function captureEvidenceAvailableSql(
  metadata: SQL, orgId: string | SQLWrapper, spaceId: SQLWrapper, readerId?: string | SQL,
): SQL {
  const ids = sql`coalesce(${metadata}->'batch_message_ids', '[]'::jsonb)`;
  const previews = sql`coalesce(${metadata}->'batch_message_previews', '[]'::jsonb)`;
  return sql`(CASE WHEN jsonb_typeof(${ids}) = 'array' AND jsonb_typeof(${previews}) = 'array' THEN NOT EXISTS (
    SELECT 1 FROM (
      SELECT value #>> '{}' AS id, jsonb_typeof(value) = 'string' AS valid FROM jsonb_array_elements(${ids})
      UNION ALL
      SELECT value->>'message_id', jsonb_typeof(value) = 'object' AND jsonb_typeof(value->'message_id') = 'string'
        FROM jsonb_array_elements(${previews})
    ) evidence WHERE coalesce(evidence.valid, false) = false OR coalesce(evidence.id, '') = '' OR NOT EXISTS (
      SELECT 1 FROM messages evidence_message JOIN spaces evidence_space
        ON evidence_space.id = evidence_message.space_id AND evidence_space.org_id = evidence_message.org_id
      WHERE evidence_message.id = evidence.id AND evidence_message.org_id = ${orgId}
        AND (${spaceId} IS NULL OR evidence_message.space_id = ${spaceId})
        AND evidence_message.is_deleted = false AND evidence_space.is_archived = false
        AND ${readerId === undefined ? sql`true` : readableSpaceSql(readerId, sql`evidence_message.space_id`, sql`evidence_message.org_id`)}
    )
  ) ELSE false END)`;
}
