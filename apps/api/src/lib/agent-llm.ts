/**
 * Provider-agnostic agent reasoning primitive.
 *
 * Defty's reasoning loops (agent-runner.ts, agent-stream-loop.ts) were written
 * against the Anthropic SDK — Anthropic-shaped `messages`, `tools`, and
 * `tool_use`/`tool_result` content blocks. This module exposes one function,
 * `createAgentMessage`, that accepts that same Anthropic shape but dispatches
 * to whichever provider the org pinned for the `reason` task and returns a
 * normalized Anthropic-shaped response. That lets the loops stay unchanged in
 * their data model while gaining OpenAI / OpenRouter / Ollama support.
 *
 * Both loops use the NON-streaming `messages.create` (they fake-stream the
 * returned text word-by-word), so this primitive is non-streaming too — no SSE
 * delta handling required.
 *
 * Translation responsibilities for non-Anthropic providers:
 *   - request: Anthropic system+messages+tools → OpenAI/Ollama chat shape
 *   - response: OpenAI/Ollama choice → Anthropic content blocks (text + tool_use)
 *   - prompt caching (cache_control) is Anthropic-only and applied here, so
 *     callers pass a plain `system` string + plain `tools`.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { ResolvedReasonProvider } from './org-ai-config.js';

export type AgentMessageResult = {
  content: Anthropic.ContentBlock[];
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number; cache_read?: number; cache_write?: number };
};

export type CreateAgentMessageParams = {
  resolved: ResolvedReasonProvider;
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  maxTokens: number;
  abortSignal?: AbortSignal;
};

export async function createAgentMessage(p: CreateAgentMessageParams): Promise<AgentMessageResult> {
  switch (p.resolved.provider) {
    case 'anthropic':
      return callAnthropicAgent(p);
    case 'openai':
    case 'openrouter':
      return callOpenAIAgent(p);
    case 'ollama':
      return callOllamaAgent(p);
    default:
      throw new Error(`Unsupported agent provider: ${(p.resolved as any).provider}`);
  }
}

// ─── Anthropic (native passthrough + prompt caching) ───

async function callAnthropicAgent(p: CreateAgentMessageParams): Promise<AgentMessageResult> {
  if (!p.resolved.apiKey) throw new Error('Anthropic API key not configured (org or env)');
  const anthropic = new Anthropic({ apiKey: p.resolved.apiKey, timeout: 60_000, maxRetries: 1 });

  // Two cache breakpoints: end of system, end of tools list — both stable
  // across iterations within a turn, so re-reads cost 10%.
  const cachedSystem: Anthropic.TextBlockParam[] = [
    { type: 'text', text: p.system, cache_control: { type: 'ephemeral' } },
  ];
  const cachedTools: Anthropic.Tool[] =
    p.tools.length > 0
      ? [...p.tools.slice(0, -1), { ...p.tools[p.tools.length - 1]!, cache_control: { type: 'ephemeral' } }]
      : p.tools;

  const response = await anthropic.messages.create(
    {
      model: p.resolved.model,
      max_tokens: p.maxTokens,
      system: cachedSystem,
      messages: p.messages,
      tools: cachedTools,
    },
    p.abortSignal ? { signal: p.abortSignal } : undefined,
  );

  return {
    content: response.content,
    stop_reason: response.stop_reason,
    usage: {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
      cache_read: (response.usage as any)?.cache_read_input_tokens ?? 0,
      cache_write: (response.usage as any)?.cache_creation_input_tokens ?? 0,
    },
  };
}

// ─── OpenAI / OpenRouter (OpenAI-compatible chat/completions) ───

async function callOpenAIAgent(p: CreateAgentMessageParams): Promise<AgentMessageResult> {
  if (!p.resolved.apiKey) {
    throw new Error(`${p.resolved.provider} API key not configured (org or env)`);
  }
  const baseURL = (p.resolved.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');

  const body: any = {
    model: p.resolved.model,
    messages: toOpenAIMessages(p.system, p.messages),
    max_tokens: p.maxTokens,
  };
  if (p.tools.length > 0) {
    body.tools = toOpenAITools(p.tools);
    body.tool_choice = 'auto';
  }

  const res = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${p.resolved.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: p.abortSignal ?? AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`${p.resolved.provider} API error (${res.status}): ${t.slice(0, 500)}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  return {
    content: fromOpenAIMessage(choice?.message),
    stop_reason: mapFinishReason(choice?.finish_reason),
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
    },
  };
}

// ─── Ollama (/api/chat, OpenAI-ish tool calling on capable models) ───

async function callOllamaAgent(p: CreateAgentMessageParams): Promise<AgentMessageResult> {
  const baseURL = (p.resolved.baseUrl || 'http://localhost:11434').replace(/\/$/, '');

  const body: any = {
    model: p.resolved.model,
    messages: toOllamaMessages(p.system, p.messages),
    stream: false,
  };
  if (p.tools.length > 0) {
    body.tools = toOpenAITools(p.tools);
  }

  const res = await fetch(`${baseURL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: p.abortSignal ?? AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`ollama API error (${res.status}): ${t.slice(0, 500)}`);
  }

  const data = await res.json();
  return {
    content: fromOllamaMessage(data.message),
    stop_reason: (data.message?.tool_calls?.length ?? 0) > 0 ? 'tool_use' : 'end_turn',
    usage: {
      input_tokens: data.prompt_eval_count ?? 0,
      output_tokens: data.eval_count ?? 0,
    },
  };
}

// ─── Request translation ───

function toOpenAITools(tools: Anthropic.Tool[]): any[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: (t as any).description || '',
      parameters: (t as any).input_schema || { type: 'object', properties: {} },
    },
  }));
}

/**
 * Anthropic message history → OpenAI chat messages.
 *   - string content passes through
 *   - assistant blocks → { content, tool_calls:[{id, function:{name, arguments}}] }
 *   - user tool_result blocks → one { role:'tool', tool_call_id, content } each
 */
