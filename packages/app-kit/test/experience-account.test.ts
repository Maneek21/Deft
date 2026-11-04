import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExperienceAccountTargetSchema,
  ExperienceConnectionActionSchema,
  ExperienceAccountTargetHealthSchema,
} from '../src/experience-account.js';

test('account target admits owner health and treats a missing health as optional (unknown)', () => {
  assert.deepEqual(ExperienceAccountTargetSchema.parse({ key: 'primary', label: 'Primary source' }),
    { key: 'primary', label: 'Primary source' });
  const withHealth = ExperienceAccountTargetSchema.parse({
    key: 'primary', label: 'Primary source',
    health: { connection: 'connected', background: { state: 'healthy', since: '2026-11-04T00:00:00.000Z', reason: 'live' } },
  });
  assert.equal(withHealth.health?.background?.state, 'healthy');
  assert.equal(withHealth.health?.connection, 'connected');
});

test('account target health requires a valid connection state and a well-formed background', () => {
  assert.equal(ExperienceAccountTargetHealthSchema.safeParse({ connection: 'connected' }).success, true);
  assert.equal(ExperienceAccountTargetHealthSchema.safeParse({ connection: 'unknown' }).success, false);
  assert.equal(ExperienceAccountTargetHealthSchema.safeParse({ connection: 'connected', background: { state: 'healthy', since: 'not-a-date', reason: 'live' } }).success, false);
  assert.equal(ExperienceAccountTargetHealthSchema.safeParse({ connection: 'connected', background: { state: 'healthy', since: '2026-11-04T00:00:00.000Z', reason: 'live' } }).success, true);
  assert.equal(ExperienceAccountTargetHealthSchema.safeParse({ connection: 'connected', background: { state: 'healthy', since: '2026-11-04T00:00:00.000Z', reason: 'live', extra: true } }).success, false);
});

test('connection action admits the closed kinds and bounded ids, never free text', () => {
  assert.deepEqual(ExperienceConnectionActionSchema.parse({ kind: 'restore_access', installation_id: '11111111-1111-4111-8111-111111111111', target_key: 'primary' }),
    { kind: 'restore_access', installation_id: '11111111-1111-4111-8111-111111111111', target_key: 'primary' });
  assert.equal(ExperienceConnectionActionSchema.safeParse({ kind: 'reconnect' }).success, true);
  assert.equal(ExperienceConnectionActionSchema.safeParse({ kind: 'review_consent', consent_id: '22222222-2222-4222-8222-222222222222' }).success, true);
  assert.equal(ExperienceConnectionActionSchema.safeParse({ kind: 'delete_everything' }).success, false);
  assert.equal(ExperienceConnectionActionSchema.safeParse({ kind: 'reconnect', target_key: 'Bad Key!' }).success, false);
  assert.equal(ExperienceConnectionActionSchema.safeParse({ kind: 'reconnect', installation_id: 'not-a-uuid' }).success, false);
  assert.equal(ExperienceConnectionActionSchema.safeParse({ kind: 'reconnect', callback: 'https://evil.example' }).success, false);
});
