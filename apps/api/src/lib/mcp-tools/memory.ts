/**
 * memory_recall / memory_write / memory_list MCP tools.
 *
 * memory_recall delegates to the retrieveContext gateway (Task 1.4).
 * memory_write inserts a wiki_pages row with `agent_employee_id = ctx.employee_id`
 * and `scope = 'user'` for now. Phase 4 adds `memory_update` with approval
 * gating for cross-scope promotion.
 */
import { sql, and, eq, or, desc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { agentEmployees, spaceMembers, spaces, wikiPages } from '@deft/db/schema';
import type { ToolContext, ToolResult } from './types.js';
import { errorResult, textResult } from './types.js';
import { invalidatePlatformContextCacheFor } from './context.js';
import { retrieveContext } from '../retrieve-context.js';

const VALID_TYPES = new Set([
  'concept',
  'entity',
  'decision',
  'resource',
  'procedure',
  'preference',
  'fact',
]);

function wikiScopeCondition(scope: 'own' | 'org' | 'all', employeeId: string) {
  const orgScope = eq(wikiPages.scope, 'org');
  const ownScope = and(
    eq(wikiPages.agent_employee_id, employeeId),
    sql`${wikiPages.scope} != 'org'`,
  );
  if (scope === 'own') return ownScope;
  if (scope === 'org') return orgScope;
  return or(orgScope, ownScope);
}

function contextResultMatchesMemoryScope(
  scope: 'own' | 'org' | 'all',
  employeeId: string,
  resultScope?: string,
  resultEmployeeId?: string | null,
) {
  const isOrgScope = resultScope === 'org';
  const isOwnScope = resultEmployeeId === employeeId && !isOrgScope;
  if (scope === 'own') return isOwnScope;
  if (scope === 'org') return isOrgScope;
  return isOrgScope || isOwnScope;
}

function wikiPageRelevantToSpaceCondition(spaceId: string, orgId: string) {
  return or(
    and(eq(wikiPages.scope, 'space'), eq(wikiPages.space_id, spaceId)),
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

function wikiRetrievalScopeCondition(orgId: string, spaceId: string | undefined, includeOrg: boolean) {
  if (!spaceId) return undefined;
  const spaceRelevant = wikiPageRelevantToSpaceCondition(spaceId, orgId);
  return includeOrg ? or(eq(wikiPages.scope, 'org'), spaceRelevant) : spaceRelevant;
}

function wikiMatchedSpaceIdExpr(orgId: string, spaceId: string | undefined) {
  if (!spaceId) return sql<string | null>`NULL`;
  const spaceRelevant = wikiPageRelevantToSpaceCondition(spaceId, orgId) ?? sql`FALSE`;
  return sql<string | null>`CASE WHEN ${spaceRelevant} THEN ${spaceId} ELSE NULL END`;
}

async function canEmployeeSeeSpace(
  spaceId: string,
  orgId: string,
  employeeId: string,
): Promise<boolean> {
  const [space] = await db
    .select({ id: spaces.id, type: spaces.type })
    .from(spaces)
    .where(and(eq(spaces.id, spaceId), eq(spaces.org_id, orgId)))
    .limit(1);
  if (!space) return false;
  if (space.type === 'public') return true;

  const [employee] = await db
    .select({ user_id: agentEmployees.user_id })
    .from(agentEmployees)
    .where(and(eq(agentEmployees.id, employeeId), eq(agentEmployees.org_id, orgId)))
    .limit(1);
  if (!employee?.user_id) return false;

  const [member] = await db
    .select({ id: spaceMembers.id })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.space_id, spaceId), eq(spaceMembers.user_id, employee.user_id)))
    .limit(1);
  return !!member;
}

// ─── memory_recall ────────────────────────────────────────────────────────

export type MemoryRecallArgs = {
  caller_employee_slug: string;
  query: string;
  limit?: number;
  scope?: 'own' | 'org' | 'all';
  space_id?: string;
  include_org?: boolean;
};

