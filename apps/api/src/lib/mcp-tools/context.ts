/**
 * platform_context MCP tool — "NC1" in the Deft Agentic Vision plan.
 *
 * This is the tool the AGENTS.md system prompt instructs every employee to
 * call as their first tool call on every turn. It returns the dynamic JSON
 * blob the employee needs to reason: today's date, org + employee identity,
 * teammates, active projects, relevant wiki snippets scoped to the employee,
 * and the trigger descriptor.
 *
 * The blob is assembled here rather than being baked into a dynamic system
 * prompt (NC1 fix): the system prompt is owned by the agent runtime and
 * stays immutable, while per-turn context flows through this tool.
 *
 * Cache: 60-second LRU keyed by (employee_id + query hash) so a busy agent
 * calling `platform_context` repeatedly inside a single session doesn't
 * thrash the DB. Cache is cleared on any `memory_write` in Phase 4. For
 * Phase 3 MVP the cache is write-through only.
 */
import { createHash } from 'node:crypto';
import { sql, and, eq, or, desc } from 'drizzle-orm';
import { db } from '../db.js';
import {
  orgs,
  orgMembers,
  users,
  wikiPages,
  messages,
  agentEmployees,
  spaces,
  spaceMembers,
} from '@deft/db/schema';
import type { ToolContext, ToolResult } from './types.js';
import { errorResult, textResult } from './types.js';
import { retrieveContext, type ContextResult } from '../retrieve-context.js';
import { listTeamSummaries, teamAccessForEmployee } from './team-context.js';

type TriggerDescriptor = {
  kind: string;
  space_id?: string | null;
  triggering_message_id?: string | null;
  [k: string]: unknown;
};

type PlatformContextArgs = {
  caller_employee_slug: string;
  trigger?: TriggerDescriptor;
};

type WikiSnippet = {
  source_id?: string;
  slug: string;
  title: string;
  summary: string | null;
  type: string;
  confidence: number;
  scope?: string | null;
  tier?: string | null;
  space_id?: string | null;
  origin_space_id?: string | null;
  origin_message_id?: string | null;
  created_via?: string | null;
  matched_space_id?: string | null;
  agent_employee_id?: string | null;
};

type ContextPacket = {
  id: string;
  scope: 'org' | 'space' | 'employee';
  label: string;
  description: string;
  space_id?: string | null;
  employee_id?: string | null;
  retrieval_hint: {
    tool: 'memory_recall';
    args_template: Record<string, unknown>;
  };
  item_count: number;
  items: WikiSnippet[];
};

function snippetFromContextResult(result: ContextResult): WikiSnippet {
  return {
    source_id: result.source_id,
    slug: String(result.metadata?.slug ?? ''),
    title: result.title,
    summary: (result.metadata?.summary as string | null) ?? null,
    type: String(result.metadata?.type ?? 'fact'),
    confidence: result.confidence ?? 0,
    scope: result.scope ?? null,
    tier: (result.metadata?.tier as string | null) ?? null,
    space_id: (result.metadata?.space_id as string | null) ?? null,
    origin_space_id: (result.metadata?.origin_space_id as string | null) ?? null,
    origin_message_id: (result.metadata?.origin_message_id as string | null) ?? null,
    created_via: (result.metadata?.created_via as string | null) ?? null,
    matched_space_id: (result.metadata?.matched_space_id as string | null) ?? null,
    agent_employee_id: (result.metadata?.agent_employee_id as string | null) ?? null,
  };
}

function isEmployeeSnippet(snippet: WikiSnippet, employeeId: string): boolean {
  return (
    snippet.tier === 'employee' ||
    (snippet.agent_employee_id === employeeId && snippet.scope !== 'org')
  );
}

function isChannelSnippet(snippet: WikiSnippet, spaceId: string | null | undefined): boolean {
  if (!spaceId) return false;
  return (
    snippet.space_id === spaceId ||
    snippet.origin_space_id === spaceId ||
    snippet.matched_space_id === spaceId ||
    (snippet.scope === 'space' && snippet.space_id === spaceId)
  );
}

