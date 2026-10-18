import { z } from 'zod';

export const DEFAULT_DEFTY_OPENAI_MODEL = 'gpt-5.6-sol';

/** Provider-specific support is checked by the provider; the host validates a bounded token. */
export const ModelRouteSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'openrouter', 'ollama']),
  model: z.string().trim().min(1),
  baseUrl: z.string().optional(),
  reasoning_effort: z.string().trim().min(1).max(32).regex(/^[a-z][a-z0-9_-]*$/).optional(),
}).superRefine((route, ctx) => {
  if (route.provider === 'openai' && /^gpt-6\.1-sol(?:-|$)/i.test(route.model)
    && route.reasoning_effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(route.reasoning_effort)) {
    ctx.addIssue({ code: 'custom', path: ['reasoning_effort'], message: 'GPT-6.1 Sol supports low, medium, high, xhigh or max reasoning effort.' });
  }
});

export type ModelRoute = z.infer<typeof ModelRouteSchema>;
