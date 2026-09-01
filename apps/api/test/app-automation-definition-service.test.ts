import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APP_AUTOMATION_POLICY_V1 } from '@deft/app-kit';
import { RESOURCE_CONTRACT_VERSIONS } from '@deft/shared';
import {
  APP_AUTOMATION_FOUNDATION_LIMITS,
  APP_AUTOMATION_POLICY_DIGEST,
  AppAutomationDefinitionReviewInputSchema,
  canonicalAppAutomationTimezone,
  digestAppAutomationFireIdentity,
} from '../src/lib/app-automation-definition-service.js';
import { digestAppGrantValue } from '../src/lib/app-grant-service.js';

const REF = {
  schema_version: RESOURCE_CONTRACT_VERSIONS.ref,
  provider: {
    kind: 'module' as const,
    provider_instance_id: '4a8104b9-a47e-4f44-a040-d5c9ad6a51f0',
  },
  resource_type: 'campaigns',
  resource_id: '3e283469-3883-4848-af03-4148b6610f6b',
};
const DIGEST = `sha256:${'a'.repeat(64)}`;

function reviewInput() {
  return {
    app_installation_id: 'f6520a59-00e7-4792-ad17-0044615fba5d',
    app_version_id: '85498475-4a94-4730-8839-c5f2d6d12ba3',
    action_binding_id: 'ea3445b7-6d7d-4a76-9ac0-4df0a74c90de',
    automation_request_key: 'daily_campaign_send',
    placement: { resource_ref: REF, revision: '1', content_digest: DIGEST },
    selected: {
      resource_ref: { ...REF, resource_type: 'contacts', resource_id: 'f208bb59-2749-48f6-a6a7-da13212e01e9' },
      revision: '1',
      content_digest: DIGEST,
    },
    local_time: '09:00',
    timezone: 'UTC',
    validity_seconds: 86_400,
  };
}

test('automation review input is closed, bounded, and has no caller authority vector', () => {
  const parsed = AppAutomationDefinitionReviewInputSchema.parse(reviewInput());
  assert.equal('max_actions_per_fire' in parsed, false);
  assert.equal(parsed.max_org_runs_per_utc_day, APP_AUTOMATION_FOUNDATION_LIMITS.max_org_runs_per_utc_day);
  assert.equal(parsed.max_pending_org_fires, APP_AUTOMATION_FOUNDATION_LIMITS.max_pending_org_fires);
  assert.equal(AppAutomationDefinitionReviewInputSchema.safeParse({
    ...reviewInput(),
    authorization_vector: { forged: true },
  }).success, false);
  assert.equal(AppAutomationDefinitionReviewInputSchema.safeParse({
    ...reviewInput(),
    validity_seconds: APP_AUTOMATION_FOUNDATION_LIMITS.validity_seconds + 1,
  }).success, false);
});

test('automation policy digest comes from the one code-owned policy descriptor', () => {
  assert.equal(APP_AUTOMATION_POLICY_DIGEST, digestAppGrantValue(APP_AUTOMATION_POLICY_V1));
  assert.equal(APP_AUTOMATION_POLICY_V1.private_interface.key, 'sandbox_email_send');
  assert.equal(APP_AUTOMATION_POLICY_V1.review_scope, 'approved_automation_definition');
});

test('fire identity is canonical, deterministic, and epoch-bound', () => {
  assert.equal(canonicalAppAutomationTimezone('UTC'), 'UTC');
  const input = {
    organization_id: 'e3d616e6-bbfa-4649-95eb-119060b9aee6',
    definition_id: '889440fc-a3a0-42c8-99fe-4b08eb5cc7b2',
    definition_epoch: 3,
    logical_local_date: '2026-09-01',
    local_time: '09:00',
    timezone: 'UTC',
  } as const;
  const digest = digestAppAutomationFireIdentity(input);
  assert.match(digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(digestAppAutomationFireIdentity(input), digest);
  assert.notEqual(digestAppAutomationFireIdentity({ ...input, definition_epoch: 4 }), digest);
});