function toOpenAIMessages(system: string, messages: Anthropic.MessageParam[]): any[] {
  const out: any[] = [];
  if (system) out.push({ role: 'system', content: system });

  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = m.content as any[];

    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const toolUses = blocks.filter((b) => b.type === 'tool_use');
      const msg: any = { role: 'assistant', content: text || null };
      if (toolUses.length > 0) {
        msg.tool_calls = toolUses.map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      }
      out.push(msg);
    } else {
      const toolResults = blocks.filter((b) => b.type === 'tool_result');
      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: contentToString(tr.content) });
        }
      } else {
        const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        out.push({ role: 'user', content: text });
      }
    }
  }
  return out;
}

/**
 * Like toOpenAIMessages but for Ollama: tool results are matched by order/name,
 * not id, so we emit { role:'tool', content } without tool_call_id and pass
 * tool_calls arguments as objects (Ollama's native shape).
 */
function toOllamaMessages(system: string, messages: Anthropic.MessageParam[]): any[] {
  const out: any[] = [];
  if (system) out.push({ role: 'system', content: system });

  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = m.content as any[];

    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const toolUses = blocks.filter((b) => b.type === 'tool_use');
      const msg: any = { role: 'assistant', content: text || '' };
      if (toolUses.length > 0) {
        msg.tool_calls = toolUses.map((b) => ({
          function: { name: b.name, arguments: b.input ?? {} },
        }));
      }
      out.push(msg);
    } else {
      const toolResults = blocks.filter((b) => b.type === 'tool_result');
      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          out.push({ role: 'tool', content: contentToString(tr.content) });
        }
      } else {
        const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        out.push({ role: 'user', content: text });
      }
    }
  }
  return out;
}

function contentToString(c: any): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((b: any) => (typeof b === 'string' ? b : b.text ?? JSON.stringify(b))).join('\n');
  }
  return JSON.stringify(c ?? '');
}

// ─── Response translation ───

function fromOpenAIMessage(message: any): Anthropic.ContentBlock[] {
  const blocks: any[] = [];
  if (message?.content) blocks.push({ type: 'text', text: message.content });
  for (const tc of message?.tool_calls ?? []) {
    let input: any = {};
    try {
      input = JSON.parse(tc.function?.arguments || '{}');
    } catch {
      input = {};
    }
    blocks.push({ type: 'tool_use', id: tc.id || `call_${blocks.length}`, name: tc.function?.name, input });
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
  return blocks as Anthropic.ContentBlock[];
}

function fromOllamaMessage(message: any): Anthropic.ContentBlock[] {
  const blocks: any[] = [];
  if (message?.content) blocks.push({ type: 'text', text: message.content });
  (message?.tool_calls ?? []).forEach((tc: any, i: number) => {
    // Ollama returns arguments as an object (not a JSON string) and gives no id.
    const args = tc.function?.arguments;
    const input = typeof args === 'string' ? safeParse(args) : args ?? {};
    blocks.push({ type: 'tool_use', id: `call_${i}`, name: tc.function?.name, input });
  });
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
  return blocks as Anthropic.ContentBlock[];
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function mapFinishReason(finish: string | undefined | null): string {
  switch (finish) {
    case 'tool_calls':
      return 'tool_use';
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    default:
      return finish || 'end_turn';
  }
}
