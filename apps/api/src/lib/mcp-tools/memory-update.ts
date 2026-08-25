/**
 * Phase 4 — memory_update MCP tool.
 *
 * Logic:
 *   1. Look up the page by slug + org_id + not-deleted.
 *   2. Reject if the page belongs to a different employee (cross-employee
 *      isolation). Org-scoped pages are shared knowledge even when
 *      agent_employee_id is retained for audit.
 *   3. If patch.scope === 'org' → cross-scope promotion → apply approval
 *      gating. Conservative/standard employees must queue; autonomous can
 *      auto-execute (quick tier + autonomous = auto-exec).
 *   4. Else → direct update. Raw SQL with explicit column list to dodge the
 *      deferred pgvector column (same pattern as Phase 3 `memory_write`).
 *   5. Invalidate platform_context cache on successful auto-executes.
 *
 * Phase 6.5 refactor: extracted the side-effecting write into
 * `executeMemoryUpdate` so the approval resolver can re-invoke it when a
 * queued scope-promotion action is approved. The public `memoryUpdate`
 * handler still does the gating + cross-employee isolation check.
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
import { generateReceipt } from '../receipts.js';

export type MemoryUpdateArgs = {
  caller_employee_slug: string;
  slug: string;
  patch: {
    title?: string;
    body?: string;
    confidence?: number;
    scope?: 'user' | 'org';
  };
  /** Server-stamped when a promotion is queued; callers should not set this. */
  _approval_guard?: MemoryUpdateApprovalGuard;
};

type MemoryUpdateApprovalGuard = {
  page_id: string;
  version: number;
};

export function memoryUpdateApprovalGuardError(
  page: { id: string; version: number },
  guard?: MemoryUpdateApprovalGuard,
): string | null {
  // Pending rows created before version fencing remain executable.
  if (!guard) return null;
  if (page.id !== guard.page_id) {
    return 'memory_update: target changed since approval was requested; request a fresh promotion approval';
  }
  if (page.version !== guard.version) {
    return 'memory_update: page changed since approval was requested; review the current version and request a fresh promotion approval';
  }
  return null;
}

/**
 * Inner executor — performs the actual wiki_pages update. It re-runs the
 * target-lookup + cross-employee isolation check because callers may be
 * invoking with stale approval payloads where another employee has since
 * claimed the page. Returns an error ToolResult if the page is now missing
 * or owned by someone else.
 *
 * Deliberately does NOT gate on trust_level — if the caller decided to
 * run this (either because of auto-exec at handler time or because a
 * user approved the queued action), we trust their decision.
 */
