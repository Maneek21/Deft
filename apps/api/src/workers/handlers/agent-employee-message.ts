// Handler: agent-employee-message — processes DMs and @mentions directed at agent employees.
//
// Phase 9: every agent_employees row is BYOA. Deft never pushes work to
// the agent runtime — it queues a pending `agent_actions` row that the
// BYOA client discovers via the `poll_pending_work` MCP tool, and posts
// a subtle system note in the thread so the human knows the mention
// landed.
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import {
  agentActions,
  agentEmployees,
  messages,
  users,
} from '@deft/db/schema';
import { eq, and } from 'drizzle-orm';
import { getIO } from '../../socket.js';
import { ensureDeftyMembership } from '../../lib/ensure-defty-membership.js';
import { publishAgentChannelEvent } from '../../lib/agent-channel.js';

interface AgentEmployeeMessageData {
  messageId: string;
  spaceId: string;
  orgId: string;
  employeeId: string;
  isDM: boolean;
}

export async function handleAgentEmployeeMessage(job: JobData): Promise<void> {
  const { messageId, spaceId, orgId, employeeId, isDM } = job.data as AgentEmployeeMessageData;

  console.log(`[agent-employee-message] Processing ${isDM ? 'DM' : '@mention'} for employee ${employeeId} in space ${spaceId}`);

  // Block agent→agent mentions (prevent loops)
  const [triggerMsg] = await db.select().from(messages)
    .where(eq(messages.id, messageId))
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

  // ─── BYOA (MCP pull) — the only path ────────────────────────────────
  // BYOA agents run in the user's own Claude Code / Claude Desktop /
  // custom runtime. Deft has no push endpoint for them — they pull via
  // MCP. Queue the mention as a pending agent_actions row so the BYOA
  // client can discover it through `fetch_unread`, then post a
  // subtle system note so the human sees the mention was received but
  // the agent replies on its own schedule.
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

    await publishAgentChannelEvent({
      orgId,
      employeeId,
      kind: 'message.created',
      sourceKind: 'message',
      sourceId: messageId,
      spaceId,
      threadId: triggerMsg.parent_id ?? messageId,
      actorUserId: author!.id,
      idempotencyKey: `message:${messageId}:employee:${employeeId}`,
      payload: {
        message_id: messageId,
        space_id: spaceId,
        parent_id: triggerMsg.parent_id ?? null,
        reply_thread_id: triggerMsg.parent_id ?? messageId,
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
    const cadence = employee.heartbeat_interval_min ?? 30;
    const lastSeen = employee.last_mcp_call_at ?? employee.last_heartbeat_at ?? null;
    const statusText = lastSeen
      ? `Last MCP contact: ${new Date(lastSeen).toLocaleString('en-US', { timeZone: 'UTC' })} UTC.`
      : 'No MCP contact has been recorded yet; connect or certify the runtime from the Developer tab.';
    const [sysMsg] = await db
      .insert(messages)
      .values({
        org_id: orgId,
        space_id: spaceId,
        user_id: deftyUserId,
        content: `Queued for ${employee.name}. Live channel delivery will wake the runtime when it is connected; fetch_unread remains available as a fallback${employee.wake_mode === 'polling' ? ` (polling about every ${cadence}m)` : ''}. ${statusText}`,
        parent_id: triggerMsg.parent_id ?? null,
        metadata: {
          kind: 'system_note',
          subtype: 'byoa_mention_received',
          agent_employee_id: employeeId,
          wake_mode: employee.wake_mode,
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
