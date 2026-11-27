import { and, eq, inArray, sql } from 'drizzle-orm';
import { agentActions, messages, orgMembers } from '@deft/db/schema';
import { documents } from '@deft/db/documents';
import { db } from './db.js';
import { captureRealtimeAccessGeneration, isRealtimeAccessGenerationCurrent } from '../socket.js';
import { projectPendingDeftyMetadataForOutbound } from './defty-pending-action.js';
import { canonicalDeftyActionSql, visibleModuleActionSql } from './module-action-visibility.js';
import { visibleDocumentCondition } from './document-access.js';
import { draftTextOmittedFromMetadata } from './document-draft-params.js';

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
 * other member of the space receives only the allowlisted metadata of an
 * agent message (AGENT_METADATA_FOR_EVERYONE): the reply text, the tool names,
 * identity/status keys and a neutral marker of each proposed action (id,
 * action, tier, status). Anything else is audience-only.
 *
 * `pending_actions` entries never carry params on any outbound path: approval
 * cards load action details from the audience-checked action endpoints.
 *
 * Documents (consult rule C4; plan Task M3): a run stores a document only as
 * a reference (lib/document-audience.ts), and a document citation is shown
 * only to a viewer in that audience who can open the document now, with its
 * current title (withViewerDocumentCitations). Owners and admins included:
 * the action audience doesn't open a document.
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

/**
 * Metadata keys of agent messages (Defty replies, approval confirmations and
 * results, provider/failure notices, agent documents) that every member of the
 * space may receive: identity, status, the reply's own text and model usage.
 * `agent_blocks`, `tool_calls`, `defty_pending` and `pending_actions` are
 * projected field by field below. Every other key (sources, result copies,
 * error text, warnings, diagnostics, metrics, the action graph, and any key a
 * future writer adds) is delivered only to the action audience.
 */
const AGENT_METADATA_FOR_EVERYONE = new Set([
  'is_agent_reply', 'reply_to_message_id', 'kind', 'hidden', 'subtype', 'model', 'tokens_in', 'tokens_out',
  'duplicate_action_ids', 'rejected_module_actions', 'rejected_action_proposals', 'defty_pending_resolved_at',
  'approval_confirmation_for_message_id', 'confirmed_action_ids', 'rejected_action_ids', 'requested_by_user_id',
  'approval_proposal_original_content', 'approval_resolution_message_id',
  'approval_rejection_result_for_action_id', 'approval_execution_result_for_action_id',
  'agent_action_id', 'source_message_id', 'provider',
]);
/** Keys that make a message an agent-run message wherever they appear. */
const AGENT_RUN_MARKER_KEYS = [
  'agent_blocks', 'tool_calls', 'action_graph', 'defty_pending', 'citations',
  'approval_execution_result', 'pending_actions_error', 'pending_actions',
] as const;
const DEFTY_PENDING_FOR_EVERYONE = ['kind', 'request_message_id', 'request_text', 'question', 'created_at'] as const;

function isAgentRunMessage(metadata: Record<string, any>): boolean {
  return metadata.is_agent_reply === true || metadata.kind === 'tool_result'
    || AGENT_RUN_MARKER_KEYS.some((key) => Object.hasOwn(metadata, key));
}

