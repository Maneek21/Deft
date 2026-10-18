import { and, eq, or, sql } from 'drizzle-orm';
import { spaceMembers, spaces, wikiPages } from '@deft/db/schema';

export function visibleWikiPageCondition(userId: string, orgId?: string) {
  return or(
    eq(wikiPages.scope, 'org'),
    eq(wikiPages.user_id, userId),
    orgId ? sql`exists (
      select 1 from ${spaces}
      inner join ${spaceMembers} on ${spaceMembers.space_id} = ${spaces.id}
      where ${spaces.id} = ${wikiPages.space_id}
        and ${spaces.org_id} = ${orgId}
        and ${spaceMembers.user_id} = ${userId}
    )` : sql`exists (
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
  const directSpacePage = eq(wikiPages.space_id, spaceId);
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
