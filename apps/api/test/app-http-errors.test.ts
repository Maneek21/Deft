import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APP_NEXT_STEP_KINDS, AppNextStepSchema, appHttpNextStep, appHttpDetails, appHttpFailureDetails } from '../src/lib/app-http-errors.js';

const uuid = '11111111-1111-4111-8111-111111111111';
const key = 'primary';

test('the next_step contract admits a bare review_consent default and pinned reconnect/restore steps', () => {
  assert.deepEqual(appHttpNextStep({ kind: 'review_consent' }), { kind: 'review_consent' });
  assert.deepEqual(appHttpNextStep({ kind: 'reconnect', installation_id: uuid, target_key: key }),
    { kind: 'reconnect', installation_id: uuid, target_key: key });
  assert.deepEqual(appHttpNextStep({ kind: 'restore_access', installation_id: uuid, target_key: key }),
    { kind: 'restore_access', installation_id: uuid, target_key: key });
  assert.deepEqual(appHttpNextStep({ kind: 'review_consent', consent_id: uuid }),
    { kind: 'review_consent', consent_id: uuid });
});

test('the next_step contract drops unknown kinds, extra keys and malformed ids', () => {
  for (const value of [
    { kind: 'delete_everything' },
    { kind: 'reconnect', installation_id: 'not-a-uuid', target_key: key },
    { kind: 'reconnect', installation_id: uuid, target_key: 'Bad Key!' },
    { kind: 'review_consent', consent_id: 'not-a-uuid' },
    { kind: 'reconnect', installation_id: uuid, target_key: key, callback: 'https://evil.example' },
    'reconnect',
    null,
  ]) {
    assert.equal(appHttpNextStep(value), undefined, JSON.stringify(value));
  }
});

test('the schema admits exactly the three documented kinds and every id as optional', () => {
  assert.deepEqual([...APP_NEXT_STEP_KINDS].sort(), ['reconnect', 'restore_access', 'review_consent'].sort());
  assert.ok(AppNextStepSchema.safeParse({ kind: 'reconnect' }).success, 'every id is optional');
  assert.equal(AppNextStepSchema.safeParse({ kind: 'review_consent', extra: true }).success, false);
});

test('appHttpFailureDetails always carries a concrete next_step for APP_REVIEW_REQUIRED', () => {
  assert.deepEqual(appHttpFailureDetails('APP_REVIEW_REQUIRED'), { next_step: { kind: 'review_consent' } });
  assert.deepEqual(appHttpFailureDetails('APP_REVIEW_REQUIRED', { next_step: { kind: 'reconnect', installation_id: uuid, target_key: key } }),
    { next_step: { kind: 'reconnect', installation_id: uuid, target_key: key } });
  assert.deepEqual(appHttpFailureDetails('APP_REVIEW_REQUIRED', { next_step: { kind: 'bogus' } }),
    { next_step: { kind: 'review_consent' } }, 'a malformed step falls back to the neutral default');
  assert.equal(appHttpFailureDetails('APP_ACCESS_DENIED'), undefined, 'no next_step outside APP_REVIEW_REQUIRED');
});

test('appHttpDetails keeps unrelated details, drops a malformed next_step and never echoes free text', () => {
  assert.deepEqual(appHttpDetails({ reason: 'x' }), { reason: 'x' });
  assert.deepEqual(appHttpDetails({ next_step: { kind: 'review_consent' } }), { next_step: { kind: 'review_consent' } });
  assert.deepEqual(appHttpDetails({ next_step: { kind: 'bogus' } }), {}, 'malformed next_step is dropped');
});
