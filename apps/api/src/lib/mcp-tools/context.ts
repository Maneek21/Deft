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
 * prompt (NC1 fix): the system prompt is owned by OpenClaw and stays
 * immutable, while per-turn context flows through this tool.
 *
 * Cache: 60-second LRU keyed by (employee_id + query hash) so a busy agent
 * calling `platform_context` repeatedly inside a single session doesn't
 * thrash the DB. Cache is cleared on any `memory_write` in Phase 4. For
 * Phase 3 MVP the cache is write-through only.
 */
import { createHash } from 'node:crypto';
import { sql, and, eq, desc } from 'drizzle-orm';
import { db } from '../db.js';
import {
  orgs,
  orgMembers,
  users,
  wikiPages,
  messages,
} from '@deft/db/schema';
import type { ToolContext, ToolResult } from './types.js';
import { errorResult, textResult } from './types.js';
import { retrieveContext } from '../retrieve-context.js';

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

export async function platformContext(
  args: PlatformContextArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const trigger = args.trigger;
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
    let queryText = '';
    if (trigger?.triggering_message_id) {
      try {
        const [msg] = await db
          .select({ content: messages.content })
          .from(messages)
          .where(eq(messages.id, trigger.triggering_message_id))
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
    let wikiSnippets: Array<{
      slug: string;
      title: string;
      summary: string | null;
      type: string;
      confidence: number;
    }> = [];
    try {
      if (queryText.trim().length > 0) {
        const results = await retrieveContext({
          query: queryText,
          org_id: ctx.org_id,
          agent_employee_id: ctx.employee_id,
          types: ['wiki'],
          limit: 5,
        });
        wikiSnippets = results.map((r) => ({
          slug: String(r.metadata?.slug ?? ''),
          title: r.title,
          summary: (r.metadata?.summary as string | null) ?? null,
          type: String(r.metadata?.type ?? 'fact'),
          confidence: r.confidence ?? 0,
        }));
      } else {
        const rows = await db
          .select({
            slug: wikiPages.slug,
            title: wikiPages.title,
            summary: wikiPages.summary,
            type: wikiPages.type,
            confidence: wikiPages.confidence,
          })
          .from(wikiPages)
          .where(
            and(
              eq(wikiPages.org_id, ctx.org_id),
              eq(wikiPages.is_deleted, false),
              sql`(${wikiPages.agent_employee_id} = ${ctx.employee_id} OR ${wikiPages.agent_employee_id} IS NULL)`,
            ),
          )
          .orderBy(desc(wikiPages.confidence), desc(wikiPages.updated_at))
          .limit(5);
        wikiSnippets = rows.map((r) => ({
          slug: r.slug,
          title: r.title,
          summary: r.summary,
          type: r.type as string,
          confidence: r.confidence,
        }));
      }
    } catch {
      wikiSnippets = [];
    }

    // ─── assemble JSON payload ───────────────────────────────────
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
      relevant_wiki_snippets: wikiSnippets,
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
