/**
 * Phase 4 — memory_update MCP tool.
 *
 * Logic:
 *   1. Look up the page by slug + org_id + not-deleted.
 *   2. Reject if the page belongs to a different employee (cross-employee
 *      isolation). Pages where agent_employee_id IS NULL (org-wide) are
 *      updateable via the scope-promotion path.
 *   3. If patch.scope === 'org' → cross-scope promotion → apply approval
 *      gating. Conservative/standard employees must queue; autonomous can
 *      auto-execute (quick tier + autonomous = auto-exec).
 *   4. Else → direct update. Raw SQL with explicit column list to dodge the
 *      deferred pgvector column (same pattern as Phase 3 `memory_write`).
 *   5. Invalidate platform_context cache on successful auto-executes.
 */
import { sql, eq, and } from 'drizzle-orm';
import { db } from '../db.js';
import { wikiPages, agentActions, agentEmployees } from '@deft/db/schema';
import type { ToolContext, ToolResult } from './types.js';
import { errorResult, textResult } from './types.js';
import {
  shouldAutoExecute,
  getApprovalTier,
  asPseudoResult,
} from '../agent-approval.js';
import { invalidatePlatformContextCacheFor } from './context.js';

export type MemoryUpdateArgs = {
  caller_employee_slug: string;
  slug: string;
  patch: {
    title?: string;
    body?: string;
    confidence?: number;
    scope?: 'user' | 'org';
  };
};

export async function memoryUpdate(
  args: MemoryUpdateArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!args.slug) return errorResult('memory_update requires slug');
  if (!args.patch || Object.keys(args.patch).length === 0) {
    return errorResult('memory_update requires a non-empty patch');
  }

  try {
    // 1. Fetch the target page
    const [page] = await db
      .select({
        id: wikiPages.id,
        agent_employee_id: wikiPages.agent_employee_id,
        title: wikiPages.title,
        scope: wikiPages.scope,
      })
      .from(wikiPages)
      .where(
        and(
          eq(wikiPages.slug, args.slug),
          eq(wikiPages.org_id, ctx.org_id),
          eq(wikiPages.is_deleted, false),
        ),
      )
      .limit(1);

    if (!page) {
      return errorResult(`memory_update: page "${args.slug}" not found`);
    }

    // 2. Cross-employee isolation. Null means org-wide which is allowed
    // through the scope-promotion path.
    if (
      page.agent_employee_id !== null &&
      page.agent_employee_id !== ctx.employee_id
    ) {
      return errorResult(
        `memory_update: cannot update another employee's memory (page is owned by a different employee)`,
      );
    }

    // 3. Scope-promotion path — requires approval unless trust allows it.
    const isPromotion = args.patch.scope === 'org' && page.scope !== 'org';
    if (isPromotion && !shouldAutoExecute('memory_update', ctx.trust_level)) {
      const shadowUserId = await getShadowUserIdForEmployee(ctx.employee_id);
      if (!shadowUserId) {
        return errorResult(
          `memory_update: no shadow user for employee ${ctx.employee_id}`,
        );
      }
      const [actionRow] = await db
        .insert(agentActions)
        .values({
          org_id: ctx.org_id,
          user_id: shadowUserId,
          agent_employee_id: ctx.employee_id,
          source: 'mcp',
          action: 'memory_update',
          params: args as unknown as Record<string, unknown>,
          approval_tier: getApprovalTier('memory_update'),
          approval_status: 'pending',
        })
        .returning({ id: agentActions.id });
      if (!actionRow?.id) {
        return errorResult('memory_update: failed to queue approval');
      }
      return asPseudoResult(
        actionRow.id,
        'Scope promotion to org-wide requires human approval. Tell the user the change is pending review.',
      );
    }

    // 4. Direct update — build raw SQL to avoid the embedding column.
    // Build the SET clause conditionally.
    const setFragments: ReturnType<typeof sql>[] = [];
    if (typeof args.patch.title === 'string') {
      setFragments.push(sql`title = ${args.patch.title}`);
    }
    if (typeof args.patch.body === 'string') {
      setFragments.push(sql`content = ${args.patch.body}`);
      setFragments.push(sql`summary = ${args.patch.body.slice(0, 240)}`);
    }
    if (typeof args.patch.confidence === 'number') {
      const c = Math.max(0, Math.min(1, args.patch.confidence));
      setFragments.push(sql`confidence = ${c}`);
    }
    if (isPromotion) {
      // Auto-exec promotion path — autonomous trust
      setFragments.push(sql`scope = 'org'`);
      setFragments.push(sql`agent_employee_id = NULL`);
    }
    setFragments.push(sql`updated_at = now()`);
    setFragments.push(sql`version = version + 1`);

    // Join fragments with commas
    const setClause = sql.join(setFragments, sql`, `);

    await db.execute(sql`
      UPDATE wiki_pages SET ${setClause}
      WHERE id = ${page.id}
    `);

    // Refresh search_vector so memory_recall sees the edit.
    await db.execute(sql`
      UPDATE wiki_pages SET search_vector =
        setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(summary, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(content, '')), 'C')
      WHERE id = ${page.id}
    `);

    invalidatePlatformContextCacheFor(ctx.employee_id);

    return textResult({
      slug: args.slug,
      updated: true,
      promoted: isPromotion,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`memory_update failed: ${msg}`);
  }
}

async function getShadowUserIdForEmployee(
  employeeId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ user_id: agentEmployees.user_id })
    .from(agentEmployees)
    .where(eq(agentEmployees.id, employeeId))
    .limit(1);
  return row?.user_id ?? null;
}
