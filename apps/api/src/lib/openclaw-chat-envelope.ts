/**
 * OpenClaw chat envelope adapter.
 *
 * `buildChatCompletionRequest` packages a Deft thread into a standard
 * OpenAI-compatible chat completions request. Per §4.1 of the Deft Agentic
 * Vision plan, this function deliberately does NOT build a dynamic system
 * message. OpenClaw owns its system prompt and per-turn context flows
 * through the `platform_context` MCP tool instead.
 *
 * `parseReplyIntoMessage` consumes the SSE stream OpenClaw returns, concats
 * text deltas, strips any tool_use bleed-through, backfills @mentions into
 * Deft's pill syntax, persists the reply as a new `messages` row, and
 * returns the row plus an `agent_session_turns` payload for the caller to
 * persist for the inspector.
 *
 * `backfillMentions` rewrites `@Firstname` tokens that appear outside code
 * fences into `<@user-id|Name>` pill syntax so they light up in the UI.
 */
import { eq, and, inArray } from 'drizzle-orm';
import { db } from './db.js';
import {
  messages,
  users,
  orgMembers as orgMembersTable,
  agentActions,
} from '@deft/db/schema';
import type { TrustLevel } from './mcp-tools/types.js';
import { generateReceipt } from './receipts.js';
import { getApprovalTier } from './agent-approval.js';

// Minimal shapes — the real Message/Employee types live in the routes layer.
type MessageLike = {
  id?: string;
  user_id: string;
  user_name?: string;
  content: string;
};

type AgentEmployeeLike = {
  id: string;
  org_id: string;
  slug: string;
  user_id: string;
  trust_level: TrustLevel;
};

export type TriggerDescriptor = {
  kind: string;
  summary?: string;
  goal?: string;
  context?: Record<string, unknown>;
};

export type ChatRole = 'user' | 'assistant' | 'system';

export type ChatMessage = { role: ChatRole; content: string };

export type OpenAIChatCompletionRequest = {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
};

export type OrgMember = { id: string; name: string };

export function formatTriggerAsMessage(trigger: TriggerDescriptor): string {
  const parts = [`[trigger:${trigger.kind}]`];
  if (trigger.goal) parts.push(`goal: ${trigger.goal}`);
  if (trigger.summary) parts.push(trigger.summary);
  if (trigger.context) parts.push(`context: ${JSON.stringify(trigger.context)}`);
  return parts.join('\n');
}

export type BuildChatCompletionRequestParams = {
  employee: AgentEmployeeLike;
  threadContext: {
    parentMessage?: MessageLike;
    replies: MessageLike[];
  };
  triggerMessage: MessageLike | TriggerDescriptor;
};

function isMessageLike(t: MessageLike | TriggerDescriptor): t is MessageLike {
  return (
    typeof (t as MessageLike).content === 'string' &&
    typeof (t as MessageLike).user_id === 'string'
  );
}

export async function buildChatCompletionRequest(
  params: BuildChatCompletionRequestParams,
): Promise<OpenAIChatCompletionRequest> {
  const messagesOut: ChatMessage[] = [];

  if (params.threadContext.parentMessage) {
    const m = params.threadContext.parentMessage;
    messagesOut.push({
      role: 'user',
      content: `[${m.user_name ?? 'user'}]: ${m.content}`,
    });
  }

  for (const reply of params.threadContext.replies) {
    const isSelf = reply.user_id === params.employee.user_id;
    messagesOut.push({
      role: isSelf ? 'assistant' : 'user',
      content: isSelf
        ? reply.content
        : `[${reply.user_name ?? 'user'}]: ${reply.content}`,
    });
  }

  const trigger = params.triggerMessage;
  if (isMessageLike(trigger)) {
    messagesOut.push({
      role: 'user',
      content: `[${trigger.user_name ?? 'user'}]: ${trigger.content}`,
    });
  } else {
    messagesOut.push({
      role: 'user',
      content: formatTriggerAsMessage(trigger),
    });
  }

  return {
    model: `openclaw/${params.employee.slug}`,
    messages: messagesOut,
    stream: true,
  };
}

// ─── parseReplyIntoMessage ────────────────────────────────────────────────

