import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { orgMembers } from '@deft/db/schema';
import {
  getOrgAIConfigMasked,
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

export const orgRoutes = new Hono();

async function requireAdmin(c: Context): Promise<true | Response> {
  const user = c.get('user') as { id: string; org_id: string };
  const [m] = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.org_id, user.org_id), eq(orgMembers.user_id, user.id)))
    .limit(1);
  if (!m || (m.role !== 'owner' && m.role !== 'admin')) {
    return c.json({ error: 'Admin only', code: 'FORBIDDEN' }, 403);
  }
  return true;
}

async function readTranscriptionConfig(orgId: string): Promise<{ provider: 'local' | 'openai' | 'deepgram'; effective: 'local' | 'openai' | 'deepgram' }> {
  const [row] = await db.select({ ai_config: orgs.ai_config }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  const stored = (row?.ai_config ?? {}) as { transcription?: { provider?: 'local' | 'openai' | 'deepgram' } };
  const orgChoice = stored.transcription?.provider;
  return {
    provider: orgChoice ?? env.TRANSCRIPTION_PROVIDER,
    effective: orgChoice ?? env.TRANSCRIPTION_PROVIDER,
  };
}

// GET /api/org/ai-config — masked config + a summary of usable providers
orgRoutes.get('/ai-config', async (c) => {
  const user = c.get('user');
  const masked = await getOrgAIConfigMasked(user.org_id);
  const has_provider = await hasAnyAIProvider(user.org_id);
  const embed = await getEmbedConfigMasked(user.org_id);
  const transcription = await readTranscriptionConfig(user.org_id);
  return c.json({ ...masked, has_provider, embed, transcription });
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
      classify: z
        .object({
          provider: z.enum(['anthropic', 'openai', 'openrouter', 'ollama']),
          model: z.string().min(1),
          baseUrl: z.string().optional(),
        })
        .nullable()
        .optional(),
      summarize: z
        .object({
          provider: z.enum(['anthropic', 'openai', 'openrouter', 'ollama']),
          model: z.string().min(1),
          baseUrl: z.string().optional(),
        })
        .nullable()
        .optional(),
      reason: z
        .object({
          provider: z.enum(['anthropic', 'openai', 'openrouter', 'ollama']),
          model: z.string().min(1),
          baseUrl: z.string().optional(),
        })
        .nullable()
        .optional(),
      extract: z
        .object({
          provider: z.enum(['anthropic', 'openai', 'openrouter', 'ollama']),
          model: z.string().min(1),
          baseUrl: z.string().optional(),
        })
        .nullable()
        .optional(),
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
  const embed = await getEmbedConfigMasked(user.org_id);
  const transcription = await readTranscriptionConfig(user.org_id);
  return c.json({ ...masked, has_provider, embed, transcription });
});
