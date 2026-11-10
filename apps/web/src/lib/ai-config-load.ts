// Load step for Settings > AI. Never throws: a network rejection, a non-2xx
// response, or an unreadable body all resolve to a readable error so the page
// can leave its loading state and offer Retry (E14).

type Get = (path: string) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

export type AiConfigLoadResult<T> = { ok: true; cfg: T } | { ok: false; error: string };

export const AI_CONFIG_LOAD_ERROR = 'Failed to load AI configuration.';

export async function loadAiConfig<T>(get: Get): Promise<AiConfigLoadResult<T>> {
  try {
    const res = await get('/api/org/ai-config');
    if (!res.ok) return { ok: false, error: AI_CONFIG_LOAD_ERROR };
    return { ok: true, cfg: (await res.json()) as T };
  } catch {
    return { ok: false, error: `${AI_CONFIG_LOAD_ERROR} Check your connection and try again.` };
  }
}
