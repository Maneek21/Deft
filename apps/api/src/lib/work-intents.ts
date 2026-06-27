import { and, eq, inArray } from 'drizzle-orm';
import { workIntents } from '@deft/db/schema';
import { db } from './db.js';

function getWorkIntentIdFromParams(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null;
  const value = (params as Record<string, unknown>).work_intent_id;
  return typeof value === 'string' && value.trim() ? value : null;
}

function getTaskIdFromResult(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  const value = record.task_id ?? record.id;
  return typeof value === 'string' && value.trim() ? value : null;
}

export async function markWorkIntentConvertedForAction(params: {
  actionId: string;
  orgId: string;
  actionParams: unknown;
  result: unknown;
  convertedBy: string;
}): Promise<void> {
  const workIntentId = getWorkIntentIdFromParams(params.actionParams);
  if (!workIntentId) return;

  await db
    .update(workIntents)
    .set({
      status: 'converted',
      converted_action_id: params.actionId,
      converted_task_id: getTaskIdFromResult(params.result),
      converted_by: params.convertedBy,
      converted_at: new Date(),
      failure_reason: null,
    })
    .where(and(
      eq(workIntents.id, workIntentId),
      eq(workIntents.org_id, params.orgId),
    ));
}

export async function markWorkIntentDismissedForAction(params: {
  actionId: string;
  orgId: string;
  actionParams: unknown;
  dismissedBy: string;
  reason?: string | null;
}): Promise<void> {
  const workIntentId = getWorkIntentIdFromParams(params.actionParams);
  if (!workIntentId) return;

  await db
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
    ));
}

export async function markWorkIntentFailedForAction(params: {
  actionId: string;
  orgId: string;
  actionParams: unknown;
  reason?: string | null;
}): Promise<void> {
  const workIntentId = getWorkIntentIdFromParams(params.actionParams);
  if (!workIntentId) return;

  await db
    .update(workIntents)
    .set({
      status: 'failed',
      converted_action_id: params.actionId,
      failure_reason: params.reason?.slice(0, 2000) ?? 'Action failed',
    })
    .where(and(
      eq(workIntents.id, workIntentId),
      eq(workIntents.org_id, params.orgId),
    ));
}

export async function markWorkIntentsExpiredForActions(params: {
  orgId: string;
  actions: Array<{ id?: string | null; params: unknown }>;
  reason?: string | null;
}): Promise<number> {
  const actionByIntentId = new Map<string, string | null>();
  for (const action of params.actions) {
    const workIntentId = getWorkIntentIdFromParams(action.params);
    if (workIntentId) actionByIntentId.set(workIntentId, action.id ?? null);
  }
  const workIntentIds = [...actionByIntentId.keys()];

  if (workIntentIds.length === 0) return 0;

  const reason = params.reason?.slice(0, 2000) ?? 'Approval expired';
  let count = 0;
  for (const workIntentId of workIntentIds) {
    const updated = await db
      .update(workIntents)
      .set({
        status: 'expired',
        converted_action_id: actionByIntentId.get(workIntentId) ?? null,
        failure_reason: reason,
      })
      .where(and(
        eq(workIntents.org_id, params.orgId),
        eq(workIntents.status, 'proposed'),
        eq(workIntents.id, workIntentId),
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
