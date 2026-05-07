// BYOK — per-org AI provider config.
//
// Single source of truth for resolving which AI provider key + model to use
// for a given org. Falls back to env vars when the org hasn't configured a
// provider, so existing self-hosted installs with ANTHROPIC_API_KEY in env
// keep working unchanged.
//
// Storage shape (in `orgs.ai_config` JSONB):
//   {
//     api_keys: { anthropic: "<encrypted>", openai: "<encrypted>", openrouter: "<encrypted>" },
//     ai_models: {
//       classify:  { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
//       reason:    { provider: "anthropic", model: "claude-sonnet-4-20250514" },
//       summarize: { ... },
//       extract:   { ... }
//     },
//     ollama_url: "http://localhost:11434"
//   }
//
// Wire format expected by `llm()` (apps/api/src/lib/llm.ts):
//   { api_keys: { anthropic: "<plain>", ... }, ai_models: { ... } }
//
// `llm()` reads `orgConfig.api_keys[provider]` and `orgConfig.ai_models[task]`
// and falls back to env when missing — see `resolveApiKey` and `getModelConfig`
// in llm.ts.

import { eq } from 'drizzle-orm';
import { db } from './db.js';
import { orgs } from '@deft/db/schema';
import { encrypt, decrypt } from './encryption.js';
import { env } from './env.js';

export type LLMProvider = 'anthropic' | 'openai' | 'openrouter' | 'ollama';
export type LLMTask = 'classify' | 'summarize' | 'reason' | 'extract';

export type ModelRoute = {
  provider: LLMProvider;
  model: string;
  baseUrl?: string;
};

export type OrgAIConfigStored = {
  api_keys?: Partial<Record<LLMProvider, string>>; // values are encrypted
  ai_models?: Partial<Record<LLMTask, ModelRoute>>;
  ollama_url?: string;
};

export type OrgAIConfigRuntime = {
  api_keys?: Partial<Record<LLMProvider, string>>; // values are PLAIN
  ai_models?: Partial<Record<LLMTask, ModelRoute>>;
  ollama_url?: string;
};

export type OrgAIConfigMasked = {
  api_keys: Record<LLMProvider, { configured: boolean; mask: string | null }>;
  ai_models: Partial<Record<LLMTask, ModelRoute>>;
  ollama_url: string | null;
  /** True when the env has a usable fallback for that provider. */
  env_fallback: Record<LLMProvider, boolean>;
};

const PROVIDERS: readonly LLMProvider[] = ['anthropic', 'openai', 'openrouter', 'ollama'];

function safeDecrypt(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    return decrypt(value);
  } catch {
    // Corrupt or wrong-key — log a warning rather than throw so AI calls
    // gracefully fall back to env keys instead of breaking the request.
    console.warn('[org-ai-config] Failed to decrypt stored API key — ignoring');
    return null;
  }
}

