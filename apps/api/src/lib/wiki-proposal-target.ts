/**
 * A `wiki_write` action applies only to the page revision it was proposed
 * against.
 *
 * When the action row is created, the server records in the row's
 * `before_state` (a column callers never write) the target the requester
 * may see: the page id and a revision digest over exactly the fields the
 * action will write (title, summary, type, content, outgoing related links),
 * or, for a new page, that no page holds the slug yet. Params never carry
 * this target: a page id or digest in params is ignored.
 *
 * At execution the page row is locked, the requester's access is checked
 * again for that exact page, and the digest is recomputed. The write, its
 * version row, its related links and its ops log entry commit together, and
 * only when the digest still matches. Otherwise the action fails for good
 * with a "changed since proposed" message that asks for a new proposal.
 */
import { createHash } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  agentActions,
  wikiLinks,
  wikiOpsLog,
  wikiPages,
  wikiPageVersions,
} from '@deft/db/schema';
import { db } from './db.js';
import { logAuditEvent } from './audit.js';
import { visibleWikiPageCondition } from './wiki-visibility.js';

type Executor = Pick<typeof db, 'select'>;
type Params = Record<string, any>;

/** The key under `agent_actions.before_state` that holds the frozen target. */
const TARGET_KEY = 'wiki_proposal_target';

type FrozenWikiTarget =
  | { v: 1; mode: 'update'; slug: string; page_id: string | null; revision: string | null }
  | { v: 1; mode: 'create'; slug: string };

/** Marks an execution failure that must end the approval, never reopen it. */
export const TERMINAL_REFUSAL_RESULT = { terminal_refusal: true } as const;

export function isTerminalRefusalResult(result: unknown): boolean {
  return Boolean(result && typeof result === 'object' && !Array.isArray(result)
    && (result as Record<string, unknown>).terminal_refusal === true);
}

export const WIKI_PAGE_CHANGED_ERROR =
  'The wiki page changed after this update was proposed, so it was not applied. Review the current page and propose the update again.';
export const WIKI_PAGE_UNAVAILABLE_ERROR =
  'The wiki page this update was proposed for is no longer available to the requester, so it was not applied.';
export const WIKI_PAGE_EXISTS_ERROR =
  'A wiki page with this name was created after this page was proposed, so it was not created. Review that page and propose the change again.';
export const WIKI_PROPOSAL_UNVERIFIABLE_ERROR =
  'This wiki proposal does not record the page revision it was made against, so it was not applied. Ask for the update again.';

function refused(error: string) {
  return { success: false as const, result: { ...TERMINAL_REFUSAL_RESULT }, error };
}

function slugFromTitle(title: unknown): string {
  return typeof title === 'string'
    ? title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
    : '';
}

function existingSlugOf(params: Params): string | null {
  return typeof params.slug === 'string' && params.slug ? params.slug : null;
}

function writesRelatedLinks(params: Params): boolean {
  return Array.isArray(params.related_slugs) && params.related_slugs.length > 0;
}

/**
 * Digest over the current values of the fields this action writes. Fields
 * the action leaves alone (confidence, tags, embeddings, timestamps) do not
 * take part, so housekeeping such as wiki lint does not invalidate it.
 */
async function writtenFieldsRevision(
  executor: Executor,
  page: { id: string; title: string; summary: string | null; type: string; content: string },
  params: Params,
): Promise<string> {
  const fields: Record<string, unknown> = {};
  if (params.title) fields.title = page.title;
  if (params.summary) fields.summary = page.summary;
  if (params.type) fields.type = page.type;
  if (params.content) fields.content = page.content;
  if (writesRelatedLinks(params)) {
    fields.related = (await executor
      .select({ target: wikiLinks.target_page_id })
      .from(wikiLinks)
      .where(eq(wikiLinks.source_page_id, page.id))
      .orderBy(asc(wikiLinks.target_page_id))).map((link) => link.target);
  }
  return `sha256:${createHash('sha256').update(JSON.stringify(fields)).digest('hex')}`;
}

/**
 * Values to merge into a new `wiki_write` agent_actions row: the target the
 * requester may write, frozen at proposal time. Empty for other actions.
 */
