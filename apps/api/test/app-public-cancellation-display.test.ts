import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { normalizeAppInstallation } from '../../web/src/lib/apps.js';
import { parseCancellationContext, parseCancellationList, parseCancellationReview } from '../../web/src/lib/public-cancellation-owner.js';

test('native App settings accept the actual packed six display and reject malformed or unknown native display fields',
  { skip: !process.env.DEFT_NATIVE_AUTHOR_PACKAGE }, async () => {
    const { manifest } = JSON.parse(await readFile(process.env.DEFT_NATIVE_AUTHOR_PACKAGE!, 'utf8'));
    const row = { id: randomUUID(), version_id: randomUUID(), app_id: manifest.id, name: manifest.name, version: manifest.version,
      state: 'active', lifecycle_epoch: 1, grant_epoch: 1, active_version_id: randomUUID(), package_digest: 'sha256:test',
      manifest_digest: 'sha256:test', manifest, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    assert.equal(normalizeAppInstallation(row).manifest.schema_version, '6');
    for (const bad of [{ ...manifest, unknown_private_input: 'forbidden' }, { ...manifest, native_actions: [] },
      { ...manifest, native_actions: [...manifest.native_actions, manifest.native_actions[0]] },
      { ...manifest, native_actions: [{ ...manifest.native_actions[0], owner_user_id: randomUUID() }] },
      { ...manifest, native_actions: [{ ...manifest.native_actions[0], operation: 'unreviewed.operation' }] },
      { ...manifest, experiences: [{ ...manifest.experiences[0], bridge_version: 'unreviewed' }] }]) {
      assert.throws(() => normalizeAppInstallation({ ...row, manifest: bad }));
    }
  });

test('public cancellation display rejects extra private fields mismatched locators and excess binding choices', () => {
  const app = randomUUID(), id = randomUUID(), binding = randomUUID(), version = randomUUID(), digest = `sha256:${'a'.repeat(64)}`;
  const choice = { native_binding_id: binding, action_label: 'Cancel Booking', consent_digest: digest, current_app_version_id: version, historical_create_authorized: false };
  const item = { id, state: 'cancellation_unavailable', accepted_at: new Date().toISOString(), original_version: '1.0.0', cancel_run_id: null, cancel_run_state: null };
  const list = { schema_version: 'deft.app_public_cancellation_owner_list.v1', installation_id: app, items: [item], next_after_cancellation_id: null };
  assert.equal(parseCancellationList(list, app).items.length, 1);
  for (const value of [{ ...list, secret: 'private' }, { ...list, items: [{ ...item, input: 'private' }] },
    { ...list, items: Array(21).fill(item) }, { ...list, next_after_cancellation_id: randomUUID() }]) assert.throws(() => parseCancellationList(value, app));
  assert.throws(() => parseCancellationList(list, randomUUID()));
  const context = { schema_version: 'deft.app_public_cancellation_owner_context.v1', installation_id: app, cancellation_id: id,
    state: item.state, original_version: '1.0.0', choices: [choice], cancel_run_id: null };
  assert.equal(parseCancellationContext(context, app, id).choices.length, 1);
  for (const value of [{ ...context, choices: Array(9).fill(choice) }, { ...context, choices: [{ ...choice, token: 'private' }] },
    { ...context, cancellation_id: randomUUID() }, { ...context, input: 'private' }]) assert.throws(() => parseCancellationContext(value, app, id));
});

test('public cancellation review display stays closed and requires exact current selection fresh lifetime and owner approval policy', () => {
  const id = randomUUID(), binding = randomUUID(), version = randomUUID(), digest = `sha256:${'a'.repeat(64)}`;
  const choice = { native_binding_id: binding, action_label: 'Cancel Booking', consent_digest: digest, current_app_version_id: version, historical_create_authorized: false };
  const review = { schema_version: 'deft.app_public_cancellation_owner_review.v1', cancellation_id: id,
    request: { schema_version: 'deft.app_public_cancellation_owner_review_request.v1', native_binding_id: binding, expected_consent_digest: digest },
    original_create_pin: { app_version_id: version, package_digest: digest, grant_snapshot_id: randomUUID(), grant_snapshot_digest: digest },
    current_app_version_id: version, native_binding_id: binding, historical_create_policy: null,
    input: { create_run_id: randomUUID(), event_ref: { schema_version: 'deft.resource_ref.v2', provider: { kind: 'core', provider_instance_id: 'calendar_events' }, resource_type: 'calendar_event', resource_id: randomUUID() } },
    review_digest: digest, review_token: 'bounded.review', expires_at: new Date(Date.now() + 60000).toISOString(),
    host_policy: { normal_owner_approval_required: true, old_grant_execution: false, automatic_rebinding: false } };
  assert.equal(parseCancellationReview(review, id, choice).native_binding_id, binding);
  for (const value of [{ ...review, secret: 'private' }, { ...review, expires_at: new Date(Date.now() - 1).toISOString() },
    { ...review, current_app_version_id: randomUUID() },
    { ...review, request: { ...review.request, expected_consent_digest: `sha256:${'b'.repeat(64)}` } },
    { ...review, input: { ...review.input, private_note: 'forbidden' } },
    { ...review, host_policy: { ...review.host_policy, automatic_rebinding: true } }]) assert.throws(() => parseCancellationReview(value, id, choice));
  const received = Date.now();
  const clamped = parseCancellationReview({ ...review, expires_at: new Date(received + 301000).toISOString() }, id, choice);
  assert.ok(Date.parse(clamped.expires_at) <= Date.now() + 300000, 'positive SQL/client clock skew cannot extend transient local display');
});
