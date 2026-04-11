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

  async fetch(path: string, options: RequestInit = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    if (this.accessToken) {
      headers.set('Authorization', `Bearer ${this.accessToken}`);
    }
    headers.set('Content-Type', 'application/json');

    let response = await fetch(`${API_URL}${path}`, { ...options, headers });

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
        response = await fetch(`${API_URL}${path}`, { ...options, headers });
      } else {
        this.clearTokens();
        window.location.href = '/login';
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
    if (this.accessToken) {
      headers.set('Authorization', `Bearer ${this.accessToken}`);
    }
    // Don't set Content-Type — let browser set it with boundary for multipart
    const formData = new FormData();
    formData.append('file', file);

    let response = await fetch(`${API_URL}${path}`, {
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
        response = await fetch(`${API_URL}${path}`, { method: 'POST', headers, body: formData });
      } else {
        this.clearTokens();
        window.location.href = '/login';
      }
    }

    return response;
  }
}

export const api = new ApiClient();
