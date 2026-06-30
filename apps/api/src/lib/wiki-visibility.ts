import { and, eq, or, sql } from 'drizzle-orm';
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

export function wikiPageRelevantToSpaceCondition(
  spaceId: string,
  orgId: string,
  includeOriginAndCitations = true,
) {
  const directSpacePage = and(eq(wikiPages.scope, 'space'), eq(wikiPages.space_id, spaceId));
  if (!includeOriginAndCitations) return directSpacePage;

  return or(
    directSpacePage,
    eq(wikiPages.origin_space_id, spaceId),
    sql`EXISTS (
      SELECT 1
      FROM wiki_citations wc
      LEFT JOIN messages m
        ON m.id = wc.source_id
       AND wc.source_type = 'message'
      WHERE wc.page_id = ${wikiPages.id}
        AND (
          wc.source_space_id = ${spaceId}
          OR (m.space_id = ${spaceId} AND m.org_id = ${orgId})
        )
    )`,
  );
}
