import { and, eq, or, sql } from 'drizzle-orm';
import { spaceMembers, spaces, wikiPages } from '@deft/db/schema';

export function visibleWikiPageCondition(userId: string, orgId?: string) {
  const ordinary = or(
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
  // Routed Email copies belong to their destination audience. Retaining the
  // capturing owner for attribution must not bypass later space removal.
  const emailDestination = and(
    sql`exists (select 1 from org_members om where om.org_id = ${wikiPages.org_id}
      and om.user_id = ${userId} and om.is_active = true)`,
    orgId ? eq(wikiPages.org_id, orgId) : undefined,
    or(
      and(eq(wikiPages.scope, 'user'), eq(wikiPages.user_id, userId)),
      and(eq(wikiPages.scope, 'space'), sql`exists (
        select 1 from spaces s join space_members sm on sm.space_id = s.id
        where s.id = ${wikiPages.space_id} and s.org_id = ${wikiPages.org_id}
          and s.is_archived = false and sm.user_id = ${userId}
      )`),
    ),
  );
  return or(
    and(sql`${wikiPages.created_via} IS DISTINCT FROM 'email_knowledge_auto' AND ${wikiPages.created_via} IS DISTINCT FROM 'app_integration_capture' AND ${wikiPages.created_via} IS DISTINCT FROM 'app_integration_transfer'`, ordinary),
    and(or(eq(wikiPages.created_via, 'email_knowledge_auto'), eq(wikiPages.created_via, 'app_integration_capture'), eq(wikiPages.created_via, 'app_integration_transfer')), emailDestination),
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