export async function wikiProposalTargetValues(
  action: string,
  params: Params,
  orgId: string,
  userId: string,
  executor: Executor = db,
): Promise<{ before_state?: { [TARGET_KEY]: FrozenWikiTarget } }> {
  if (action !== 'wiki_write' || !params || typeof params !== 'object') return {};
  const slug = existingSlugOf(params);
  if (!slug) {
    return { before_state: { [TARGET_KEY]: { v: 1, mode: 'create', slug: slugFromTitle(params.title) } } };
  }
  const [page] = await executor
    .select({
      id: wikiPages.id,
      title: wikiPages.title,
      summary: wikiPages.summary,
      type: wikiPages.type,
      content: wikiPages.content,
    })
    .from(wikiPages)
    .where(and(
      eq(wikiPages.org_id, orgId),
      eq(wikiPages.slug, slug),
      eq(wikiPages.is_deleted, false),
      visibleWikiPageCondition(userId, orgId),
    ))
    .limit(1);
  return {
    before_state: {
      [TARGET_KEY]: page
        ? { v: 1, mode: 'update', slug, page_id: page.id, revision: await writtenFieldsRevision(executor, page, params) }
        : { v: 1, mode: 'update', slug, page_id: null, revision: null },
    },
  };
}

function readFrozenTarget(beforeState: unknown): FrozenWikiTarget | null {
  if (!beforeState || typeof beforeState !== 'object' || Array.isArray(beforeState)) return null;
  const target = (beforeState as Record<string, unknown>)[TARGET_KEY];
  if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
  const value = target as Record<string, unknown>;
  if (value.v !== 1 || typeof value.slug !== 'string') return null;
  if (value.mode === 'create') return { v: 1, mode: 'create', slug: value.slug };
  if (value.mode !== 'update') return null;
  const pageId = typeof value.page_id === 'string' ? value.page_id : null;
  const revision = typeof value.revision === 'string' ? value.revision : null;
  return { v: 1, mode: 'update', slug: value.slug, page_id: pageId, revision };
}

class WikiWriteRefusal extends Error {}

let revisionCheckedHook: (() => Promise<void>) | null = null;

/** Test seam: runs inside the write, after the revision check and before any change. */
export function _setWikiWriteRevisionCheckedHookForTest(hook: (() => Promise<void>) | null): void {
  revisionCheckedHook = hook;
}

