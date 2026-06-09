import { eq, or, sql } from 'drizzle-orm';
import { spaceMembers, wikiPages } from '@deft/db/schema';

export function visibleWikiPageCondition(userId: string) {
  return or(
    eq(wikiPages.scope, 'org'),
    eq(wikiPages.user_id, userId),
    sql`exists (
      select 1 from ${spaceMembers}
      where ${spaceMembers.space_id} = ${wikiPages.space_id}
        and ${spaceMembers.user_id} = ${userId}
    )`,
  );
}
