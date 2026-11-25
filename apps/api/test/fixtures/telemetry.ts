/**
 * Shared setup for the telemetry tests: a hosted cell's settings and a
 * stand-in for the network that records every request instead of sending it.
 */
import { setApiRouteTemplates } from '../../src/lib/telemetry/route-templates.js';
import { errorReporterDeps, resetErrorTelemetryForTest } from '../../src/lib/telemetry/error-reporter.js';

export const CONTROL_PLANE = 'https://control.test.invalid';
export const CELL_ID = 'cell-telemetry-test';
export const FETCH_TOKEN = 'synthetic-seat-fetch-token';

/** A production hosted cell with every control-plane setting present. */
export const HOSTED_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  DEFT_HOSTED: 'true',
  DEFT_CELL_ID: CELL_ID,
  DEFT_SEAT_PUBLIC_KEYS: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg',
  DEFT_SEAT_STATEMENT_URL: `${CONTROL_PLANE}/v1/cells/${CELL_ID}/seat-statement`,
  DEFT_SEAT_FETCH_TOKEN: FETCH_TOKEN,
};

/** A production self-hosted install. */
export const SELF_HOSTED_ENV: NodeJS.ProcessEnv = { NODE_ENV: 'production' };

export type SentRequest = { url: string; init: RequestInit; body: unknown };

/** Records requests; answers each with `status` (or throws when `status` is 'throw'). */
export function recordingFetch(status: number | 'throw' | (() => number | 'throw') = 200) {
  const sent: SentRequest[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    sent.push({ url, init, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
    const answer = typeof status === 'function' ? status() : status;
    if (answer === 'throw') throw new TypeError('fetch failed');
    return new Response(null, { status: answer });
  };
  return { sent, fetch };
}

const originalReporterDeps = { ...errorReporterDeps };

/** Point the error reporter at a test environment and a recording network. */
export function useErrorReporter(env: NodeJS.ProcessEnv, options: { status?: Parameters<typeof recordingFetch>[0]; known?: string[]; now?: () => number } = {}) {
  resetErrorTelemetryForTest();
  const network = recordingFetch(options.status ?? 200);
  Object.assign(errorReporterDeps, {
    env,
    fetch: network.fetch,
    release: async () => '0.3.0-preview.152',
    knownValues: async () => options.known ?? [],
    isPaused: () => false,
    now: options.now ?? (() => Date.now()),
  });
  return network;
}

export function restoreErrorReporter(): void {
  resetErrorTelemetryForTest();
  Object.assign(errorReporterDeps, originalReporterDeps);
}

/** A small route list for templating reported API paths. */
export function useApiRoutes(): void {
  setApiRouteTemplates([
    { method: 'GET', path: '/api/spaces/:id/messages' },
    { method: 'POST', path: '/api/spaces/:id/messages' },
    { method: 'GET', path: '/api/spaces/unread' },
    { method: 'GET', path: '/api/tasks/:id' },
    { method: 'ALL', path: '/api/*' },
  ]);
}

export const EVENT_KEYS = [
  'count', 'error_class', 'fingerprint', 'first_seen_at', 'frames', 'job', 'kind', 'last_seen_at', 'message',
  'method', 'request_ids', 'route', 'status',
].sort();
