/**
 * Network boundary for the mounted chat tests. The production `api` client is
 * replaced so the real chat surfaces render against deterministic fixtures
 * without reaching the Deft API. Everything else about the module is the real
 * implementation.
 */
export * from '../../src/lib/api';

import {
  CHANNEL_MESSAGES,
  DESTINATION_MESSAGE_ID,
  SPACE_ID,
  THREAD_REPLY,
  THREAD_ROOT,
  THREAD_ROOT_ID,
} from './deft-chat-fixtures';

type Route = { status?: number; body: unknown };

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function route(path: string, method: string): Route {
  if (path === `/api/messages/${SPACE_ID}` && method === 'GET') return { body: { messages: CHANNEL_MESSAGES } };
  if (path === `/api/messages/${THREAD_ROOT_ID}/thread` && method === 'GET') {
    return { body: { parent: THREAD_ROOT, replies: [THREAD_REPLY] } };
  }
  if (path === `/api/agent/actions/pending-by-space` && method === 'GET') return { body: [] };
  if (path === '/api/work-intents' && method === 'GET') return { body: { intents: [] } };
  if (path === '/api/bookmarks' && method === 'GET') return { body: [] };
  if (path === `/api/spaces/${SPACE_ID}/members` && method === 'GET') return { body: [] };
  if (path === `/api/spaces/${SPACE_ID}/pins` && method === 'GET') return { body: [] };
  return { body: {} };
}

const calls: Array<{ method: string; path: string }> = [];

function call(method: string, path: string): Response {
  calls.push({ method, path });
  const found = route(path.split('?')[0]!, method);
  return jsonResponse(found.body, found.status ?? 200);
}

export const api = {
  fetch: async (path: string, options: RequestInit = {}) => call((options.method ?? 'GET').toUpperCase(), path),
  get: async (path: string) => call('GET', path),
  post: async (path: string, _body?: unknown, _options?: { headers?: HeadersInit }) => call('POST', path),
  patch: async (path: string, _body?: unknown) => call('PATCH', path),
  delete: async (path: string, _body?: unknown) => call('DELETE', path),
  upload: async (path: string) => call('POST', path),
  getAccessToken: () => 'mounted-test-token',
  setTokens: () => {},
  clearTokens: () => {},
  dispose: () => {},
};

declare global {
  interface Window {
    __deftApiCalls?: Array<{ method: string; path: string }>;
  }
}

if (typeof window !== 'undefined') window.__deftApiCalls = calls;

export const DESTINATION = DESTINATION_MESSAGE_ID;
