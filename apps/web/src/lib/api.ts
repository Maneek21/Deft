const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// ── Concurrency-guarded token refresh ────────────────────────────────────────
// A burst of concurrent 401 responses must only trigger ONE refresh call.
// Subsequent callers await the same in-flight promise and share the result.
let _refreshPromise: Promise<string | null> | null = null;

/**
 * Silently refresh the access token using the stored refresh token.
 * Updates both the in-memory ApiClient singleton and localStorage.
 * Returns the new access token, or null if refresh failed (caller should
 * treat null as "session expired — redirect to /login").
 *
 * Exported so socket.ts can import it directly without coupling to the class.
 */
export async function refreshAccessToken(): Promise<string | null> {
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = (async () => {
    const refresh = typeof window !== 'undefined'
      ? localStorage.getItem('deft-refresh-token')
      : null;
    if (!refresh) return null;
    try {
      const r = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: refresh }),
      });
      if (!r.ok) return null;
      const j = await r.json();
      if (!j.accessToken) return null;
      // Mirror into the singleton instance and localStorage.
      // `api` is initialised before this closure ever runs (module-level const).
      api.setTokens(j.accessToken, j.refreshToken ?? refresh);
      return j.accessToken as string;
    } catch {
      return null;
    }
  })();
  try {
    return await _refreshPromise;
  } finally {
    _refreshPromise = null;
  }
}

class ApiClient {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      this.accessToken = localStorage.getItem('deft-access-token');
      this.refreshToken = localStorage.getItem('deft-refresh-token');
    }
  }

  setTokens(access: string, refresh: string) {
    this.accessToken = access;
    this.refreshToken = refresh;
    localStorage.setItem('deft-access-token', access);
    localStorage.setItem('deft-refresh-token', refresh);
  }

  clearTokens() {
    this.accessToken = null;
    this.refreshToken = null;
    localStorage.removeItem('deft-access-token');
    localStorage.removeItem('deft-refresh-token');
  }

  getAccessToken() {
    return this.accessToken;
  }

  private async fetchWithRetry(url: string, options: RequestInit, retries = 2): Promise<Response> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fetch(url, options);
      } catch (err) {
        // Only retry on network errors (TypeError from fetch), not HTTP errors
        if (attempt === retries || !(err instanceof TypeError)) throw err;
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    throw new Error('Request failed after retries');
  }

  async fetch(path: string, options: RequestInit = {}): Promise<Response> {
    const headers = new Headers(options.headers);

    // Proactive refresh: if we have a refresh token but no access token
    // (e.g. cold page load after access token expired), refresh upfront
    // so the initial request doesn't 401 and force a retry.
    if (!this.accessToken && this.refreshToken) {
      await refreshAccessToken();
    }

    if (this.accessToken) {
      headers.set('Authorization', `Bearer ${this.accessToken}`);
    }
    const method = (options.method ?? 'GET').toUpperCase();
    if (options.body && !headers.has('Content-Type') && method !== 'GET' && method !== 'HEAD') {
      headers.set('Content-Type', 'application/json');
    }

    let response = await this.fetchWithRetry(`${API_URL}${path}`, { ...options, headers });

    // Reactive 401 interceptor: access token was present but has since expired.
    // Attempt a silent refresh (concurrency-guarded) and retry the original
    // request exactly once. If the refresh also fails, clear tokens and redirect.
    if (response.status === 401) {
      const fresh = await refreshAccessToken();
      if (fresh) {
        headers.set('Authorization', `Bearer ${fresh}`);
        response = await this.fetchWithRetry(`${API_URL}${path}`, { ...options, headers });
      } else {
        this.clearTokens();
        // Store current path for post-login redirect
        if (typeof window !== 'undefined') {
          sessionStorage.setItem('deft-redirect-after-login', window.location.pathname);
          console.warn('[auth] Session expired, redirecting to login');
          window.location.href = '/login?expired=1';
        }
      }
    }

    return response;
  }

  async get(path: string) {
    return this.fetch(path);
  }

  async post(path: string, body?: unknown) {
    return this.fetch(path, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async patch(path: string, body?: unknown) {
    return this.fetch(path, {
      method: 'PATCH',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async put(path: string, body?: unknown) {
    return this.fetch(path, {
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async delete(path: string) {
    return this.fetch(path, { method: 'DELETE' });
  }

  async upload(path: string, file: File): Promise<Response> {
    const headers = new Headers();

    // Proactive refresh: if we have a refresh token but no access token
    // (e.g. cold page load after access token expired), refresh upfront
    // so the initial request doesn't 401 and force a retry.
    if (!this.accessToken && this.refreshToken) {
      await refreshAccessToken();
    }

    if (this.accessToken) {
      headers.set('Authorization', `Bearer ${this.accessToken}`);
    }
    // Don't set Content-Type — let browser set it with boundary for multipart
    const formData = new FormData();
    formData.append('file', file);

    let response = await this.fetchWithRetry(`${API_URL}${path}`, {
      method: 'POST',
      headers,
      body: formData,
    });

    // Reactive 401 interceptor (same pattern as fetch() above)
    if (response.status === 401) {
      const fresh = await refreshAccessToken();
      if (fresh) {
        headers.set('Authorization', `Bearer ${fresh}`);
        response = await this.fetchWithRetry(`${API_URL}${path}`, { method: 'POST', headers, body: formData });
      } else {
        this.clearTokens();
        if (typeof window !== 'undefined') {
          sessionStorage.setItem('deft-redirect-after-login', window.location.pathname);
          window.location.href = '/login?expired=1';
        }
      }
    }

    return response;
  }
}

export const api = new ApiClient();
