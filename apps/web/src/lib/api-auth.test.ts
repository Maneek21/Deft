/**
 * Run: pnpm exec tsx --test apps/web/src/lib/api-auth.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, refreshAccessToken } from './api';
import {
  AuthRequestGeneration,
  isCrossTabSessionReplacement,
  isCurrentRefreshStorageEvent,
  revokeWebSessionBestEffort,
  safePostLoginDestination,
} from './auth-context';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

function installBrowserGlobals(t: test.TestContext, pathname: string) {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const location = { pathname, href: pathname };

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location },
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: local,
  });
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: session,
  });

  t.after(() => {
    for (const [name, descriptor] of [
      ['window', originalWindow],
      ['localStorage', originalLocalStorage],
      ['sessionStorage', originalSessionStorage],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  });

  return { local, session, location };
}

test('an invalid login returns its 401 without entering session-expiry handling', async (t) => {
  const browser = installBrowserGlobals(t, '/login');
  const originalFetch = globalThis.fetch;
  let transportCalls = 0;
  globalThis.fetch = (async () => {
    transportCalls += 1;
    return new Response(JSON.stringify({ error: 'Invalid credentials' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  t.mock.method(console, 'warn', () => {});
  api.clearTokens();

  const response = await api.post('/api/auth/login', {
    email: 'audit@example.invalid',
    password: 'wrong-password',
  });

  assert.equal(response.status, 401);
  assert.equal(transportCalls, 1);
  assert.equal(browser.location.href, '/login', 'the login page must remain mounted');
  assert.equal(browser.session.getItem('deft-redirect-after-login'), null);
});

test('a protected resource still refreshes the session and retries once', async (t) => {
  const browser = installBrowserGlobals(t, '/tasks');
  const token = (jti: string) => {
    const encoded = btoa(JSON.stringify({ id: 'user', org_id: 'org', sid: 'session', jti })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `header.${encoded}.signature`;
  };
  const staleAccess = token('stale-access');
  const storedRefresh = token('stored-refresh');
  const freshAccess = token('fresh-access');
  const freshRefresh = token('fresh-refresh');
  const originalFetch = globalThis.fetch;
  const authorizations: Array<string | null> = [];
  let protectedCalls = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith('/api/auth/refresh')) {
      return new Response(JSON.stringify({
        accessToken: freshAccess,
        refreshToken: freshRefresh,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    protectedCalls += 1;
    authorizations.push(new Headers(init?.headers).get('Authorization'));
    return new Response(null, { status: protectedCalls === 1 ? 401 : 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  api.setTokens(staleAccess, storedRefresh);

  const response = await api.get('/api/tasks');

  assert.equal(response.status, 200);
  assert.equal(protectedCalls, 2);
  assert.deepEqual(authorizations, [`Bearer ${staleAccess}`, `Bearer ${freshAccess}`]);
  assert.equal(browser.local.getItem('deft-access-token'), freshAccess);
  assert.equal(browser.location.href, '/tasks');
});

test('post-login destinations allow local workspace routes and reject auth loops or unsafe URLs', () => {
  assert.equal(
    safePostLoginDestination('/tasks?task=OPS-42#activity'),
    '/tasks?task=OPS-42#activity',
  );
  assert.equal(safePostLoginDestination('/oauth/authorize?client_id=local'), '/oauth/authorize?client_id=local');

  for (const value of [
    '/login',
    '/login?next=/tasks',
    '/signup/',
    '/forgot-password',
    '/reset-password?token=secret',
    '//evil.example/path',
    '/\\evil.example/path',
    'https://evil.example/path',
    'javascript:alert(1)',
    '',
    null,
  ]) {
    assert.equal(safePostLoginDestination(value), null, String(value));
  }
});

test('concurrent callers share a rotation and a late response cannot undo logout', async (t) => {
  const browser = installBrowserGlobals(t, '/tasks');
  const originalFetch = globalThis.fetch;
  let finish!: (response: Response) => void;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    return new Promise<Response>((resolve) => { finish = resolve; });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  api.setTokens('old', 'old-refresh');
  const first = refreshAccessToken();
  const second = refreshAccessToken();
  assert.equal(calls, 1);
  api.clearTokens();
  finish(new Response(JSON.stringify({ accessToken: 'late', refreshToken: 'late-refresh' })));
  assert.deepEqual(await Promise.all([first, second]), [null, null]);
  assert.equal(browser.local.getItem('deft-access-token'), null);
});

test('a tab waiting for the refresh lock reuses the completed rotation from another tab', async (t) => {
  const browser = installBrowserGlobals(t, '/tasks');
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; throw new Error('Unexpected duplicate rotation'); }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  api.setTokens('old', 'old-refresh');
  Object.defineProperty(window, 'navigator', { value: { locks: { request: async (_name: string, callback: () => Promise<string | null>) => {
    browser.local.setItem('deft-access-token', 'other-tab-access');
    browser.local.setItem('deft-refresh-token', 'other-tab-refresh');
    return callback();
  } } } });
  assert.equal(await refreshAccessToken(), 'other-tab-access');
  assert.equal(api.getAccessToken(), 'other-tab-access');
  assert.equal(calls, 0);
});

test('best-effort logout posts the captured refresh token with a bounded signal', async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  await revokeWebSessionBestEffort('captured-refresh', (async (input, init) => {
    request = { url: String(input), init };
    return new Response(null, { status: 200 });
  }) as typeof fetch, 100);

  assert.equal(request?.url.endsWith('/api/auth/logout'), true);
  assert.deepEqual(JSON.parse(String(request?.init?.body)), { refreshToken: 'captured-refresh' });
  assert.equal(request?.init?.signal instanceof AbortSignal, true);
});

test('best-effort logout resolves when its request exceeds the timeout', async () => {
  const started = Date.now();
  await revokeWebSessionBestEffort('captured-refresh', ((_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  })) as typeof fetch, 10);
  assert.ok(Date.now() - started < 500);
});

test('auth generations reject a pre-logout response and an older login response', () => {
  const generation = new AuthRequestGeneration();
  const initialMe = generation.capture();
  generation.advance(); // logout
  assert.equal(generation.isCurrent(initialMe), false, 'logout must invalidate the pending /me response');

  const firstLoginMe = generation.advance(); // first login starts
  const secondLoginMe = generation.advance(); // newer login starts
  assert.equal(generation.isCurrent(firstLoginMe), false, 'the older identity response cannot win');
  assert.equal(generation.isCurrent(secondLoginMe), true);
});

test('cross-tab session replacement differs from seamless refresh rotation', () => {
  const token = (claims: Record<string, string>) => {
    const encoded = btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `header.${encoded}.signature`;
  };
  const first = token({ id: 'user-a', org_id: 'org-a', sid: 'session-a', jti: 'one' });
  const rotated = token({ id: 'user-a', org_id: 'org-a', sid: 'session-a', jti: 'two' });
  const otherLogin = token({ id: 'user-b', org_id: 'org-a', sid: 'session-b', jti: 'three' });

  assert.equal(isCrossTabSessionReplacement(first, rotated), false);
  assert.equal(isCrossTabSessionReplacement(rotated, otherLogin), true);
  assert.equal(isCrossTabSessionReplacement(null, otherLogin), true);
  assert.equal(isCrossTabSessionReplacement(otherLogin, null), false);
});

test('queued storage events cannot overwrite a newer refresh token', () => {
  assert.equal(isCurrentRefreshStorageEvent('stale-rotation', 'new-login'), false);
  assert.equal(isCurrentRefreshStorageEvent(null, 'new-login'), false);
  assert.equal(isCurrentRefreshStorageEvent('new-login', 'new-login'), true);
  assert.equal(isCurrentRefreshStorageEvent(null, null), true);
});

test('a late 401 from an old session cannot refresh, replay, or clear a newer login', async (t) => {
  const browser = installBrowserGlobals(t, '/tasks');
  const token = (claims: Record<string, string>) => {
    const encoded = btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `header.${encoded}.signature`;
  };
  const oldAccess = token({ id: 'old-user', org_id: 'org', sid: 'old-session' });
  const oldRefresh = token({ id: 'old-user', org_id: 'org', sid: 'old-session' });
  const newAccess = token({ id: 'new-user', org_id: 'org', sid: 'new-session' });
  const newRefresh = token({ id: 'new-user', org_id: 'org', sid: 'new-session' });
  const originalFetch = globalThis.fetch;
  let release!: (response: Response) => void;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    return new Promise<Response>(resolve => { release = resolve; });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  api.setTokens(oldAccess, oldRefresh);
  const pending = api.post('/api/tasks', { title: 'must not replay as another user' });
  api.setTokens(newAccess, newRefresh);
  release(new Response(null, { status: 401 }));

  assert.equal((await pending).status, 401);
  assert.equal(calls, 1);
  assert.equal(browser.local.getItem('deft-access-token'), newAccess);
  assert.equal(browser.local.getItem('deft-refresh-token'), newRefresh);
});
