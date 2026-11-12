import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { workIntents } from '@deft/db/schema';
import { db } from './db.js';

type WorkIntentExecutor = Pick<typeof db, 'update'>;

function getWorkIntentIdFromParams(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null;
  const value = (params as Record<string, unknown>).work_intent_id;
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * An action changes a WorkIntent only when it is that intent's own capture
 * action: the row exists in the same org, carries the server-written
 * `defty_capture` source, and its stored params name this intent. Some action
 * kinds scrub their params in the same transaction that closes the intent; for
 * those the caller-supplied (pre-scrub) intent id, already part of the WHERE,
 * is the only binding left.
 */
function isCaptureActionForIntent(actionId: string, orgId: string): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM agent_actions capture_action
    WHERE capture_action.id = ${actionId}
      AND capture_action.org_id = ${orgId}
      AND capture_action.source = 'defty_capture'
      AND COALESCE(capture_action.params->>'work_intent_id', ${workIntents.id}) = ${workIntents.id}
  )`;
}

function getTaskIdFromResult(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  const value = record.task_id ?? record.id;
  return typeof value === 'string' && value.trim() ? value : null;
}

function getWikiResultFromResult(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  const slug = record.slug;
  const pageId = record.page_id ?? record.id;
  if (typeof slug !== 'string' || !slug.trim()) return null;
  return {
    converted_wiki_slug: slug,
    converted_wiki_page_id: typeof pageId === 'string' ? pageId : null,
    converted_wiki_title: typeof record.title === 'string' ? record.title : null,
    converted_wiki_type: typeof record.type === 'string' ? record.type : null,
  };
}

export async function markWorkIntentConvertedForAction(params: {
  actionId: string;
  orgId: string;
  actionParams: unknown;
  result: unknown;
  convertedBy: string;
}, executor: WorkIntentExecutor = db): Promise<void> {
  const workIntentId = getWorkIntentIdFromParams(params.actionParams);
  if (!workIntentId) return;
  const wikiResult = getWikiResultFromResult(params.result);

  await executor
    .update(workIntents)
    .set({
      status: 'converted',
      converted_action_id: params.actionId,
      converted_task_id: getTaskIdFromResult(params.result),
      converted_by: params.convertedBy,
      converted_at: new Date(),
      failure_reason: null,
      ...(wikiResult
        ? { metadata: sql`${workIntents.metadata} || ${JSON.stringify(wikiResult)}::jsonb` as any }
        : {}),
    })
    .where(and(
      eq(workIntents.id, workIntentId),
      eq(workIntents.org_id, params.orgId),
      isCaptureActionForIntent(params.actionId, params.orgId),
    ));
}

export async function markWorkIntentDismissedForAction(params: {
  actionId: string;
  orgId: string;
  actionParams: unknown;
  dismissedBy: string;
  reason?: string | null;
}, executor: WorkIntentExecutor = db): Promise<void> {
  const workIntentId = getWorkIntentIdFromParams(params.actionParams);
  if (!workIntentId) return;

  await executor
    .update(workIntents)
    .set({
      status: 'dismissed',
      converted_action_id: params.actionId,
      dismissed_by: params.dismissedBy,
      dismissed_at: new Date(),
      failure_reason: params.reason?.slice(0, 2000) ?? null,
    })
    .where(and(
      eq(workIntents.id, workIntentId),
      eq(workIntents.org_id, params.orgId),
      isCaptureActionForIntent(params.actionId, params.orgId),
    ));
}

export async function markWorkIntentFailedForAction(params: {
  actionId: string;
  orgId: string;
  actionParams: unknown;
  reason?: string | null;
}, executor: WorkIntentExecutor = db): Promise<void> {
  const workIntentId = getWorkIntentIdFromParams(params.actionParams);
  if (!workIntentId) return;

  await executor
    .update(workIntents)
    .set({
      status: 'failed',
      converted_action_id: params.actionId,
      failure_reason: params.reason?.slice(0, 2000) ?? 'Action failed',
    })
    .where(and(
      eq(workIntents.id, workIntentId),
      eq(workIntents.org_id, params.orgId),
      isCaptureActionForIntent(params.actionId, params.orgId),
    ));
}

export async function markWorkIntentsExpiredForActions(params: {
  orgId: string;
  actions: Array<{ id?: string | null; params: unknown }>;
  reason?: string | null;
}, executor: WorkIntentExecutor = db): Promise<number> {
  // Every (intent, action) candidate is checked on its own, before any
  // collapsing by intent, so only an intent's own capture action expires it.
  const candidates = new Map<string, { workIntentId: string; actionId: string }>();
  for (const action of params.actions) {
    const workIntentId = getWorkIntentIdFromParams(action.params);
    const actionId = typeof action.id === 'string' && action.id ? action.id : null;
    if (!workIntentId || !actionId) continue;
    candidates.set(JSON.stringify([workIntentId, actionId]), { workIntentId, actionId });
  }

  if (candidates.size === 0) return 0;

  const reason = params.reason?.slice(0, 2000) ?? 'Approval expired';
  let count = 0;
  for (const { workIntentId, actionId } of candidates.values()) {
    const updated = await executor
      .update(workIntents)
      .set({
        status: 'expired',
        converted_action_id: actionId,
        failure_reason: reason,
      })
      .where(and(
        eq(workIntents.org_id, params.orgId),
        eq(workIntents.status, 'proposed'),
        eq(workIntents.id, workIntentId),
        isCaptureActionForIntent(actionId, params.orgId),
      ))
      .returning({ id: workIntents.id });
    count += updated.length;
  }
  return count;
}

export async function markWorkIntentsExpiredByIds(params: {
  orgId: string;
  workIntentIds: string[];
  reason?: string | null;
}): Promise<number> {
  const workIntentIds = [...new Set(params.workIntentIds.filter(Boolean))];
  if (workIntentIds.length === 0) return 0;

  const updated = await db
    .update(workIntents)
    .set({
      status: 'expired',
      failure_reason: params.reason?.slice(0, 2000) ?? 'Approval expired',
    })
    .where(and(
      eq(workIntents.org_id, params.orgId),
      eq(workIntents.status, 'proposed'),
      inArray(workIntents.id, workIntentIds),
    ))
    .returning({ id: workIntents.id });

  return updated.length;
}
