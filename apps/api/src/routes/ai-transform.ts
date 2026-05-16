/**
 * AI transform endpoint — POST /api/ai/transform.
 *
 * Generic inline-AI runner used by the universal slash-menu's AI actions
 * (summarize, translate, tone-formal, tone-casual, expand). The client
 * sends a named action + the selected text; the server resolves the org's
 * AI provider, runs the prompt template, and returns the LLM output verbatim.
 *
 * Why this lives behind /api/ai/transform (not /api/spaces/:id/recap-style
 * routes): the slash menu surfaces these actions on ANY focused text — chat
 * composer, task description, comment, wiki block — and never has a parent
 * resource ID. One endpoint is simpler than five and avoids exposing per-
 * surface authorization edges to a stateless transform.
 *
 * Dependency injection: the LLM + AI-config calls are routed through a
 * `_deps` object so tests can stub without hitting a real provider or the
 * DB. Production callers should leave _deps alone.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { llm } from '../lib/llm.js';
import { getOrgAIConfig, hasAnyAIProvider } from '../lib/org-ai-config.js';

export const aiTransformRoutes = new Hono();

export type AITransformAction =
  | 'summarize'
  | 'translate'
  | 'tone-formal'
  | 'tone-casual'
  | 'expand';

const ACTION_PROMPTS: Record<AITransformAction, string> = {
  'summarize':
    'Summarize the following text in 2-3 sentences. Return only the summary, no preamble:\n\n{text}',
  'translate':
    'Translate the following text to {target}. Return only the translation, no preamble:\n\n{text}',
  'tone-formal':
    'Rewrite the following text in a formal, professional tone. Preserve meaning. Return only the rewritten text:\n\n{text}',
  'tone-casual':
    'Rewrite the following text in a casual, conversational tone. Preserve meaning. Return only the rewritten text:\n\n{text}',
  'expand':
    'Expand the following text with additional detail and supporting points. Preserve the original voice and meaning. Return only the expanded text:\n\n{text}',
};

const RequestSchema = z.object({
  action: z.enum([
    'summarize',
    'translate',
    'tone-formal',
    'tone-casual',
    'expand',
  ]),
  text: z.string().min(1).max(20000),
  target: z.string().optional(),
});

/**
 * Injectable seam — tests overwrite these to avoid real LLM/DB calls.
 * Production code path uses the real `llm` / `getOrgAIConfig` /
 * `hasAnyAIProvider` imports.
 */
export const _deps = {
  llm: llm as typeof llm,
  getOrgAIConfig: getOrgAIConfig as typeof getOrgAIConfig,
  hasAnyAIProvider: hasAnyAIProvider as typeof hasAnyAIProvider,
};

aiTransformRoutes.post('/transform', async (c) => {
  const user = c.get('user') as { id?: string; org_id?: string } | undefined;
  if (!user?.org_id) {
    return c.json({ error: 'Unauthorized', code: 'AUTH' }, 401);
  }

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Invalid JSON', code: 'BAD_JSON' }, 400);
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues;
    // Distinguish unknown action from other validation errors so the client
    // can surface a clearer message ("This action isn't supported" vs
    // "Selection is too long").
    if (issues.some((i) => i.path[0] === 'action')) {
      return c.json(
        { error: 'Unknown action', code: 'UNKNOWN_ACTION' },
        400,
      );
    }
    return c.json(
      { error: 'Invalid request', code: 'BAD_REQUEST', issues },
      400,
    );
  }

  const { action, text, target } = parsed.data;

  // Gate on AI availability — same precedence as recap (org key, then env).
  if (!(await _deps.hasAnyAIProvider(user.org_id))) {
    return c.json(
      { error: 'No AI provider configured', code: 'NO_AI' },
      503,
    );
  }

  let prompt = ACTION_PROMPTS[action];
  if (action === 'translate') {
    prompt = prompt.replace('{target}', target || 'English');
  }
  prompt = prompt.replace('{text}', text);

  try {
    const orgConfig = await _deps.getOrgAIConfig(user.org_id);
    const result = await _deps.llm({
      task: 'summarize',
      orgId: user.org_id,
      orgConfig,
      system:
        'You are an inline text-transform assistant. Return only the requested transformation as plain text — no markdown fencing, no preamble, no commentary.',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 2000,
    });

    return c.json({ output: result.text || '', model: result.model });
  } catch (err) {
    console.error('[ai-transform] LLM call failed:', err);
    return c.json(
      { error: 'AI transform failed', code: 'INTERNAL_ERROR' },
      500,
    );
  }
});
