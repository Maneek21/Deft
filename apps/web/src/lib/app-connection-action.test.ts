import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseExperienceView } from './app-experience-bridge';

const c = { installation_id: '11111111-1111-4111-8111-111111111111', target_key: 'primary' };

test('a button may carry a bounded connection_action recovery step', () => {
  for (const kind of ['reconnect', 'restore_access', 'review_consent'] as const) {
    const view = { root: { kind: 'button', id: kind, label: kind, connection_action: { kind, ...c } } };
    const parsed = parseExperienceView(view);
    assert.ok(parsed, kind);
    assert.deepEqual((parsed!.root as { connection_action?: unknown }).connection_action, { kind, ...c });
  }
});

test('connection_action is a closed, bounded field and never free text or callbacks', () => {
  const valid = { kind: 'restore_access', ...c };
  for (const connection_action of [
    { ...valid, kind: 'delete_everything' },
    { ...valid, target_key: 'Bad Key!' },
    { ...valid, installation_id: 'not-a-uuid' },
    { ...valid, consent_id: 'not-a-uuid' },
    { ...valid, callback: 'https://evil.example' },
    'reconnect',
  ]) {
    assert.equal(parseExperienceView({ root: { kind: 'button', id: 'x', label: 'x', connection_action } }), null, JSON.stringify(connection_action));
  }
});

test('a button without connection_action still parses, and unknown button fields stay rejected', () => {
  assert.ok(parseExperienceView({ root: { kind: 'button', id: 'plain', label: 'Plain' } }));
  assert.equal(parseExperienceView({ root: { kind: 'button', id: 'x', label: 'x', connection_action: { kind: 'reconnect' }, extra: true } }), null);
});