export async function memoryRecall(
  args: MemoryRecallArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const query = (args.query ?? '').trim();
  if (!query) {
    return errorResult('memory_recall requires a non-empty query');
  }
  const limit = Math.min(Math.max(1, args.limit ?? 5), 25);
  const scope = args.scope ?? 'all';
  const spaceId = args.space_id?.trim() || undefined;
  const includeOrg = args.include_org !== false;

  try {
    if (spaceId && !(await canEmployeeSeeSpace(spaceId, ctx.org_id, ctx.employee_id))) {
      return errorResult(`memory_recall: employee cannot access space ${spaceId}`);
    }
    const retrievalScope = wikiRetrievalScopeCondition(ctx.org_id, spaceId, includeOrg);
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length >= 3)
      .slice(0, 8);
    const exactTermMatches = terms.length > 0
      ? await db
          .select({
            slug: wikiPages.slug,
            title: wikiPages.title,
            summary: wikiPages.summary,
            content: wikiPages.content,
            type: wikiPages.type,
            agent_employee_id: wikiPages.agent_employee_id,
            space_id: wikiPages.space_id,
            origin_space_id: wikiPages.origin_space_id,
            origin_message_id: wikiPages.origin_message_id,
            created_via: wikiPages.created_via,
            matched_space_id: wikiMatchedSpaceIdExpr(ctx.org_id, spaceId),
            updated_at: wikiPages.updated_at,
          })
          .from(wikiPages)
          .where(and(
            eq(wikiPages.org_id, ctx.org_id),
            eq(wikiPages.is_deleted, false),
            wikiScopeCondition(scope, ctx.employee_id),
            ...(retrievalScope ? [retrievalScope] : []),
            ...terms.map((term) => {
              const pattern = `%${term}%`;
              return sql`(
                lower(${wikiPages.title}) like ${pattern}
                or lower(${wikiPages.summary}) like ${pattern}
                or lower(${wikiPages.content}) like ${pattern}
              )`;
            }),
          ))
          .orderBy(desc(wikiPages.updated_at))
          .limit(limit)
      : [];
    // Fetch from the unified gateway — always pass agent_employee_id so
    // the two-tier employee+org split is applied inside fetchWiki.
    const contextResults = await retrieveContext({
      query,
      org_id: ctx.org_id,
      agent_employee_id: ctx.employee_id,
      space_id: spaceId,
      include_org: includeOrg,
      types: ['wiki'],
      limit,
      hybrid: false, // FTS-only; pgvector is a separate phase
    });

    // Post-filter by explicit wiki scope. Org pages can retain an
    // agent_employee_id for audit, so employee ownership is not the tier.
    const filtered = contextResults.filter((r) => {
      if (r.source_type !== 'wiki_page') return false;
      const empId = r.metadata?.agent_employee_id as string | null | undefined;
      return contextResultMatchesMemoryScope(scope, ctx.employee_id, r.scope, empId);
    });

    // Map ContextResult back to the shape clients expect.
    // Fix #5: include page content (truncated to 2000 chars) so callers can
    // quote body text instead of only the summary. Flag pages whose content
    // exceeded the cap with `truncated: true`.
    const CONTENT_CAP = 2000;
    const seenSlugs = new Set<string>();
    const exactResults = exactTermMatches.map((row) => {
      seenSlugs.add(row.slug);
      const fullContent = row.content ?? '';
      const truncated = fullContent.length > CONTENT_CAP;
      return {
        slug: row.slug,
        title: row.title,
        summary: row.summary ?? null,
        content: truncated ? fullContent.slice(0, CONTENT_CAP) : fullContent,
        truncated,
        type: row.type ?? '',
        confidence: 1.0,
        space_id: row.space_id ?? null,
        origin_space_id: row.origin_space_id ?? null,
        origin_message_id: row.origin_message_id ?? null,
        created_via: row.created_via ?? null,
        matched_space_id: row.matched_space_id ?? null,
      };
    });
    const result = [...exactResults, ...filtered.filter((r) => {
      const slug = (r.metadata?.slug as string) ?? '';
      if (!slug || seenSlugs.has(slug)) return false;
      seenSlugs.add(slug);
      return true;
    }).map((r) => {
      const fullContent = r.content ?? '';
      const truncated = fullContent.length > CONTENT_CAP;
      return {
        slug: (r.metadata?.slug as string) ?? '',
        title: r.title,
        summary: (r.metadata?.summary as string | null) ?? null,
        content: truncated ? fullContent.slice(0, CONTENT_CAP) : fullContent,
        truncated,
        type: (r.metadata?.type as string) ?? '',
        confidence: r.confidence ?? 1.0,
        space_id: r.metadata?.space_id ?? null,
        origin_space_id: r.metadata?.origin_space_id ?? null,
        origin_message_id: r.metadata?.origin_message_id ?? null,
        created_via: r.metadata?.created_via ?? null,
        matched_space_id: r.metadata?.matched_space_id ?? null,
      };
    })].slice(0, limit);

    return textResult(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`memory_recall failed: ${msg}`);
  }
}

