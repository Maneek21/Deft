const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

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
      try {
        const r = await fetch(`${API_URL}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: this.refreshToken }),
        });
        if (r.ok) {
          const data = await r.json();
          this.setTokens(data.accessToken, data.refreshToken);
        }
      } catch {
        // Fall through — the 401-retry logic below will handle any failure
      }
    }

    if (this.accessToken) {
      headers.set('Authorization', `Bearer ${this.accessToken}`);
    }
    headers.set('Content-Type', 'application/json');

    let response = await this.fetchWithRetry(`${API_URL}${path}`, { ...options, headers });

    // If 401, try refresh
    if (response.status === 401 && this.refreshToken) {
      const refreshRes = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: this.refreshToken }),
      });

      if (refreshRes.ok) {
        const data = await refreshRes.json();
        this.setTokens(data.accessToken, data.refreshToken);
        headers.set('Authorization', `Bearer ${data.accessToken}`);
        response = await this.fetchWithRetry(`${API_URL}${path}`, { ...options, headers });
      } else {
        this.clearTokens();
        // Store current path for post-login redirect
        if (typeof window !== 'undefined') {
          sessionStorage.setItem('deft-redirect-after-login', window.location.pathname);
          // Brief notification before redirect
          console.warn('[auth] Session expired, redirecting to login');
        }
        window.location.href = '/login?expired=1';
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

  async delete(path: string) {
    return this.fetch(path, { method: 'DELETE' });
  }

  async upload(path: string, file: File): Promise<Response> {
    const headers = new Headers();

    // Proactive refresh: if we have a refresh token but no access token
    // (e.g. cold page load after access token expired), refresh upfront
    // so the initial request doesn't 401 and force a retry.
    if (!this.accessToken && this.refreshToken) {
      try {
        const r = await fetch(`${API_URL}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: this.refreshToken }),
        });
        if (r.ok) {
          const data = await r.json();
          this.setTokens(data.accessToken, data.refreshToken);
        }
      } catch {
        // Fall through — the 401-retry logic below will handle any failure
      }
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

    // If 401, try refresh
    if (response.status === 401 && this.refreshToken) {
      const refreshRes = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: this.refreshToken }),
      });
      if (refreshRes.ok) {
        const data = await refreshRes.json();
        this.setTokens(data.accessToken, data.refreshToken);
        headers.set('Authorization', `Bearer ${data.accessToken}`);
        response = await this.fetchWithRetry(`${API_URL}${path}`, { method: 'POST', headers, body: formData });
      } else {
        this.clearTokens();
        if (typeof window !== 'undefined') {
          sessionStorage.setItem('deft-redirect-after-login', window.location.pathname);
        }
        window.location.href = '/login?expired=1';
      }
    }

    return response;
  }
}

export const api = new ApiClient();
