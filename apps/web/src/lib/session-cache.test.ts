import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSessionCacheScope,
  getActiveSessionCacheScope,
  isActiveSessionCacheKey,
  sessionSWRKey,
  sessionSWRPath,
  sessionSWRScope,
  setActiveSessionCacheScope,
} from './session-cache';

function token(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

test('session cache scope isolates account, organization, server session, and local relogin epoch', () => {
  const first = createSessionCacheScope({
    accessToken: token({ id: 'user-a', org_id: 'org-a', sid: 'session-a' }),
    authenticatedUserId: 'user-a',
    authenticatedOrgId: 'org-a',
    authEpoch: 1,
  });
  const replacement = createSessionCacheScope({
    accessToken: token({ id: 'user-b', org_id: 'org-b', sid: 'session-b' }),
    authenticatedUserId: 'user-b',
    authenticatedOrgId: 'org-b',
    authEpoch: 2,
  });
  const reloginWithoutSid = createSessionCacheScope({
    accessToken: token({ id: 'user-a', org_id: 'org-a' }),
    authenticatedUserId: 'user-a',
    authenticatedOrgId: 'org-a',
    authEpoch: 3,
  });
  const secondReloginWithoutSid = createSessionCacheScope({
    accessToken: token({ id: 'user-a', org_id: 'org-a' }),
    authenticatedUserId: 'user-a',
    authenticatedOrgId: 'org-a',
    authEpoch: 4,
  });

  assert.notEqual(first, replacement);
  assert.notEqual(reloginWithoutSid, secondReloginWithoutSid);
});

test('JWT claims only refine a scope when they match the authenticated user and organization', () => {
  const mismatched = createSessionCacheScope({
    accessToken: token({ id: 'attacker', org_id: 'other-org', sid: 'forged-session' }),
    authenticatedUserId: 'user-a',
    authenticatedOrgId: 'org-a',
    authEpoch: 7,
  });
  assert.match(mismatched, /org-a:user-a:legacy:7/u);
  assert.doesNotMatch(mismatched, /forged-session/u);
});

test('access-token rotation inside one authenticated session keeps the cache namespace stable', () => {
  const first = createSessionCacheScope({
    accessToken: token({ id: 'user-a', org_id: 'org-a', sid: 'session-a', exp: 10 }),
    authenticatedUserId: 'user-a',
    authenticatedOrgId: 'org-a',
    authEpoch: 5,
  });
  const rotated = createSessionCacheScope({
    accessToken: token({ id: 'user-a', org_id: 'org-a', sid: 'session-a', exp: 20 }),
    authenticatedUserId: 'user-a',
    authenticatedOrgId: 'org-a',
    authEpoch: 5,
  });
  assert.equal(first, rotated);
});

test('late old-session results remain unreachable from the replacement-session key', () => {
  const oldScope = 'org-a:user-a:session-a:1';
  const newScope = 'org-b:user-b:session-b:2';
  const oldKey = sessionSWRKey(oldScope, '/api/modules');
  const newKey = sessionSWRKey(newScope, '/api/modules');
  assert.ok(oldKey && newKey);

  const cache = new Map<string, unknown>();
  cache.set(oldKey, { modules: [{ id: 'private-a' }] });
  assert.equal(cache.get(newKey), undefined);
  assert.equal(sessionSWRPath(oldKey), '/api/modules');
});

test('global invalidation can target only the active session, including infinite keys', () => {
  const active = 'org-a:user-a:session-a:1';
  const inactive = 'org-b:user-b:session-b:2';
  setActiveSessionCacheScope(active);
  assert.equal(getActiveSessionCacheScope(), active);

  const activeKey = sessionSWRKey(active, '/api/modules/contacts/records');
  const inactiveKey = sessionSWRKey(inactive, '/api/modules/contacts/records');
  assert.ok(activeKey && inactiveKey);
  assert.equal(isActiveSessionCacheKey(activeKey), true);
  assert.equal(isActiveSessionCacheKey(`${INFINITE_PREFIX}${activeKey}`), true);
  assert.equal(isActiveSessionCacheKey(inactiveKey), false);
  assert.equal(sessionSWRScope(activeKey), active);

  setActiveSessionCacheScope(null);
  assert.equal(isActiveSessionCacheKey(activeKey), false);
});

const INFINITE_PREFIX = '$inf$';
