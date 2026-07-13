import { and, desc, eq } from 'drizzle-orm';
import {
  agentActions,
  agentChannelEvents,
  agentCooperativeLog,
  agentMcpCallAudit,
  agentSessionTurns,
} from '@deft/db/schema';
import { db } from './db.js';
import { summarizeAgentChannelLifecycle } from './agent-channel-lifecycle.js';

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

function actionStatus(row: typeof agentActions.$inferSelect): AgentActivityItem['status'] {
  if (row.error || row.approval_status === 'rejected' || row.approval_status === 'expired') return 'failed';
  if (row.executed_at) return 'completed';
  if (row.approval_status === 'pending') return 'approval_pending';
  return 'running';
}

export async function loadAgentActivity(params: { orgId: string; employeeId: string; limit?: number }) {
  const perSource = Math.min(Math.max(params.limit ?? 50, 1), 100);
  const [events, actions, calls, sessions, records] = await Promise.all([
    db.select().from(agentChannelEvents).where(and(
      eq(agentChannelEvents.org_id, params.orgId),
      eq(agentChannelEvents.agent_employee_id, params.employeeId),
    )).orderBy(desc(agentChannelEvents.created_at)).limit(perSource),
    db.select().from(agentActions).where(and(
      eq(agentActions.org_id, params.orgId),
      eq(agentActions.agent_employee_id, params.employeeId),
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

  const items: AgentActivityItem[] = [
    ...events.map((event): AgentActivityItem => {
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
        detail: event.source_kind ? `From ${event.source_kind}` : null,
        occurred_at: event.updated_at,
        target_url: event.space_id ? `/chat${query}` : null,
        error: event.error,
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
      error: call.error,
    })),
    ...sessions.map((session): AgentActivityItem => ({
      id: `session:${session.id}`,
      kind: 'session',
      label: session.trigger_kind,
      status: session.result === 'success' ? 'completed' : 'failed',
      detail: `${session.model_name ?? 'Agent runtime'} - ${session.latency_ms}ms`,
      occurred_at: session.created_at,
      target_url: session.space_id ? `/chat?space=${encodeURIComponent(session.space_id)}` : null,
      error: session.error,
    })),
    ...records.map((record): AgentActivityItem => ({
      id: `record:${record.id}`,
      kind: 'record',
      label: record.kind.replaceAll('_', ' '),
      status: record.kind === 'action_attempt' ? 'running' : 'completed',
      detail: record.summary,
      occurred_at: record.created_at,
      target_url: null,
      error: null,
    })),
  ];

  return items
    .sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime())
    .slice(0, perSource);
}
