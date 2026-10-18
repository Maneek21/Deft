import { and, desc, eq, inArray, ne, or, type SQL } from 'drizzle-orm';
import {
  agentEmployees, messages, orgMembers, spaceMembers, spaces, tasks, users,
  wikiCitations, wikiLinks, wikiPages,
} from '@deft/db/schema';
import { db } from './db.js';
import { visibleWikiPageCondition } from './wiki-visibility.js';
import { visibleTaskCondition } from './task-visibility.js';
import { canonicalDeftyEmployeeCondition } from './defty-identity.js';
import { employeeProjectAccessAllows, loadEmployeeProjectAccess } from './mcp-tools/employee-project-access.js';
import { retrieveContext } from './retrieve-context.js';

/** Native agent identity is supplied by the host runner, never tool input. */
export type NativeWikiCaller = Readonly<{
  orgId: string;
  userId: string;
  agentEmployeeId?: string;
}>;

export type NativeWikiReader = Readonly<{
  orgId: string;
  subjectUserId: string;
  agentEmployeeId?: string;
}>;

export async function resolveNativeWikiReader(caller: NativeWikiCaller): Promise<NativeWikiReader | null> {
  if (!caller.orgId || (!caller.userId && !caller.agentEmployeeId)) return null;
  if (caller.agentEmployeeId) {
    const [employee] = await db.select({ user_id: agentEmployees.user_id })
      .from(agentEmployees)
      .innerJoin(orgMembers, and(eq(orgMembers.org_id, agentEmployees.org_id),
        eq(orgMembers.user_id, agentEmployees.user_id)))
      .where(and(eq(agentEmployees.id, caller.agentEmployeeId),
        eq(agentEmployees.org_id, caller.orgId), eq(agentEmployees.is_active, true),
        eq(orgMembers.is_active, true),
        or(eq(agentEmployees.is_deleted, false), canonicalDeftyEmployeeCondition())))
      .limit(1);
    return employee?.user_id ? { orgId: caller.orgId, subjectUserId: employee.user_id,
      agentEmployeeId: caller.agentEmployeeId } : null;
  }
  const [member] = await db.select({ id: orgMembers.id })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.user_id))
    .where(and(eq(orgMembers.org_id, caller.orgId), eq(orgMembers.user_id, caller.userId),
      eq(orgMembers.is_active, true), eq(users.is_agent, false)))
    .limit(1);
  return member ? { orgId: caller.orgId, subjectUserId: caller.userId } : null;
}

function visiblePage(reader: NativeWikiReader): SQL | undefined {
  const humanVisibility = visibleWikiPageCondition(reader.subjectUserId, reader.orgId);
  return reader.agentEmployeeId
    ? or(humanVisibility, and(eq(wikiPages.agent_employee_id, reader.agentEmployeeId),
        ne(wikiPages.scope, 'org')))
    : humanVisibility;
}

async function linkedPages(reader: NativeWikiReader, pageId: string,
  direction: 'out' | 'in', limit: number) {
  const source = direction === 'out' ? wikiLinks.source_page_id : wikiLinks.target_page_id;
  const target = direction === 'out' ? wikiLinks.target_page_id : wikiLinks.source_page_id;
  const rows = await db.select({
    slug: wikiPages.slug, title: wikiPages.title, type: wikiPages.type,
    summary: wikiPages.summary, context: wikiLinks.context,
  }).from(wikiLinks)
    .innerJoin(wikiPages, eq(target, wikiPages.id))
    .where(and(eq(source, pageId), eq(wikiLinks.org_id, reader.orgId),
      eq(wikiPages.org_id, reader.orgId), eq(wikiPages.is_deleted, false), visiblePage(reader)))
    .limit(limit);
  return rows;
}

async function citationVisible(reader: NativeWikiReader, citation: typeof wikiCitations.$inferSelect): Promise<boolean> {
  if (citation.org_id && citation.org_id !== reader.orgId) return false;
  if (citation.source_type === 'message') {
    const [row] = await db.select({ id: messages.id }).from(messages)
      .innerJoin(spaces, and(eq(spaces.id, messages.space_id), eq(spaces.org_id, reader.orgId)))
      .innerJoin(spaceMembers, and(eq(spaceMembers.space_id, messages.space_id),
        eq(spaceMembers.user_id, reader.subjectUserId)))
      .where(and(eq(messages.id, citation.source_id), eq(messages.org_id, reader.orgId),
        eq(messages.is_deleted, false)))
      .limit(1);
    return Boolean(row);
  }
  if (citation.source_type === 'task') {
    const [row] = await db.select({ project_id: tasks.project_id }).from(tasks)
      .where(and(eq(tasks.id, citation.source_id), eq(tasks.org_id, reader.orgId),
        eq(tasks.is_deleted, false), visibleTaskCondition(reader.subjectUserId)))
      .limit(1);
    if (!row) return false;
    if (!reader.agentEmployeeId) return true;
    return employeeProjectAccessAllows(await loadEmployeeProjectAccess({
      org_id: reader.orgId, employee_id: reader.agentEmployeeId,
    }), row.project_id);
  }
  // Unknown source types have no reviewed owner authorization path.
  return false;
}

