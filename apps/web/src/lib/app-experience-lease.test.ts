import assert from 'node:assert/strict';
import test from 'node:test';
import { ExperienceAuthorityUnavailable } from './app-experience-connection';
import { createExperienceLease, normalizeExperienceLeaseRefresh, type ExperienceLease } from './app-experience-lease';

const leaseAt = (time: number): ExperienceLease => ({ session_expires_at: new Date(time).toISOString(),
  exposure: { exposure_id: 'grant', exposure_epoch: 0, review_digest: 'scope', expires_at: new Date(time).toISOString() } });

test('technical renewal crosses the original fifteen minute deadline without new consent', async () => {
  let now = 0, renewals = 0;
  const lease = createExperienceLease({ initial: leaseAt(900_000), current: () => true, now: () => now,
    refresh: async () => { renewals++; return leaseAt(now + 900_000); } });
  now = 820_000;
  assert.equal(await lease.ensure(), true);
  now = 960_000;
  assert.equal(lease.valid(), true);
  assert.equal(await lease.ensure(), true);
  assert.equal(renewals, 1);
  assert.equal(lease.value.exposure.review_digest, 'scope');
});

test('an idle tab can renew an expired technical lease; concurrent callers share one refresh', async () => {
  let calls = 0, finish!: (value: ExperienceLease) => void;
  const lease = createExperienceLease({ initial: leaseAt(900_000), current: () => true, now: () => 1_800_000,
    refresh: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  assert.equal(lease.valid(), false);
  const first = lease.ensure(), second = lease.ensure();
  finish(leaseAt(2_700_000));
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(calls, 1);
});

test('revocation, scope changes and logout during refresh never extend local authority', async () => {
  for (const change of ['identity', 'epoch', 'scope', 'expired', 'denied', 'logout'] as const) {
    let current = true;
    const lease = createExperienceLease({ initial: leaseAt(900_000), current: () => current, now: () => 960_000,
      refresh: async () => {
        if (change === 'denied') throw new Error('revoked');
        if (change === 'logout') current = false;
        const value = leaseAt(change === 'expired' ? 800_000 : 1_800_000);
        return { ...value, exposure: { ...value.exposure,
          ...(change === 'identity' ? { exposure_id: 'different' } : {}),
          ...(change === 'epoch' ? { exposure_epoch: 1 } : {}),
          ...(change === 'scope' ? { review_digest: 'expanded' } : {}) } };
      } });
    assert.equal(await lease.ensure(), false, change);
    assert.equal(lease.valid(), false, change);
  }
});

 test('an outage across lease expiry blocks access but later fresh renewal keeps exact consent', async () => {
  let now = 820_000, unavailable = true;
  const original = leaseAt(900_000);
  const lease = createExperienceLease({ initial: original, current: () => true, now: () => now,
    refresh: async () => { if (unavailable) throw new ExperienceAuthorityUnavailable(); return leaseAt(now + 900_000); } });
  await assert.rejects(lease.ensure(), ExperienceAuthorityUnavailable);
  assert.deepEqual(lease.value, original);
  now = 1_800_000;
  assert.equal(lease.valid(), false);
  await assert.rejects(lease.ensure(), ExperienceAuthorityUnavailable);
  unavailable = false;
  assert.equal(await lease.ensure(), true);
  assert.equal(lease.value.exposure.exposure_id, original.exposure.exposure_id);
  assert.equal(lease.value.exposure.review_digest, original.exposure.review_digest);
});

test('pre-worker and Worker lease refresh consume the actual API contract', () => {
  const expires = Date.now() + 900_000;
  const response = { session_expires_at: new Date(expires).toISOString(), exposure: { ...leaseAt(expires).exposure,
    exposure_id: '11111111-1111-4111-8111-111111111111', review_digest: 'sha256:' + 'a'.repeat(64), active: true } };
  assert.equal(normalizeExperienceLeaseRefresh(response).session_expires_at, response.session_expires_at);
  for (const value of [{ expires_at: response.session_expires_at, session_id: 'legacy', exposure: response.exposure },
    { ...response, session_expires_at: 'invalid' }, { ...response, exposure: null }]) assert.throws(() => normalizeExperienceLeaseRefresh(value));
});
