// docs/superpowers/audits/agent-byoa/lib/api-client.ts
export interface DeftRest {
  login(): Promise<void>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  get<T = unknown>(path: string): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown): Promise<T>;
  put<T = unknown>(path: string, body?: unknown): Promise<T>;
  delete<T = unknown>(path: string): Promise<T>;
  user(): { id: string; org_id: string };
}

export function createDeftRest(opts: { apiUrl: string; email: string; password: string }): DeftRest {
  let token: string | null = null;
  let user: { id: string; org_id: string } | null = null;

  async function fetchJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!token && path !== '/api/auth/login') throw new Error('Call login() first');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${opts.apiUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  return {
    async login() {
      const raw = await fetchJson<Record<string, unknown>>('POST', '/api/auth/login', {
        email: opts.email,
        password: opts.password,
      });
      const accessToken = (raw.access_token ?? raw.accessToken) as string;
      const u = (raw.user as { id: string; org_id?: string }) ?? null;
      const orgId = (raw.org_id ?? u?.org_id) as string;
      if (!accessToken || !u?.id || !orgId) {
        throw new Error(`Login response missing fields: ${JSON.stringify(raw)}`);
      }
      token = accessToken;
      user = { id: u.id, org_id: orgId };
    },
    post: (p, b) => fetchJson('POST', p, b),
    get: (p) => fetchJson('GET', p),
    patch: (p, b) => fetchJson('PATCH', p, b),
    put: (p, b) => fetchJson('PUT', p, b),
    delete: (p) => fetchJson('DELETE', p),
    user: () => {
      if (!user) throw new Error('Not logged in');
      return user;
    },
  };
}
