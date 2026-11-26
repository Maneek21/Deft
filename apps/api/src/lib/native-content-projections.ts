import { and, eq, isNull, or } from 'drizzle-orm';
import { messages, spaces, wikiPages } from '@deft/db/schema';
import { documents } from '@deft/db/documents';
import { readableSpaceSql } from './space-membership.js';
import { db } from './db.js';
import { visibleDocumentCondition } from './document-access.js';
import { documentIdForNoteRef } from './legacy-notes.js';
import { visibleWikiPageCondition } from './wiki-visibility.js';
import type { NativeResourceDisplay, NativeResourceSubject } from './native-resource-types.js';

function isoDate(value: Date | null): string | undefined {
  return value instanceof Date && Number.isFinite(value.getTime())
    ? value.toISOString()
    : undefined;
}

/** Exact-ID display only. The native message body and metadata are never selected. */
export async function resolveNativeMessageDisplay(
  subject: NativeResourceSubject,
  id: string,
): Promise<NativeResourceDisplay | null> {
  const [row] = await db.select({ updated_at: messages.updated_at })
    .from(messages)
    .innerJoin(spaces, and(
      eq(spaces.id, messages.space_id),
      eq(spaces.org_id, subject.org_id),
    ))
    .where(and(
      eq(messages.id, id),
      eq(messages.org_id, subject.org_id),
      eq(messages.is_deleted, false),
      readableSpaceSql(subject.user_id, messages.space_id, messages.org_id),
    ))
    .limit(1);
  if (!row) return null;
  return { label: 'Message', updated_at: isoDate(row.updated_at) };
}

/** No wiki body, summary, links, or citations cross this display boundary. */
export async function resolveNativeWikiDisplay(
  subject: NativeResourceSubject,
  id: string,
): Promise<NativeResourceDisplay | null> {
  const [row] = await db.select({
    title: wikiPages.title,
    updated_at: wikiPages.updated_at,
    version: wikiPages.version,
  })
    .from(wikiPages)
    .leftJoin(spaces, eq(spaces.id, wikiPages.space_id))
    .where(and(
      eq(wikiPages.id, id),
      eq(wikiPages.org_id, subject.org_id),
      eq(wikiPages.is_deleted, false),
      or(isNull(wikiPages.space_id), eq(spaces.org_id, subject.org_id)),
      visibleWikiPageCondition(subject.user_id, subject.org_id),
    ))
    .limit(1);
  if (!row) return null;
  return { label: row.title, revision: String(row.version), updated_at: isoDate(row.updated_at) };
}

/**
 * A document's title, revision and time, for someone who can open it (the
 * one access check, lib/document-access.ts: shares included). `documentId`
 * may be an old note id (a `notes` reference): it is mapped to the document
 * the note moved to first (F15). No content crosses this boundary.
 */
export async function resolveNativeDocumentDisplay(
  orgId: string,
  userId: string,
  documentId: string,
): Promise<NativeResourceDisplay | null> {
  const id = await documentIdForNoteRef(orgId, documentId);
  const [row] = await db.select({
    title: documents.title,
    updated_at: documents.updated_at,
    revision: documents.revision,
  })
    .from(documents)
    .where(and(eq(documents.id, id), visibleDocumentCondition(userId, orgId)))
    .limit(1);
  if (!row) return null;
  return { label: row.title.trim() || 'Untitled', revision: String(row.revision), updated_at: isoDate(row.updated_at) };
}
