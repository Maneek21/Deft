import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  agentActions,
  agentChannelEvents,
  agentCooperativeLog,
  agentEmployees,
  agentMcpCallAudit,
  agentSessionTurns,
} from '@deft/db/schema';
import { db } from './db.js';
import { summarizeAgentChannelLifecycle } from './agent-channel-lifecycle.js';
import { channelEventTextAudienceSql } from './agent-channel.js';
import { currentEmployeeMessageAuthoritySql, currentEmployeeSpaceAuthoritySql, currentUserSpaceAuthoritySql } from './agent-channel-authority.js';
import { isCanonicalDeftyEmployee } from './defty-identity.js';
import { visibleModuleActionSql } from './module-action-visibility.js';
import { visibleCaptureActionSql } from './agent-action-visibility.js';

export type AgentActivityItem = {
  id: string;
  kind: 'delivery' | 'action' | 'tool_call' | 'session' | 'record';
  label: string;
  status: 'queued' | 'running' | 'approval_pending' | 'completed' | 'failed' | 'cancelled';
  detail: string | null;
  occurred_at: Date;
  target_url: string | null;
  error: string | null;
  timing?: ReturnType<typeof summarizeAgentChannelLifecycle>;
};

/**
 * Who may read a session turn's content (input messages, tool calls, reply,
 * error) besides owners/admins: for a Defty turn, its requester (the author
 * of the triggering message, the one link to the request that the server
 * itself records); for an employee turn, the employee source rule (current
 * employee access to the source and the reader's access to it). A turn whose
 * requester or source cannot be established matches nobody.
 */
export function sessionTurnContentAudienceSql(params: { orgId: string; employeeId: string; readerId: string; defty: boolean }): SQL {
  const org = sql`${params.orgId}`;
  const reader = sql`${params.readerId}`;
  const trigger = sql`${agentSessionTurns.triggering_message_id}`;
  const turnSpace = sql`${agentSessionTurns.space_id}`;
  return params.defty
    ? sql`${agentSessionTurns.triggering_message_id} IS NOT NULL AND (
        EXISTS (SELECT 1 FROM messages turn_request
          WHERE turn_request.id = ${trigger} AND turn_request.org_id = ${org}
            AND turn_request.user_id = ${reader} AND turn_request.is_deleted = false
            AND (${turnSpace} IS NULL OR turn_request.space_id = ${turnSpace})))`
    : sql`CASE
        WHEN ${agentSessionTurns.triggering_message_id} IS NOT NULL THEN
          ${currentEmployeeMessageAuthoritySql(org, sql`${params.employeeId}`, trigger)}
          AND EXISTS (SELECT 1 FROM messages turn_source
            WHERE turn_source.id = ${trigger} AND turn_source.org_id = ${org} AND turn_source.is_deleted = false
              AND ${currentUserSpaceAuthoritySql(org, reader, sql`turn_source.space_id`)})
        WHEN ${agentSessionTurns.space_id} IS NOT NULL THEN
          ${currentEmployeeSpaceAuthoritySql(org, sql`${params.employeeId}`, turnSpace)}
          AND ${currentUserSpaceAuthoritySql(org, reader, turnSpace)}
        ELSE false END`;
}

function actionStatus(row: typeof agentActions.$inferSelect): AgentActivityItem['status'] {
  if (row.error || row.approval_status === 'rejected' || row.approval_status === 'expired') return 'failed';
  if (row.executed_at) return 'completed';
  if (row.approval_status === 'pending') return 'approval_pending';
  return 'running';
}

/**
 * Every org member who may open the feed sees every entry's kind, label,
 * status and time. Free text a run produced (event outcome details and
 * errors, tool-call and session errors, cooperative summaries) and the link
 * to the source go only to owners/admins and to readers of that entry's
 * source: the action audience for action rows (module-action-visibility.ts,
 * which also scopes which action rows are listed), the channel event's source
 * under the employee source rule, and the session turn's content audience.
 * Tool calls and cooperative records (whatever ids they carry) keep their
 * text for owners/admins.
 */
