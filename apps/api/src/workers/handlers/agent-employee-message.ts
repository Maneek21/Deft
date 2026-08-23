// Handler: agent-employee-message — processes DMs and @mentions directed at agent employees.
//
// Every agent_employees row is BYOA. Deft publishes durable Agent Channel
// events for live runtimes and also keeps a pending `agent_actions` fallback
// so pull-only MCP clients can discover the work through `fetch_unread`.
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import {
  agentActions,
  agentChannelConnections,
  agentEmployees,
  messages,
  notifications,
  orgMembers,
  users,
} from '@deft/db/schema';
import { eq, and, lte, sql } from 'drizzle-orm';
import { getIO } from '../../socket.js';
import { ensureDeftyMembership } from '../../lib/ensure-defty-membership.js';
import { publishAgentChannelEvent } from '../../lib/agent-channel.js';
import { employeeCanAccessSpace } from '../../lib/mcp-tools/employee-space-access.js';

interface AgentEmployeeMessageData {
  messageId: string;
  spaceId: string;
  orgId: string;
  employeeId: string;
  isDM: boolean;
}

type AgentChannelState = {
  id?: string;
  status: string;
  last_seen_at: Date | null;
} | null;

export function describeAgentDelivery(
  employeeName: string,
  connection: AgentChannelState,
  now = Date.now(),
) {
  const lastSeenAt = connection?.last_seen_at?.getTime() ?? 0;
  const isLive = connection?.status === 'connected' && now - lastSeenAt < 5 * 60_000;
  if (isLive) {
    return {
      state: 'sent' as const,
      content: `Sent to ${employeeName}. They will reply here when they pick it up.`,
    };
  }
  if (lastSeenAt) {
    return {
      state: 'queued' as const,
      content: `Queued for ${employeeName}. Their runtime is offline; Deft will deliver this when it reconnects.`,
    };
  }
  return {
    state: 'queued' as const,
    content: `Queued for ${employeeName}. Connect their runtime to deliver it.`,
  };
}

async function notifyAdminsOfQueuedRuntime(orgId: string, employeeId: string, employeeName: string) {
  const admins = await db
    .select({ userId: orgMembers.user_id })
    .from(orgMembers)
    .where(and(
      eq(orgMembers.org_id, orgId),
      eq(orgMembers.is_active, true),
      sql`${orgMembers.role} IN ('owner', 'admin')`,
    ));

  for (const admin of admins) {
    const [recent] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(
        eq(notifications.org_id, orgId),
        eq(notifications.user_id, admin.userId),
        eq(notifications.type, 'system'),
        sql`${notifications.metadata}->>'subtype' = 'agent_runtime_offline'`,
        sql`${notifications.metadata}->>'agent_employee_id' = ${employeeId}`,
        sql`${notifications.created_at} > now() - interval '24 hours'`,
      ))
      .limit(1);
    if (recent) continue;

    await db.insert(notifications).values({
      org_id: orgId,
      user_id: admin.userId,
      type: 'system',
      title: `${employeeName} is offline`,
      body: 'New work is queued and will be delivered when the runtime reconnects.',
      link: `/settings/agent-employees/${employeeId}/developer`,
      metadata: {
        subtype: 'agent_runtime_offline',
        agent_employee_id: employeeId,
      },
    });
  }
}

