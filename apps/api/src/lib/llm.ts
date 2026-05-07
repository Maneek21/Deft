// Unified multi-model LLM router — all LLM calls in the codebase go through this.
import { env } from './env.js';

export type LLMTask = 'classify' | 'summarize' | 'reason' | 'extract';

export type LLMProvider = 'anthropic' | 'openai' | 'openrouter' | 'ollama';

export type LLMConfig = {
  provider: LLMProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string; // for Ollama or custom endpoints
};

// Default model routing — used when org has no custom config
const DEFAULT_ROUTES: Record<LLMTask, LLMConfig> = {
  classify: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  summarize: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  reason: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
  extract: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
};

// Get the model config for a task, checking org overrides first
export function getModelConfig(task: LLMTask, orgConfig?: Record<string, any>): LLMConfig {
  // If org has custom config for this task, use it
  if (orgConfig?.ai_models?.[task]) {
    const route = orgConfig.ai_models[task] as LLMConfig;
    // For Ollama, ensure baseUrl falls through to org-level ollama_url if the
    // route itself doesn't pin one. Precedence (highest first):
    //   route.baseUrl → orgConfig.ollama_url → env.OLLAMA_URL (callOllama default)
    if (route.provider === 'ollama' && !route.baseUrl && orgConfig?.ollama_url) {
      return { ...route, baseUrl: orgConfig.ollama_url };
    }
    return route;
  }
  return DEFAULT_ROUTES[task];
}

/**
 * Convert Anthropic-style tool definitions to OpenAI function calling format.
 */
function convertToolsToOpenAIFormat(tools: any[]): any[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || {},
    },
  }));
}

/**
 * Resolve the API key for a given provider, checking orgConfig first, then env vars.
 */
function resolveApiKey(provider: LLMProvider, orgConfig?: Record<string, any>): string {
  // Check org-level API keys first
  if (orgConfig?.api_keys) {
    const orgKey = orgConfig.api_keys[provider];
    if (orgKey) return orgKey;
  }

  // Fall back to environment variables
  switch (provider) {
    case 'anthropic':
      return env.ANTHROPIC_API_KEY;
    case 'openai':
      return env.OPENAI_API_KEY;
    case 'openrouter':
      return env.OPENROUTER_API_KEY;
    case 'ollama':
      return ''; // Ollama doesn't need an API key
    default:
      return '';
  }
}

// The main function — call any LLM with a unified interface
export async function llm(params: {
  task: LLMTask;
  messages: { role: 'user' | 'assistant' | 'system'; content: string }[];
  system?: string;
  maxTokens?: number;
  tools?: any[];
  orgConfig?: Record<string, any>;
  /**
   * Retained for API compatibility with existing callers. Self-hosted v1
   * runs a single org on the operator's own API keys, so no per-org spend
   * gating is applied.
   */
  orgId?: string;
}): Promise<{
  text: string;
  toolCalls?: any[];
  usage?: { input: number; output: number };
  model: string;
}> {
  const config = getModelConfig(params.task, params.orgConfig);
  const apiKey = resolveApiKey(config.provider, params.orgConfig);

  let result: {
    text: string;
    toolCalls?: any[];
    usage?: { input: number; output: number };
    model: string;
  };
  switch (config.provider) {
    case 'anthropic':
      result = await callAnthropic(config, apiKey, params);
      break;
    case 'openai':
    case 'openrouter':
      result = await callOpenAI(config, apiKey, params);
      break;
    case 'ollama':
      result = await callOllama(config, params);
      break;
    default:
      throw new Error(`Unsupported LLM provider: ${config.provider}`);
  }

  return result;
}

async function callAnthropic(
  config: LLMConfig,
  apiKey: string,
  params: {
    messages: { role: 'user' | 'assistant' | 'system'; content: string }[];
    system?: string;
    maxTokens?: number;
    tools?: any[];
  },
): Promise<{ text: string; toolCalls?: any[]; usage?: { input: number; output: number }; model: string }> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey });

  // Filter out system messages — Anthropic uses the system parameter instead
  const nonSystemMessages = params.messages.filter((m) => m.role !== 'system');

  const createParams: any = {
    model: config.model,
    max_tokens: params.maxTokens || 1024,
    messages: nonSystemMessages,
  };

  if (params.system) {
    createParams.system = params.system;
  }

  if (params.tools && params.tools.length > 0) {
    createParams.tools = params.tools;
  }

  const response = await client.messages.create(createParams);

  // Extract text blocks
  const textBlocks = response.content.filter((b: any) => b.type === 'text');
  const text = textBlocks.map((b: any) => b.text).join('');

  // Extract tool_use blocks
  const toolUseBlocks = response.content.filter((b: any) => b.type === 'tool_use');
  const toolCalls = toolUseBlocks.length > 0
    ? toolUseBlocks.map((b: any) => ({ id: b.id, name: b.name, input: b.input }))
    : undefined;

  return {
    text,
    toolCalls,
    usage: {
      input: response.usage?.input_tokens ?? 0,
      output: response.usage?.output_tokens ?? 0,
    },
    model: config.model,
  };
}

async function callOpenAI(
  config: LLMConfig,
  apiKey: string,
  params: {
    messages: { role: 'user' | 'assistant' | 'system'; content: string }[];
    system?: string;
    maxTokens?: number;
    tools?: any[];
  },
): Promise<{ text: string; toolCalls?: any[]; usage?: { input: number; output: number }; model: string }> {
  const baseURL =
    config.provider === 'openrouter'
      ? 'https://openrouter.ai/api/v1'
      : config.baseUrl || 'https://api.openai.com/v1';

  // Build messages array — OpenAI uses system role in the messages array
  const apiMessages: { role: string; content: string }[] = [];
  if (params.system) {
    apiMessages.push({ role: 'system', content: params.system });
  }
  apiMessages.push(...params.messages);

  const body: any = {
    model: config.model,
    messages: apiMessages,
    max_tokens: params.maxTokens || 1024,
  };

  if (params.tools && params.tools.length > 0) {
    body.tools = convertToolsToOpenAIFormat(params.tools);
  }

  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const choice = data.choices?.[0];

  const text = choice?.message?.content || '';
  const toolCalls = choice?.message?.tool_calls?.length > 0
    ? choice.message.tool_calls.map((tc: any) => ({
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || '{}'),
      }))
    : undefined;

  return {
    text,
    toolCalls,
    usage: data.usage
      ? { input: data.usage.prompt_tokens, output: data.usage.completion_tokens }
      : undefined,
    model: config.model,
  };
}

async function callOllama(
  config: LLMConfig,
  params: {
    messages: { role: 'user' | 'assistant' | 'system'; content: string }[];
    system?: string;
    maxTokens?: number;
  },
): Promise<{ text: string; toolCalls?: any[]; usage?: { input: number; output: number }; model: string }> {
  const baseURL = config.baseUrl || env.OLLAMA_URL;

  // Build messages array
  const apiMessages: { role: string; content: string }[] = [];
  if (params.system) {
    apiMessages.push({ role: 'system', content: params.system });
  }
  apiMessages.push(...params.messages);

  const response = await fetch(`${baseURL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      messages: apiMessages,
      stream: false,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  return {
    text: data.message?.content || '',
    usage: data.eval_count
      ? { input: data.prompt_eval_count || 0, output: data.eval_count || 0 }
      : undefined,
    model: config.model,
  };
}
