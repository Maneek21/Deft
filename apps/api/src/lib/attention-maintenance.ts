import { and, eq, inArray, lt, notInArray, sql } from 'drizzle-orm';
import { agentActions, attentionItems } from '@deft/db/schema';
import { db } from './db.js';
import { markWorkIntentsExpiredForActions } from './work-intents.js';
import { resolveAttentionBySource, transitionAttentionItem } from './attention.js';
import {
  MODULE_WRITE_ACTION_NAMES,
} from './module-action-visibility.js';
import { terminalizePendingModuleActions } from './module-action-terminalization.js';

export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export async function maintainAttentionSystem(
  now = new Date(),
): Promise<{ expired: number; unsnoozed: number; redacted: number; cleaned: number }> {
  const cutoff = new Date(now.getTime() - APPROVAL_TTL_MS);

  // Module proposals carry record values until a reviewer decides. Their TTL
  // path therefore needs the same terminal sanitation, receipt, and lifecycle
  // closure as an explicit approval decision. Keep each pass org-scoped.
  const staleModuleOrgs = await db
    .selectDistinct({ org_id: agentActions.org_id })
    .from(agentActions)
    .where(and(
      eq(agentActions.approval_status, 'pending'),
      lt(agentActions.created_at, cutoff),
      inArray(agentActions.action, [...MODULE_WRITE_ACTION_NAMES]),
    ));
  let expiredModuleActionCount = 0;
  for (const { org_id: orgId } of staleModuleOrgs) {
    expiredModuleActionCount += (await terminalizePendingModuleActions({
      orgId,
      createdBefore: cutoff,
      reason: 'Approval expired',
      attentionResolution: 'expired',
    })).length;
  }

  // Preserve the legacy status-only behavior for every non-module action.
  const expired = await db
    .update(agentActions)
    .set({ approval_status: 'expired' })
    .where(and(
      eq(agentActions.approval_status, 'pending'),
      lt(agentActions.created_at, cutoff),
      notInArray(agentActions.action, [...MODULE_WRITE_ACTION_NAMES]),
    ))
    .returning({
      id: agentActions.id,
      org_id: agentActions.org_id,
      params: agentActions.params,
    });

  const byOrg = new Map<string, Array<{ id: string; params: unknown }>>();
  for (const action of expired) {
    const actions = byOrg.get(action.org_id) ?? [];
    actions.push({ id: action.id, params: action.params });
    byOrg.set(action.org_id, actions);
  }
  for (const [orgId, actions] of byOrg) {
    await markWorkIntentsExpiredForActions({ orgId, actions });
  }

  for (const action of expired) {
    await resolveAttentionBySource({
      orgId: action.org_id,
      sourceType: 'agent_action',
      sourceId: action.id,
      resolution: 'expired',
    });
  }

  const dueSnoozes = await db
    .select()
    .from(attentionItems)
    .where(and(
      eq(attentionItems.state, 'snoozed'),
      lt(attentionItems.snoozed_until, now),
    ));
  for (const item of dueSnoozes) {
    await transitionAttentionItem({
      orgId: item.org_id,
      userId: item.user_id,
      itemId: item.id,
      state: 'open_unseen',
      resolution: 'snooze_elapsed',
    });
  }

  const summaryRetentionCutoff = new Date(now.getTime() - 180 * 24 * 60 * 60_000);
  const redacted = await db
    .update(attentionItems)
    .set({
      title: 'Resolved attention item',
      body: null,
      link: null,
      metadata: { retention_redacted_at: now.toISOString() },
      updated_at: now,
    })
    .where(and(
      inArray(attentionItems.state, ['resolved', 'expired', 'superseded']),
      lt(attentionItems.resolved_at, summaryRetentionCutoff),
      sql`NOT (${attentionItems.metadata} ? 'retention_redacted_at')`,
    ))
    .returning({ id: attentionItems.id });

  const eventRetentionCutoff = new Date(now.getTime() - 365 * 24 * 60 * 60_000);
  const cleaned = await db
    .delete(attentionItems)
    .where(and(
      inArray(attentionItems.state, ['resolved', 'expired', 'superseded']),
      lt(attentionItems.resolved_at, eventRetentionCutoff),
    ))
    .returning({ id: attentionItems.id });

  return {
    expired: expired.length + expiredModuleActionCount,
    unsnoozed: dueSnoozes.length,
    redacted: redacted.length,
    cleaned: cleaned.length,
  };
}

export const expireStaleApprovalActions = maintainAttentionSystem;
