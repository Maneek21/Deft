import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAppAuthorityContentCache, createAsyncAppAuthorityContentCache } from '../src/lib/app-authority-content-cache.js';

const scope = { org_id: 'org-a', app_version_id: 'version-a' };
const evidence = () => ({ grant: { id: 'grant-a', revision: 1, rights: ['read'] }, lifecycle_epoch: 1,
  grant_epoch: 1, membership: { owner: 'owner-a', active: true, revision: 1 }, rows: [{ id: 'binding-a', state: 'active' }] });

test('pure reconstruction reuses exact current bytes only within one organization and version', () => {
  const reuse = createAppAuthorityContentCache<{ rights: string[] }>();
  let calls = 0;
  const reconstruct = () => { calls++; return { rights: ['read'] }; };
  const first = reuse(scope, evidence(), reconstruct);
  first.rights.push('caller poison');
  assert.deepEqual(reuse(scope, evidence(), reconstruct), { rights: ['read'] });
  assert.equal(calls, 1);
  reuse({ ...scope, org_id: 'org-b' }, evidence(), reconstruct);
  reuse({ ...scope, app_version_id: 'version-b' }, evidence(), reconstruct);
  assert.equal(calls, 3, 'identical content cannot reuse across organizations or versions');
});

test('grant, epoch, revision, membership, insertion, removal and mutation invalidate reconstruction', () => {
  const reuse = createAppAuthorityContentCache<{ validated: boolean }>();
  let calls = 0;
  const reconstruct = () => { calls++; return { validated: true }; };
  const baseline = evidence();
  reuse(scope, baseline, reconstruct);
  const mutations = [
    (value: ReturnType<typeof evidence>) => { value.grant.id = 'grant-b'; },
    (value: ReturnType<typeof evidence>) => { value.grant.revision++; },
    (value: ReturnType<typeof evidence>) => { value.lifecycle_epoch++; },
    (value: ReturnType<typeof evidence>) => { value.grant_epoch++; },
    (value: ReturnType<typeof evidence>) => { value.membership.owner = 'owner-b'; },
    (value: ReturnType<typeof evidence>) => { value.membership.active = false; },
    (value: ReturnType<typeof evidence>) => { value.membership.revision++; },
    (value: ReturnType<typeof evidence>) => { value.rows.push({ id: 'binding-b', state: 'active' }); },
    (value: ReturnType<typeof evidence>) => { value.rows.length = 0; },
    (value: ReturnType<typeof evidence>) => { value.grant.rights.push('write'); },
  ];
  for (const change of mutations) {
    const value = evidence(); change(value);
    const before = calls; reuse(scope, value, reconstruct);
    assert.equal(calls, before + 1);
  }
  baseline.grant.rights.push('mutated in place');
  const before = calls; reuse(scope, baseline, reconstruct);
  assert.equal(calls, before + 1, 'no object identity or advertised digest shortcut');
});

test('invalid/non-JSON evidence and failures never seed reusable validated facts', () => {
  const reuse = createAppAuthorityContentCache<{ ok: boolean }>();
  let calls = 0;
  const reconstruct = () => { calls++; return { ok: true }; };
  for (const value of [{ value: undefined }, { value: NaN }, { value: -0 }, { value: new Date() },
    { value: () => true }, { value: Array(1) }, Object.defineProperty({}, 'value', { enumerable: true, get: () => 1 })]) {
    const before = calls; reuse(scope, value, reconstruct); reuse(scope, value, reconstruct);
    assert.equal(calls, before + 2);
  }
  let failures = 0;
  for (let count = 0; count < 2; count++) assert.throws(() => reuse(scope, { failed: true }, () => {
    failures++; throw Error('invalid grant');
  }), /invalid grant/);
  assert.equal(failures, 2);
});

test('entry/content/memory bounds evict facts and oversized content is revalidated', () => {
  const reuse = createAppAuthorityContentCache<{ ok: boolean }>({ maxEntries: 2, maxContentBytes: 128, maxBytes: 4096 });
  let calls = 0;
  const reconstruct = () => { calls++; return { ok: true }; };
  for (const id of ['a', 'b', 'c', 'a']) reuse(scope, { id }, reconstruct);
  assert.equal(calls, 4);
  for (let count = 0; count < 2; count++) reuse(scope, { oversized: 'x'.repeat(129) }, reconstruct);
  assert.equal(calls, 6);
  const tooSmall = createAppAuthorityContentCache<{ large: string }>({ maxBytes: 32 });
  for (let count = 0; count < 2; count++) tooSmall(scope, { id: 'a' }, () => { calls++; return { large: 'x'.repeat(64) }; });
  assert.equal(calls, 8);
});

test('async pure reconstruction caches only resolved exact content and never changed in-flight inputs or failures', async () => {
  const reuse = createAsyncAppAuthorityContentCache<{ validated: string[] }>();
  let calls = 0;
  const reconstruct = async () => { calls++; return { validated: ['read'] }; };
  const first = await reuse(scope, evidence(), reconstruct); first.validated.push('poison');
  assert.deepEqual(await reuse(scope, evidence(), reconstruct), { validated: ['read'] }); assert.equal(calls, 1);
  await reuse({ ...scope, org_id: 'other-org' }, evidence(), reconstruct); assert.equal(calls, 2);
  const changed = evidence(); changed.grant_epoch++;
  await reuse(scope, changed, reconstruct); assert.equal(calls, 3);
  const mutable = { revision: 1 };
  await reuse(scope, mutable, async () => { calls++; await Promise.resolve(); mutable.revision++; return { validated: ['changed'] }; });
  mutable.revision = 1; await reuse(scope, mutable, reconstruct); assert.equal(calls, 5, 'pre-await content was never cached');
  for (let count = 0; count < 2; count++) await assert.rejects(reuse(scope, { invalid: true }, async () => {
    calls++; throw Error('invalid async evidence');
  }), /invalid async evidence/);
  assert.equal(calls, 7);
});