// ─── memory_write ─────────────────────────────────────────────────────────

export type MemoryWriteArgs = {
  caller_employee_slug: string;
  title: string;
  body: string;
  type: string;
  confidence?: number;
  scope?: 'user' | 'org';
};

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

export async function memoryWrite(
  args: MemoryWriteArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!args.title?.trim()) return errorResult('memory_write requires title');
  if (!args.body?.trim()) return errorResult('memory_write requires body');
  if (!args.type || !VALID_TYPES.has(args.type)) {
    return errorResult(
      `memory_write requires type in: ${[...VALID_TYPES].join(', ')}`,
    );
  }

  const confidence =
    typeof args.confidence === 'number'
      ? Math.max(0, Math.min(1, args.confidence))
      : 0.7;

  // Phase 3: always tag to the employee. Phase 4's memory_update handles
  // scope promotion to org with approval.
  const baseSlug = slugify(args.title);
  const suffix = Math.random().toString(36).slice(2, 8);
  const slug = baseSlug ? `${baseSlug}-${suffix}` : `memory-${suffix}`;

  // NOTE: raw SQL rather than drizzle insert() because the schema declares
  // `embedding vector(1536)` but migration 0011 is deferred — pgvector is not
  // installed locally, so the column doesn't physically exist. A drizzle
  // insert() always references every declared column and would fail. Raw SQL
  // lets us list only the columns we know exist.
  try {
    const id = randomUUID();
    const rows = await db.execute(sql`
      INSERT INTO wiki_pages
        (id, org_id, scope, agent_employee_id, type, title, slug, summary,
         content, confidence, version, is_deleted, created_at, updated_at)
      VALUES
        (${id}, ${ctx.org_id}, 'user', ${ctx.employee_id}, ${args.type},
         ${args.title.trim()}, ${slug}, ${args.body.slice(0, 240)},
         ${args.body}, ${confidence}, 1, false, now(), now())
      RETURNING slug, created_at
    `);
    const anyRows = (rows as { rows?: unknown[] }).rows ?? (rows as unknown as unknown[]);
    const first = (anyRows as Array<Record<string, unknown>>)[0];
    if (!first) return errorResult('memory_write: insert returned no row');

    // Update search_vector so memory_recall can find this page immediately.
    await db.execute(sql`
      UPDATE wiki_pages SET search_vector =
        setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(summary, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(content, '')), 'C')
      WHERE id = ${id}
    `);

    // Phase 12 review fix — plan §4.2 I3: invalidate platform_context cache
    // on any memory_write so the next turn sees the new wiki page.
    invalidatePlatformContextCacheFor(ctx.employee_id);

    return textResult({
      slug: String(first.slug),
      created_at: first.created_at,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`memory_write failed: ${msg}`);
  }
}

// ─── memory_list ──────────────────────────────────────────────────────────

export type MemoryListArgs = {
  caller_employee_slug: string;
  type?: string;
  limit?: number;
};

export async function memoryList(
  args: MemoryListArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const limit = Math.min(Math.max(1, args.limit ?? 25), 100);

  try {
    const conditions = [
      eq(wikiPages.org_id, ctx.org_id),
      eq(wikiPages.is_deleted, false),
      wikiScopeCondition('all', ctx.employee_id),
    ];
    if (args.type && VALID_TYPES.has(args.type)) {
      conditions.push(eq(wikiPages.type, args.type as 'fact'));
    }

    const rows = await db
      .select({
        slug: wikiPages.slug,
        title: wikiPages.title,
        summary: wikiPages.summary,
        type: wikiPages.type,
        confidence: wikiPages.confidence,
        updated_at: wikiPages.updated_at,
      })
      .from(wikiPages)
      .where(and(...conditions))
      .orderBy(desc(wikiPages.updated_at))
      .limit(limit);

    return textResult(
      rows.map((r) => ({
        slug: r.slug,
        title: r.title,
        summary: r.summary,
        type: r.type,
        confidence: r.confidence,
        updated_at: r.updated_at,
      })),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`memory_list failed: ${msg}`);
  }
}
