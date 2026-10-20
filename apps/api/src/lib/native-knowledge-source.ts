import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { wikiPages } from '@deft/db/schema';

/** Storage owners may declare retained origin markers during migration. Source
 * provenance also classifies a page, so editing its origin cannot bypass policy. */
export function appSourceKnowledgeOriginCondition(retainedOrigins: readonly string[] = []) {
  return or(inArray(wikiPages.created_via, ['app_integration_capture', 'app_integration_transfer', ...retainedOrigins]),
    sql`exists (select 1 from app_integration_capture_sources source
      where source.org_id = ${wikiPages.org_id} and source.page_id = ${wikiPages.id})`)!;
}

/** Retained excerpts belong to the current destination audience. Attribution to
 * their capturing user grants no access after membership or destination changes. */
export function appSourceKnowledgeDestinationCondition(userId: string, orgId?: string) {
  return and(eq(wikiPages.is_deleted, false), orgId ? eq(wikiPages.org_id, orgId) : undefined,
    sql`exists (select 1 from org_members member where member.org_id = ${wikiPages.org_id}
      and member.user_id = ${userId} and member.is_active = true)`,
    or(and(eq(wikiPages.scope, 'user'), eq(wikiPages.user_id, userId)),
      and(eq(wikiPages.scope, 'space'), sql`exists (
        select 1 from spaces destination join space_members member on member.space_id = destination.id
        where destination.id = ${wikiPages.space_id} and destination.org_id = ${wikiPages.org_id}
          and destination.is_archived = false and member.user_id = ${userId})`)));
}

/** Native Knowledge owns both page visibility and the output audience. A private
 * retained copy may be recalled personally, never into a shared answer. Space
 * captures are usable only in their destination when answering a conversation. */
export function appSourceKnowledgeAudienceCondition(orgId: string, userId?: string,
  conversationId?: string, agentEmployeeId?: string, retainedOrigins: readonly string[] = []) {
  const ordinary = sql`not coalesce((${appSourceKnowledgeOriginCondition(retainedOrigins)}), false)`;
  if (!userId) return ordinary;
  const employee = !agentEmployeeId ? sql`true` : sql`exists (
    select 1 from agent_employees employee where employee.id = ${agentEmployeeId}
      and employee.org_id = ${orgId} and employee.is_active = true and employee.is_deleted = false
      and ((employee.runtime_kind = 'defty_system' and employee.slug = 'defty-system' and employee.is_byoa = false)
        or employee.user_id = ${userId}))`;
  const audience = !conversationId ? sql`true` : or(
    and(eq(wikiPages.scope, 'user'), sql`exists (
      select 1 from spaces conversation where conversation.id = ${conversationId}
        and conversation.org_id = ${orgId} and conversation.type = 'dm' and conversation.is_archived = false
        and exists (select 1 from space_members member where member.space_id = conversation.id and member.user_id = ${userId})
        and not exists (select 1 from space_members member join users person on person.id = member.user_id
          where member.space_id = conversation.id and member.user_id <> ${userId} and person.is_agent = false))`),
    and(eq(wikiPages.scope, 'space'), eq(wikiPages.space_id, conversationId)));
  return or(ordinary, and(appSourceKnowledgeDestinationCondition(userId, orgId), employee, audience));
}
