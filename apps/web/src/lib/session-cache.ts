const SESSION_CACHE_PREFIX = 'deft-session:';
const INFINITE_CACHE_PREFIX = '$inf$';

type SessionClaims = Readonly<{
  userId: string;
  orgId: string;
  sessionId: string | null;
}>;

let activeSessionCacheScope: string | null = null;

function decodeSessionClaims(token: string | null): SessionClaims | null {
  if (!token) return null;
  try {
    const segment = token.split('.')[1];
    if (!segment) return null;
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))) as Record<string, unknown>;
    if (typeof payload.id !== 'string' || typeof payload.org_id !== 'string') return null;
    return {
      userId: payload.id,
      orgId: payload.org_id,
      sessionId: typeof payload.sid === 'string' && payload.sid.length > 0 ? payload.sid : null,
    };
  } catch {
    return null;
  }
}

/** Build a browser-cache namespace only after `/api/auth/me` has established
 * the authenticated user and organization. JWT claims may distinguish the
 * server session, but never establish user/org authority on their own. */
export function createSessionCacheScope(input: Readonly<{
  accessToken: string | null;
  authenticatedUserId: string;
  authenticatedOrgId: string;
  authEpoch: number;
}>): string {
  const claims = decodeSessionClaims(input.accessToken);
  const sessionId = claims
    && claims.userId === input.authenticatedUserId
    && claims.orgId === input.authenticatedOrgId
    ? claims.sessionId
    : null;
  return [
    input.authenticatedOrgId,
    input.authenticatedUserId,
    sessionId ?? 'legacy',
    String(input.authEpoch),
  ].map(encodeURIComponent).join(':');
}

export function setActiveSessionCacheScope(scope: string | null): void {
  activeSessionCacheScope = scope;
}

export function getActiveSessionCacheScope(): string | null {
  return activeSessionCacheScope;
}

export function sessionSWRKey(scope: string | null, path: string | null): string | null {
  if (!scope || !path) return null;
  return `${SESSION_CACHE_PREFIX}${encodeURIComponent(scope)}:${path}`;
}

export function sessionSWRPath(key: string): string {
  const normalized = key.startsWith(INFINITE_CACHE_PREFIX) ? key.slice(INFINITE_CACHE_PREFIX.length) : key;
  if (!normalized.startsWith(SESSION_CACHE_PREFIX)) throw new Error('Invalid session cache key.');
  const separator = normalized.indexOf(':', SESSION_CACHE_PREFIX.length);
  if (separator < 0) throw new Error('Invalid session cache key.');
  return normalized.slice(separator + 1);
}

export function sessionSWRScope(key: unknown): string | null {
  if (typeof key !== 'string') return null;
  const normalized = key.startsWith(INFINITE_CACHE_PREFIX) ? key.slice(INFINITE_CACHE_PREFIX.length) : key;
  if (!normalized.startsWith(SESSION_CACHE_PREFIX)) return null;
  const separator = normalized.indexOf(':', SESSION_CACHE_PREFIX.length);
  if (separator < 0) return null;
  try {
    return decodeURIComponent(normalized.slice(SESSION_CACHE_PREFIX.length, separator));
  } catch {
    return null;
  }
}

export function isActiveSessionCacheKey(key: unknown): boolean {
  return activeSessionCacheScope !== null && sessionSWRScope(key) === activeSessionCacheScope;
}
