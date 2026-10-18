import { randomUUID } from 'node:crypto';
import { notes, wikiPages } from '@deft/db/schema';
import type { db } from './db.js';

export type ContextWriteDatabase = Pick<typeof db, 'select' | 'insert'>;
export type ContextCreator = Readonly<{ id: string; org_id: string }>;

/** Shared destination writes: ordinary routes and reviewed Email transfers use
 * the same defaults and provenance. Authorization belongs to the caller, which
 * can hold its existing transaction through both creation and its receipt. */
export async function createNativeNote(database: ContextWriteDatabase, user: ContextCreator,
  input: { title?: string; content?: string; icon?: string | null; folder_id?: string | null;
    is_template?: boolean; visibility?: 'private' | 'org' | 'space'; visibility_space_id?: string | null }) {
  const [note] = await database.insert(notes).values({ org_id: user.org_id, user_id: user.id,
    title: input.title || '', content: input.content || '', icon: input.icon || null,
    folder_id: input.folder_id || null, is_template: input.is_template || false,
    visibility: input.visibility || 'private',
    visibility_space_id: input.visibility === 'space' ? input.visibility_space_id || null : null }).returning();
  if (!note) throw new Error('Failed to create note');
  return note;
}

export async function createNativeKnowledge(database: ContextWriteDatabase, user: ContextCreator,
  input: { space_id: string; type: typeof wikiPages.$inferInsert.type; title: string; content: string;
    metadata: unknown; source_message_id?: string | null; source_space_id?: string | null;
    created_via?: string }) {
  const base = input.title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-')
    .replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'knowledge';
  // The actual unique index arbitrates concurrent creates. A preflight lookup
  // alone lets two distinct reviewed requests choose the same slug and fail.
  for (let attempt = 0; attempt < 3; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${randomUUID()}`;
    const [entry] = await database.insert(wikiPages).values({ org_id: user.org_id, user_id: user.id,
      space_id: input.space_id, origin_space_id: input.source_space_id ?? input.space_id,
      origin_message_id: input.source_message_id ?? null, origin_user_id: user.id,
      created_via: input.created_via ?? 'space_knowledge_panel', scope: 'space', type: input.type,
      title: input.title, slug, content: input.content || '', metadata: input.metadata, confidence: 0.9 })
      .onConflictDoNothing({ target: [wikiPages.org_id, wikiPages.slug] }).returning();
    if (entry) return entry;
  }
  throw new Error('Failed to create entry');
}
