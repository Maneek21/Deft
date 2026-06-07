import { eq, or, sql } from 'drizzle-orm';
import { notes, noteShares, spaceMembers } from '@deft/db/schema';

export function visibleNoteCondition(userId: string) {
  return or(
    eq(notes.user_id, userId),
    eq(notes.visibility, 'org'),
    sql`exists (
      select 1 from ${noteShares}
      where ${noteShares.note_id} = ${notes.id}
        and ${noteShares.shared_with_user_id} = ${userId}
    )`,
    sql`exists (
      select 1 from ${spaceMembers}
      where ${spaceMembers.space_id} = ${notes.visibility_space_id}
        and ${spaceMembers.user_id} = ${userId}
        and ${notes.visibility} = 'space'
    )`,
  );
}
