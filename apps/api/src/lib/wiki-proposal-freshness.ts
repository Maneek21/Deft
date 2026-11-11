import { and, eq, sql, type SQL } from 'drizzle-orm';
import { agentActions, wikiPages } from '@deft/db/schema';
import { db } from './db.js';

/**
 * Answer when an approved wiki update no longer matches the page it was
 * proposed against. Plain and non-leaking: it names no content.
 */
export const WIKI_PROPOSAL_STALE_ERROR =
  'This wiki page changed after the update was proposed, so the update was not applied. Ask for it again against the current page.';

function frozenPageId(params: Record<string, unknown>): string | null {
  return params.wiki_write_mode === 'update'
    && typeof params.resolved_wiki_page_id === 'string'
    && params.resolved_wiki_page_id.trim()
    ? params.resolved_wiki_page_id
    : null;
}

/**
 * Which page a wiki_write update targets. A chat proposal freezes the page
 * it read (`resolved_wiki_page_id`); the executor honours that identity
 * instead of re-resolving the slug, which another page may hold by now.
 */
export function wikiWriteTargetCondition(params: Record<string, unknown>, slug: string): SQL {
  const pageId = frozenPageId(params);
  return pageId ? eq(wikiPages.id, pageId) : eq(wikiPages.slug, slug);
}

/**
 * Error when the page a proposal was prepared against changed after the
 * proposal was recorded. The proposal does not store the page version it
 * read, so the action's own created_at stands for the proposal time and the
 * page's updated_at is compared with it in the database.
 */
export async function staleWikiProposalError(
  actionId: string,
  orgId: string,
  params: Record<string, unknown>,
  page: { id: string },
): Promise<string | null> {
  if (!frozenPageId(params)) return null;
  const [changed] = await db
    .select({ id: wikiPages.id })
    .from(wikiPages)
    .innerJoin(agentActions, and(eq(agentActions.id, actionId), eq(agentActions.org_id, orgId)))
    .where(and(
      eq(wikiPages.id, page.id),
      eq(wikiPages.org_id, orgId),
      sql`${wikiPages.updated_at} > ${agentActions.created_at}`,
    ))
    .limit(1);
  return changed ? WIKI_PROPOSAL_STALE_ERROR : null;
}
