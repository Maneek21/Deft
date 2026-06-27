import { and, eq } from 'drizzle-orm';
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