export async function readNativeWiki(reader: NativeWikiReader, slug: string) {
  if (!slug) return null;
  const [page] = await db.select().from(wikiPages)
    .where(and(eq(wikiPages.org_id, reader.orgId), eq(wikiPages.slug, slug),
      eq(wikiPages.is_deleted, false), visiblePage(reader)))
    .limit(1);
  if (!page) return null;
  const candidates = await db.select().from(wikiCitations)
    .where(eq(wikiCitations.page_id, page.id))
    .orderBy(desc(wikiCitations.created_at)).limit(10);
  // Every linked target and citation source is authorized independently.
  const [currentLinks, currentBacklinks] = await Promise.all([
    linkedPages(reader, page.id, 'out', 100), linkedPages(reader, page.id, 'in', 100),
  ]);
  const checks = await Promise.all(candidates.map((citation) => citationVisible(reader, citation)));
  // A removal during adjunct reads must not let an old page body escape.
  const [stillVisible] = await db.select().from(wikiPages)
    .where(and(eq(wikiPages.id, page.id), eq(wikiPages.org_id, reader.orgId),
      eq(wikiPages.is_deleted, false), visiblePage(reader))).limit(1);
  if (!stillVisible) return null;
  if (!await resolveNativeWikiReader({ orgId: reader.orgId,
    userId: reader.subjectUserId, agentEmployeeId: reader.agentEmployeeId })) return null;
  return { page: stillVisible,
    linked_pages: currentLinks.map(({ context: _context, ...link }) => link),
    backlinks: currentBacklinks.map(({ summary: _summary, context: _context, ...link }) => link),
    citations: candidates.filter((_, index) => checks[index]) };
}

export async function searchNativeWiki(reader: NativeWikiReader, input: {
  query?: unknown; type?: unknown; scope?: unknown; limit?: unknown;
}, timing?: { afterCandidates?: () => Promise<void> }) {
  if (typeof input.query !== 'string' || input.query.trim().length < 2) return [];
  const limit = typeof input.limit === 'number' && Number.isInteger(input.limit)
    ? Math.max(1, Math.min(input.limit, 10)) : 5;
  const hits = await retrieveContext({ query: input.query, org_id: reader.orgId,
    ...(reader.agentEmployeeId ? { agent_employee_id: reader.agentEmployeeId }
      : { user_id: reader.subjectUserId }), types: ['wiki'], limit });
  const ids = hits.map((hit) => hit.source_id);
  if (ids.length === 0) return [];
  // Search index results are candidate IDs only. The test seam pauses between
  // candidate selection and current owner resolution; tool callers cannot set it.
  await timing?.afterCandidates?.();
  const rows = await db.select({
    id: wikiPages.id, title: wikiPages.title, slug: wikiPages.slug,
    summary: wikiPages.summary, type: wikiPages.type, scope: wikiPages.scope,
    confidence: wikiPages.confidence, updated_at: wikiPages.updated_at,
  }).from(wikiPages).where(and(eq(wikiPages.org_id, reader.orgId),
    eq(wikiPages.is_deleted, false), inArray(wikiPages.id, ids), visiblePage(reader),
    ...(typeof input.type === 'string' ? [eq(wikiPages.type, input.type as typeof wikiPages.$inferSelect.type)] : []),
    ...(typeof input.scope === 'string' ? [eq(wikiPages.scope, input.scope as typeof wikiPages.$inferSelect.scope)] : [])));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = ids.map((id) => byId.get(id)).filter((row): row is NonNullable<typeof row> => Boolean(row));
  const enriched = await Promise.all(ordered.map(async (page) => ({
    ...page, linked_pages: (await linkedPages(reader, page.id, 'out', 5))
      .map(({ slug, title }) => ({ slug, title })),
  })));
  if (!await resolveNativeWikiReader({ orgId: reader.orgId, userId: reader.subjectUserId,
    agentEmployeeId: reader.agentEmployeeId })) return [];
  return enriched;
}
