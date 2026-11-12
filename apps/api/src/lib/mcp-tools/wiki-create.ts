import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db.js';
import { employeeMentionWriteError } from './native-mention-write-guard.js';
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
import { employeeCanAccessSpace } from './employee-space-access.js';
import { generateReceipt } from '../receipts.js';
import { enqueue, QUEUE_NAMES } from '../queues.js';
import { toPlainText } from '../plain-text.js';
import {
  readFrozenTarget,
  revisionDigest,
  TARGET_KEY,
  WIKI_PAGE_CHANGED_ERROR,
  WIKI_PAGE_NOT_CREATED_ERROR,
  WIKI_PAGE_UNAVAILABLE_ERROR,
  WIKI_PROPOSAL_UNVERIFIABLE_ERROR,
  type FrozenWikiTarget,
} from '../wiki-proposal-target.js';

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

type Executor = Pick<typeof db, 'select'>;

async function getShadowUserId(employeeId: string, executor: Executor = db): Promise<string | null> {
  const [row] = await executor
    .select({ user_id: agentEmployees.user_id })
    .from(agentEmployees)
    .where(eq(agentEmployees.id, employeeId))
    .limit(1);
  return row?.user_id ?? null;
}

async function verifyMessageVisibleToUser(
  messageId: string,
  userId: string,
  orgId: string,
  expectedSpaceId?: string | null,
  executor: Executor = db,
): Promise<{ id: string; space_id: string; user_id: string; content: string } | null> {
  const [row] = await executor
    .select({
      id: messages.id,
      space_id: messages.space_id,
      user_id: messages.user_id,
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

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

async function uniqueSlug(orgId: string, title: string, executor: Executor = db): Promise<string> {
  const base = slugify(title) || `knowledge-${Date.now().toString(36)}`;
  const [existing] = await executor
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
        channel_event_id: ctx.channel_event_id,
        runtime_request_key: ctx.runtime_request_key,
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
  const title = toPlainText(args.title ?? '').slice(0, 160);
  const content = String(args.content ?? '').trim();
  if (!title) return errorResult('wiki_create requires title');
  if (!content) return errorResult('wiki_create requires content');
  const referenceError = await employeeMentionWriteError('wiki_create', args, ctx);
  if (referenceError) return errorResult(referenceError);

  try {
    const shadowUserId = await getShadowUserId(ctx.employee_id);
    if (!shadowUserId) {
      return errorResult(`wiki_create: no shadow user for employee ${ctx.employee_id}`);
    }

    // An approved proposal creates the page at the slug fixed when it was
    // proposed, or not at all.
    let frozenSlug: string | null = null;
    if (opts?.actionId) {
      const [row] = await db
        .select({ action: agentActions.action, before_state: agentActions.before_state })
        .from(agentActions)
        .where(and(eq(agentActions.id, opts.actionId), eq(agentActions.org_id, ctx.org_id)))
        .limit(1);
      const target = row?.action === 'wiki_create' ? readFrozenTarget(row.before_state) : null;
      if (!target || target.mode !== 'create' || !target.slug) return errorResult(WIKI_PROPOSAL_UNVERIFIABLE_ERROR);
      frozenSlug = target.slug;
    }

    const wikiType = VALID_WIKI_TYPES.has(args.type ?? '')
      ? args.type as 'concept' | 'entity' | 'decision' | 'resource' | 'procedure' | 'preference' | 'fact'
      : 'fact';
    const scope = VALID_SCOPES.has(args.scope ?? '')
      ? args.scope as 'org' | 'space' | 'user'
      : 'org';
    const tags = Array.isArray(args.tags)
      ? args.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0).slice(0, 10)
      : [];

    // Access checks and the insert share one transaction. Lock order: the
    // spaces and memberships that grant access (FOR SHARE), then the new rows.
    const { page, sourceSpaceId } = await db.transaction(async (tx) => {
      const canAccessSpace = (spaceId: string) =>
        employeeCanAccessSpace(ctx.employee_id, ctx.org_id, spaceId, { executor: tx, lock: true });

      let sourceMessageExcerpt: string | null = null;
      let sourceSpaceId = args.source_space_id ?? args.space_id ?? null;
      let sourceUserId: string | null = null;
      if (sourceSpaceId && !(await canAccessSpace(sourceSpaceId))) {
        throw new WikiUpdateRefusal(frozenSlug ? errorResult(WIKI_PAGE_NOT_CREATED_ERROR) : wikiTargetUnavailableResult('wiki_create'));
      }
      if (scope === 'space' && !sourceSpaceId) {
        refuse('wiki_create: space_id or source_space_id is required when scope is space');
      }
      if (args.source_message_id?.trim()) {
        const readerIds = [
          shadowUserId,
          opts?.sourceReaderUserId ?? null,
          args.source_user_id ?? null,
        ].filter((value, index, values): value is string =>
          typeof value === 'string' && value.length > 0 && values.indexOf(value) === index,
        );
        let source: { id: string; space_id: string; user_id: string; content: string } | null = null;
        for (const readerId of readerIds) {
          source = await verifyMessageVisibleToUser(
            args.source_message_id,
            readerId,
            ctx.org_id,
            sourceSpaceId,
            tx,
          );
          if (source) break;
        }
        if (!source) {
          refuse(`wiki_create: source_message_id ${args.source_message_id} is not readable in caller's org`);
        }
        sourceSpaceId = source.space_id;
        if (!(await canAccessSpace(sourceSpaceId))) {
          refuse(`wiki_create: source message space ${sourceSpaceId} is not accessible to this employee`);
        }
        sourceUserId = source.user_id;
        sourceMessageExcerpt = toPlainText(source.content).slice(0, 200);
      }
      sourceUserId = sourceUserId ?? shadowUserId;

      const metadata = {
        ...(args.metadata && typeof args.metadata === 'object' ? args.metadata : {}),
        created_via: 'wiki_create',
        source_message_id: args.source_message_id ?? null,
        source_space_id: sourceSpaceId,
        source_user_id: sourceUserId,
        capture_kind: args.capture_kind ?? null,
        capture_reason: args.capture_reason ?? null,
      };

      // A slug held by any page in this org, deleted ones included, creates nothing.
      const [insertedPage] = await tx
        .insert(wikiPages)
        .values({
          org_id: ctx.org_id,
          scope,
          space_id: scope === 'space' ? sourceSpaceId : null,
          origin_space_id: sourceSpaceId,
          origin_message_id: args.source_message_id ?? null,
          origin_user_id: sourceUserId,
          created_via: 'wiki_create',
          user_id: shadowUserId,
          agent_employee_id: ctx.employee_id,
          type: wikiType,
          title,
          slug: frozenSlug ?? await uniqueSlug(ctx.org_id, title, tx),
          summary: args.summary?.trim() || toPlainText(content).slice(0, 240),
          content,
          metadata,
          confidence: 0.9,
          tags,
        })
        .onConflictDoNothing({ target: [wikiPages.org_id, wikiPages.slug] })
        .returning();

      if (!insertedPage) refuse(WIKI_PAGE_NOT_CREATED_ERROR);

      if (args.source_message_id) {
        await tx.insert(wikiCitations).values({
          org_id: ctx.org_id,
          page_id: insertedPage.id,
          source_type: 'message',
          source_id: args.source_message_id,
          source_space_id: sourceSpaceId,
          source_user_id: sourceUserId,
          excerpt: sourceMessageExcerpt ?? toPlainText(content).slice(0, 200),
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

      return { page: insertedPage, sourceSpaceId };
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
          origin_space_id: page.origin_space_id ?? null,
          origin_message_id: page.origin_message_id ?? null,
          origin_user_id: page.origin_user_id ?? null,
          created_via: page.created_via ?? null,
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
    if (err instanceof WikiUpdateRefusal) return err.result;
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`wiki_create failed: ${msg}`);
  }
}

/**
 * The target to freeze into a new pending `wiki_create` row: the slug the page
 * will be created at, chosen once here and never recomputed. Null when the
 * employee cannot reach the space the page would be created in; the proposal
 * is then refused with `wikiTargetUnavailableResult('wiki_create')`.
 */
export async function wikiCreateProposalTarget(
  args: { title?: unknown; space_id?: unknown; source_space_id?: unknown },
  orgId: string,
  employeeId: string,
  executor: Executor = db,
): Promise<{ values: { before_state: { [TARGET_KEY]: FrozenWikiTarget } } } | null> {
  if (!(await getShadowUserId(employeeId, executor))) return null;
  const spaceId = args.source_space_id ?? args.space_id ?? null;
  if (spaceId && (typeof spaceId !== 'string'
    || !(await employeeCanAccessSpace(employeeId, orgId, spaceId, { executor })))) {
    return null;
  }
  const title = toPlainText(typeof args.title === 'string' ? args.title : '').slice(0, 160);
  const slug = await uniqueSlug(orgId, title, executor);
  return { values: { before_state: { [TARGET_KEY]: { v: 1, mode: 'create', slug } } } };
}

async function queueAction(
  actionName: 'wiki_create' | 'wiki_update',
  args: Record<string, unknown>,
  ctx: ToolContext,
  frozen: { values: { before_state: { [TARGET_KEY]: FrozenWikiTarget } } } | null = null,
): Promise<ToolResult> {
  const shadowUserId = await getShadowUserId(ctx.employee_id);
  if (!shadowUserId) {
    return errorResult(`wiki_create: no shadow user for employee ${ctx.employee_id}`);
  }
  const [row] = await db
    .insert(agentActions)
    .values({
      ...(frozen ? frozen.values : {}),
      org_id: ctx.org_id,
      user_id: shadowUserId,
      agent_employee_id: ctx.employee_id,
      channel_event_id: ctx.channel_event_id,
      runtime_request_key: ctx.runtime_request_key,
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
    const frozen = await wikiCreateProposalTarget(args, ctx.org_id, ctx.employee_id);
    if (!frozen) return wikiTargetUnavailableResult('wiki_create');
    return queueAction('wiki_create', args as unknown as Record<string, unknown>, ctx, frozen);
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
  /** When set, the update applies only if the page is still at this version. */
  expected_version?: number | null;
};

export const WIKI_TARGET_UNAVAILABLE_CODE = 'WIKI_TARGET_UNAVAILABLE';
/** The one answer for a page this employee cannot update, whatever the reason. */
export const WIKI_TARGET_UNAVAILABLE_ERROR =
  'WIKI_TARGET_UNAVAILABLE: wiki_update: page not found or not available to this employee';
/** The one answer for a space this employee cannot create a page in, whatever the reason. */
export const WIKI_CREATE_TARGET_UNAVAILABLE_ERROR =
  'WIKI_TARGET_UNAVAILABLE: wiki_create: the target space is not available to this employee';

export function wikiTargetUnavailableResult(action: 'wiki_update' | 'wiki_create' = 'wiki_update'): ToolResult {
  const error = action === 'wiki_create' ? WIKI_CREATE_TARGET_UNAVAILABLE_ERROR : WIKI_TARGET_UNAVAILABLE_ERROR;
  return {
    ...errorResult(error),
    structuredContent: { code: WIKI_TARGET_UNAVAILABLE_CODE, error },
  };
}

type WikiPageRow = typeof wikiPages.$inferSelect;

/**
 * The page named by `page_id` (or else `slug`) in this org, not deleted.
 * When both are given they must name the same page. With `lock`, the row is
 * read FOR NO KEY UPDATE, the lock every wiki page writer takes.
 */
async function findWikiUpdateTarget(
  executor: Executor,
  orgId: string,
  ref: { page_id?: unknown; slug?: unknown },
  lock: boolean,
): Promise<WikiPageRow | null> {
  const pageId = typeof ref.page_id === 'string' && ref.page_id ? ref.page_id : null;
  const slug = typeof ref.slug === 'string' && ref.slug.trim() ? ref.slug.trim() : null;
  if (!pageId && !slug) return null;
  const query = executor
    .select()
    .from(wikiPages)
    .where(and(eq(wikiPages.org_id, orgId), pageId ? eq(wikiPages.id, pageId) : eq(wikiPages.slug, slug!)))
    .limit(1);
  const [page] = lock ? await query.for('no key update') : await query;
  if (!page || page.is_deleted) return null;
  if (pageId && slug && page.slug !== slug) return null;
  return page;
}

/** Whether this employee may update the page: the same rule at proposal and at execution. */
async function employeeCanWriteWikiPage(
  executor: Executor,
  page: WikiPageRow,
  ctx: Pick<ToolContext, 'org_id' | 'employee_id'>,
  shadowUserId: string,
  lock: boolean,
): Promise<boolean> {
  if (page.scope === 'user') {
    return page.agent_employee_id === ctx.employee_id || page.user_id === shadowUserId;
  }
  if (page.scope === 'space' && page.space_id) {
    return employeeCanAccessSpace(ctx.employee_id, ctx.org_id, page.space_id, { executor, lock });
  }
  return true;
}

/**
 * Digest over the current values of every column this patch writes, plus the
 * columns a write is derived from (the page's space and origin columns supply
 * the source space and fill empty origins).
 */
function wikiUpdateRevision(page: WikiPageRow, patch: WikiUpdateArgs['patch']): string {
  const fields: Record<string, unknown> = {
    space_id: page.space_id,
    origin_space_id: page.origin_space_id,
    origin_message_id: page.origin_message_id,
    origin_user_id: page.origin_user_id,
  };
  if (typeof patch.title === 'string') fields.title = page.title;
  if (typeof patch.content === 'string') fields.content = page.content;
  if (patch.summary !== undefined) fields.summary = page.summary;
  if (patch.type !== undefined) fields.type = page.type;
  if (patch.scope !== undefined) fields.scope = page.scope;
  if (typeof patch.confidence === 'number') fields.confidence = page.confidence;
  if (Array.isArray(patch.tags)) fields.tags = page.tags;
  if (patch.metadata && typeof patch.metadata === 'object') fields.metadata = page.metadata;
  return revisionDigest(fields);
}

/**
 * The target to freeze into a new pending `wiki_update` row: the page this
 * employee may update and the revision of the fields the patch depends on.
 * Null when the employee cannot reach the page; the proposal is then refused
 * with `wikiTargetUnavailableResult()`.
 */
export async function wikiUpdateProposalTarget(
  args: { page_id?: unknown; slug?: unknown; patch?: unknown },
  orgId: string,
  employeeId: string,
  executor: Executor = db,
): Promise<{ page: WikiPageRow; values: { before_state: { [TARGET_KEY]: FrozenWikiTarget } } } | null> {
  const patch = args.patch && typeof args.patch === 'object' && !Array.isArray(args.patch)
    ? args.patch as WikiUpdateArgs['patch']
    : {};
  const shadowUserId = await getShadowUserId(employeeId, executor);
  if (!shadowUserId) return null;
  const page = await findWikiUpdateTarget(executor, orgId, args, false);
  if (!page || !(await employeeCanWriteWikiPage(executor, page, { org_id: orgId, employee_id: employeeId }, shadowUserId, false))) {
    return null;
  }
  return {
    page,
    values: {
      before_state: {
        [TARGET_KEY]: { v: 1, mode: 'update', slug: page.slug, page_id: page.id, revision: wikiUpdateRevision(page, patch) },
      },
    },
  };
}

class WikiUpdateRefusal extends Error {
  constructor(readonly result: ToolResult) {
    super(result.content[0]?.text ?? 'wiki_update refused');
  }
}

function refuse(message: string): never {
  throw new WikiUpdateRefusal(errorResult(message));
}

type UpdateTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
let updateRevisionCheckedHook: ((tx: UpdateTransaction) => Promise<void>) | null = null;

/** Test seam: runs inside the update, after the page and access checks and before any change. */
export function _setWikiUpdateRevisionCheckedHookForTest(hook: ((tx: UpdateTransaction) => Promise<void>) | null): void {
  updateRevisionCheckedHook = hook;
}

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
  const referenceError = await employeeMentionWriteError('wiki_update', args, ctx);
  if (referenceError) return errorResult(referenceError);

  try {
    // An approved proposal applies only to the page revision frozen when it
    // was proposed; anything else ends the approval with a refusal.
    let frozen: { page_id: string; slug: string; revision: string } | null = null;
    if (opts?.actionId) {
      const [row] = await db
        .select({ action: agentActions.action, before_state: agentActions.before_state })
        .from(agentActions)
        .where(and(eq(agentActions.id, opts.actionId), eq(agentActions.org_id, ctx.org_id)))
        .limit(1);
      const target = row?.action === 'wiki_update' ? readFrozenTarget(row.before_state) : null;
      if (!target || target.mode !== 'update') return errorResult(WIKI_PROPOSAL_UNVERIFIABLE_ERROR);
      if (!target.page_id || !target.revision) return errorResult(WIKI_PAGE_UNAVAILABLE_ERROR);
      if ((args.page_id && args.page_id !== target.page_id) || (args.slug?.trim() && args.slug.trim() !== target.slug)) {
        return errorResult(WIKI_PROPOSAL_UNVERIFIABLE_ERROR);
      }
      frozen = { page_id: target.page_id, slug: target.slug, revision: target.revision };
    }

    const shadowUserId = await getShadowUserId(ctx.employee_id);
    if (!shadowUserId) {
      return errorResult(`wiki_update: no shadow user for employee ${ctx.employee_id}`);
    }

    // Lock order: the page row, then the spaces and memberships that grant
    // access (FOR SHARE), then the rows this write inserts.
    // A page the employee cannot reach is refused before any lock is taken,
    // so the answer never waits on activity on that page.
    if (!frozen && !(await wikiUpdateProposalTarget(args, ctx.org_id, ctx.employee_id))) {
      return wikiTargetUnavailableResult();
    }

    const { page, changedFields } = await db.transaction(async (tx) => {
      const existingPage = await findWikiUpdateTarget(tx, ctx.org_id, frozen ?? args, true);
      if (!existingPage || !(await employeeCanWriteWikiPage(tx, existingPage, ctx, shadowUserId, true))) {
        throw new WikiUpdateRefusal(frozen ? errorResult(WIKI_PAGE_UNAVAILABLE_ERROR) : wikiTargetUnavailableResult());
      }
      if (frozen && wikiUpdateRevision(existingPage, args.patch) !== frozen.revision) {
        refuse(WIKI_PAGE_CHANGED_ERROR);
      }
      if (updateRevisionCheckedHook) await updateRevisionCheckedHook(tx);
      const expectedVersion = typeof args.expected_version === 'number' ? args.expected_version : null;
      if (expectedVersion !== null && (existingPage.version ?? 1) !== expectedVersion) {
        refuse('wiki_update: page changed since this update was drafted; capture it again against the current page');
      }
      const canAccessSpace = (spaceId: string) =>
        employeeCanAccessSpace(ctx.employee_id, ctx.org_id, spaceId, { executor: tx, lock: true });

      const patch = args.patch;
      const update: Record<string, unknown> = {};
      const changedFields: string[] = [];

      if (typeof patch.title === 'string') {
        const title = toPlainText(patch.title).slice(0, 160);
        if (!title) refuse('wiki_update: title cannot be empty');
        if (title !== existingPage.title) {
          update.title = title;
          changedFields.push('title');
        }
      }
      if (typeof patch.content === 'string') {
        const content = patch.content.trim();
        if (!content) refuse('wiki_update: content cannot be empty');
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
        if (!VALID_WIKI_TYPES.has(patch.type)) refuse('wiki_update: invalid type');
        if (patch.type !== existingPage.type) {
          update.type = patch.type;
          changedFields.push('type');
        }
      }
      if (patch.scope !== undefined) {
        if (!VALID_SCOPES.has(patch.scope)) refuse('wiki_update: invalid scope');
        if (patch.scope !== existingPage.scope) {
          update.scope = patch.scope;
          changedFields.push('scope');
        }
      }
      if (patch.space_id !== undefined) {
        const spaceId = patch.space_id || null;
        if (spaceId && !(await canAccessSpace(spaceId))) {
          refuse(`wiki_update: space ${spaceId} is not accessible to this employee`);
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
        refuse('wiki_update: no valid changed fields in patch');
      }

      let sourceMessageExcerpt: string | null = null;
      let sourceSpaceId = args.source_space_id ?? existingPage.origin_space_id ?? existingPage.space_id ?? null;
      let sourceUserId: string | null = null;
      if (sourceSpaceId && !(await canAccessSpace(sourceSpaceId))) {
        refuse(`wiki_update: source space ${sourceSpaceId} is not accessible to this employee`);
      }
      if (args.source_message_id?.trim()) {
        const readerIds = [
          shadowUserId,
          opts?.sourceReaderUserId ?? null,
          args.source_user_id ?? null,
        ].filter((value, index, values): value is string =>
          typeof value === 'string' && value.length > 0 && values.indexOf(value) === index,
        );
        let source: { id: string; space_id: string; user_id: string; content: string } | null = null;
        for (const readerId of readerIds) {
          source = await verifyMessageVisibleToUser(
            args.source_message_id,
            readerId,
            ctx.org_id,
            sourceSpaceId,
            tx,
          );
          if (source) break;
        }
        if (!source) {
          refuse(`wiki_update: source_message_id ${args.source_message_id} is not readable in caller's org`);
        }
        sourceSpaceId = source.space_id;
        if (!(await canAccessSpace(sourceSpaceId))) {
          refuse(`wiki_update: source message space ${sourceSpaceId} is not accessible to this employee`);
        }
        sourceUserId = source.user_id;
        sourceMessageExcerpt = toPlainText(source.content).slice(0, 200);
      }
      sourceUserId = sourceUserId ?? shadowUserId;

      if (!existingPage.origin_space_id && sourceSpaceId) {
        update.origin_space_id = sourceSpaceId;
        changedFields.push('origin_space_id');
      }
      if (!existingPage.origin_message_id && args.source_message_id) {
        update.origin_message_id = args.source_message_id;
        changedFields.push('origin_message_id');
      }
      if (!existingPage.origin_user_id && sourceUserId) {
        update.origin_user_id = sourceUserId;
        changedFields.push('origin_user_id');
      }

      const nextVersion = (existingPage.version ?? 1) + 1;
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
        .where(and(
          eq(wikiPages.id, existingPage.id),
          eq(wikiPages.org_id, ctx.org_id),
          ...(expectedVersion !== null ? [eq(wikiPages.version, expectedVersion)] : []),
        ))
        .returning();
      if (!updatedPage) throw new Error('wiki_update: update returned no row');

      if (args.source_message_id) {
        await tx.insert(wikiCitations).values({
          org_id: ctx.org_id,
          page_id: updatedPage.id,
          source_type: 'message',
          source_id: args.source_message_id,
          source_space_id: sourceSpaceId,
          source_user_id: sourceUserId,
          excerpt: sourceMessageExcerpt ?? toPlainText(updatedPage.content).slice(0, 200),
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

      return { page: updatedPage, changedFields };
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
    if (err instanceof WikiUpdateRefusal) return err.result;
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
    const frozen = await wikiUpdateProposalTarget(args, ctx.org_id, ctx.employee_id);
    if (!frozen) return wikiTargetUnavailableResult();
    return queueAction('wiki_update', args as unknown as Record<string, unknown>, ctx, frozen);
  }

  return executeWikiUpdate(args, ctx);
}
