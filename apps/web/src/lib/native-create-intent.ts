type StoredIntent = { key: string; fingerprint: string };

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

async function fingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(stableValue(value)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function webSessionScope(): string | null {
  if (typeof window === 'undefined') return null;
  const accessToken = localStorage.getItem('deft-access-token');
  if (!accessToken) return null;
  try {
    const encoded = accessToken.split('.')[1];
    if (!encoded) return null;
    const payload = JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '='))) as Record<string, unknown>;
    if (typeof payload.id !== 'string' || typeof payload.org_id !== 'string' || typeof payload.sid !== 'string') return null;
    return `${payload.id}:${payload.org_id}:${payload.sid}`;
  } catch {
    return null;
  }
}

/**
 * Keeps one unresolved native create intent in sessionStorage. Reloading the
 * same tab and composer scope retains its key, but drafts are never stored.
 */
export function createNativeCreateIntent(scope: string) {
  let memory: StoredIntent | null = null;
  let memorySession: string | null = null;

  const storageKey = () => {
    const session = webSessionScope();
    return session ? `deft-native-create-intent:v1:${session}:${scope}` : null;
  };

  const read = (): StoredIntent | null => {
    const session = webSessionScope();
    if (memory && memorySession === session) return memory;
    memory = null;
    memorySession = session;
    const key = session ? `deft-native-create-intent:v1:${session}:${scope}` : null;
    if (!key || typeof window === 'undefined') return null;
    try {
      const value = JSON.parse(sessionStorage.getItem(key) ?? 'null') as StoredIntent | null;
      if (value && typeof value.key === 'string' && typeof value.fingerprint === 'string') memory = value;
    } catch {
      // Corrupt tab-scoped state must never block a new create intent.
    }
    return memory;
  };

  const clear = () => {
    memory = null;
    memorySession = null;
    const key = storageKey();
    if (key && typeof window !== 'undefined') {
      try { sessionStorage.removeItem(key); } catch { /* Storage is an optional tab convenience. */ }
    }
  };

  return {
    async keyFor(payload: unknown): Promise<string> {
      const sessionBeforeFingerprint = webSessionScope();
      const nextFingerprint = await fingerprint(payload);
      // Do not turn a draft prepared under one authenticated browser session
      // into a create for another user if the session changed while hashing.
      if (sessionBeforeFingerprint !== webSessionScope()) throw new Error('Your session changed while preparing this create. Please submit again.');
      const existing = read();
      if (existing?.fingerprint === nextFingerprint) return existing.key;
      // A changed payload is a new intent. Do not reuse an unresolved key and
      // turn an intentional edit into a server-side idempotency conflict.
      clear();
      const intent: StoredIntent = { key: crypto.randomUUID(), fingerprint: nextFingerprint };
      memory = intent;
      memorySession = webSessionScope();
      const key = storageKey();
      if (key && typeof window !== 'undefined') {
        try { sessionStorage.setItem(key, JSON.stringify(intent)); } catch { /* Continue without reload persistence. */ }
      }
      return intent.key;
    },
    acknowledgeSuccess(key: string) {
      const session = webSessionScope();
      if (!memory || memory.key !== key || memorySession !== session) return;
      memory = null;
      memorySession = null;
      const storedKey = storageKey();
      if (!storedKey || typeof window === 'undefined') return;
      try {
        const stored = JSON.parse(sessionStorage.getItem(storedKey) ?? 'null') as StoredIntent | null;
        if (stored?.key === key) sessionStorage.removeItem(storedKey);
      } catch {
        // Storage failure cannot invalidate an acknowledged server create.
      }
    },
    cancel: clear,
  };
}
