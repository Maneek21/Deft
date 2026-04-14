/**
 * memory_recall / memory_write / memory_list MCP tools.
 *
 * Phase 3 scope: FTS only. pgvector is an optional ranking boost added in a
 * follow-up once the `vector` extension is enabled on local dev Postgres.
 * The `embedding` column on wiki_pages is nullable and is ignored here —
 * ranking is `ts_rank × confidence DESC`, scoped to the caller's employee +
 * org-wide pages.
 *
 * memory_write inserts a wiki_pages row with `agent_employee_id = ctx.employee_id`
 * and `scope = 'user'` for now. Phase 4 adds `memory_update` with approval
 * gating for cross-scope promotion.
 */
import { sql, and, eq, or, isNull, desc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { wikiPages } from '@deft/db/schema';
import type { ToolContext, ToolResult } from './types.js';
import { errorResult, textResult } from './types.js';

const VALID_TYPES = new Set([
  'concept',
  'entity',
  'decision',
  'resource',
  'procedure',
  'preference',
  'fact',
]);

// ─── memory_recall ────────────────────────────────────────────────────────

export type MemoryRecallArgs = {
  caller_employee_slug: string;
  query: string;
  limit?: number;
  scope?: 'own' | 'org' | 'all';
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

  try {
    // Scope filter: employee-tagged + org-wide by default; `own` excludes org-wide.
    const scope = args.scope ?? 'all';
    const scopeCondition =
      scope === 'own'
        ? eq(wikiPages.agent_employee_id, ctx.employee_id)
        : scope === 'org'
          ? isNull(wikiPages.agent_employee_id)
          : or(
              eq(wikiPages.agent_employee_id, ctx.employee_id),
              isNull(wikiPages.agent_employee_id),
            );

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
          scopeCondition,
          sql`search_vector @@ plainto_tsquery('english', ${query})`,
        ),
      )
      .orderBy(
        sql`ts_rank(search_vector, plainto_tsquery('english', ${query})) * ${wikiPages.confidence} DESC`,
      )
      .limit(limit);

    const result = rows.map((r) => ({
      slug: r.slug,
      title: r.title,
      summary: r.summary,
      type: r.type,
      confidence: r.confidence,
    }));

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
      or(
        eq(wikiPages.agent_employee_id, ctx.employee_id),
        isNull(wikiPages.agent_employee_id),
      ),
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
