import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { ModelRouteSchema } from '@deft/shared';
import { eq, and } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { orgMembers } from '@deft/db/schema';
import {
  getOrgAIConfigMasked,
  getReasonProviderReadiness,
  setOrgAPIKey,
  setOrgModelRoute,
  setOrgOllamaUrl,
  hasAnyAIProvider,
  type LLMProvider,
  type LLMTask,
} from '../lib/org-ai-config.js';
import { getEmbedConfigMasked, setEmbedConfig } from '../lib/embed.js';
import { orgs } from '@deft/db/schema';
import { env } from '../lib/env.js';
import { aiProviderAddress, HOSTED_AI_ADDRESS_REFUSED, transcriptionProviderAllowed } from '../lib/ai-provider-address.js';
import { effectiveTranscriptionProvider } from '../lib/transcription.js';
import { isHostedMode } from '../lib/hosted-mode.js';

export const orgRoutes = new Hono();

/** True when the caller's stored membership (never a supplied role) may change AI settings. */
async function canManageAiSettings(c: Context): Promise<boolean> {
  const user = c.get('user') as { id: string; org_id: string };
  const [m] = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.org_id, user.org_id), eq(orgMembers.user_id, user.id)))
    .limit(1);
  return Boolean(m && (m.role === 'owner' || m.role === 'admin'));
}

async function requireAdmin(c: Context): Promise<true | Response> {
  if (!(await canManageAiSettings(c))) {
    return c.json({ error: 'Admin only', code: 'FORBIDDEN' }, 403);
  }
  return true;
}

