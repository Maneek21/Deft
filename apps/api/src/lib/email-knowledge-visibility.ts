import { and, eq, or, sql } from 'drizzle-orm';
import { wikiPages } from '@deft/db/schema';
import { visibleWikiPageCondition } from './wiki-visibility.js';

export const EMAIL_KNOWLEDGE_ORIGIN = 'email_knowledge_auto';

/** Captured mail is a retained Knowledge copy, but its declared audience still
 * applies to generated answers. A user's private page must not enter a reply
 * in a shared conversation just because the requesting user owns the page. */
export function emailKnowledgeAudienceCondition(orgId: string, userId?: string, conversationId?: string, agentEmployeeId?: string) {
  const ordinary = sql`${wikiPages.created_via} IS DISTINCT FROM ${EMAIL_KNOWLEDGE_ORIGIN}`;
  if (!userId) return ordinary;
  const agentAuthority = !agentEmployeeId ? sql`true` : sql`exists (
    select 1 from agent_employees ae where ae.id = ${agentEmployeeId} and ae.org_id = ${orgId}
      and ae.is_active = true and (
        (ae.runtime_kind = 'defty_system' and ae.slug = 'defty-system' and ae.is_byoa = false)
        or (ae.user_id = ${userId} and ae.is_deleted = false)
      )
  )`;
  const audience = !conversationId ? sql`true` : or(
    // A personal agent DM contains the owner and agents, not another person.
    sql`exists (
      select 1 from spaces s
      where s.id = ${conversationId} and s.org_id = ${orgId}
        and s.type = 'dm' and s.is_archived = false
        and exists (select 1 from space_members m where m.space_id = s.id and m.user_id = ${userId})
        and not exists (select 1 from space_members m join users u on u.id = m.user_id
          where m.space_id = s.id and m.user_id <> ${userId} and u.is_agent = false)
    )`,
    // A shared answer may cite mail explicitly routed into that same space.
    and(eq(wikiPages.scope, 'space'), eq(wikiPages.space_id, conversationId)),
  );
  return or(ordinary, and(
    eq(wikiPages.org_id, orgId),
    visibleWikiPageCondition(userId, orgId),
    sql`exists (select 1 from org_members om where om.org_id = ${orgId}
      and om.user_id = ${userId} and om.is_active = true)`,
    audience, agentAuthority,
  ));
}

export function emailKnowledgeSourceUrl(accountId: string, messageId: string): string | null {
  if (!accountId || accountId.length > 256 || /[\u0000-\u001f\u007f]/u.test(accountId)
    || !/^mail_[a-f0-9]{64}$/u.test(messageId)) return null;
  return `/email?account=${encodeURIComponent(accountId)}&message=${encodeURIComponent(messageId)}`;
}