/** Executes an approved or automatic `wiki_write` action against its frozen target. */
export async function executeWikiWriteAction(input: {
  actionId: string;
  params: Params;
  orgId: string;
  userId: string;
}): Promise<{ success: boolean; result: any; error?: string }> {
  const { actionId, params, orgId, userId } = input;
  const [row] = await db
    .select({ before_state: agentActions.before_state })
    .from(agentActions)
    .where(and(eq(agentActions.id, actionId), eq(agentActions.org_id, orgId)))
    .limit(1);
  const target = readFrozenTarget(row?.before_state);
  if (!target) return refused(WIKI_PROPOSAL_UNVERIFIABLE_ERROR);
  const existingSlug = existingSlugOf(params);
  if ((target.mode === 'update') !== Boolean(existingSlug)) return refused(WIKI_PROPOSAL_UNVERIFIABLE_ERROR);

  const { title, content, type: pageType, summary, related_slugs } = params;

  if (target.mode === 'update') {
    if (existingSlug !== target.slug) return refused(WIKI_PROPOSAL_UNVERIFIABLE_ERROR);
    if (!target.page_id || !target.revision) {
      return refused(`Wiki page "${existingSlug}" not found`);
    }
    const pageId = target.page_id;
    const expectedRevision = target.revision;
    let outcome: {
      existing: typeof wikiPages.$inferSelect;
      updates: Record<string, any>;
    };
    try {
      outcome = await db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(wikiPages)
          .where(and(eq(wikiPages.id, pageId), eq(wikiPages.org_id, orgId)))
          .limit(1)
          .for('update');
        if (!locked || locked.is_deleted || locked.slug !== target.slug) {
          throw new WikiWriteRefusal(WIKI_PAGE_UNAVAILABLE_ERROR);
        }
        const [visible] = await tx
          .select({ id: wikiPages.id })
          .from(wikiPages)
          .where(and(eq(wikiPages.id, pageId), eq(wikiPages.org_id, orgId), visibleWikiPageCondition(userId, orgId)))
          .limit(1);
        if (!visible) throw new WikiWriteRefusal(WIKI_PAGE_UNAVAILABLE_ERROR);
        if (await writtenFieldsRevision(tx, locked, params) !== expectedRevision) {
          throw new WikiWriteRefusal(WIKI_PAGE_CHANGED_ERROR);
        }
        if (revisionCheckedHook) await revisionCheckedHook();

        const updates: Record<string, any> = {};
        if (title) updates.title = title;
        if (summary) updates.summary = summary;
        if (pageType) updates.type = pageType;
        if (content && content !== locked.content) {
          updates.content = content;
          updates.previous_content = locked.content;
          updates.version = locked.version + 1;
        }
        if (Object.keys(updates).length > 0) {
          if (updates.version !== undefined) {
            await tx.insert(wikiPageVersions).values({
              page_id: locked.id,
              version: locked.version,
              title: locked.title,
              content: locked.content,
              summary: locked.summary,
              edited_by: userId,
            }).onConflictDoNothing({
              target: [wikiPageVersions.page_id, wikiPageVersions.version],
            });
          }
          await tx.update(wikiPages).set(updates).where(eq(wikiPages.id, locked.id));
        }

        if (writesRelatedLinks(params)) {
          await tx.delete(wikiLinks).where(eq(wikiLinks.source_page_id, locked.id));
          const targets = await tx
            .select({ id: wikiPages.id })
            .from(wikiPages)
            .where(and(eq(wikiPages.org_id, orgId), inArray(wikiPages.slug, related_slugs)));
          for (const linked of targets) {
            if (linked.id !== locked.id) {
              await tx.insert(wikiLinks).values({ org_id: orgId, source_page_id: locked.id, target_page_id: linked.id }).onConflictDoNothing();
            }
          }
        }

        await tx.insert(wikiOpsLog).values({
          org_id: orgId,
          operation: 'update',
          page_id: locked.id,
          details: { updated_fields: Object.keys(updates), by_agent: true },
          performed_by: userId,
        });
        return { existing: locked, updates };
      });
    } catch (error) {
      if (error instanceof WikiWriteRefusal) return refused(error.message);
      throw error;
    }
    const { existing } = outcome;

    await db
      .update(agentActions)
      .set({
        result: { slug: existingSlug, action: 'updated' },
        before_state: { content: existing.content, version: existing.version },
        after_state: { content: content || existing.content, version: (existing.version || 0) + 1 },
        executed_at: new Date(),
      })
      .where(eq(agentActions.id, actionId));

    await logAuditEvent({
      orgId,
      actorType: 'agent',
      actorId: userId,
      action: 'wiki_write',
      entityType: 'wiki_page',
      entityId: existing.id,
      beforeState: { content: existing.content },
      afterState: { content: content || existing.content },
      metadata: { action_id: actionId, slug: existingSlug },
    });

    return { success: true, result: { slug: existingSlug, action: 'updated' } };
  }

  if (!title || !content || !pageType) {
    return { success: false, result: null, error: 'title, content, and type are required for new wiki pages' };
  }

  const slug = slugFromTitle(title);
  if (slug !== target.slug) return refused(WIKI_PROPOSAL_UNVERIFIABLE_ERROR);

  const page = await db.transaction(async (tx) => {
    // The slug is unique per workspace, deleted pages included: a page that
    // took this slug after the proposal leaves nothing inserted here.
    const [inserted] = await tx
      .insert(wikiPages)
      .values({
        org_id: orgId,
        scope: 'org',
        type: pageType,
        title,
        slug,
        summary: summary || null,
        content,
        confidence: 0.7,
        version: 1,
      })
      .onConflictDoNothing({ target: [wikiPages.org_id, wikiPages.slug] })
      .returning();
    if (!inserted) return null;
    await tx.insert(wikiOpsLog).values({
      org_id: orgId,
      operation: 'create',
      page_id: inserted.id,
      details: { type: pageType, by_agent: true },
      performed_by: userId,
    });
    return inserted;
  });
  if (!page) return refused(WIKI_PAGE_EXISTS_ERROR);

  await db
    .update(agentActions)
    .set({
      result: { slug, page_id: page.id, action: 'created' },
      before_state: null,
      after_state: { id: page.id, title, slug, type: pageType },
      executed_at: new Date(),
    })
    .where(eq(agentActions.id, actionId));

  await logAuditEvent({
    orgId,
    actorType: 'agent',
    actorId: userId,
    action: 'wiki_write',
    entityType: 'wiki_page',
    entityId: page.id,
    beforeState: null,
    afterState: { title, slug, type: pageType },
    metadata: { action_id: actionId },
  });

  return { success: true, result: { slug, page_id: page.id, action: 'created' } };
}