export type ParseReplyParams = {
  sseStream: ReadableStream<Uint8Array> | NodeJS.ReadableStream;
  employee: AgentEmployeeLike;
  context: {
    space_id: string;
    parent_id: string | null;
    org_id: string;
    trigger_kind?: string;
    triggering_message_id?: string | null;
    input_messages?: ChatMessage[];
    start_time_ms?: number;
  };
  orgMembers?: OrgMember[];
};

export type AgentSessionTurnInsert = {
  org_id: string;
  employee_id: string;
  trigger_kind: string;
  triggering_message_id: string | null;
  space_id: string | null;
  input_messages_json: unknown;
  raw_reply_text: string | null;
  latency_ms: number;
  model_name: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  result: 'success' | 'timeout' | 'error' | 'rejected_approval';
  error: string | null;
};

export type ParseReplyResult = {
  message: typeof messages.$inferSelect;
  turn: AgentSessionTurnInsert;
};

type StreamDelta = {
  choices?: Array<{
    delta?: { content?: string | null; role?: string };
    finish_reason?: string | null;
  }>;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

async function readWholeStream(
  stream: ReadableStream<Uint8Array> | NodeJS.ReadableStream,
): Promise<string> {
  // Handle Web ReadableStream
  if (typeof (stream as ReadableStream<Uint8Array>).getReader === 'function') {
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) buf += decoder.decode(value, { stream: true });
    }
    buf += decoder.decode();
    return buf;
  }

  // Handle Node Readable
  const chunks: Buffer[] = [];
  for await (const chunk of stream as NodeJS.ReadableStream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Parse a standard OpenAI Server-Sent-Events stream. Each event is a
 * `data: ...` line; the payload `[DONE]` terminates the stream. We accumulate
 * text deltas, record the model slug if present, and capture token usage from
 * whichever delta carries it (OpenClaw may put it on the final event).
 */
export function parseSseBuffer(buf: string): {
  text: string;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
} {
  let text = '';
  let model: string | null = null;
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;

  const lines = buf.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === '[DONE]') break;
    let parsed: StreamDelta;
    try {
      parsed = JSON.parse(payload) as StreamDelta;
    } catch {
      continue;
    }
    if (parsed.model && !model) model = parsed.model;
    if (parsed.usage) {
      if (typeof parsed.usage.prompt_tokens === 'number') {
        tokensIn = parsed.usage.prompt_tokens;
      }
      if (typeof parsed.usage.completion_tokens === 'number') {
        tokensOut = parsed.usage.completion_tokens;
      }
    }
    const choices = parsed.choices ?? [];
    for (const ch of choices) {
      const content = ch?.delta?.content;
      if (typeof content === 'string') {
        text += content;
      }
    }
  }

  return { text, model, tokens_in: tokensIn, tokens_out: tokensOut };
}

/**
 * Strip stray `<tool_use>` / `<tool_result>` XML blocks that some OpenAI-
 * compatible providers occasionally leak into assistant content. Real MCP
 * tool calls go through the Gateway's own tool loop so they should never
 * appear in the final text we post into the chat surface, but we defensively
 * remove them here so a misbehaving provider can't break the UI.
 */
function stripToolUseBleed(text: string): string {
  return text
    .replace(/<tool_use\b[^>]*>[\s\S]*?<\/tool_use>/gi, '')
    .replace(/<tool_result\b[^>]*>[\s\S]*?<\/tool_result>/gi, '')
    .trim();
}

