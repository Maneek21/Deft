import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db.js';
import {
  agentActions,
  agentEmployees,
  messages,
  spaces,
  spaceMembers,
  wikiCitations,
  wikiOpsLog,
  wikiPageVersions,
  wikiPages,
} from '@deft/db/schema';
import type { ToolContext, ToolResult } from './types.js';
import { errorResult, textResult } from './types.js';
import {
  asPseudoResult,
  getApprovalTier,
  shouldAutoExecute,
} from '../agent-approval.js';
import { invalidatePlatformContextCacheFor } from './context.js';
import { generateReceipt } from '../receipts.js';
import { enqueue, QUEUE_NAMES } from '../queues.js';

const VALID_WIKI_TYPES = new Set([
  'concept',
  'entity',
  'decision',
  'resource',
  'procedure',
  'preference',
  'fact',
]);
const VALID_SCOPES = new Set(['org', 'space', 'user']);

export type WikiCreateArgs = {
  caller_employee_slug: string;
  title: string;
  content: string;
  type?: string;
  summary?: string | null;
  scope?: string;
  space_id?: string | null;
  source_message_id?: string | null;
  source_space_id?: string | null;
  source_user_id?: string | null;
  capture_kind?: string | null;
  capture_reason?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown> | null;
};

async function getShadowUserId(employeeId: string): Promise<string | null> {
  const [row] = await db
    .select({ user_id: agentEmployees.user_id })
    .from(agentEmployees)
    .where(eq(agentEmployees.id, employeeId))
    .limit(1);
  return row?.user_id ?? null;
}

async function verifySpaceInOrg(spaceId: string, orgId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(
      eq(spaces.id, spaceId),
      eq(spaces.org_id, orgId),
      eq(spaces.is_archived, false),
    ))
    .limit(1);
  return !!row;
}

async function verifyMessageVisibleToUser(
  messageId: string,
  userId: string,
  orgId: string,
  expectedSpaceId?: string | null,
): Promise<{ id: string; space_id: string; content: string } | null> {
  const [row] = await db
    .select({
      id: messages.id,
      space_id: messages.space_id,
      content: messages.content,
    })
    .from(messages)
    .innerJoin(spaceMembers, and(
      eq(spaceMembers.space_id, messages.space_id),
      eq(spaceMembers.user_id, userId),
    ))
    .innerJoin(spaces, and(
      eq(spaces.id, messages.space_id),
      eq(spaces.org_id, orgId),
      eq(spaces.is_archived, false),
    ))
    .where(and(
      eq(messages.id, messageId),
      eq(messages.org_id, orgId),
      eq(messages.is_deleted, false),
      expectedSpaceId ? eq(messages.space_id, expectedSpaceId) : sql`TRUE`,
    ))
    .limit(1);
  return row ?? null;
}

