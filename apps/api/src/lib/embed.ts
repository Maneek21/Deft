// BYO-embedding-provider abstraction.
//
// Centralizes the "turn text into a 1536-dim vector" path. Every site that
// previously hit https://api.openai.com/v1/embeddings directly should call
// `embed()` instead. Returns null when no provider is configured — callers
// must already handle that (FTS-only fallback paths exist in
// retrieve-context.ts and embed-content.ts).
//
// Why pinned to 1536 dims: the schema's `vector(1536)` columns predate this
// abstraction. Allowing other dim counts would require either per-row dim
// metadata or schema migrations. Self-hosters who want fully-local
// embeddings can run an OpenAI-compatible server (LM Studio, vllm, llama.cpp
// server) that emits 1536-dim vectors and point `embed_base_url` at it.
//
// Storage shape (in `orgs.ai_config.embed`):
//   {
//     provider: "openai" | "off",
//     base_url: "https://api.openai.com/v1",  // overridable for local servers
//     model:    "text-embedding-3-small"
//   }

import { eq } from 'drizzle-orm';
import { db } from './db.js';
import { orgs } from '@deft/db/schema';
import { decrypt } from './encryption.js';
import { env } from './env.js';

export const EMBED_DIMS = 1536;

export type EmbedProvider = 'openai' | 'off';

export type EmbedConfig = {
  provider: EmbedProvider;
  base_url: string;
  model: string;
  /** Resolved at call-time; org-level OpenAI key first, env fallback. */
  api_key: string;
};

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'text-embedding-3-small';

type StoredAIConfig = {
  api_keys?: { openai?: string };
  embed?: {
    provider?: EmbedProvider;
    base_url?: string;
    model?: string;
  };
};

function safeDecrypt(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    return decrypt(value);
  } catch {
    return null;
  }
}

async function loadOrgEmbedConfig(orgId: string | null | undefined): Promise<EmbedConfig> {
  let stored: StoredAIConfig = {};
  if (orgId) {
    const [row] = await db.select({ ai_config: orgs.ai_config }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
    stored = (row?.ai_config ?? {}) as StoredAIConfig;
  }

  const provider: EmbedProvider = stored.embed?.provider ?? 'openai';
  const base_url = stored.embed?.base_url || DEFAULT_BASE_URL;
  const model = stored.embed?.model || DEFAULT_MODEL;
  const api_key = safeDecrypt(stored.api_keys?.openai) || env.OPENAI_API_KEY || '';

  return { provider, base_url, model, api_key };
}

/**
 * Embed `text` into a 1536-dim vector for the given org. Returns null when:
 *   - the org has set provider=off
 *   - no API key is available (org or env) AND the base_url is the public
 *     OpenAI host (local OpenAI-compatible servers usually don't require a key)
 *
 * Throws on network/HTTP failure so worker queues can retry.
 */
export async function embed(text: string, orgId: string | null | undefined): Promise<number[] | null> {
  const cfg = await loadOrgEmbedConfig(orgId);

  if (cfg.provider === 'off') return null;

  // If pointing at api.openai.com but no key is set, bail. For self-hosted
  // OpenAI-compatible servers, an empty key is fine — many don't enforce auth.
  const isPublicOpenAI = /api\.openai\.com/i.test(cfg.base_url);
  if (isPublicOpenAI && !cfg.api_key) return null;

  // Cap input to avoid token-limit errors. ~32k chars ≈ 8k tokens — safe for
  // text-embedding-3-small.
  const trimmed = text.slice(0, 32_000);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.api_key) headers['Authorization'] = `Bearer ${cfg.api_key}`;

  const url = `${cfg.base_url.replace(/\/$/, '')}/embeddings`;
  const res = await globalThis.fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: cfg.model,
      input: trimmed,
      dimensions: EMBED_DIMS,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Embedding ${cfg.provider} ${res.status}: ${body.slice(0, 500)}`);
  }

  const json = (await res.json()) as { data?: { embedding?: number[] }[] };
  const vec = json.data?.[0]?.embedding;
  if (!Array.isArray(vec)) {
    throw new Error('Embedding response missing data[0].embedding');
  }
  if (vec.length !== EMBED_DIMS) {
    throw new Error(`Embedding returned ${vec.length} dims, expected ${EMBED_DIMS}`);
  }
  if (vec.some((v) => !Number.isFinite(v))) {
    throw new Error('Embedding contains non-finite values');
  }

  return vec;
}

/**
 * Quiet variant for query-time use. Returns null on any failure so the caller
 * gracefully falls back to FTS-only ranking. Use this in retrieve-context.ts;
 * use `embed()` directly in workers where job-retry is desired.
 */
export async function embedQuiet(text: string, orgId: string | null | undefined): Promise<number[] | null> {
  try {
    return await embed(text, orgId);
  } catch (err) {
    console.warn('[embed] quiet failure — falling back:', (err as Error).message);
    return null;
  }
}

/**
 * UI-safe view of the embedding config. Used by /api/org/ai-config.
 */
export type EmbedConfigMasked = {
  provider: EmbedProvider;
  base_url: string;
  model: string;
  /** True when an OpenAI key (org or env) is reachable. */
  has_key: boolean;
};

export async function getEmbedConfigMasked(orgId: string): Promise<EmbedConfigMasked> {
  const cfg = await loadOrgEmbedConfig(orgId);
  return {
    provider: cfg.provider,
    base_url: cfg.base_url,
    model: cfg.model,
    has_key: Boolean(cfg.api_key),
  };
}

export async function setEmbedConfig(
  orgId: string,
  partial: { provider?: EmbedProvider; base_url?: string | null; model?: string | null },
): Promise<void> {
  const [row] = await db.select({ ai_config: orgs.ai_config }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  const stored = (row?.ai_config ?? {}) as StoredAIConfig;
  const next = { ...stored, embed: { ...(stored.embed ?? {}) } };

  if (partial.provider) next.embed.provider = partial.provider;
  if (partial.base_url === null) delete next.embed.base_url;
  else if (typeof partial.base_url === 'string' && partial.base_url.trim()) next.embed.base_url = partial.base_url.trim();
  if (partial.model === null) delete next.embed.model;
  else if (typeof partial.model === 'string' && partial.model.trim()) next.embed.model = partial.model.trim();

  await db.update(orgs).set({ ai_config: next }).where(eq(orgs.id, orgId));
}