export async function loadAgentActivity(params: { orgId: string; employeeId: string; viewer: { id: string; role?: string }; limit?: number }) {
  const perSource = Math.min(Math.max(params.limit ?? 50, 1), 100);
  const [events, actions, calls, sessions, records] = await Promise.all([
    db.select().from(agentChannelEvents).where(and(
      eq(agentChannelEvents.org_id, params.orgId),
      eq(agentChannelEvents.agent_employee_id, params.employeeId),
    )).orderBy(desc(agentChannelEvents.created_at)).limit(perSource),
    db.select().from(agentActions).where(and(
      eq(agentActions.org_id, params.orgId),
      eq(agentActions.agent_employee_id, params.employeeId),
      visibleCaptureActionSql({ id: params.viewer.id, org_id: params.orgId }),
      visibleModuleActionSql(params.viewer.role, { userId: params.viewer.id, orgId: params.orgId }),
    )).orderBy(desc(agentActions.created_at)).limit(perSource),
    db.select().from(agentMcpCallAudit).where(and(
      eq(agentMcpCallAudit.org_id, params.orgId),
      eq(agentMcpCallAudit.employee_id, params.employeeId),
    )).orderBy(desc(agentMcpCallAudit.created_at)).limit(perSource),
    db.select().from(agentSessionTurns).where(and(
      eq(agentSessionTurns.org_id, params.orgId),
      eq(agentSessionTurns.employee_id, params.employeeId),
    )).orderBy(desc(agentSessionTurns.created_at)).limit(perSource),
    db.select().from(agentCooperativeLog).where(and(
      eq(agentCooperativeLog.org_id, params.orgId),
      eq(agentCooperativeLog.employee_id, params.employeeId),
    )).orderBy(desc(agentCooperativeLog.created_at)).limit(perSource),
  ]);

  const canSeeAll = params.viewer.role === 'owner' || params.viewer.role === 'admin';
  let textEvents = new Set<string>();
  let textTurns = new Set<string>();
  if (!canSeeAll) {
    const [employee] = await db
      .select({ slug: agentEmployees.slug, runtime_kind: agentEmployees.runtime_kind, is_byoa: agentEmployees.is_byoa })
      .from(agentEmployees)
      .where(and(eq(agentEmployees.id, params.employeeId), eq(agentEmployees.org_id, params.orgId)))
      .limit(1);
    const eventIds = events.map((event) => event.id);
    const turnIds = sessions.map((session) => session.id);
    const [eventRows, turnRows] = await Promise.all([
      eventIds.length > 0
        ? db.select({ id: agentChannelEvents.id }).from(agentChannelEvents).where(and(
          inArray(agentChannelEvents.id, eventIds),
          eq(agentChannelEvents.org_id, params.orgId),
          eq(agentChannelEvents.agent_employee_id, params.employeeId),
          channelEventTextAudienceSql(agentChannelEvents.id, sql`${params.viewer.id}`),
        ))
        : [],
      employee && turnIds.length > 0
        ? db.select({ id: agentSessionTurns.id }).from(agentSessionTurns).where(and(
          inArray(agentSessionTurns.id, turnIds),
          eq(agentSessionTurns.org_id, params.orgId),
          eq(agentSessionTurns.employee_id, params.employeeId),
          sessionTurnContentAudienceSql({
            orgId: params.orgId,
            employeeId: params.employeeId,
            readerId: params.viewer.id,
            defty: isCanonicalDeftyEmployee(employee),
          }),
        ))
        : [],
    ]);
    textEvents = new Set(eventRows.map((row) => row.id));
    textTurns = new Set(turnRows.map((row) => row.id));
  }

  const items: AgentActivityItem[] = [
    ...events.map((event): AgentActivityItem => {
      const withText = canSeeAll || textEvents.has(event.id);
      const lifecycle = summarizeAgentChannelLifecycle(event);
      const status = lifecycle.phase === 'queued' || lifecycle.phase === 'approval_pending'
        ? lifecycle.phase
        : lifecycle.phase === 'cancelled'
          ? 'cancelled'
          : lifecycle.phase === 'failed'
          ? 'failed'
          : lifecycle.phase === 'completed'
            ? 'completed'
            : 'running';
      const query = event.space_id
        ? `?space=${encodeURIComponent(event.space_id)}${event.thread_id ? `&thread=${encodeURIComponent(event.thread_id)}` : ''}`
        : '';
      return {
        id: `delivery:${event.id}`,
        kind: 'delivery',
        label: event.kind,
        status,
        detail: [
          event.source_kind ? `From ${event.source_kind}` : null,
          event.work_outcome && event.work_outcome !== 'completed'
            ? `Outcome: ${event.work_outcome.replaceAll('_', ' ')}`
            : null,
          withText ? event.outcome_detail ?? null : null,
        ].filter(Boolean).join(' · ') || null,
        occurred_at: event.updated_at,
        target_url: withText && event.space_id ? `/chat${query}` : null,
        error: withText ? event.error : null,
        timing: lifecycle,
      };
    }),
    ...actions.map((action): AgentActivityItem => ({
      id: `action:${action.id}`,
      kind: 'action',
      label: action.action.replaceAll('_', ' '),
      status: actionStatus(action),
      detail: action.source ? `Source: ${action.source}` : null,
      occurred_at: action.executed_at ?? action.updated_at,
      target_url: action.conversation_id
        ? `/chat?space=${encodeURIComponent(action.conversation_id)}${action.message_id ? `&message=${encodeURIComponent(action.message_id)}` : ''}`
        : null,
      error: action.error,
    })),
    ...calls.map((call): AgentActivityItem => ({
      id: `tool:${call.id}`,
      kind: 'tool_call',
      label: call.tool_name,
      status: call.success ? 'completed' : 'failed',
      detail: 'MCP tool call',
      occurred_at: call.created_at,
      target_url: null,
      error: canSeeAll ? call.error : null,
    })),
    ...sessions.map((session): AgentActivityItem => {
      const withText = canSeeAll || textTurns.has(session.id);
      return {
        id: `session:${session.id}`,
        kind: 'session',
        label: session.trigger_kind,
        status: session.result === 'success' ? 'completed' : 'failed',
        detail: `${session.model_name ?? 'Agent runtime'} - ${session.latency_ms}ms`,
        occurred_at: session.created_at,
        target_url: withText && session.space_id ? `/chat?space=${encodeURIComponent(session.space_id)}` : null,
        error: withText ? session.error : null,
      };
    }),
    ...records.map((record): AgentActivityItem => ({
      id: `record:${record.id}`,
      kind: 'record',
      label: record.kind.replaceAll('_', ' '),
      status: record.kind === 'action_attempt' ? 'running' : 'completed',
      detail: canSeeAll ? record.summary : null,
      occurred_at: record.created_at,
      target_url: null,
      error: null,
    })),
  ];

  return items
    .sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime())
    .slice(0, perSource);
}