function projectedAgentBlocks(metadata: Record<string, any>): Record<string, unknown>[] | undefined {
  // A tool-result row's text is the result itself, not a reply.
  if (!Array.isArray(metadata.agent_blocks) || metadata.kind === 'tool_result') return undefined;
  return metadata.agent_blocks.flatMap((block: unknown): Record<string, unknown>[] => {
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

function withoutRunDetails(metadata: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const key of Object.keys(metadata)) {
    if (AGENT_METADATA_FOR_EVERYONE.has(key)) out[key] = metadata[key];
  }
  const blocks = projectedAgentBlocks(metadata);
  if (blocks) out.agent_blocks = blocks;
  if (Array.isArray(metadata.tool_calls)) {
    out.tool_calls = metadata.tool_calls.flatMap((call: unknown) => {
      if (!isRecord(call)) return [];
      const name = typeof call.tool === 'string' ? { tool: call.tool } : typeof call.name === 'string' ? { name: call.name } : null;
      return name ? [{ ...(typeof call.id === 'string' ? { id: call.id } : {}), ...name }] : [];
    });
  }
  if (isRecord(metadata.defty_pending)) {
    const pending: Record<string, unknown> = {};
    for (const key of DEFTY_PENDING_FOR_EVERYONE) if (Object.hasOwn(metadata.defty_pending, key)) pending[key] = metadata.defty_pending[key];
    out.defty_pending = pending;
  }
  if (Object.hasOwn(metadata, 'pending_actions')) out.pending_actions = pendingActionMarkers(metadata.pending_actions);
  return out;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** True when an agent message holds anything beyond what every member may receive. */
export function hasAgentRunDetails(metadata: unknown): boolean {
  if (!isRecord(metadata) || !isAgentRunMessage(metadata)) return false;
  const everyone = withoutRunDetails(metadata);
  const full = Object.hasOwn(metadata, 'pending_actions')
    ? { ...metadata, pending_actions: pendingActionMarkers(metadata.pending_actions) }
    : metadata;
  return canonical(everyone) !== canonical(full);
}

/** Outbound metadata for one viewer: `withDetails` comes from agentRunDetailAudience. */
export function projectAgentMessageMetadata<T>(metadata: T, withDetails: boolean): T {
  // M7 fix round 5: a draft's text (a note's, canvas's or document's title and
  // text) reaches nobody through message metadata, owners and admins included,
  // whenever the reply was stored; its requester sees it on the card.
  const projected = draftTextOmittedFromMetadata(projectPendingDeftyMetadataForOutbound(metadata)) as unknown;
  if (!isRecord(projected)) return projected as T;
  const base = Object.hasOwn(projected, 'pending_actions')
    ? { ...projected, pending_actions: pendingActionMarkers(projected.pending_actions) }
    : projected;
  return (withDetails || !hasAgentRunDetails(base) ? base : withoutRunDetails(base)) as T;
}

const RESULT_ACTION_KEYS = ['approval_execution_result_for_action_id', 'approval_rejection_result_for_action_id', 'agent_action_id'] as const;

/** Stands for a result row whose markers name no single resolvable action. */
const UNRESOLVABLE_ACTION = Symbol('unresolvable-action');

/**
 * The action a result row reports on. Null when the row carries no result
 * marker. A marker that is not a valid id, or markers that name different
 * actions, resolve to no action: such a row's details go to owners/admins only
 * and never fall through to authorship.
 */
function resultActionId(metadata: unknown): string | typeof UNRESOLVABLE_ACTION | null {
  if (!isRecord(metadata)) return null;
  const named = new Set<string>();
  for (const key of RESULT_ACTION_KEYS) {
    if (!Object.hasOwn(metadata, key)) continue;
    const value = metadata[key];
    if (typeof value !== 'string' || value.length === 0 || value.length > 255) return UNRESOLVABLE_ACTION;
    named.add(value);
  }
  if (named.size > 1) return UNRESOLVABLE_ACTION;
  return named.values().next().value ?? null;
}

/** Ids of the given messages whose run details this viewer may receive. */
export async function agentRunDetailAudience(viewer: MessageDetailViewer, rows: readonly DetailMessage[]): Promise<Set<string>> {
  const candidates = rows.filter((row) => hasAgentRunDetails(row.metadata));
  if (candidates.length === 0) return new Set();
  if (viewer.role === 'owner' || viewer.role === 'admin') return new Set(candidates.map((row) => row.id));
  const granted = new Set<string>();

  // A row that records the outcome of one action (an approval execution or
  // rejection result, an agent document) has exactly that action's audience
  // under the shared rule. Its author (for example the approver) gets nothing
  // from authorship.
  const resultRows = new Map<string, string | typeof UNRESOLVABLE_ACTION>();
  for (const row of candidates) {
    const actionId = resultActionId(row.metadata);
    if (actionId) resultRows.set(row.id, actionId);
  }
  const namedActions = [...new Set(resultRows.values())].filter((id): id is string => typeof id === 'string');
  if (namedActions.length > 0) {
    const visible = await db.select({ id: agentActions.id }).from(agentActions).where(and(
      eq(agentActions.org_id, viewer.org_id),
      inArray(agentActions.id, namedActions),
      visibleModuleActionSql(viewer.role ?? undefined, { userId: viewer.id, orgId: viewer.org_id }),
    ));
    const visibleIds = new Set(visible.map((row) => row.id));
    for (const [messageId, actionId] of resultRows) if (typeof actionId === 'string' && visibleIds.has(actionId)) granted.add(messageId);
  }
  const resolved = (row: DetailMessage) => resultRows.has(row.id) || granted.has(row.id);

  // Any other run row: its author (a requester's own tool-result row).
  for (const row of candidates) if (!resolved(row) && row.user_id === viewer.id) granted.add(row.id);

  // The requester: the author of the message this reply answers (or whose
  // clarification draft it holds), in the same space.
  const replyTargets = new Map<string, DetailMessage[]>();
  for (const row of candidates) {
    if (resolved(row) || !isRecord(row.metadata)) continue;
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
  const remaining = candidates.filter((row) => !resolved(row)).map((row) => row.id);
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

/** At most this many documents are named in one projection (a page of messages). */
const MAX_PROJECTED_DOCUMENTS = 200;

/** The documents a message's run details cite (`citations` of type `document`). */
function documentCitationIds(metadata: unknown): string[] {
  if (!isRecord(metadata) || !Array.isArray(metadata.citations)) return [];
  return metadata.citations.flatMap((citation: unknown) => (isRecord(citation) && citation.type === 'document'
    && typeof citation.id === 'string' && citation.id.length > 0 && citation.id.length <= 255 ? [citation.id] : []));
}

/** The statement openableDocumentTitles runs: which of `ids` the viewer can open, with their titles. Exported for its planning test. */
export function openableDocumentTitlesQuery(viewerId: string, orgId: string, ids: readonly string[]) {
  return db.select({ id: documents.id, title: documents.title }).from(documents)
    .where(and(inArray(documents.id, [...ids]), visibleDocumentCondition(viewerId, orgId)));
}

/** The current title of each of `ids` the viewer can open now, through the one access check. */
async function openableDocumentTitles(viewer: MessageDetailViewer, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)].slice(0, MAX_PROJECTED_DOCUMENTS);
  if (unique.length === 0) return new Map();
  const rows = await openableDocumentTitlesQuery(viewer.id, viewer.org_id, unique);
  return new Map(rows.map((row) => [row.id, row.title.trim() || 'Untitled']));
}

/**
 * The metadata's document citations as this viewer may see them (rule C4):
 * each document they can open now (`titles`, from openableDocumentTitles)
 * with its current title and link, and none of the others. Other citations
 * are kept as they are.
 */
function withViewerDocumentCitations<T>(metadata: T, titles: ReadonlyMap<string, string>): T {
  if (!isRecord(metadata) || !Array.isArray(metadata.citations)) return metadata;
  if (!metadata.citations.some((citation: unknown) => isRecord(citation) && citation.type === 'document')) return metadata;
  const citations = metadata.citations.flatMap((citation: unknown) => {
    if (!isRecord(citation) || citation.type !== 'document') return [citation];
    const title = typeof citation.id === 'string' ? titles.get(citation.id) : undefined;
    return title === undefined ? [] : [{ type: 'document', id: citation.id, title, url: `/d/${citation.id}` }];
  });
  return { ...metadata, citations } as T;
}

/** Project a batch of message rows for one viewer. */
export async function projectMessagesForViewer<T extends DetailMessage>(viewer: MessageDetailViewer, rows: readonly T[]): Promise<T[]> {
  const audience = await agentRunDetailAudience(viewer, rows);
  const titles = await openableDocumentTitles(viewer, rows.filter((row) => audience.has(row.id)).flatMap((row) => documentCitationIds(row.metadata)));
  return rows.map((row) => {
    const withDetails = audience.has(row.id);
    const metadata = projectAgentMessageMetadata(row.metadata, withDetails);
    return { ...row, metadata: withDetails ? withViewerDocumentCitations(metadata, titles) : metadata };
  });
}

/**
 * Emit a new message to the sockets viewing its space. A message without run
 * details goes out as one room broadcast; otherwise each socket receives the
 * projection for its own user, resolved by the same audience rule as reads.
 * An emitter that cannot list sockets receives the projection without details.
 */
function socketUser(rooms: Set<string>, orgId: string): string | undefined {
  const prefix = `org-user:${orgId}:`;
  return [...rooms].find((name) => name.startsWith(prefix))?.slice(prefix.length);
}

type ListedSocket = { rooms: Set<string>; emit(event: string, payload: unknown): unknown };
type SpaceEmitter = {
  to(room: string): { emit(event: string, payload: unknown): unknown };
  in?(room: string): { fetchSockets(): Promise<ListedSocket[]> };
};

/** All message broadcasts reload the live row rather than replaying a retained body. */
export async function emitCurrentMessageToSpaceViewers(
  io: SpaceEmitter | null | undefined, spaceId: string, event: string, payload: unknown,
): Promise<void> {
  if (!io || !payload || typeof payload !== 'object' || !('id' in payload) || typeof payload.id !== 'string') return;
  const [message] = await db.select().from(messages).where(and(
    eq(messages.id, payload.id), eq(messages.space_id, spaceId), eq(messages.is_deleted, false),
  )).limit(1);
  if (!message) return;
  await emitMessageToSpaceViewers(io, { orgId: message.org_id, spaceId, event, message: { ...payload, ...message } });
}

export async function emitMessageToSpaceViewers(io: SpaceEmitter, input: {
  orgId: string; spaceId: string; event: string; message: DetailMessage & Record<string, unknown>;
}): Promise<void> {
  const liveSnapshot = async () => {
    const [current] = await db.select().from(messages).where(and(
      eq(messages.id, input.message.id), eq(messages.org_id, input.orgId),
      eq(messages.space_id, input.spaceId), eq(messages.is_deleted, false),
    )).limit(1);
    return current;
  };
  const source = await liveSnapshot();
  if (!source) return;
  input = { ...input, message: { ...input.message, ...source } };
  // Per-viewer metadata resolution below can itself outlive a delete or edit.
  const unchanged = async () => {
    const current = await liveSnapshot();
    return current && current.content === source.content && JSON.stringify(current.metadata) === JSON.stringify(source.metadata);
  };
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
  // Access changes (space removal, org removal, role change) bump the realtime
  // generation; if one happened while delivery was resolved, nobody gets details.
  const generation = captureRealtimeAccessGeneration();
  let resolved: { allowed: Map<string, typeof full>; current: ListedSocket[] } | null = null;
  try {
    const sockets = await io.in(room).fetchSockets();
    const userIds = [...new Set(sockets.map((socket) => socketUser(socket.rooms, input.orgId)).filter((id): id is string => Boolean(id)))];
    const members = userIds.length ? await db.select({ user_id: orgMembers.user_id, role: orgMembers.role }).from(orgMembers).where(and(
      eq(orgMembers.org_id, input.orgId), inArray(orgMembers.user_id, userIds), eq(orgMembers.is_active, true),
    )) : [];
    // Each viewer with details gets their own copy when it cites documents:
    // only those they can open, by their current title (rule C4).
    const citedDocuments = documentCitationIds(full.metadata);
    const allowed = new Map<string, typeof full>();
    for (const member of members) {
      const viewer = { id: member.user_id, org_id: input.orgId, role: member.role };
      const audience = await agentRunDetailAudience(viewer, [input.message]);
      if (!audience.has(input.message.id)) continue;
      allowed.set(member.user_id, citedDocuments.length === 0 ? full
        : { ...full, metadata: withViewerDocumentCitations(full.metadata, await openableDocumentTitles(viewer, citedDocuments)) });
    }
    // Deliver to the sockets in the room now, not the ones listed before the
    // queries: a socket that left the room gets nothing, a new one gets the
    // projection without details.
    const current = await io.in(room).fetchSockets();
    resolved = { allowed, current };
  } catch (error) {
    // Resolution failed before any socket was sent to: the space still gets
    // the message, without details, and the caller's later emits still run.
    console.warn('[agent-message-run-details] per-viewer delivery unavailable; sending without details');
    if (await unchanged()) io.to(room).emit(input.event, redacted);
    return;
  }
  const { allowed, current } = resolved;
  if (!(await unchanged())) return;
  if (!isRealtimeAccessGenerationCurrent(generation)) {
    io.to(room).emit(input.event, redacted);
    return;
  }
  for (const socket of current) {
    const userId = socketUser(socket.rooms, input.orgId);
    socket.emit(input.event, (userId && allowed.get(userId)) || redacted);
  }
}