function stripHtml(input: string): string {
  return input
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

async function uniqueSlug(orgId: string, title: string): Promise<string> {
  const base = slugify(title) || `knowledge-${Date.now().toString(36)}`;
  const [existing] = await db
    .select({ id: wikiPages.id })
    .from(wikiPages)
    .where(and(eq(wikiPages.org_id, orgId), eq(wikiPages.slug, base)))
    .limit(1);
  if (!existing) return base;
  return `${base}-${Date.now().toString(36)}`;
}

async function insertAutoExecActionRow(
  actionName: 'wiki_create' | 'wiki_update',
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string | null> {
  try {
    const shadowUserId = await getShadowUserId(ctx.employee_id);
    if (!shadowUserId) return null;
    const now = new Date();
    const [row] = await db
      .insert(agentActions)
      .values({
        org_id: ctx.org_id,
        user_id: shadowUserId,
        agent_employee_id: ctx.employee_id,
        source: 'mcp',
        action: actionName,
        params: args,
        approval_tier: getApprovalTier(actionName),
        approval_status: 'approved',
        approved_at: now,
        executed_at: now,
      })
      .returning({ id: agentActions.id });
    return row?.id ?? null;
  } catch (err) {
    console.error('[wiki] insertAutoExecActionRow failed:', err);
    return null;
  }
}

async function patchActionResult(actionId: string | null, result: unknown): Promise<void> {
  if (!actionId) return;
  try {
    await db
      .update(agentActions)
      .set({ result: result as any })
      .where(eq(agentActions.id, actionId));
  } catch (err) {
    console.error('[wiki-create] patchActionResult failed:', err);
  }
}

export async function executeWikiCreate(
  args: WikiCreateArgs,
  ctx: ToolContext,
  opts?: {
    skipReceipt?: boolean;
    actionId?: string | null;
    sourceReaderUserId?: string | null;
  },
): Promise<ToolResult> {
  const title = stripHtml(args.title ?? '').slice(0, 160);
  const content = String(args.content ?? '').trim();
  if (!title) return errorResult('wiki_create requires title');
  if (!content) return errorResult('wiki_create requires content');

  try {
    const shadowUserId = await getShadowUserId(ctx.employee_id);
    if (!shadowUserId) {
      return errorResult(`wiki_create: no shadow user for employee ${ctx.employee_id}`);
    }

    const wikiType = VALID_WIKI_TYPES.has(args.type ?? '')
      ? args.type as 'concept' | 'entity' | 'decision' | 'resource' | 'procedure' | 'preference' | 'fact'
      : 'fact';
    const scope = VALID_SCOPES.has(args.scope ?? '')
      ? args.scope as 'org' | 'space' | 'user'
      : 'org';

    let sourceMessageExcerpt: string | null = null;
    let sourceSpaceId = args.source_space_id ?? args.space_id ?? null;
    if (sourceSpaceId && !(await verifySpaceInOrg(sourceSpaceId, ctx.org_id))) {
      return errorResult(`wiki_create: source space ${sourceSpaceId} not found in caller's org`);
    }
    if (args.source_message_id?.trim()) {
      const readerIds = [
        shadowUserId,
        opts?.sourceReaderUserId ?? null,
        args.source_user_id ?? null,
      ].filter((value, index, values): value is string =>
        typeof value === 'string' && value.length > 0 && values.indexOf(value) === index,
      );
      let source: { id: string; space_id: string; content: string } | null = null;
      for (const readerId of readerIds) {
        source = await verifyMessageVisibleToUser(
          args.source_message_id,
          readerId,
          ctx.org_id,
          sourceSpaceId,
        );
        if (source) break;
      }
      if (!source) {
        return errorResult(
          `wiki_create: source_message_id ${args.source_message_id} is not readable in caller's org`,
        );
      }
      sourceSpaceId = source.space_id;
      sourceMessageExcerpt = stripHtml(source.content).slice(0, 200);
    }

    const slug = await uniqueSlug(ctx.org_id, title);
    const tags = Array.isArray(args.tags)
      ? args.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0).slice(0, 10)
      : [];
    const metadata = {
      ...(args.metadata && typeof args.metadata === 'object' ? args.metadata : {}),
      created_via: 'wiki_create',
      source_message_id: args.source_message_id ?? null,
      source_space_id: sourceSpaceId,
      capture_kind: args.capture_kind ?? null,
      capture_reason: args.capture_reason ?? null,
    };

    const page = await db.transaction(async (tx) => {
      const [insertedPage] = await tx
        .insert(wikiPages)
        .values({
          org_id: ctx.org_id,
          scope,
          space_id: sourceSpaceId,
          user_id: shadowUserId,
          agent_employee_id: ctx.employee_id,
          type: wikiType,
          title,
          slug,
          summary: args.summary?.trim() || stripHtml(content).slice(0, 240),
          content,
          metadata,
          confidence: 0.9,
          tags,
        })
        .returning();

      if (!insertedPage) throw new Error('wiki_create: insert returned no row');

      if (args.source_message_id) {
        await tx.insert(wikiCitations).values({
          page_id: insertedPage.id,
          source_type: 'message',
          source_id: args.source_message_id,
          excerpt: sourceMessageExcerpt ?? stripHtml(content).slice(0, 200),
        });
      }

      await tx.insert(wikiOpsLog).values({
        org_id: ctx.org_id,
        operation: 'create',
        page_id: insertedPage.id,
        details: {
          source_message_id: args.source_message_id ?? null,
          source_space_id: sourceSpaceId,
          capture_kind: args.capture_kind ?? null,
          action_id: opts?.actionId ?? null,
        },
        performed_by: shadowUserId,
      });

      await tx.execute(sql`
        UPDATE wiki_pages SET search_vector =
          setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
          setweight(to_tsvector('english', COALESCE(summary, '')), 'B') ||
          setweight(to_tsvector('english', COALESCE(content, '')), 'C')
        WHERE id = ${insertedPage.id}
      `);

      return insertedPage;
    });

    try {
      const { getIO } = await import('../../socket.js');
      const io = getIO();
      if (io && sourceSpaceId) {
        io.to(`space:${sourceSpaceId}`).emit('knowledge:created', {
          id: page.id,
          type: page.type,
          title: page.title,
          content: page.content,
          metadata: page.metadata ?? null,
          source_message_id: args.source_message_id ?? null,
          source_space_id: sourceSpaceId,
          space_id: page.space_id,
          created_by: page.user_id,
          created_at: page.created_at,
          updated_at: page.updated_at,
          author_name: null,
          author_avatar: null,
          slug: page.slug,
          scope: page.scope,
        });
      }
    } catch {
      // Best-effort in tests and workers.
    }

    try {
      await enqueue(QUEUE_NAMES.AGENT_JOBS, 'embed-content', {
        source_type: 'wiki_page',
        source_id: page.id,
      });
    } catch (err) {
      console.warn('[wiki-create] failed to enqueue embed-content:', err);
    }

    invalidatePlatformContextCacheFor(ctx.employee_id);

    const resultPayload = {
      page_id: page.id,
      slug: page.slug,
      title: page.title,
      type: page.type,
      scope: page.scope,
      source_message_id: args.source_message_id ?? null,
      source_space_id: sourceSpaceId,
      created_at: page.created_at,
    };

    if (!opts?.skipReceipt) {
      const actionId = await insertAutoExecActionRow('wiki_create', args as Record<string, unknown>, ctx);
      await patchActionResult(actionId, resultPayload);
      if (actionId) {
        await generateReceipt({
          actionId,
          orgId: ctx.org_id,
          employeeId: ctx.employee_id,
          proposer: 'employee',
          proposerId: ctx.employee_id,
          decision: 'auto_executed',
          actionName: 'wiki_create',
          actionParams: args as unknown,
          resultJson: resultPayload,
        });
      }
    }

    return textResult(resultPayload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`wiki_create failed: ${msg}`);
  }
}

async function queueAction(
  actionName: 'wiki_create' | 'wiki_update',
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const shadowUserId = await getShadowUserId(ctx.employee_id);
  if (!shadowUserId) {
    return errorResult(`wiki_create: no shadow user for employee ${ctx.employee_id}`);
  }
  const [row] = await db
    .insert(agentActions)
    .values({
      org_id: ctx.org_id,
      user_id: shadowUserId,
      agent_employee_id: ctx.employee_id,
      source: 'mcp',
      action: actionName,
      params: args,
      approval_tier: getApprovalTier(actionName),
      approval_status: 'pending',
    })
    .returning({ id: agentActions.id });
  if (!row?.id) return errorResult('wiki_create: insert returned no row');
  return asPseudoResult(
    row.id,
    'Action requires human approval. Tell the user the knowledge change is pending review and will execute asynchronously if approved.',
  );
}

export async function wikiCreate(args: WikiCreateArgs, ctx: ToolContext): Promise<ToolResult> {
  if (!args.title?.trim()) return errorResult('wiki_create requires title');
  if (!args.content?.trim()) return errorResult('wiki_create requires content');

  if (!shouldAutoExecute('wiki_create', ctx.trust_level, args)) {
    return queueAction('wiki_create', args as unknown as Record<string, unknown>, ctx);
  }

  return executeWikiCreate(args, ctx);
}

export type WikiUpdateArgs = {
  caller_employee_slug: string;
  page_id?: string;
  slug?: string;
  patch: {
    title?: string;
    content?: string;
    summary?: string | null;
    type?: string;
    scope?: string;
    space_id?: string | null;
    confidence?: number;
    tags?: string[];
    metadata?: Record<string, unknown> | null;
  };
  source_message_id?: string | null;
  source_space_id?: string | null;
  source_user_id?: string | null;
  capture_reason?: string | null;
};

export async function executeWikiUpdate(
  args: WikiUpdateArgs,
  ctx: ToolContext,
  opts?: {
    skipReceipt?: boolean;
    actionId?: string | null;
    sourceReaderUserId?: string | null;
  },
): Promise<ToolResult> {
  if (!args.page_id && !args.slug?.trim()) {
    return errorResult('wiki_update requires page_id or slug');
  }
  if (!args.patch || Object.keys(args.patch).length === 0) {
    return errorResult('wiki_update requires a non-empty patch');
  }

  try {
    const shadowUserId = await getShadowUserId(ctx.employee_id);
    if (!shadowUserId) {
      return errorResult(`wiki_update: no shadow user for employee ${ctx.employee_id}`);
    }

    const [existingPage] = await db
      .select()
      .from(wikiPages)
      .where(and(
        eq(wikiPages.org_id, ctx.org_id),
        eq(wikiPages.is_deleted, false),
        args.page_id ? eq(wikiPages.id, args.page_id) : eq(wikiPages.slug, args.slug!.trim()),
      ))
      .limit(1);
    if (!existingPage) return errorResult('wiki_update: page not found');

    if (existingPage.scope === 'user') {
      const ownedByEmployee = existingPage.agent_employee_id === ctx.employee_id;
      const ownedByShadowUser = existingPage.user_id === shadowUserId;
      if (!ownedByEmployee && !ownedByShadowUser) {
        return errorResult('wiki_update: cannot update another user-scoped page');
      }
    }

    const patch = args.patch;
    const update: Record<string, unknown> = {};
    const changedFields: string[] = [];

    if (typeof patch.title === 'string') {
      const title = stripHtml(patch.title).slice(0, 160);
      if (!title) return errorResult('wiki_update: title cannot be empty');
      if (title !== existingPage.title) {
        update.title = title;
        changedFields.push('title');
      }
    }
    if (typeof patch.content === 'string') {
      const content = patch.content.trim();
      if (!content) return errorResult('wiki_update: content cannot be empty');
      if (content !== existingPage.content) {
        update.content = content;
        update.previous_content = existingPage.content;
        changedFields.push('content');
      }
    }
    if (patch.summary !== undefined) {
      const summary = patch.summary?.trim() || null;
      if (summary !== (existingPage.summary ?? null)) {
        update.summary = summary;
        changedFields.push('summary');
      }
    }
    if (patch.type !== undefined) {
      if (!VALID_WIKI_TYPES.has(patch.type)) return errorResult('wiki_update: invalid type');
      if (patch.type !== existingPage.type) {
        update.type = patch.type;
        changedFields.push('type');
      }
    }
    if (patch.scope !== undefined) {
      if (!VALID_SCOPES.has(patch.scope)) return errorResult('wiki_update: invalid scope');
      if (patch.scope !== existingPage.scope) {
        update.scope = patch.scope;
        changedFields.push('scope');
      }
    }
    if (patch.space_id !== undefined) {
      const spaceId = patch.space_id || null;
      if (spaceId && !(await verifySpaceInOrg(spaceId, ctx.org_id))) {
        return errorResult(`wiki_update: space ${spaceId} not found in caller's org`);
      }
      if (spaceId !== (existingPage.space_id ?? null)) {
        update.space_id = spaceId;
        changedFields.push('space_id');
      }
    }
    if (typeof patch.confidence === 'number') {
      const confidence = Math.max(0, Math.min(1, patch.confidence));
      if (confidence !== existingPage.confidence) {
        update.confidence = confidence;
        changedFields.push('confidence');
      }
    }
    if (Array.isArray(patch.tags)) {
      const tags = patch.tags
        .filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
        .map((tag) => tag.trim())
        .slice(0, 10);
      if (JSON.stringify(tags) !== JSON.stringify(existingPage.tags ?? [])) {
        update.tags = tags;
        changedFields.push('tags');
      }
    }
    if (patch.metadata && typeof patch.metadata === 'object') {
      update.metadata = {
        ...((existingPage.metadata as Record<string, unknown> | null) ?? {}),
        ...patch.metadata,
        updated_via: 'wiki_update',
      };
      changedFields.push('metadata');
    }

    if (changedFields.length === 0) {
      return errorResult('wiki_update: no valid changed fields in patch');
    }

    let sourceMessageExcerpt: string | null = null;
    let sourceSpaceId = args.source_space_id ?? existingPage.space_id ?? null;
    if (sourceSpaceId && !(await verifySpaceInOrg(sourceSpaceId, ctx.org_id))) {
      return errorResult(`wiki_update: source space ${sourceSpaceId} not found in caller's org`);
    }
    if (args.source_message_id?.trim()) {
      const readerIds = [
        shadowUserId,
        opts?.sourceReaderUserId ?? null,
        args.source_user_id ?? null,
      ].filter((value, index, values): value is string =>
        typeof value === 'string' && value.length > 0 && values.indexOf(value) === index,
      );
      let source: { id: string; space_id: string; content: string } | null = null;
      for (const readerId of readerIds) {
        source = await verifyMessageVisibleToUser(
          args.source_message_id,
          readerId,
          ctx.org_id,
          sourceSpaceId,
        );
        if (source) break;
      }
      if (!source) {
        return errorResult(
          `wiki_update: source_message_id ${args.source_message_id} is not readable in caller's org`,
        );
      }
      sourceSpaceId = source.space_id;
      sourceMessageExcerpt = stripHtml(source.content).slice(0, 200);
    }

    const nextVersion = (existingPage.version ?? 1) + 1;
    const page = await db.transaction(async (tx) => {
      await tx.insert(wikiPageVersions).values({
        page_id: existingPage.id,
        version: existingPage.version ?? 1,
        title: existingPage.title,
        content: existingPage.content,
        summary: existingPage.summary,
        edited_by: shadowUserId,
      }).onConflictDoNothing();

      const [updatedPage] = await tx
        .update(wikiPages)
        .set({
          ...update,
          version: nextVersion,
          updated_at: new Date(),
        })
        .where(and(eq(wikiPages.id, existingPage.id), eq(wikiPages.org_id, ctx.org_id)))
        .returning();
      if (!updatedPage) throw new Error('wiki_update: update returned no row');

      if (args.source_message_id) {
        await tx.insert(wikiCitations).values({
          page_id: updatedPage.id,
          source_type: 'message',
          source_id: args.source_message_id,
          excerpt: sourceMessageExcerpt ?? stripHtml(updatedPage.content).slice(0, 200),
        });
      }

      await tx.insert(wikiOpsLog).values({
        org_id: ctx.org_id,
        operation: 'update',
        page_id: updatedPage.id,
        details: {
          changed_fields: changedFields,
          previous_version: existingPage.version ?? 1,
          version: nextVersion,
          source_message_id: args.source_message_id ?? null,
          source_space_id: sourceSpaceId,
          action_id: opts?.actionId ?? null,
          capture_reason: args.capture_reason ?? null,
        },
        performed_by: shadowUserId,
      });

      await tx.execute(sql`
        UPDATE wiki_pages SET search_vector =
          setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
          setweight(to_tsvector('english', COALESCE(summary, '')), 'B') ||
          setweight(to_tsvector('english', COALESCE(content, '')), 'C')
        WHERE id = ${updatedPage.id}
      `);

      return updatedPage;
    });

    try {
      await enqueue(QUEUE_NAMES.AGENT_JOBS, 'embed-content', {
        source_type: 'wiki_page',
        source_id: page.id,
      });
    } catch (err) {
      console.warn('[wiki-update] failed to enqueue embed-content:', err);
    }

    invalidatePlatformContextCacheFor(ctx.employee_id);

    const resultPayload = {
      page_id: page.id,
      slug: page.slug,
      title: page.title,
      type: page.type,
      scope: page.scope,
      version: page.version,
      changed_fields: changedFields,
      source_message_id: args.source_message_id ?? null,
      updated_at: page.updated_at,
    };

    if (!opts?.skipReceipt) {
      const actionId = await insertAutoExecActionRow('wiki_update', args as Record<string, unknown>, ctx);
      await patchActionResult(actionId, resultPayload);
      if (actionId) {
        await generateReceipt({
          actionId,
          orgId: ctx.org_id,
          employeeId: ctx.employee_id,
          proposer: 'employee',
          proposerId: ctx.employee_id,
          decision: 'auto_executed',
          actionName: 'wiki_update',
          actionParams: args as unknown,
          resultJson: resultPayload,
        });
      }
    }

    return textResult(resultPayload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`wiki_update failed: ${msg}`);
  }
}

export async function wikiUpdate(args: WikiUpdateArgs, ctx: ToolContext): Promise<ToolResult> {
  if (!args.page_id && !args.slug?.trim()) return errorResult('wiki_update requires page_id or slug');
  if (!args.patch || Object.keys(args.patch).length === 0) {
    return errorResult('wiki_update requires a non-empty patch');
  }

  if (!shouldAutoExecute('wiki_update', ctx.trust_level, args)) {
    return queueAction('wiki_update', args as unknown as Record<string, unknown>, ctx);
  }

  return executeWikiUpdate(args, ctx);
}
