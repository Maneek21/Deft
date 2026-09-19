import assert from 'node:assert/strict';
import test from 'node:test';
import { cache, SWRGlobalState } from 'swr/_internal';
import { unstable_serialize } from 'swr/infinite';
import {
  moduleRelatedLatestCacheKey,
  invalidateModuleRealtimeCaches,
  invalidateModuleTaskRealtimeCaches,
  refreshModuleCaches,
  registerModuleInfiniteCacheRevalidator,
} from './use-modules';
import { setActiveSessionCacheScope } from '@/lib/session-cache';

test('refreshModuleCaches revalidates latest-related only for the active session', async () => {
  const firstSession = 'org-a:user-a:session-a:1';
  const secondSession = 'org-b:user-b:session-b:2';
  const firstKey = moduleRelatedLatestCacheKey(firstSession, 'contacts', 'deal-1');
  const secondKey = moduleRelatedLatestCacheKey(secondSession, 'contacts', 'deal-1');
  assert.ok(firstKey && secondKey);
  assert.notEqual(firstKey, secondKey);
  assert.equal(moduleRelatedLatestCacheKey(null, 'contacts', 'deal-1'), null);

  const revalidators = SWRGlobalState.get(cache)![0];
  const internalCache = cache as Map<string, { data: unknown; _k: string }>;
  let firstRefreshes = 0;
  let secondRefreshes = 0;
  internalCache.set(firstKey, { data: 'first-stale', _k: firstKey });
  internalCache.set(secondKey, { data: 'second-stale', _k: secondKey });
  revalidators[firstKey] = [(() => { firstRefreshes += 1; return Promise.resolve(true); }) as (typeof revalidators)[string][number]];
  revalidators[secondKey] = [(() => { secondRefreshes += 1; return Promise.resolve(true); }) as (typeof revalidators)[string][number]];

  try {
    setActiveSessionCacheScope(firstSession);
    await refreshModuleCaches('contacts');
    assert.deepEqual({ firstRefreshes, secondRefreshes }, { firstRefreshes: 1, secondRefreshes: 0 });

    setActiveSessionCacheScope(secondSession);
    await refreshModuleCaches('contacts');
    assert.deepEqual({ firstRefreshes, secondRefreshes }, { firstRefreshes: 1, secondRefreshes: 1 });

    setActiveSessionCacheScope(null);
    await refreshModuleCaches('contacts');
    assert.deepEqual({ firstRefreshes, secondRefreshes }, { firstRefreshes: 1, secondRefreshes: 1 });
  } finally {
    setActiveSessionCacheScope(null);
    internalCache.delete(firstKey);
    internalCache.delete(secondKey);
    delete revalidators[firstKey];
    delete revalidators[secondKey];
  }
});

test('task realtime invalidation refreshes task infinite caches without revalidating record collections', async () => {
  const session = 'org-a:user-a:session-a:1';
  let linkedTaskRefreshes = 0;
  let recordCollectionRefreshes = 0;
  let otherSlugRefreshes = 0;
  const unregisterLinkedTasks = registerModuleInfiniteCacheRevalidator(
    session,
    'contacts',
    () => { linkedTaskRefreshes += 1; return Promise.resolve(); },
    { taskCache: true },
  );
  const unregisterRecords = registerModuleInfiniteCacheRevalidator(
    session,
    'contacts',
    () => { recordCollectionRefreshes += 1; return Promise.resolve(); },
  );
  const unregisterOtherSlug = registerModuleInfiniteCacheRevalidator(
    session,
    'loan-review',
    () => { otherSlugRefreshes += 1; return Promise.resolve(); },
    { taskCache: true },
  );

  try {
    setActiveSessionCacheScope(session);
    await invalidateModuleTaskRealtimeCaches(session, 'contacts');
    assert.deepEqual(
      { linkedTaskRefreshes, recordCollectionRefreshes, otherSlugRefreshes },
      { linkedTaskRefreshes: 1, recordCollectionRefreshes: 0, otherSlugRefreshes: 0 },
    );

    unregisterLinkedTasks();
    await invalidateModuleTaskRealtimeCaches(session, 'contacts');
    assert.equal(linkedTaskRefreshes, 1);

    setActiveSessionCacheScope('org-b:user-b:session-b:2');
    await invalidateModuleTaskRealtimeCaches(session, 'contacts');
    assert.equal(linkedTaskRefreshes, 1);
  } finally {
    unregisterLinkedTasks();
    unregisterRecords();
    unregisterOtherSlug();
    setActiveSessionCacheScope(null);
  }
});

