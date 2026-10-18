export const APP_CONNECTION_PENDING_KEY = 'deft.app-connection.pending.v1';
export type PendingAppConnection = Readonly<{ sessionId: string; installationId: string; experienceKey: string; state: string; expiresAt: number }>;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const state = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function connectionBegin(value: unknown) {
  if (!record(value) || typeof value.authorization_url !== 'string' || value.authorization_url.length > 8192
    || !Number.isSafeInteger(value.expires_at) || Number(value.expires_at) <= Date.now()) throw Error('Account setup is unavailable.');
  const url = new URL(value.authorization_url);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !state(url.searchParams.get('state'))) throw Error('Account setup is unavailable.');
  return { authorizationUrl: url.href, state: url.searchParams.get('state')!, expiresAt: Number(value.expires_at) };
}
export function pendingAppConnection(value: unknown, now = Date.now()): PendingAppConnection {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'experienceKey,expiresAt,installationId,sessionId,state'
    || !uuid(value.sessionId) || !uuid(value.installationId) || typeof value.experienceKey !== 'string'
    || !/^[a-z][a-z0-9_]{0,47}$/.test(value.experienceKey) || !state(value.state)
    || !Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) <= now) throw Error('This account setup has ended. Return to Email and connect again.');
  return value as PendingAppConnection;
}
export function connectionCallback(search: string, pending: PendingAppConnection) {
  const params = new URLSearchParams(search);
  const ignored = new Set(['scope', 'authuser', 'prompt', 'iss', 'error_description', 'error_uri']);
  const allowed = new Set(['state', 'code', 'error', ...ignored]);
  for (const key of params.keys()) if (!allowed.has(key) || params.getAll(key).length !== 1) throw Error('Account setup response is invalid.');
  if (params.get('state') !== pending.state || Boolean(params.get('code')) === Boolean(params.get('error'))) throw Error('Account setup response is invalid.');
  const code = params.get('code'), error = params.get('error');
  if (code && (code.length > 4096 || /[\r\n\0]/.test(code)) || error && !/^[a-zA-Z0-9_.-]{1,128}$/.test(error)) throw Error('Account setup response is invalid.');
  return { state: pending.state, ...(code ? { code } : { error: error! }) };
}

// Only an explicitly started, still-current navigation transfers cleanup to the
// callback page. This pointer does not extend host session or consent lifetime.
export function connectionSessionRetirementRequired(pending: PendingAppConnection | null, sessionId: string, now = Date.now()) {
  return !pending || pending.sessionId !== sessionId || pending.expiresAt <= now;
}
