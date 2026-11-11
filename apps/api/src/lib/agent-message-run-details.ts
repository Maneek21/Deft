import { and, eq, inArray, sql } from 'drizzle-orm';
import { agentActions, messages, orgMembers } from '@deft/db/schema';
import { db } from './db.js';
import { projectPendingDeftyMetadataForOutbound } from './defty-pending-action.js';
import { canonicalDeftyActionSql, visibleModuleActionSql } from './module-action-visibility.js';

/**
 * Run details in chat message metadata follow the Defty action audience.
 *
 * A Defty reply can carry what its run did: tool arguments and tool results
 * (`agent_blocks`, `tool_calls`), the planned action graph and a clarification
 * draft (`defty_pending.draft`). Those values can contain content from places
 * only the requester can read, so they are delivered with a message only to
 * the same audience as the actions themselves (module-action-visibility.ts):
 * the requester, an assigned approver of a Defty action anchored to the
 * message, and org owners/admins; a guest only for its own request. Every
 * other member of the space receives the reply text, the tool names and a
 * neutral marker of each proposed action (id, action, tier, status).
 *
 * `pending_actions` entries never carry params on any outbound path: approval
 * cards load action details from the audience-checked action endpoints.
 */

export type MessageDetailViewer = { id: string; org_id: string; role?: string | null };
type DetailMessage = { id: string; user_id: string; space_id?: string | null; metadata: unknown };

const PENDING_ACTION_MARKER_KEYS = ['id', 'action', 'approval_tier', 'status'] as const;

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Identity and status of each proposed action; no params, results or state. */
export function pendingActionMarkers(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => {
    if (!isRecord(entry)) return entry;
    const marker: Record<string, unknown> = {};
    for (const key of PENDING_ACTION_MARKER_KEYS) if (Object.hasOwn(entry, key)) marker[key] = entry[key];
    return marker;
  });
}

/** True when metadata holds values beyond the reply text that the audience rule governs. */
export function hasAgentRunDetails(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false;
  if (metadata.action_graph !== undefined || metadata.tool_calls !== undefined) return true;
  if (isRecord(metadata.defty_pending) && Object.hasOwn(metadata.defty_pending, 'draft')) return true;
  return Array.isArray(metadata.agent_blocks)
    && metadata.agent_blocks.some((block: unknown) => !isRecord(block) || block.type !== 'text' || Object.keys(block).some((key) => key !== 'type' && key !== 'text'));
}

function withoutRunDetails(metadata: Record<string, any>): Record<string, any> {
  const { action_graph: _graph, tool_calls: toolCalls, ...rest } = metadata;
  const out: Record<string, any> = { ...rest };
  if (Array.isArray(toolCalls)) {
    out.tool_calls = toolCalls.flatMap((call: unknown) => {
      if (!isRecord(call)) return [];
      const name = typeof call.tool === 'string' ? { tool: call.tool } : typeof call.name === 'string' ? { name: call.name } : null;
      return name ? [{ ...(typeof call.id === 'string' ? { id: call.id } : {}), ...name }] : [];
    });
  }
  if (Array.isArray(metadata.agent_blocks)) {
    out.agent_blocks = metadata.agent_blocks.flatMap((block: unknown): Record<string, unknown>[] => {
      if (!isRecord(block)) return [];
      if (block.type === 'text' && typeof block.text === 'string') return [{ type: 'text', text: block.text }];
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        return [{ type: 'tool_use', ...(typeof block.id === 'string' ? { id: block.id } : {}), name: block.name }];
      }
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        return [{ type: 'tool_result', tool_use_id: block.tool_use_id, ...(block.is_error === true ? { is_error: true } : {}) }];
      }
      return [];
    });
  }
  if (isRecord(metadata.defty_pending)) {
    const { draft: _draft, ...pending } = metadata.defty_pending;
    out.defty_pending = pending;
  }
  return out;
}

/** Outbound metadata for one viewer: `withDetails` comes from agentRunDetailAudience. */
export function projectAgentMessageMetadata<T>(metadata: T, withDetails: boolean): T {
  const projected = projectPendingDeftyMetadataForOutbound(metadata) as unknown;
  if (!isRecord(projected)) return projected as T;
  const base = Object.hasOwn(projected, 'pending_actions')
    ? { ...projected, pending_actions: pendingActionMarkers(projected.pending_actions) }
    : projected;
  return (withDetails || !hasAgentRunDetails(base) ? base : withoutRunDetails(base)) as T;
}