function buildContextPackets(
  snippets: WikiSnippet[],
  trigger: TriggerDescriptor | undefined,
  ctx: ToolContext,
): ContextPacket[] {
  const spaceId = trigger?.space_id ?? null;
  const channelItems = spaceId
    ? snippets.filter((snippet) => isChannelSnippet(snippet, spaceId))
    : [];
  const employeeItems = snippets.filter((snippet) => isEmployeeSnippet(snippet, ctx.employee_id));
  const companyItems = snippets.filter((snippet) => {
    if (isEmployeeSnippet(snippet, ctx.employee_id)) return false;
    if (isChannelSnippet(snippet, spaceId)) return false;
    return snippet.scope === 'org' || snippet.tier === 'org' || !snippet.scope;
  });

  const packets: ContextPacket[] = [
    {
      id: 'company_memory',
      scope: 'org',
      label: 'Company memory',
      description: 'Org-wide knowledge that is useful across channels and teams.',
      retrieval_hint: {
        tool: 'memory_recall',
        args_template: {
          caller_employee_slug: ctx.employee_slug,
          query: '<query>',
          scope: 'org',
        },
      },
      item_count: companyItems.length,
      items: companyItems,
    },
    {
      id: 'employee_memory',
      scope: 'employee',
      label: 'Employee memory',
      description: 'Memory owned by or scoped to the calling employee.',
      employee_id: ctx.employee_id,
      retrieval_hint: {
        tool: 'memory_recall',
        args_template: {
          caller_employee_slug: ctx.employee_slug,
          query: '<query>',
          scope: 'own',
        },
      },
      item_count: employeeItems.length,
      items: employeeItems,
    },
  ];

  if (spaceId) {
    packets.splice(1, 0, {
      id: `space:${spaceId}:memory`,
      scope: 'space',
      label: 'Channel memory',
      description:
        'Knowledge created in, scoped to, or cited from the current channel. Use this before broad company memory when answering channel-specific questions.',
      space_id: spaceId,
      retrieval_hint: {
        tool: 'memory_recall',
        args_template: {
          caller_employee_slug: ctx.employee_slug,
          query: '<query>',
          space_id: spaceId,
          include_org: false,
          scope: 'all',
        },
      },
      item_count: channelItems.length,
      items: channelItems,
    });
  }

  return packets;
}

function mergeWikiSnippets(existing: WikiSnippet[], additions: WikiSnippet[]): WikiSnippet[] {
  const seen = new Set(existing.map((snippet) => snippet.source_id ?? snippet.slug));
  const merged = [...existing];
  for (const snippet of additions) {
    const key = snippet.source_id ?? snippet.slug;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(snippet);
  }
  return merged;
}

function wikiPageMatchesSpaceExpr(orgId: string, spaceId: string) {
  return sql<boolean>`(
    ${wikiPages.space_id} = ${spaceId}
    OR ${wikiPages.origin_space_id} = ${spaceId}
    OR EXISTS (
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
    )
  )`;
}

function wikiMatchedSpaceIdExpr(orgId: string, spaceId: string | null | undefined) {
  if (!spaceId) return sql<string | null>`NULL`;
  return sql<string | null>`CASE WHEN ${wikiPageMatchesSpaceExpr(orgId, spaceId)} THEN ${spaceId} ELSE NULL END`;
}

// ─── 60s LRU cache ────────────────────────────────────────────────────────

type CacheEntry = { value: ToolResult; expiresAt: number };
const CACHE: Map<string, CacheEntry> = new Map();
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 200;

function hashArgs(obj: unknown): string {
  const s = JSON.stringify(obj ?? {});
  return createHash('sha1').update(s).digest('hex').slice(0, 16);
}

function cacheKey(employeeId: string, trigger: TriggerDescriptor | undefined): string {
  return `${employeeId}:${hashArgs(trigger)}`;
}

function cacheGet(key: string): ToolResult | null {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    CACHE.delete(key);
    return null;
  }
  // bump LRU position
  CACHE.delete(key);
  CACHE.set(key, hit);
  return hit.value;
}

