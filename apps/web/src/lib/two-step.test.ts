/**
 * Run: pnpm exec tsx --test apps/web/src/lib/two-step.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { exchangeTwoStepChallenge, readTwoStepPending, TwoStepError, twoStepMessage } from './two-step';
import { safePostLoginDestination } from './auth-context';

test('a sign-in answer is a pending second step only when it carries a challenge', () => {
  assert.deepEqual(
    readTwoStepPending({ user: {}, two_step: { status: 'code_required', token: 'tsc_a', expires_at: '2026-11-16T00:00:00.000Z' } }),
    { status: 'code_required', token: 'tsc_a', expires_at: '2026-11-16T00:00:00.000Z' },
  );
  assert.equal(readTwoStepPending({ two_step: { status: 'enrolment_required', token: 'tsc_b' } })?.status, 'enrolment_required');
  for (const answer of [null, {}, { accessToken: 'a', refreshToken: 'r' }, { two_step: { status: 'code_required' } }, { two_step: { status: 'other', token: 'x' } }]) {
    assert.equal(readTwoStepPending(answer), null, JSON.stringify(answer));
  }
});

test('refusals read as plain sentences, with the wait spelled out', () => {
  assert.match(twoStepMessage('TWO_STEP_CODE_INVALID'), /not right/);
  assert.match(twoStepMessage('TWO_STEP_CHALLENGE_DEAD'), /Sign in again/);
  assert.equal(twoStepMessage('TWO_STEP_LOCKED', undefined, 30), 'Too many wrong codes. Wait 30 seconds and try again.');
  assert.equal(twoStepMessage('TWO_STEP_LOCKED', undefined, 240), 'Too many wrong codes. Wait 4 minutes and try again.');
  assert.equal(twoStepMessage('SOMETHING_ELSE', 'Server said so'), 'Server said so');
  assert.equal(twoStepMessage(undefined), 'Something went wrong. Try again.');
});

test('the code exchange sends only the challenge and the code, and never treats a refusal as a session', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const seen: Array<{ url: string; init: RequestInit }> = [];
  let answer: { status: number; body: unknown } = { status: 200, body: { accessToken: 'access', refreshToken: 'refresh' } };
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;

  assert.deepEqual(await exchangeTwoStepChallenge('tsc_challenge', { code: '123456' }), { accessToken: 'access', refreshToken: 'refresh' });
  assert.match(seen[0]!.url, /\/api\/auth\/two-step\/verify$/);
  assert.deepEqual(JSON.parse(String(seen[0]!.init.body)), { challenge_token: 'tsc_challenge', code: '123456' });
  assert.equal(new Headers(seen[0]!.init.headers).has('Authorization'), false);

  answer = { status: 401, body: { error: 'That code is not valid', code: 'TWO_STEP_CODE_INVALID' } };
  await assert.rejects(() => exchangeTwoStepChallenge('tsc_challenge', { recovery_code: 'ABCD-EFGH-JKMN-PQRS' }),
    (error: unknown) => error instanceof TwoStepError && error.code === 'TWO_STEP_CODE_INVALID' && error.status === 401);
  assert.deepEqual(JSON.parse(String(seen[1]!.init.body)), { challenge_token: 'tsc_challenge', recovery_code: 'ABCD-EFGH-JKMN-PQRS' });

  answer = { status: 200, body: { two_step: { status: 'code_required', token: 'tsc_other' } } };
  await assert.rejects(() => exchangeTwoStepChallenge('tsc_challenge', { code: '123456' }), TwoStepError);
});

test('15.1: a recovery code is answered with an enrol-only token, never a session', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const body = { two_step: { status: 'enrolment_required', token: 'tsr_reset', expires_at: '2026-11-23T00:30:00.000Z', reason: 'recovery_code' } };
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  assert.deepEqual(await exchangeTwoStepChallenge('tsc_challenge', { recovery_code: 'ABCD-EFGH-JKMN-PQRS' }),
    { status: 'enrolment_required', token: 'tsr_reset', expires_at: '2026-11-23T00:30:00.000Z', reason: 'recovery_code' });
  // The reason is kept only on an enrolment answer, and only this one value.
  assert.equal(readTwoStepPending({ two_step: { status: 'enrolment_required', token: 'tsc_b', reason: 'other' } })?.reason, undefined);
  assert.equal(readTwoStepPending({ two_step: { status: 'code_required', token: 'tsc_b', reason: 'recovery_code' } })?.reason, undefined);
});

test('the enrolment screen is never a post-login destination', () => {
  assert.equal(safePostLoginDestination('/two-step-setup'), null);
  assert.equal(safePostLoginDestination('/settings/profile'), '/settings/profile');
});