export async function handleAgentEmployeeMessage(job: JobData): Promise<void> {
  const { messageId, spaceId, orgId, employeeId, isDM } = job.data as AgentEmployeeMessageData;

  console.log(`[agent-employee-message] Processing ${isDM ? 'DM' : '@mention'} for employee ${employeeId} in space ${spaceId}`);

  // Block agent→agent mentions (prevent loops)
  const [triggerMsg] = await db.select().from(messages)
    .where(and(
      eq(messages.id, messageId),
      eq(messages.org_id, orgId),
      eq(messages.space_id, spaceId),
      eq(messages.is_deleted, false),
    ))
    .limit(1);
  if (!triggerMsg) return;

  const [author] = await db.select().from(users)
    .where(eq(users.id, triggerMsg.user_id))
    .limit(1);
  if (author?.is_agent) return; // Agent employees cannot trigger other agents

  // 1. Load employee and verify it's active
  const [employee] = await db.select()
    .from(agentEmployees)
    .where(and(eq(agentEmployees.id, employeeId), eq(agentEmployees.org_id, orgId), eq(agentEmployees.is_active, true)))
    .limit(1);

  if (!employee) {
    console.warn(`[agent-employee-message] Employee ${employeeId} not found or inactive, skipping`);
    return;
  }
  if (!(await employeeCanAccessSpace(employeeId, orgId, spaceId))) {
    console.warn(`[agent-employee-message] Employee ${employeeId} cannot access space ${spaceId}, skipping`);
    return;
  }

  // Queue a pull fallback and publish the same work to the durable live
  // channel. A runtime may consume either path; terminal channel handling
  // closes the linked fallback row so Inbox does not retain phantom work.
  try {
    const [actionRow] = await db.insert(agentActions).values({
      org_id: orgId,
      user_id: author!.id,
      agent_employee_id: employeeId,
      source: 'mention',
      action: 'chat_mention',
      params: {
        message_id: messageId,
        space_id: spaceId,
        author_name: author!.name,
        content: triggerMsg.content,
        is_dm: isDM,
      },
      approval_tier: 'auto',
      approval_status: 'pending',
    }).returning({ id: agentActions.id });

    const replyThreadId = isDM
      ? (triggerMsg.parent_id ?? null)
      : (triggerMsg.parent_id ?? messageId);

    await publishAgentChannelEvent({
      orgId,
      employeeId,
      kind: 'message.created',
      sourceKind: 'message',
      sourceId: messageId,
      spaceId,
      threadId: replyThreadId,
      actorUserId: author!.id,
      idempotencyKey: `message:${messageId}:employee:${employeeId}`,
      payload: {
        message_id: messageId,
        space_id: spaceId,
        parent_id: triggerMsg.parent_id ?? null,
        reply_thread_id: replyThreadId,
        author_id: author!.id,
        author_name: author!.name,
        content: triggerMsg.content,
        is_dm: isDM,
        pending_action_id: actionRow?.id ?? null,
      },
    });
  } catch (err) {
    console.error(
      `[agent-employee-message] failed to queue BYOA mention for ${employeeId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  // Post a subtle system note so the human knows the mention landed.
  // Authored by the Defty system user, not the BYOA agent itself —
  // this is a platform notice rendered as a centered pill via
  // `metadata.kind === 'system_note'` (no avatar, no author block).
  try {
    const io = getIO();
    const deftyUserId = await ensureDeftyMembership(orgId);
    const [connection] = await db
      .select({
        id: agentChannelConnections.id,
        status: agentChannelConnections.status,
        last_seen_at: agentChannelConnections.last_seen_at,
      })
      .from(agentChannelConnections)
      .where(and(
        eq(agentChannelConnections.org_id, orgId),
        eq(agentChannelConnections.agent_employee_id, employeeId),
      ))
      .limit(1);
    const delivery = describeAgentDelivery(employee.name, connection ?? null);

    if (delivery.state === 'queued') {
      if (connection?.status === 'connected' && connection.id && connection.last_seen_at) {
        await db.update(agentChannelConnections)
          .set({ status: 'disconnected', last_error: 'Runtime contact timed out', updated_at: new Date() })
          .where(and(
            eq(agentChannelConnections.id, connection.id),
            eq(agentChannelConnections.status, 'connected'),
            lte(agentChannelConnections.last_seen_at, connection.last_seen_at),
          ));
      }
      try {
        await notifyAdminsOfQueuedRuntime(orgId, employeeId, employee.name);
      } catch (alertError) {
        console.warn(
          '[agent-employee-message] offline runtime alert failed:',
          alertError instanceof Error ? alertError.message : alertError,
        );
      }
    }

    const [sysMsg] = await db
      .insert(messages)
      .values({
        org_id: orgId,
        space_id: spaceId,
        user_id: deftyUserId,
        content: delivery.content,
        parent_id: triggerMsg.parent_id ?? null,
        metadata: {
          kind: 'system_note',
          subtype: 'byoa_mention_received',
          agent_employee_id: employeeId,
          wake_mode: employee.wake_mode,
          delivery_state: delivery.state,
          channel_status: connection?.status ?? 'never_connected',
          channel_last_seen_at: connection?.last_seen_at ?? null,
          last_mcp_call_at: employee.last_mcp_call_at,
          last_heartbeat_at: employee.last_heartbeat_at,
        } as never,
      })
      .returning();
    if (sysMsg && io) {
      io.to(`space:${spaceId}`).emit('message:new', sysMsg);
    }
  } catch (err) {
    console.warn(
      `[agent-employee-message] BYOA system-note post failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}
