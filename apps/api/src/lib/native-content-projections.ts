import { and, eq, isNull, or } from 'drizzle-orm';
import { messages, notes, spaceMembers, spaces, wikiPages } from '@deft/db/schema';
import { db } from './db.js';
import { visibleNoteCondition } from './note-visibility.js';
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
    .innerJoin(spaceMembers, and(
      eq(spaceMembers.space_id, spaces.id),
      eq(spaceMembers.user_id, subject.user_id),
    ))
    .where(and(
      eq(messages.id, id),
      eq(messages.org_id, subject.org_id),
      eq(messages.is_deleted, false),
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

/** Preserves explicit note shares and requires any attached space to remain in this org. */
export async function resolveNativeNoteDisplay(
  subject: NativeResourceSubject,
  id: string,
): Promise<NativeResourceDisplay | null> {
  const [row] = await db.select({
    title: notes.title,
    updated_at: notes.updated_at,
    version: notes.version,
  })
    .from(notes)
    .leftJoin(spaces, eq(spaces.id, notes.visibility_space_id))
    .where(and(
      eq(notes.id, id),
      eq(notes.org_id, subject.org_id),
      eq(notes.is_deleted, false),
      or(isNull(notes.visibility_space_id), eq(spaces.org_id, subject.org_id)),
      visibleNoteCondition(subject.user_id),
    ))
    .limit(1);
  if (!row) return null;
  return { label: row.title, revision: String(row.version), updated_at: isoDate(row.updated_at) };
}