/** Ids of the given messages whose run details this viewer may receive. */
export async function agentRunDetailAudience(viewer: MessageDetailViewer, rows: readonly DetailMessage[]): Promise<Set<string>> {
  const candidates = rows.filter((row) => hasAgentRunDetails(row.metadata));
  if (candidates.length === 0) return new Set();
  if (viewer.role === 'owner' || viewer.role === 'admin') return new Set(candidates.map((row) => row.id));
  const granted = new Set(candidates.filter((row) => row.user_id === viewer.id).map((row) => row.id));

  // The requester: the author of the message this reply answers (or whose
  // clarification draft it holds), in the same space.
  const replyTargets = new Map<string, DetailMessage[]>();
  for (const row of candidates) {
    if (granted.has(row.id) || !isRecord(row.metadata)) continue;
    const pending = isRecord(row.metadata.defty_pending) ? row.metadata.defty_pending.request_message_id : undefined;
    for (const target of new Set([row.metadata.reply_to_message_id, pending])) {
      if (typeof target === 'string') replyTargets.set(target, [...(replyTargets.get(target) ?? []), row]);
    }
  }
  if (replyTargets.size > 0) {
    const asked = await db.select({ id: messages.id, space_id: messages.space_id }).from(messages).where(and(
      inArray(messages.id, [...replyTargets.keys()]),
      eq(messages.org_id, viewer.org_id),
      eq(messages.user_id, viewer.id),
    ));
    for (const request of asked) {
      for (const row of replyTargets.get(request.id) ?? []) {
        if (!row.space_id || row.space_id === request.space_id) granted.add(row.id);
      }
    }
  }

  // The audience of a Defty action anchored to the message, under the shared rule.
  const remaining = candidates.filter((row) => !granted.has(row.id)).map((row) => row.id);
  if (remaining.length > 0) {
    const anchored = await db.selectDistinct({ message_id: agentActions.message_id }).from(agentActions).where(and(
      eq(agentActions.org_id, viewer.org_id),
      inArray(agentActions.message_id, remaining),
      sql`(${agentActions.agent_employee_id} IS NULL OR ${canonicalDeftyActionSql()})`,
      visibleModuleActionSql(viewer.role ?? undefined, { userId: viewer.id, orgId: viewer.org_id }),
    ));
    for (const row of anchored) if (row.message_id) granted.add(row.message_id);
  }
  return granted;
}

/** Project a batch of message rows for one viewer. */
export async function projectMessagesForViewer<T extends DetailMessage>(viewer: MessageDetailViewer, rows: readonly T[]): Promise<T[]> {
  const audience = await agentRunDetailAudience(viewer, rows);
  return rows.map((row) => ({ ...row, metadata: projectAgentMessageMetadata(row.metadata, audience.has(row.id)) }));
}

/**
 * Emit a new message to the sockets viewing its space. A message without run
 * details goes out as one room broadcast; otherwise each socket receives the
 * projection for its own user, resolved by the same audience rule as reads.
 * An emitter that cannot list sockets receives the projection without details.
 */
type SpaceEmitter = {
  to(room: string): { emit(event: string, payload: unknown): unknown };
  in?(room: string): { fetchSockets(): Promise<Array<{ rooms: Set<string>; emit(event: string, payload: unknown): unknown }>> };
};

export async function emitMessageToSpaceViewers(io: SpaceEmitter, input: {
  orgId: string; spaceId: string; event: string; message: DetailMessage & Record<string, unknown>;
}): Promise<void> {
  const room = `space:${input.spaceId}`;
  const full = { ...input.message, metadata: projectAgentMessageMetadata(input.message.metadata, true) };
  if (!hasAgentRunDetails(full.metadata)) {
    io.to(room).emit(input.event, full);
    return;
  }
  const redacted = { ...input.message, metadata: projectAgentMessageMetadata(input.message.metadata, false) };
  if (!io.in) {
    io.to(room).emit(input.event, redacted);
    return;
  }
  const sockets = await io.in(room).fetchSockets();
  const prefix = `org-user:${input.orgId}:`;
  const socketUser = (rooms: Set<string>) => [...rooms].find((name) => name.startsWith(prefix))?.slice(prefix.length);
  const userIds = [...new Set(sockets.map((socket) => socketUser(socket.rooms)).filter((id): id is string => Boolean(id)))];
  const members = userIds.length ? await db.select({ user_id: orgMembers.user_id, role: orgMembers.role }).from(orgMembers).where(and(
    eq(orgMembers.org_id, input.orgId), inArray(orgMembers.user_id, userIds), eq(orgMembers.is_active, true),
  )) : [];
  const allowed = new Set<string>();
  for (const member of members) {
    const audience = await agentRunDetailAudience({ id: member.user_id, org_id: input.orgId, role: member.role }, [input.message]);
    if (audience.has(input.message.id)) allowed.add(member.user_id);
  }
  for (const socket of sockets) {
    const userId = socketUser(socket.rooms);
    socket.emit(input.event, userId && allowed.has(userId) ? full : redacted);
  }
}