async function readTranscriptionConfig(orgId: string): Promise<{ provider: 'local' | 'openai' | 'deepgram'; effective: 'local' | 'openai' | 'deepgram' | 'none' }> {
  const [row] = await db.select({ ai_config: orgs.ai_config }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  const stored = (row?.ai_config ?? {}) as { transcription?: { provider?: 'local' | 'openai' | 'deepgram' } };
  const orgChoice = stored.transcription?.provider;
  return {
    provider: orgChoice ?? env.TRANSCRIPTION_PROVIDER,
    // Hosted mode: local Whisper is never used, so it is never reported as in use.
    effective: effectiveTranscriptionProvider(orgChoice),
  };
}

// GET /api/org/ai-config — masked config + a summary of usable providers.
// Only people who can change the AI settings see the configuration. Everyone
// else learns whether AI is usable and nothing more: no provider, no model,
// and never any part of a stored key.
orgRoutes.get('/ai-config', async (c) => {
  const user = c.get('user');
  if (!(await canManageAiSettings(c))) {
    const reason_provider = await getReasonProviderReadiness(user.org_id);
    return c.json({
      can_manage: false,
      has_provider: await hasAnyAIProvider(user.org_id),
      has_reason_provider: reason_provider.ready,
      hosted: isHostedMode(),
    });
  }
  const masked = await getOrgAIConfigMasked(user.org_id);
  const has_provider = await hasAnyAIProvider(user.org_id);
  const reason_provider = await getReasonProviderReadiness(user.org_id);
  const embed = await getEmbedConfigMasked(user.org_id);
  const transcription = await readTranscriptionConfig(user.org_id);
  return c.json({
    ...masked,
    can_manage: true,
    has_provider,
    has_reason_provider: reason_provider.ready,
    reason_provider,
    embed,
    transcription,
    // Hosted cells refuse Ollama, custom AI addresses and local transcription;
    // the settings page hides those options when this is true.
    hosted: isHostedMode(),
  });
});

const PROVIDERS: readonly LLMProvider[] = ['anthropic', 'openai', 'openrouter', 'ollama'];
const TASKS: readonly LLMTask[] = ['classify', 'summarize', 'reason', 'extract'];

const updateSchema = z.object({
  api_keys: z
    .object({
      anthropic: z.string().optional(),
      openai: z.string().optional(),
      openrouter: z.string().optional(),
      ollama: z.string().optional(),
    })
    .optional(),
  ai_models: z
    .object({
      classify: ModelRouteSchema.nullable().optional(),
      summarize: ModelRouteSchema.nullable().optional(),
      reason: ModelRouteSchema.nullable().optional(),
      extract: ModelRouteSchema.nullable().optional(),
    })
    .optional(),
  ollama_url: z.string().nullable().optional(),
  embed: z
    .object({
      provider: z.enum(['openai', 'off']).optional(),
      base_url: z.string().nullable().optional(),
      model: z.string().nullable().optional(),
    })
    .optional(),
  transcription: z
    .object({
      provider: z.enum(['local', 'openai', 'deepgram']).nullable().optional(),
    })
    .optional(),
});

/**
 * Hosted mode refuses Ollama and custom AI addresses at save time (the same
 * rule refuses them again where the provider is resolved for use). Returns
 * the reason for the first refused address, or null. Always null self-hosted.
 */
function refusedAiAddress(data: z.infer<typeof updateSchema>): string | null {
  const decisions: ReturnType<typeof aiProviderAddress>[] = [];
  if (typeof data.ollama_url === 'string' && data.ollama_url.trim()) {
    decisions.push(aiProviderAddress('ollama', data.ollama_url));
  }
  for (const t of TASKS) {
    const route = data.ai_models?.[t];
    if (route) decisions.push(aiProviderAddress(route.provider, route.baseUrl));
  }
  if (typeof data.embed?.base_url === 'string' && data.embed.base_url.trim()) {
    decisions.push(aiProviderAddress('openai', data.embed.base_url));
  }
  for (const decision of decisions) if (!decision.allowed) return decision.reason;
  if (data.transcription?.provider && !transcriptionProviderAllowed(data.transcription.provider)) {
    return 'Local transcription is not available on hosted Deft. Use OpenAI or Deepgram.';
  }
  return null;
}

// PUT /api/org/ai-config — admin-only partial update
orgRoutes.put('/ai-config', async (c) => {
  const guard = await requireAdmin(c);
  if (guard !== true) return guard;

  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR', detail: parsed.error.message }, 400);
  }
  // Checked before anything is written, so a refused request changes nothing.
  const refused = refusedAiAddress(parsed.data);
  if (refused) return c.json({ error: refused, code: HOSTED_AI_ADDRESS_REFUSED }, 400);

  // Apply api_keys updates. Empty string = clear that provider.
  if (parsed.data.api_keys) {
    for (const p of PROVIDERS) {
      const v = parsed.data.api_keys[p];
      if (typeof v === 'string') {
        await setOrgAPIKey(user.org_id, p, v);
      }
    }
  }

  // Apply ai_models updates. null = clear that route.
  if (parsed.data.ai_models) {
    for (const t of TASKS) {
      const route = parsed.data.ai_models[t];
      if (route === undefined) continue; // not present in request — leave alone
      await setOrgModelRoute(user.org_id, t, route);
    }
  }

  // Apply ollama_url
  if (parsed.data.ollama_url !== undefined) {
    await setOrgOllamaUrl(user.org_id, parsed.data.ollama_url);
  }

  // Apply embed config
  if (parsed.data.embed) {
    await setEmbedConfig(user.org_id, parsed.data.embed);
  }

  // Apply transcription config — null clears the override and falls back to env.
  if (parsed.data.transcription !== undefined) {
    const [row] = await db
      .select({ ai_config: orgs.ai_config })
      .from(orgs)
      .where(eq(orgs.id, user.org_id))
      .limit(1);
    const stored = (row?.ai_config ?? {}) as Record<string, unknown> & { transcription?: { provider?: string } };
    const next = { ...stored };
    if (parsed.data.transcription.provider == null) {
      delete (next as { transcription?: unknown }).transcription;
    } else {
      next.transcription = { provider: parsed.data.transcription.provider };
    }
    await db.update(orgs).set({ ai_config: next }).where(eq(orgs.id, user.org_id));
  }

  const masked = await getOrgAIConfigMasked(user.org_id);
  const has_provider = await hasAnyAIProvider(user.org_id);
  const reason_provider = await getReasonProviderReadiness(user.org_id);
  const embed = await getEmbedConfigMasked(user.org_id);
  const transcription = await readTranscriptionConfig(user.org_id);
  return c.json({
    ...masked,
    can_manage: true,
    has_provider,
    has_reason_provider: reason_provider.ready,
    reason_provider,
    embed,
    transcription,
    // Hosted cells refuse Ollama, custom AI addresses and local transcription;
    // the settings page hides those options when this is true.
    hosted: isHostedMode(),
  });
});
