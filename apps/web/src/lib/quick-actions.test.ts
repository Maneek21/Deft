import test from 'node:test';
import assert from 'node:assert/strict';
import { openDeftyDm, openDirectMessage } from './quick-actions';

type Call = { method: string; path: string; body?: unknown };

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function fakeApi(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const handle = (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    const route = routes[`${method} ${path}`];
    return route ? Promise.resolve().then(route) : Promise.resolve(response({ error: 'not found' }, 404));
  };
  const api = {
    get: (path: string) => handle('GET', path),
    post: (path: string, body?: unknown) => handle('POST', path, body),
  };
  return { api: api as never, calls };
}

const DEFTY = { id: 'u-defty', name: 'Defty', email: 'deft-agent@system.local', kind: 'agent' };

test('E12: Ask Defty reports failure when the DM did not open', async () => {
  const { api } = fakeApi({ 'GET /api/members': () => response([DEFTY]) });
  // The layout helper returned nothing when its cached member list was empty.
  const opened = await openDeftyDm(api, async () => false);
  assert.equal(opened, false);
});

test('E12: Ask Defty passes Defty\'s name so the DM opens without a cached member list', async () => {
  const { api } = fakeApi({ 'GET /api/members': () => response([DEFTY]) });
  const seen: Array<[string, string | undefined]> = [];
  const opened = await openDeftyDm(api, async (id, name) => { seen.push([id, name]); return true; });
  assert.equal(opened, true);
  assert.deepEqual(seen, [['u-defty', 'Defty']]);
});

test('E12: Ask Defty returns false instead of throwing when the member read fails', async () => {
  const failing = fakeApi({ 'GET /api/members': () => { throw new Error('offline'); } });
  assert.equal(await openDeftyDm(failing.api, async () => true), false);
  const refused = fakeApi({ 'GET /api/members': () => response({ error: 'x' }, 500) });
  assert.equal(await openDeftyDm(refused.api, async () => true), false);
  const missing = fakeApi({ 'GET /api/members': () => response([]) });
  assert.equal(await openDeftyDm(missing.api, async () => true), false);
  const opener = fakeApi({ 'GET /api/members': () => response([DEFTY]) });
  assert.equal(await openDeftyDm(opener.api, async () => { throw new Error('boom'); }), false);
});

test('E12: openDirectMessage opens a DM with an empty member cache', async () => {
  const { api, calls } = fakeApi({
    'POST /api/spaces': () => response({ id: 'dm-1' }),
  });
  const selected: string[] = [];
  let reloaded = 0;
  const opened = await openDirectMessage({
    api,
    currentUserName: 'Priya Shah',
    memberId: 'u-defty',
    memberName: 'Defty',
    cachedMembers: [],
    reloadSpaces: async () => { reloaded++; },
    selectSpace: (id) => selected.push(id),
  });
  assert.equal(opened, true);
  assert.deepEqual(calls.at(-1), {
    method: 'POST',
    path: '/api/spaces',
    body: { name: 'Priya Shah, Defty', type: 'dm', user_ids: ['u-defty'] },
  });
  assert.equal(reloaded, 1);
  assert.deepEqual(selected, ['dm-1']);
});

test('E12: openDirectMessage looks the name up when neither the caller nor the cache has it', async () => {
  const { api, calls } = fakeApi({
    'GET /api/members': () => response([{ id: 'u-rahul', name: 'Rahul Mehta' }]),
    'POST /api/spaces': () => response({ id: 'dm-2' }),
  });
  const opened = await openDirectMessage({
    api, currentUserName: 'Priya Shah', memberId: 'u-rahul', cachedMembers: [],
    reloadSpaces: async () => {}, selectSpace: () => {},
  });
  assert.equal(opened, true);
  assert.deepEqual((calls.at(-1)?.body as { name: string }).name, 'Priya Shah, Rahul Mehta');
});

test('E12: openDirectMessage returns false on a refused or failed request and does not navigate', async () => {
  for (const route of [() => response({ error: 'no' }, 403), () => { throw new Error('offline'); }]) {
    const { api } = fakeApi({ 'POST /api/spaces': route });
    const selected: string[] = [];
    const opened = await openDirectMessage({
      api, currentUserName: 'Priya Shah', memberId: 'u-x', memberName: 'X', cachedMembers: [],
      reloadSpaces: async () => {}, selectSpace: (id) => selected.push(id),
    });
    assert.equal(opened, false);
    assert.deepEqual(selected, []);
  }
});