export async function parseReplyIntoMessage(
  params: ParseReplyParams,
): Promise<ParseReplyResult> {
  const start = params.context.start_time_ms ?? Date.now();

  let text = '';
  let modelName: string | null = null;
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  let result: AgentSessionTurnInsert['result'] = 'success';
  let errorMsg: string | null = null;

  try {
    const buf = await readWholeStream(params.sseStream);
    const parsed = parseSseBuffer(buf);
    text = stripToolUseBleed(parsed.text);
    modelName = parsed.model;
    tokensIn = parsed.tokens_in;
    tokensOut = parsed.tokens_out;
    if (!text) {
      result = 'error';
      errorMsg = 'empty reply from OpenClaw stream';
    }
  } catch (err) {
    result = 'error';
    errorMsg = err instanceof Error ? err.message : String(err);
    text = '';
  }

  // Load org members for mention backfill if the caller didn't provide them.
  const members: OrgMember[] = params.orgMembers
    ? params.orgMembers
    : await loadOrgMembers(params.employee.org_id);

  const finalContent = text ? backfillMentions(text, members) : '';

  // Insert the message row. We only insert on a non-empty reply — callers
  // that get back an error-result turn can still log the turn for the
  // inspector but the thread stays clean.
  let inserted: typeof messages.$inferSelect | undefined;
  if (finalContent) {
    // Phase 7 — OpenClaw replies bypass the MCP layer entirely, so we
    // insert a synthetic agent_actions row first to give the receipt FK
    // a target. The row is stamped approved+executed so the action log
    // UI renders it alongside other auto-exec rows.
    let envActionId: string | null = null;
    try {
      const now = new Date();
      const triggerKind = params.context.trigger_kind ?? 'chat_mention';
      const [actionRow] = await db
        .insert(agentActions)
        .values({
          org_id: params.context.org_id,
          user_id: params.employee.user_id,
          agent_employee_id: params.employee.id,
          source: 'mcp',
          action: 'message_post',
          params: {
            space_id: params.context.space_id,
            content: finalContent.slice(0, 500),
            trigger_kind: triggerKind,
          } as Record<string, unknown>,
          approval_tier: getApprovalTier('message_post'),
          approval_status: 'approved',
          approved_at: now,
          executed_at: now,
        })
        .returning({ id: agentActions.id });
      envActionId = actionRow?.id ?? null;
    } catch (err) {
      console.error('[openclaw-envelope] synthetic action row insert failed:', err);
    }

    const rows = await db
      .insert(messages)
      .values({
        org_id: params.context.org_id,
        space_id: params.context.space_id,
        user_id: params.employee.user_id,
        content: finalContent,
        parent_id: params.context.parent_id,
        metadata: {
          is_agent_reply: true,
          openclaw_origin: {
            employee_id: params.employee.id,
            slug: params.employee.slug,
            latency_ms: Date.now() - start,
            model_name: modelName,
            tokens_in: tokensIn,
            tokens_out: tokensOut,
          },
        },
      })
      .returning();
    inserted = rows[0];

    if (envActionId) {
      try {
        await db
          .update(agentActions)
          .set({
            result: {
              message_id: inserted?.id,
              model_name: modelName,
            } as any,
          })
          .where(eq(agentActions.id, envActionId));
      } catch (err) {
        console.error('[openclaw-envelope] result patch failed:', err);
      }
      await generateReceipt({
        actionId: envActionId,
        orgId: params.context.org_id,
        employeeId: params.employee.id,
        proposer: 'employee',
        proposerId: params.employee.id,
        decision: 'auto_executed',
        decisionReason: `openclaw_reply:${params.context.trigger_kind ?? 'chat_mention'}`,
        actionName: 'message_post',
        actionParams: {
          space_id: params.context.space_id,
          content: finalContent.slice(0, 500),
          trigger_kind: params.context.trigger_kind ?? 'chat_mention',
        },
        resultJson: inserted
          ? { id: inserted.id, space_id: inserted.space_id }
          : null,
      });
    }
  }

  const turn: AgentSessionTurnInsert = {
    org_id: params.context.org_id,
    employee_id: params.employee.id,
    trigger_kind: params.context.trigger_kind ?? 'chat_mention',
    triggering_message_id:
      params.context.triggering_message_id ?? params.context.parent_id ?? null,
    space_id: params.context.space_id ?? null,
    input_messages_json: params.context.input_messages ?? [],
    raw_reply_text: finalContent || null,
    latency_ms: Date.now() - start,
    model_name: modelName,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    result,
    error: errorMsg,
  };

  if (!inserted) {
    // The caller still needs a Message-shaped object. Build a synthetic one
    // so downstream broadcast code can no-op cleanly. result='error' on the
    // turn row tells the inspector what happened.
    inserted = {
      id: '',
      org_id: params.context.org_id,
      space_id: params.context.space_id,
      user_id: params.employee.user_id,
      content: finalContent,
      parent_id: params.context.parent_id,
      is_pinned: false,
      is_deleted: false,
      edited_at: null,
      metadata: null,
      created_at: new Date(),
      updated_at: new Date(),
    } as unknown as typeof messages.$inferSelect;
  }

  return { message: inserted, turn };
}

