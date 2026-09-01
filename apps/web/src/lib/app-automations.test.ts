import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAppAutomationManagement, normalizeAppAutomationReview } from './app-automations';

test('automation review normalization exposes only the bounded operator contract', () => {
  const review = normalizeAppAutomationReview({ review: {
    review_digest: `sha256:${'a'.repeat(64)}`,
    placement: {
      resource_ref: {
        schema_version: 'deft.resource_ref.v1',
        provider: { kind: 'module', provider_instance_id: 'campaigns-installation' },
        resource_type: 'campaign',
        resource_id: 'campaign-1',
      },
      revision: '7',
      content_digest: `sha256:${'c'.repeat(64)}`,
    },
    selected: {
      resource_ref: {
        schema_version: 'deft.resource_ref.v1',
        provider: { kind: 'module', provider_instance_id: 'contacts-installation' },
        resource_type: 'contact',
        resource_id: 'contact-1',
      },
      revision: '11',
      content_digest: `sha256:${'d'.repeat(64)}`,
    },
    schedule: { local_time: '09:00', timezone: 'Asia/Calcutta', catch_up_window_minutes: 15 },
    validity_seconds: 2_592_000,
    budgets: { max_org_runs_per_utc_day: 100, max_pending_org_fires: 25 },
    policy_version: '1',
    authorization_digest: `sha256:${'b'.repeat(64)}`,
  } });
  assert.equal(review.schedule.timezone, 'Asia/Calcutta');
  assert.equal(review.validitySeconds, 2_592_000);
  assert.equal(review.placement.resourceRef.resourceId, 'campaign-1');
  assert.equal(review.placement.revision, '7');
  assert.equal(review.placement.contentDigest, `sha256:${'c'.repeat(64)}`);
  assert.equal(review.selected.resourceRef.resourceId, 'contact-1');
  assert.equal(review.selected.revision, '11');
  assert.equal(review.selected.contentDigest, `sha256:${'d'.repeat(64)}`);
  assert.equal('authorization_digest' in review, false);
});

test('automation management normalization keeps schedule, health, and safe Run status', () => {
  const management = normalizeAppAutomationManagement({ automations: {
    schema: 'deft.app_automation_management.v1',
    generated_at: '2026-09-01T04:00:00.000Z',
    kill_switch: { enabled: true, status: 'enabled' },
    definitions: [{
      id: 'definition-1',
      action_key: 'send_campaign_email',
      automation_request_key: 'daily_campaign_send',
      state: 'active',
      definition_epoch: 2,
      schedule: { local_time: '09:30', timezone: 'Asia/Calcutta', catch_up_window_minutes: 15 },
      validity: { valid_from: '2026-09-01T00:00:00.000Z', valid_until: '2026-10-01T00:00:00.000Z' },
      budgets: { max_org_runs_per_utc_day: 100, max_pending_org_fires: 25 },
      next_fire_at_utc: '2026-09-02T04:00:00.000Z',
      fire_summary: { pending: 0, claimed: 0, run_created: 1, skipped: 0, dead_letter: 0 },
      latest_fire: {
        id: 'fire-1', logical_local_date: '2026-09-01', resolved_at_utc: '2026-09-01T04:00:00.000Z',
        state: 'run_created', attempt_count: 1, terminal_reason: 'run_created', terminal_at: '2026-09-01T04:00:01.000Z',
      },
      latest_run: { id: 'run-1', state: 'succeeded', updated_at: '2026-09-01T04:00:02.000Z', terminal_at: '2026-09-01T04:00:02.000Z' },
      retry: { eligible: false, reason: 'No dead-lettered fire requires review.' },
      authorization_vector: { must_not_render: true },
    }],
  } });
  assert.equal(management.killSwitchEnabled, true);
  assert.equal(management.definitions[0].latestRun?.state, 'succeeded');
  assert.equal('authorization_vector' in management.definitions[0], false);
});
