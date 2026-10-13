export type EmailReadingPreference = Readonly<{ account_id: string; external_images: 'ask' | 'always'; revision: number }>;
export async function emailReadingPreferenceRequest(accountId: string, dependencies: {
  fetch: (path: string, init: RequestInit) => Promise<Response>; current: () => boolean;
}, update?: { external_images: 'ask' | 'always'; expected_revision: number }, signal?: AbortSignal): Promise<EmailReadingPreference> {
  const check = () => { signal?.throwIfAborted(); if (!dependencies.current()) throw Error('Account settings access ended.'); };
  check();
  const response = await dependencies.fetch(`/api/email/accounts/${encodeURIComponent(accountId)}/reading-preferences`, {
    method: update ? 'PATCH' : 'GET', ...(update ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(update) } : {}),
    signal, cache: 'no-store',
  });
  check();
  if (!response.ok) throw Error(response.status === 409 ? 'This choice changed in another view. Reload the saved choice before saving again.'
    : response.status === 403 ? 'Enable the cached mailbox for this connected account to save reading choices.' : 'Reading choices are unavailable. Try again.');
  const value = await response.json() as Record<string, unknown>;
  check();
  if (!value || value.account_id !== accountId || !['ask', 'always'].includes(String(value.external_images))
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
    || Object.keys(value).sort().join(',') !== 'account_id,external_images,revision') throw Error('Reading choices are unavailable.');
  return Object.freeze({ account_id: accountId, external_images: value.external_images as 'ask' | 'always', revision: Number(value.revision) });
}
