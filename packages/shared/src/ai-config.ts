import { z } from 'zod';

/** Provider-specific support is checked by the provider; the host validates a bounded token. */
export const ModelRouteSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'openrouter', 'ollama']),
  model: z.string().trim().min(1),
  baseUrl: z.string().optional(),
  reasoning_effort: z.string().trim().min(1).max(32).regex(/^[a-z][a-z0-9_-]*$/).optional(),
});

export type ModelRoute = z.infer<typeof ModelRouteSchema>;