async function readStored(orgId: string): Promise<OrgAIConfigStored> {
  const [row] = await db.select({ ai_config: orgs.ai_config }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  return (row?.ai_config ?? {}) as OrgAIConfigStored;
}

async function writeStored(orgId: string, next: OrgAIConfigStored): Promise<void> {
  await db.update(orgs).set({ ai_config: next }).where(eq(orgs.id, orgId));
}

/**
 * Returns a runtime-ready config (decrypted keys) suitable for passing as
 * `orgConfig` to `llm()` in apps/api/src/lib/llm.ts. Org keys take precedence
 * over env vars; both are merged so the router can fall back to env when an
 * individual provider isn't configured on the org.
 */
export async function getOrgAIConfig(orgId: string): Promise<OrgAIConfigRuntime> {
  const stored = await readStored(orgId);
  const api_keys: Partial<Record<LLMProvider, string>> = {};
  for (const p of PROVIDERS) {
    const decrypted = safeDecrypt(stored.api_keys?.[p]);
    if (decrypted) api_keys[p] = decrypted;
  }
  return {
    api_keys,
    ai_models: stored.ai_models,
    ollama_url: stored.ollama_url,
  };
}

/**
 * Resolves the Anthropic API key for an org with the same precedence as
 * `resolveApiKey` in llm.ts: org config first, env fallback. Used by the
 * streaming agent loops (agent-runner.ts, agent-stream-loop.ts,
 * agent-followups.ts, agent.ts) that bypass `llm()` and call the Anthropic
 * SDK directly.
 *
 * Returns the empty string when nothing is configured, matching `env.ANTHROPIC_API_KEY`'s
 * empty-string default — callers that need to gate behavior should check
 * truthiness, not catch a thrown error.
 */
export async function resolveAnthropicApiKey(orgId: string | null | undefined): Promise<string> {
  if (orgId) {
    const cfg = await getOrgAIConfig(orgId).catch(() => null);
    if (cfg?.api_keys?.anthropic) return cfg.api_keys.anthropic;
  }
  return env.ANTHROPIC_API_KEY || '';
}

/**
 * Returns the Anthropic model the org has chosen for a given task, falling
 * back to llm.ts defaults if unset. Useful for the streaming bypass sites
 * that hardcode `claude-haiku-4-5-20251001` / `claude-sonnet-4-20250514`.
 */
const HARDCODED_DEFAULTS: Record<LLMTask, string> = {
  classify: 'claude-haiku-4-5-20251001',
  summarize: 'claude-haiku-4-5-20251001',
  reason: 'claude-sonnet-4-20250514',
  extract: 'claude-haiku-4-5-20251001',
};

export async function resolveAnthropicModel(orgId: string | null | undefined, task: LLMTask): Promise<string> {
  if (orgId) {
    const cfg = await getOrgAIConfig(orgId).catch(() => null);
    const route = cfg?.ai_models?.[task];
    if (route?.provider === 'anthropic' && route.model) return route.model;
  }
  return HARDCODED_DEFAULTS[task];
}

/**
 * Returns the masked, UI-safe view of an org's AI config. The actual key
 * material is never returned — only a presence flag and the last 4 chars
 * for confirmation that the right key is stored.
 */
export async function getOrgAIConfigMasked(orgId: string): Promise<OrgAIConfigMasked> {
  const stored = await readStored(orgId);
  const api_keys: OrgAIConfigMasked['api_keys'] = {
    anthropic: { configured: false, mask: null },
    openai: { configured: false, mask: null },
    openrouter: { configured: false, mask: null },
    ollama: { configured: false, mask: null },
  };
  for (const p of PROVIDERS) {
    const enc = stored.api_keys?.[p];
    if (!enc) continue;
    const plain = safeDecrypt(enc);
    api_keys[p] = {
      configured: Boolean(plain),
      mask: plain ? `…${plain.slice(-4)}` : null,
    };
  }
  return {
    api_keys,
    ai_models: stored.ai_models ?? {},
    ollama_url: stored.ollama_url ?? null,
    env_fallback: {
      anthropic: Boolean(env.ANTHROPIC_API_KEY),
      openai: Boolean(env.OPENAI_API_KEY),
      openrouter: Boolean(env.OPENROUTER_API_KEY),
      ollama: Boolean(env.OLLAMA_URL && env.OLLAMA_URL !== 'http://localhost:11434') || true, // always reachable via default
    },
  };
}

/**
 * Stores or removes an encrypted provider API key on the org. Pass an empty
 * string to clear the key. Other providers' keys are left untouched.
 */
export async function setOrgAPIKey(orgId: string, provider: LLMProvider, key: string): Promise<void> {
  const stored = await readStored(orgId);
  const api_keys = { ...(stored.api_keys ?? {}) };
  if (key && key.trim().length > 0) {
    api_keys[provider] = encrypt(key.trim());
  } else {
    delete api_keys[provider];
  }
  await writeStored(orgId, { ...stored, api_keys });
}

/**
 * Sets which provider+model handles a given task. Pass `null` to clear and
 * fall back to llm.ts defaults.
 */
export async function setOrgModelRoute(orgId: string, task: LLMTask, route: ModelRoute | null): Promise<void> {
  const stored = await readStored(orgId);
  const ai_models = { ...(stored.ai_models ?? {}) };
  if (route) ai_models[task] = route;
  else delete ai_models[task];
  await writeStored(orgId, { ...stored, ai_models });
}

/**
 * Stores the org-specific Ollama base URL, or null to clear and use env default.
 */
export async function setOrgOllamaUrl(orgId: string, url: string | null): Promise<void> {
  const stored = await readStored(orgId);
  if (url && url.trim().length > 0) {
    await writeStored(orgId, { ...stored, ollama_url: url.trim() });
  } else {
    const next = { ...stored };
    delete next.ollama_url;
    await writeStored(orgId, next);
  }
}

/**
 * Returns true when the org (or env fallback) has at least one usable
 * AI provider configured. Used to drive the "AI is off — configure a key"
 * banner and to gate the `/setup-ai` redirect.
 */
export async function hasAnyAIProvider(orgId: string | null | undefined): Promise<boolean> {
  if (orgId) {
    const cfg = await getOrgAIConfig(orgId).catch(() => null);
    if (cfg?.api_keys && Object.values(cfg.api_keys).some(Boolean)) return true;
  }
  return Boolean(env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || env.OPENROUTER_API_KEY);
}
