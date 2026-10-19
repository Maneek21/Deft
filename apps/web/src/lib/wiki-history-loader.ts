export type WikiHistorySnapshot<T> = { key: string; status: 'loading' | 'ready' | 'error'; versions: T[] };
export function loadWikiHistory<T>(input: {
  key: string;
  slug: string;
  request: (slug: string, signal: AbortSignal) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
  publish: (state: WikiHistorySnapshot<T>) => void;
}) {
  const controller = new AbortController();
  input.publish({ key: input.key, status: 'loading', versions: [] });
  const finished = (async () => {
    try {
      const response = await input.request(input.slug, controller.signal);
      if (controller.signal.aborted) return;
      if (!response.ok) throw new Error('History unavailable');
      const payload = await response.json() as { versions?: T[] };
      if (controller.signal.aborted) return;
      input.publish({ key: input.key, status: 'ready', versions: Array.isArray(payload.versions) ? payload.versions : [] });
    } catch {
      if (controller.signal.aborted) return;
      input.publish({ key: input.key, status: 'error', versions: [] });
    }
  })();
  return { dispose: () => controller.abort(), finished };
}
