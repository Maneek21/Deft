export type NativeEmailSetup = Readonly<{ account_id: string; resource_binding_id: string; state: 'available' | 'active' | 'unavailable' }>;
const safeId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value.trim() === value && !/[\x00-\x1f\x7f]/u.test(value);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function nativeEmailSetup(value: unknown): NativeEmailSetup | null {
  if (!value || typeof value !== 'object') return null;
  const result = value as Record<string, unknown>, account = result.account as Record<string, unknown> | undefined;
  const setup = result.native_email as Record<string, unknown> | undefined;
  if (result.state !== 'connected' || account?.health !== 'connected' || !setup || !safeId(setup.account_id)
    || setup.account_id !== account.account_id || typeof setup.resource_binding_id !== 'string' || !uuid.test(setup.resource_binding_id)
    || !['available', 'active', 'unavailable'].includes(String(setup.state))) return null;
  return Object.freeze({ account_id: setup.account_id, resource_binding_id: setup.resource_binding_id, state: setup.state as NativeEmailSetup['state'] });
}

/** Nomination is not authority: the authenticated endpoint verifies it afresh. */
export async function adoptNativeEmailAccount(setup: NativeEmailSetup, dependencies: {
  fetch: (path: string, init: RequestInit) => Promise<Response>; current: () => boolean;
}, signal?: AbortSignal): Promise<NativeEmailSetup> {
  const check = () => { signal?.throwIfAborted(); if (!dependencies.current()) throw Error('Account setup access ended.'); };
  check();
  const response = await dependencies.fetch(`/api/email/accounts/${encodeURIComponent(setup.account_id)}/adopt`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resource_binding_id: setup.resource_binding_id }),
    cache: 'no-store', signal,
  });
  check();
  if (!response.ok) throw Error('Your account is connected. Cached mailbox setup was not confirmed. Try again from Account connection.');
  const result = await response.json() as Record<string, unknown>;
  check();
  if (!result || typeof result !== 'object' || result.state !== 'active' || result.account_id !== setup.account_id || !['gmail', 'microsoft', 'imap_smtp'].includes(String(result.provider))
    || !Number.isSafeInteger(result.authority_revision) || Number(result.authority_revision) < 1) throw Error('Cached mailbox setup was not confirmed.');
  return Object.freeze({ ...setup, state: 'active' });
}
