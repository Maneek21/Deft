/**
 * Phase 3 stub for the OpenClaw chat envelope adapter.
 *
 * Only `buildChatCompletionRequest` is implemented here — Phase 5 fills in
 * `parseReplyIntoMessage` and `backfillMentions` when the chat trigger
 * dispatcher lands.
 *
 * Per §4.1 of the Deft Agentic Vision plan, this function deliberately does
 * NOT build a dynamic system message. OpenClaw owns its system prompt and
 * per-turn context flows through the `platform_context` MCP tool instead.
 * We only package the thread history + the trigger as a standard
 * OpenAI-compatible chat completion request.
 */
import type { TrustLevel } from './mcp-tools/types.js';

// Minimal shapes — the real Message/Employee types live in the routes layer.
// Keeping this stub self-contained so Phase 5 can tighten the imports.
type MessageLike = {
  id?: string;
  user_id: string;
  user_name?: string;
  content: string;
};

type AgentEmployeeLike = {
  id: string;
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

export async function buildChatCompletionRequest(
  params: BuildChatCompletionRequestParams,
): Promise<OpenAIChatCompletionRequest> {
  const messages: ChatMessage[] = [];

  if (params.threadContext.parentMessage) {
    const m = params.threadContext.parentMessage;
    messages.push({
      role: 'user',
      content: `[${m.user_name ?? 'user'}]: ${m.content}`,
    });
  }

  for (const reply of params.threadContext.replies) {
    const isSelf = reply.user_id === params.employee.user_id;
    messages.push({
      role: isSelf ? 'assistant' : 'user',
      content: isSelf
        ? reply.content
        : `[${reply.user_name ?? 'user'}]: ${reply.content}`,
    });
  }

  const trigger = params.triggerMessage;
  if ('content' in trigger && typeof trigger.content === 'string') {
    const m = trigger as MessageLike;
    messages.push({
      role: 'user',
      content: `[${m.user_name ?? 'user'}]: ${m.content}`,
    });
  } else {
    messages.push({
      role: 'user',
      content: formatTriggerAsMessage(trigger as TriggerDescriptor),
    });
  }

  return {
    model: `openclaw/${params.employee.slug}`,
    messages,
    stream: true,
  };
}

// ─── Phase 5 pickup points ────────────────────────────────────────────────

/** @see Phase 5 — parse a streaming OpenAI chat completion reply into a Deft message row. */
export async function parseReplyIntoMessage(..._args: unknown[]): Promise<never> {
  throw new Error('parseReplyIntoMessage is a Phase 5 deliverable (not yet implemented)');
}

/** @see Phase 5 — rewrite `@username` tokens in a reply into `<@user-id>` mention spans. */
export function backfillMentions(content: string, _orgMembers: unknown[]): string {
  // Phase 5 will wire this up against the real Member list shape.
  return content;
}
