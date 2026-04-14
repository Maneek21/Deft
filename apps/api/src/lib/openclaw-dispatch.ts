/**
 * Phase 6 — shared OpenClaw dispatch helper.
 *
 * Factored out of `agent-employee-message.ts` so both the chat-mention worker
 * and the new `employee-trigger.ts` worker can share one canonical dispatch
 * path. The existing behavior (load the trigger message from the DB, build
 * the chat envelope, POST to the Gateway, parse the SSE reply, persist a
 * message + agent_session_turns row, broadcast via socket.io) is preserved.
 *
 * Phase 6 adds an optional `overrideTrigger` knob: when present, we skip the
 * DB lookup for the triggering message and instead inject a synthetic
 * `TriggerDescriptor` (cron/webhook flavor) plus a synthetic author name. The
 * `messageId`/`triggering_message_id` in that path is an audit-only
 * correlation id — the message does not need to exist in the `messages`
 * table. This is what unblocks cron + webhook-driven work (e.g. the 9am
 * standup that Alex PM should author directly).
 *
 * The refactor does NOT touch the mcp-server-v1 dispatcher, the token
 * resolver, or any of the Phase 3-5 MCP tools.
 */
import { and, desc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { db } from './db.js';
import {
  agentEmployees,
  agentSessionTurns,
  messages,
  orgMembers,
  users,
} from '@deft/db/schema';
import { getIO } from '../socket.js';
import {
  buildChatCompletionRequest,
  parseReplyIntoMessage,
  type OrgMember,
  type TriggerDescriptor,
} from './openclaw-chat-envelope.js';
import { chatCompletion as openclawChatCompletion } from './openclaw-client.js';
import { decrypt } from './encryption.js';

export type OpenClawDispatchParams = {
  employee: typeof agentEmployees.$inferSelect;
  orgId: string;
  spaceId: string;
  /**
   * The id of the message that triggered this dispatch. For chat mentions
   * this is a real `messages` row that we load from the DB. For trigger
   * invocations this is a synthetic correlation id — we do NOT look it up.
   */
  messageId: string;
  isDM: boolean;
  /**
   * Optional override. When present, the dispatcher does NOT load a
   * triggering message from the DB and instead uses this synthetic
   * trigger as the final user-role envelope entry. Pass this for
   * cron/webhook-driven invocations.
   */
  overrideTrigger?: {
    /**
     * One of the Phase 6 trigger kinds — written to agent_session_turns
     * for the inspector, and forwarded in the OpenClaw request context.
     */
    kind: string;
    content: string;
    author_name: string;
    /** Optional machine-readable context appended to the trigger envelope. */
    context?: Record<string, unknown>;
    /** Optional high-level goal the employee should pursue this turn. */
    goal?: string;
  };
};

export async function dispatchViaOpenClaw(
  params: OpenClawDispatchParams,
): Promise<void> {
  const { employee, orgId, spaceId, messageId, isDM, overrideTrigger } = params;

  if (!employee.connection_url) {
    throw new Error(`openclaw employee ${employee.id} missing connection_url`);
  }
  if (!employee.gateway_token_encrypted) {
    throw new Error(`openclaw employee ${employee.id} missing gateway_token_encrypted`);
  }

  // ─── 1. Resolve the trigger envelope entry ────────────────────────────
  //
  // Two modes:
  //   (a) chat mention / DM  → load the real messages row and the author.
  //   (b) synthetic trigger  → use `overrideTrigger` verbatim.
  //
  // For (b) we still treat `messageId` as a correlation id and set
  // `threadParentId = null` so any reply posts to the target space without
  // threading under a non-existent parent.
  let threadParentId: string | null = null;
  let triggerAuthorName = 'user';
  let triggerContent = '';
  let triggerKind: string;
  let triggerDescriptor: TriggerDescriptor | null = null;

  if (overrideTrigger) {
    triggerAuthorName = overrideTrigger.author_name;
    triggerContent = overrideTrigger.content;
    triggerKind = overrideTrigger.kind;
    threadParentId = null;
    triggerDescriptor = {
      kind: overrideTrigger.kind,
      goal: overrideTrigger.goal,
      summary: overrideTrigger.content,
      context: overrideTrigger.context,
    };
  } else {
    const [triggerMessage] = await db
      .select({
        id: messages.id,
        content: messages.content,
        user_id: messages.user_id,
        parent_id: messages.parent_id,
      })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);

    if (!triggerMessage) {
      console.warn(
        `[openclaw-dispatch] Trigger message ${messageId} not found, skipping`,
      );
      return;
    }

    const [triggerAuthor] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, triggerMessage.user_id))
      .limit(1);

    // Strip @mention artifacts that routed the job here.
    triggerContent =
      triggerMessage.content
        .replace(new RegExp(`<@${employee.slug}\\|[^>]*>`, 'gi'), '')
        .replace(new RegExp(`<@${employee.user_id}\\|[^>]*>`, 'gi'), '')
        .replace(new RegExp(`@${employee.slug}\\b`, 'gi'), '')
        .replace(new RegExp(`@${employee.name}\\b`, 'gi'), '')
        .trim() || 'Hello';
    triggerAuthorName = triggerAuthor?.name ?? 'user';
    threadParentId = triggerMessage.parent_id || messageId;
    triggerKind = isDM ? 'chat_dm' : 'chat_mention';
  }

  // ─── 2. Load thread context ───────────────────────────────────────────
  //
  // For chat mentions we pull the last N messages in the space so the
  // agent has recent context. For synthetic triggers we skip the thread
  // history — the goal + context are the whole prompt.
  let replies: Array<{
    id: string;
    user_id: string;
    user_name?: string;
    content: string;
  }> = [];
  if (!overrideTrigger) {
    const historyLimit = isDM ? 20 : 10;
    const recentRaw = await db
      .select({
        id: messages.id,
        content: messages.content,
        user_id: messages.user_id,
        user_name: users.name,
        parent_id: messages.parent_id,
        created_at: messages.created_at,
      })
      .from(messages)
      .innerJoin(users, eq(messages.user_id, users.id))
      .where(
        and(
          eq(messages.space_id, spaceId),
          eq(messages.org_id, orgId),
          eq(messages.is_deleted, false),
        ),
      )
      .orderBy(desc(messages.created_at))
      .limit(historyLimit);

    const ordered = [...recentRaw].reverse();
    replies = ordered
      .filter((m) => m.id !== messageId)
      .map((m) => ({
        id: m.id,
        user_id: m.user_id,
        user_name: m.user_name ?? undefined,
        content: m.content,
      }));
  }

  // ─── 3. Build the chat completion envelope ─────────────────────────────
  const envelope = await buildChatCompletionRequest({
    employee: {
      id: employee.id,
      org_id: employee.org_id,
      slug: employee.slug,
      user_id: employee.user_id,
      trust_level: employee.trust_level,
    },
    threadContext: {
      parentMessage: undefined,
      replies,
    },
    triggerMessage: triggerDescriptor
      ? triggerDescriptor
      : {
          user_id: 'system',
          user_name: triggerAuthorName,
          content: triggerContent,
        },
  });

  // ─── 4. POST to the Gateway ───────────────────────────────────────────
  const gatewayToken = decrypt(employee.gateway_token_encrypted);
  const { stream, startTime } = await openclawChatCompletion({
    connection_url: employee.connection_url,
    gateway_token: gatewayToken,
    request: envelope,
    timeoutMs: 60_000,
  });

  // ─── 5. Load org members for mention backfill ─────────────────────────
  const memberRows = await db
    .select({ id: users.id, name: users.name })
    .from(orgMembers)
    .innerJoin(users, eq(orgMembers.user_id, users.id))
    .where(eq(orgMembers.org_id, orgId));
  const members: OrgMember[] = memberRows.map((r) => ({
    id: r.id,
    name: r.name ?? '',
  }));

  // ─── 6. Parse the reply + persist the message row ──────────────────────
  const { message: inserted, turn } = await parseReplyIntoMessage({
    sseStream: stream,
    employee: {
      id: employee.id,
      org_id: employee.org_id,
      slug: employee.slug,
      user_id: employee.user_id,
      trust_level: employee.trust_level,
    },
    context: {
      space_id: spaceId,
      parent_id: threadParentId,
      org_id: orgId,
      trigger_kind: triggerKind,
      triggering_message_id: overrideTrigger ? null : messageId,
      input_messages: envelope.messages,
      start_time_ms: startTime,
    },
    orgMembers: members,
  });

  // ─── 7. Persist the inspector turn ────────────────────────────────────
  await db.insert(agentSessionTurns).values({
    org_id: turn.org_id,
    employee_id: turn.employee_id,
    trigger_kind: turn.trigger_kind,
    triggering_message_id: turn.triggering_message_id,
    space_id: turn.space_id,
    input_messages_json: turn.input_messages_json,
    raw_reply_text: turn.raw_reply_text,
    latency_ms: turn.latency_ms,
    model_name: turn.model_name,
    tokens_in: turn.tokens_in,
    tokens_out: turn.tokens_out,
    result: turn.result,
    error: turn.error,
  });

  if (!inserted.id) {
    console.warn(
      `[openclaw-dispatch] Empty reply from ${employee.slug}, no message posted`,
    );
    return;
  }

  // ─── 8. Increment daily action count ──────────────────────────────────
  await db.execute(
    sql`UPDATE agent_employees SET daily_action_count = daily_action_count + 1 WHERE id = ${employee.id} AND daily_action_count < max_daily_actions`,
  );

  // ─── 9. Broadcast via socket.io ───────────────────────────────────────
  const [agentUserData] = await db
    .select({ name: users.name, avatar_url: users.avatar_url })
    .from(users)
    .where(eq(users.id, employee.user_id))
    .limit(1);

  const messageWithUser = {
    ...inserted,
    user_name: agentUserData?.name ?? employee.name,
    user_avatar: agentUserData?.avatar_url ?? null,
    reactions: [],
    reply_count: 0,
    latest_reply_at: null,
  };

  const io = getIO();
  if (io) {
    io.to(`space:${spaceId}`).emit('message:new', messageWithUser);

    if (threadParentId) {
      const [replyStats] = await db
        .select({
          count: sql<number>`count(*)::int`,
          latest: sql<string>`to_char(max(${messages.created_at}), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
        })
        .from(messages)
        .where(
          and(
            eq(messages.parent_id, threadParentId),
            eq(messages.is_deleted, false),
          ),
        );

      io.to(`space:${spaceId}`).emit('thread:updated', {
        parent_id: threadParentId,
        reply_count: replyStats?.count ?? 1,
        latest_reply_at: replyStats?.latest ?? inserted.created_at,
      });
    }
  }

  console.log(
    `[openclaw-dispatch] Posted reply ${inserted.id} from ${employee.slug} (kind=${triggerKind}, latency=${turn.latency_ms}ms, tokens=${turn.tokens_in}/${turn.tokens_out})`,
  );
}