async function loadOrgMembers(orgId: string): Promise<OrgMember[]> {
  try {
    const rows = await db
      .select({ id: users.id, name: users.name })
      .from(orgMembersTable)
      .innerJoin(users, eq(orgMembersTable.user_id, users.id))
      .where(eq(orgMembersTable.org_id, orgId));
    return rows.map((r) => ({ id: r.id, name: r.name ?? '' }));
  } catch {
    return [];
  }
}

// ─── backfillMentions ─────────────────────────────────────────────────────

/**
 * Scan `content` for `@Firstname` tokens outside code fences and rewrite them
 * into `<@user-id|Name>` pill syntax. Ambiguous first names (two members
 * named Priya) are intentionally left as plain text — we prefer a missed
 * mention over a wrong one.
 *
 * Protected regions:
 *   - triple-backtick fenced code blocks (```...```)
 *   - single-backtick inline code (`...`)
 *
 * Matching is Unicode-letter-aware and consumes only the first whitespace-
 * or punctuation-delimited name token, so `@Priya, hi` rewrites to
 * `<@...|Priya>, hi`.
 */
export function backfillMentions(
  content: string,
  orgMembers: ReadonlyArray<OrgMember>,
): string {
  if (!content || orgMembers.length === 0) return content;

  // Build first-name → id map. Count duplicates so ambiguous names can be
  // left untouched.
  const counts = new Map<string, number>();
  const idByName = new Map<string, { id: string; displayName: string }>();
  for (const m of orgMembers) {
    if (!m.name) continue;
    const first = m.name.split(/\s+/)[0];
    if (!first) continue;
    const key = first.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
    // Store the first occurrence so we have a stable display name.
    if (!idByName.has(key)) {
      idByName.set(key, { id: m.id, displayName: first });
    }
  }

  // Walk `content` and split into alternating "protected" (code) and
  // "plain" regions. We apply the mention rewrite only to plain regions.
  const regions = splitCodeRegions(content);
  const rewritten = regions.map((r) =>
    r.protected ? r.text : rewritePlainRegion(r.text, counts, idByName),
  );
  return rewritten.join('');
}

type Region = { text: string; protected: boolean };

function splitCodeRegions(content: string): Region[] {
  const out: Region[] = [];
  let i = 0;
  const n = content.length;
  let plainStart = 0;

  while (i < n) {
    // Fenced code block: ```...```
    if (content.startsWith('```', i)) {
      if (plainStart < i) {
        out.push({ text: content.slice(plainStart, i), protected: false });
      }
      const end = content.indexOf('```', i + 3);
      if (end === -1) {
        // Unterminated fence — treat the rest as protected to be safe.
        out.push({ text: content.slice(i), protected: true });
        return out;
      }
      out.push({ text: content.slice(i, end + 3), protected: true });
      i = end + 3;
      plainStart = i;
      continue;
    }
    // Inline code: `...`
    if (content[i] === '`') {
      if (plainStart < i) {
        out.push({ text: content.slice(plainStart, i), protected: false });
      }
      const end = content.indexOf('`', i + 1);
      if (end === -1) {
        out.push({ text: content.slice(i), protected: false });
        return out;
      }
      out.push({ text: content.slice(i, end + 1), protected: true });
      i = end + 1;
      plainStart = i;
      continue;
    }
    i++;
  }

  if (plainStart < n) {
    out.push({ text: content.slice(plainStart), protected: false });
  }
  return out;
}

function rewritePlainRegion(
  text: string,
  counts: Map<string, number>,
  idByName: Map<string, { id: string; displayName: string }>,
): string {
  // \p{L} = any kind of letter, \p{N} = any digit; handles non-ASCII names.
  const re = /@([\p{L}][\p{L}\p{N}_-]*)/gu;
  return text.replace(re, (match, name: string) => {
    const key = name.toLowerCase();
    const count = counts.get(key) ?? 0;
    if (count !== 1) return match; // ambiguous or unknown — leave plain
    const hit = idByName.get(key);
    if (!hit) return match;
    return `<@${hit.id}|${hit.displayName}>`;
  });
}