function cacheSet(key: string, value: ToolResult) {
  if (CACHE.size >= CACHE_MAX) {
    const firstKey = CACHE.keys().next().value;
    if (firstKey) CACHE.delete(firstKey);
  }
  CACHE.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Test/debug utility — not exported from the tool registry. */
export function _clearPlatformContextCache() {
  CACHE.clear();
}

/** Phase 4 hook: invalidate all cache entries for an employee after a write. */
export function invalidatePlatformContextCacheFor(employeeId: string) {
  for (const k of Array.from(CACHE.keys())) {
    if (k.startsWith(`${employeeId}:`)) CACHE.delete(k);
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────

async function canEmployeeAccessSpace(
  employeeId: string,
  orgId: string,
  spaceId: string,
): Promise<boolean> {
  const [space] = await db
    .select({ type: spaces.type })
    .from(spaces)
    .where(and(eq(spaces.id, spaceId), eq(spaces.org_id, orgId)))
    .limit(1);

  if (!space) return false;
  if (space.type === 'public') return true;

  const [employee] = await db
    .select({ user_id: agentEmployees.user_id })
    .from(agentEmployees)
    .where(
      and(
        eq(agentEmployees.id, employeeId),
        eq(agentEmployees.org_id, orgId),
        eq(agentEmployees.is_active, true),
      ),
    )
    .limit(1);
  if (!employee) return false;

  const [membership] = await db
    .select({ id: spaceMembers.id })
    .from(spaceMembers)
    .where(
      and(
        eq(spaceMembers.space_id, spaceId),
        eq(spaceMembers.user_id, employee.user_id),
      ),
    )
    .limit(1);

  return Boolean(membership);
}

export async function platformContext(
  args: PlatformContextArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const trigger = args.trigger;
  let triggerMessageContent = '';

  try {
    if (
      trigger?.space_id &&
      !(await canEmployeeAccessSpace(ctx.employee_id, ctx.org_id, trigger.space_id))
    ) {
      return errorResult('You do not have access to the requested space.');
    }

    if (trigger?.triggering_message_id) {
      const [message] = await db
        .select({ content: messages.content, space_id: messages.space_id })
        .from(messages)
        .where(
          and(
            eq(messages.id, trigger.triggering_message_id),
            eq(messages.org_id, ctx.org_id),
            eq(messages.is_deleted, false),
          ),
        )
        .limit(1);

      if (!message) {
        return errorResult('The triggering message was not found.');
      }
      if (trigger.space_id && trigger.space_id !== message.space_id) {
        return errorResult('The triggering message does not belong to the requested space.');
      }
      if (!(await canEmployeeAccessSpace(ctx.employee_id, ctx.org_id, message.space_id))) {
        return errorResult('You do not have access to the triggering message.');
      }

      triggerMessageContent = message.content;
    }
  } catch {
    return errorResult('Unable to validate the requested workspace context.');
  }

  const key = cacheKey(ctx.employee_id, trigger);
  const cached = cacheGet(key);
  if (cached) {
    // Re-emit with the cache flag set so callers (and our tests) can tell.
    // The first content block is a JSON string — we re-parse, tag, re-stringify.
    try {
      const parsed = JSON.parse(cached.content[0]!.text);
      parsed._cache_hit = true;
      return textResult(parsed);
    } catch {
      return cached;
    }
  }

  try {
    // ─── org + employee + teammates ──────────────────────────────
    const [org] = await db
      .select({ id: orgs.id, name: orgs.name })
      .from(orgs)
      .where(eq(orgs.id, ctx.org_id))
      .limit(1);
    if (!org) {
      return errorResult(`Org ${ctx.org_id} not found`);
    }

    const teammates = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: orgMembers.role,
        is_agent: users.is_agent,
      })
      .from(orgMembers)
      .innerJoin(users, eq(orgMembers.user_id, users.id))
      .where(
        and(
          eq(orgMembers.org_id, ctx.org_id),
          eq(orgMembers.is_active, true),
        ),
      )
      .limit(100);

    // ─── active projects (optional, fail soft) ───────────────────
    let activeProjects: Array<{ id: string; name: string; prefix: string }> = [];
    try {
      const rows = await db.execute(
        sql`SELECT id, name, prefix FROM projects
            WHERE org_id = ${ctx.org_id}
              AND is_archived = false
            ORDER BY updated_at DESC
            LIMIT 25`,
      );
      const anyRows = (rows as { rows?: unknown[] }).rows ?? (rows as unknown as unknown[]);
      activeProjects = (anyRows as Array<Record<string, unknown>>).map((r) => ({
        id: String(r.id),
        name: String(r.name),
        prefix: String(r.prefix ?? ''),
      }));
    } catch {
      activeProjects = [];
    }

    // ─── wiki snippet query source ───────────────────────────────
    let queryText = triggerMessageContent;
    if (trigger?.triggering_message_id) {
      try {
        const [msg] = await db
          .select({ content: messages.content })
          .from(messages)
          .where(
            and(
              eq(messages.id, trigger.triggering_message_id),
              eq(messages.org_id, ctx.org_id),
              eq(messages.is_deleted, false),
            ),
          )
          .limit(1);
        if (msg?.content) queryText = msg.content;
      } catch {
        // swallow — fall back to top pages
      }
    }

    // ─── relevant wiki snippets ──────────────────────────────────
    // When there is a triggering message, delegate to the retrieveContext
    // gateway (FTS + hybrid ranking, two-tier employee/org scoping).
    // When there is no query text, fall back to top-confidence pages
    // (the gateway requires a non-empty query string, so we keep the
    // direct DB read for the no-query case).
    let wikiSnippets: WikiSnippet[] = [];
    try {
      if (queryText.trim().length > 0) {
        const results = await retrieveContext({
          query: queryText,
          org_id: ctx.org_id,
          agent_employee_id: ctx.employee_id,
          space_id: trigger?.space_id ?? undefined,
          include_org: true,
          types: ['wiki'],
          limit: 5,
        });
        wikiSnippets = results.map(snippetFromContextResult);
        if (trigger?.space_id) {
          const employeeResults = await retrieveContext({
            query: queryText,
            org_id: ctx.org_id,
            agent_employee_id: ctx.employee_id,
            types: ['wiki'],
            limit: 2,
          });
          wikiSnippets = mergeWikiSnippets(
            wikiSnippets,
            employeeResults
              .map(snippetFromContextResult)
              .filter((snippet) => isEmployeeSnippet(snippet, ctx.employee_id)),
          );
        }
      } else {
        const noQueryOrderBy = trigger?.space_id
          ? [
              desc(sql<number>`CASE WHEN ${wikiPageMatchesSpaceExpr(ctx.org_id, trigger.space_id)} THEN 1 ELSE 0 END`),
              desc(wikiPages.confidence),
              desc(wikiPages.updated_at),
            ]
          : [desc(wikiPages.confidence), desc(wikiPages.updated_at)];
        const rows = await db
          .select({
            slug: wikiPages.slug,
            title: wikiPages.title,
            summary: wikiPages.summary,
            type: wikiPages.type,
            confidence: wikiPages.confidence,
            scope: wikiPages.scope,
            space_id: wikiPages.space_id,
            origin_space_id: wikiPages.origin_space_id,
            origin_message_id: wikiPages.origin_message_id,
            created_via: wikiPages.created_via,
            matched_space_id: wikiMatchedSpaceIdExpr(ctx.org_id, trigger?.space_id),
            agent_employee_id: wikiPages.agent_employee_id,
          })
          .from(wikiPages)
          .where(
            and(
              eq(wikiPages.org_id, ctx.org_id),
              eq(wikiPages.is_deleted, false),
              or(
                eq(wikiPages.scope, 'org'),
                trigger?.space_id
                  ? or(
                      and(
                        eq(wikiPages.scope, 'space'),
                        eq(wikiPages.space_id, trigger.space_id),
                      ),
                      eq(wikiPages.origin_space_id, trigger.space_id),
                    )
                  : undefined,
                and(
                  eq(wikiPages.agent_employee_id, ctx.employee_id),
                  sql`${wikiPages.scope} != 'org'`,
                ),
              ),
            ),
          )
          .orderBy(...noQueryOrderBy)
          .limit(5);
        wikiSnippets = rows.map((r) => ({
          slug: r.slug,
          title: r.title,
          summary: r.summary,
          type: r.type as string,
          confidence: r.confidence,
          scope: r.scope,
          tier: r.scope === 'org' ? 'org' : r.agent_employee_id === ctx.employee_id ? 'employee' : null,
          space_id: r.space_id,
          origin_space_id: r.origin_space_id,
          origin_message_id: r.origin_message_id,
          created_via: r.created_via,
          matched_space_id: r.matched_space_id,
          agent_employee_id: r.agent_employee_id,
        }));
      }
    } catch {
      wikiSnippets = [];
    }

    // ─── assemble JSON payload ───────────────────────────────────
    let teamSummaries: Array<Record<string, unknown>> = [];
    try {
      const access = await teamAccessForEmployee(ctx);
      teamSummaries = (await listTeamSummaries(access, { limit: 20 })).map((team) => ({
        id: team.id,
        name: team.name,
        handle: team.handle,
        description: team.description,
        type: team.type,
        visibility: team.visibility,
        lead_user_id: team.lead_user_id,
        lead_name: team.lead_name,
        default_space_id: team.default_space_id,
        member_count: team.member_count,
        agent_count: team.agent_count,
        resource_count: team.resource_count,
        resources_by_type: team.resources_by_type,
        current_user_role: team.current_user_role,
        retrieval_hint: {
          tool: 'team_context',
          args_template: {
            caller_employee_slug: ctx.employee_slug,
            team_id: team.id,
          },
        },
      }));
    } catch {
      teamSummaries = [];
    }

    const now = new Date();
    const payload = {
      generated_at: now.toISOString(),
      date: now.toISOString().slice(0, 10),
      org: {
        id: org.id,
        name: org.name,
      },
      employee: {
        id: ctx.employee_id,
        slug: ctx.employee_slug,
        trust_level: ctx.trust_level,
      },
      teammates: teammates.map((t) => ({
        id: t.id,
        name: t.name,
        email: t.email,
        role: t.role,
        is_agent: t.is_agent,
      })),
      active_projects: activeProjects,
      teams: teamSummaries,
      relevant_wiki_snippets: wikiSnippets,
      context_packets: buildContextPackets(wikiSnippets, trigger, ctx),
      trigger_context: trigger ?? null,
      _cache_hit: false,
    };

    const result = textResult(payload);
    cacheSet(key, result);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`platform_context failed: ${msg}`);
  }
}