test('module realtime invalidation revalidates mounted infinite caches for only the active session and slug', async () => {
  const session = 'org-a:user-a:session-a:1';
  const inactiveSession = 'org-a:user-a:session-b:2';
  const incomingPageKey = `deft-session:${encodeURIComponent(session)}:/api/modules/contacts/records/company-1/incoming-relations?collection_key=activities&field_key=company&limit=10`;
  const recordsPageKey = `deft-session:${encodeURIComponent(session)}:/api/modules/contacts/records?collection_key=companies&limit=50`;
  const incomingInfiniteKey = unstable_serialize((pageIndex) => pageIndex === 0 ? incomingPageKey : null);
  const recordsInfiniteKey = unstable_serialize((pageIndex) => pageIndex === 0 ? recordsPageKey : null);
  const revalidators = SWRGlobalState.get(cache)![0];
  const internalCache = cache as Map<string, { data: unknown; _k: string }>;
  let incomingRefreshes = 0;
  let recordsRefreshes = 0;
  let otherSlugRefreshes = 0;
  let inactiveRefreshes = 0;
  internalCache.set(incomingInfiniteKey, { data: [{ records: [] }], _k: incomingInfiniteKey });
  internalCache.set(recordsInfiniteKey, { data: [{ records: [] }], _k: recordsInfiniteKey });
  revalidators[incomingInfiniteKey] = [(() => { incomingRefreshes += 1; return Promise.resolve(true); }) as (typeof revalidators)[string][number]];
  revalidators[recordsInfiniteKey] = [(() => { recordsRefreshes += 1; return Promise.resolve(true); }) as (typeof revalidators)[string][number]];
  const unregisterIncoming = registerModuleInfiniteCacheRevalidator(
    session,
    'contacts',
    () => Promise.resolve().then(() => revalidators[incomingInfiniteKey]![0]!(2, {})),
  );
  const unregisterRecords = registerModuleInfiniteCacheRevalidator(
    session,
    'contacts',
    () => Promise.resolve().then(() => revalidators[recordsInfiniteKey]![0]!(2, {})),
  );
  const unregisterOtherSlug = registerModuleInfiniteCacheRevalidator(
    session,
    'loan-review',
    () => { otherSlugRefreshes += 1; return Promise.resolve(); },
  );
  const unregisterInactive = registerModuleInfiniteCacheRevalidator(
    inactiveSession,
    'contacts',
    () => { inactiveRefreshes += 1; return Promise.resolve(); },
  );

  try {
    setActiveSessionCacheScope(session);
    await invalidateModuleRealtimeCaches(session, 'contacts', { slug: 'contacts' });
    assert.deepEqual(
      { incomingRefreshes, recordsRefreshes, otherSlugRefreshes, inactiveRefreshes },
      { incomingRefreshes: 1, recordsRefreshes: 1, otherSlugRefreshes: 0, inactiveRefreshes: 0 },
    );

    await invalidateModuleRealtimeCaches(session, 'contacts', { slug: 'loan-review' });
    assert.deepEqual({ incomingRefreshes, recordsRefreshes }, { incomingRefreshes: 1, recordsRefreshes: 1 });

    unregisterIncoming();
    await invalidateModuleRealtimeCaches(session, 'contacts', { module_slug: 'contacts' });
    assert.deepEqual({ incomingRefreshes, recordsRefreshes }, { incomingRefreshes: 1, recordsRefreshes: 2 });

    setActiveSessionCacheScope(inactiveSession);
    await invalidateModuleRealtimeCaches(session, 'contacts', { slug: 'contacts' });
    assert.equal(inactiveRefreshes, 0);
  } finally {
    unregisterIncoming();
    unregisterRecords();
    unregisterOtherSlug();
    unregisterInactive();
    setActiveSessionCacheScope(null);
    internalCache.delete(incomingInfiniteKey);
    internalCache.delete(recordsInfiniteKey);
    delete revalidators[incomingInfiniteKey];
    delete revalidators[recordsInfiniteKey];
  }
});
