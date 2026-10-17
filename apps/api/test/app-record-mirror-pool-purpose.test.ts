import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { mock } from 'node:test';
import type { HumanActionAuthorityPort } from '../src/lib/app-experience-human-action-service.js';

test('record-mirror review and confirmation explicitly reserve their respective human purposes', async () => {
  const caller = { org_id: randomUUID(), user_id: randomUUID(), sid: randomUUID() };
  const experience = randomUUID(), connection = randomUUID(), digest = `sha256:${'a'.repeat(64)}`;
  const request = { connection_session_id: connection, store_key: 'records', mirror_key: 'mirror',
    request_id: randomUUID(), expected_revision: 0, expires_at: new Date(Date.now() + 3_600_000).toISOString(), max_attempts_per_day: 1 };
  const policy = { key: 'mirror', action_key: 'mirror_records' };
  const ticket = { org_id: caller.org_id, owner_user_id: caller.user_id, web_session_id: caller.sid,
    experience_session_id: experience, target_key: 'primary', authority_digest: digest,
    expires_at: request.expires_at, request, authority: { policy } };
  // The ticket is a fixture. Stop at admission before current authority reads
  // to isolate review-purpose and cancellation-signal routing.
  mock.module(new URL('../src/lib/app-record-mirror-review.ts', import.meta.url).href, { namedExports: {
    openRecordMirrorReview: () => ticket, sealRecordMirrorReview: () => 'fixture',
    RecordMirrorReviewTicketSchema: { parse: (value: unknown) => value },
  } });
  const { AppRecordMirrorService } = await import('../src/lib/app-record-mirror-service.js');
  const stopped = Error('fixture admission boundary');
  const purposes: unknown[] = [], controller = new AbortController();
  const authority: HumanActionAuthorityPort = {
    async withHumanAction(_caller, session, action, _use, signal, _draft, supplied, purpose) {
      assert.equal(session, experience); assert.equal(action, policy.action_key);
      assert.equal(signal, controller.signal); assert.equal(supplied, undefined);
      purposes.push(purpose); throw stopped;
    },
  };
  const service = new AppRecordMirrorService({ caller, current: async () => ({
    store: { record_mirrors: [policy] }, consent: {},
  }) } as any, authority, {} as any);
  try {
    await assert.rejects(service.review(experience, 'primary', request, controller.signal), error => error === stopped);
    await assert.rejects(service.confirm(experience, 'primary', { ticket: 'fixture', expected_authority_digest: digest }, controller.signal), error => error === stopped);
    assert.deepEqual(purposes, ['human_action_preparation', 'human_action_confirmation']);
  } finally { mock.restoreAll(); }
});