export async function executeMemoryUpdate(
  args: MemoryUpdateArgs,
  ctx: ToolContext,
  opts?: { skipReceipt?: boolean },
): Promise<ToolResult> {
  if (!args.slug) return errorResult('memory_update requires slug');
  if (!args.patch || Object.keys(args.patch).length === 0) {
    return errorResult('memory_update requires a non-empty patch');
  }

  try {
    const [page] = await db
      .select({
        id: wikiPages.id,
        agent_employee_id: wikiPages.agent_employee_id,
        user_id: wikiPages.user_id,
        title: wikiPages.title,
        scope: wikiPages.scope,
        version: wikiPages.version,
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

    const guardError = memoryUpdateApprovalGuardError(
      page,
      args._approval_guard,
    );
    if (guardError) return errorResult(guardError);

    const shadowUserId = await getShadowUserIdForEmployee(ctx.employee_id);
    if (page.scope === 'user') {
      const ownedByEmployee = page.agent_employee_id === ctx.employee_id;
      const ownedByShadowUser = page.user_id === shadowUserId;
      if (!ownedByEmployee && !ownedByShadowUser) {
        return errorResult(
          `memory_update: cannot update another user's memory (page is owned by a different user or employee)`,
        );
      }
    } else if (
      page.scope !== 'org' &&
      page.agent_employee_id !== null &&
      page.agent_employee_id !== ctx.employee_id
    ) {
      return errorResult(
        `memory_update: cannot update another employee's memory (page is owned by a different employee)`,
      );
    }

    const isPromotion = args.patch.scope === 'org' && page.scope !== 'org';

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
      setFragments.push(sql`scope = 'org'`);
      setFragments.push(sql`agent_employee_id = NULL`);
    }
    setFragments.push(sql`updated_at = now()`);
    setFragments.push(sql`version = version + 1`);

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

    const resultPayload = {
      slug: args.slug,
      updated: true,
      promoted: isPromotion,
    };

    if (!opts?.skipReceipt) {
      // Insert a synthetic agent_actions row so the receipt FK has a real
      // target. Matches the pattern in writes.ts — auto-exec rows are
      // stamped approved+executed so the action log UI can render them.
      let actionId: string | null = null;
      try {
        const shadowUserId = await getShadowUserIdForEmployee(ctx.employee_id);
        if (shadowUserId) {
          const now = new Date();
          const [insertedAction] = await db
            .insert(agentActions)
            .values({
              org_id: ctx.org_id,
              user_id: shadowUserId,
              agent_employee_id: ctx.employee_id,
              channel_event_id: ctx.channel_event_id,
              runtime_request_key: ctx.runtime_request_key,
              source: 'mcp',
              action: 'memory_update',
              params: args as unknown as Record<string, unknown>,
              approval_tier: getApprovalTier('memory_update'),
              approval_status: 'approved',
              approved_at: now,
              executed_at: now,
              result: resultPayload as any,
            })
            .returning({ id: agentActions.id });
          actionId = insertedAction?.id ?? null;
        }
      } catch (err) {
        console.error('[memory_update] auto-exec action row insert failed:', err);
      }
      if (actionId) {
        await generateReceipt({
          actionId,
          orgId: ctx.org_id,
          employeeId: ctx.employee_id,
          proposer: 'employee',
          proposerId: ctx.employee_id,
          decision: 'auto_executed',
          actionName: 'memory_update',
          actionParams: args as unknown,
          resultJson: resultPayload,
        });
      }
    }

    return textResult(resultPayload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`memory_update failed: ${msg}`);
  }
}

export async function memoryUpdate(
  args: MemoryUpdateArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!args.slug) return errorResult('memory_update requires slug');
  if (!args.patch || Object.keys(args.patch).length === 0) {
    return errorResult('memory_update requires a non-empty patch');
  }

  try {
    // Look up the page to check if this is a scope promotion that needs
    // approval. We intentionally duplicate the lookup with executeMemoryUpdate
    // so the gating decision can run before we queue vs execute.
    const [page] = await db
      .select({
        id: wikiPages.id,
        agent_employee_id: wikiPages.agent_employee_id,
        user_id: wikiPages.user_id,
        scope: wikiPages.scope,
        version: wikiPages.version,
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

    const shadowUserId = await getShadowUserIdForEmployee(ctx.employee_id);
    if (page.scope === 'user') {
      const ownedByEmployee = page.agent_employee_id === ctx.employee_id;
      const ownedByShadowUser = page.user_id === shadowUserId;
      if (!ownedByEmployee && !ownedByShadowUser) {
        return errorResult(
          `memory_update: cannot update another user's memory (page is owned by a different user or employee)`,
        );
      }
    } else if (
      page.agent_employee_id !== null &&
      page.agent_employee_id !== ctx.employee_id
    ) {
      return errorResult(
        `memory_update: cannot update another employee's memory (page is owned by a different employee)`,
      );
    }

    const isPromotion = args.patch.scope === 'org' && page.scope !== 'org';
    if (isPromotion && !shouldAutoExecute('memory_update', ctx.trust_level, args)) {
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
          channel_event_id: ctx.channel_event_id,
          runtime_request_key: ctx.runtime_request_key,
          source: 'mcp',
          action: 'memory_update',
          params: {
            ...args,
            _approval_guard: {
              page_id: page.id,
              version: page.version,
            },
          } as unknown as Record<string, unknown>,
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

    return executeMemoryUpdate(args, ctx);
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
