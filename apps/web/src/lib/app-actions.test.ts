import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeAppActionList,
  normalizeAppActionPrepare,
  normalizeAppActionResolve,
  normalizeAppRun,
  normalizeAppRunResult,
} from './app-actions';

const ref = {
  schema_version: 'deft.resource_ref.v1',
  provider: { kind: 'module', provider_instance_id: 'campaign-module' },
  resource_type: 'campaigns',
  resource_id: 'campaign-1',
};
const resource = {
  schema_version: 'deft.resource_safe_projection.v1',
  ref,
  label: 'September campaign',
  href: '/modules/campaigns/campaigns/campaign-1',
  revision: '4',
};
const action = {
  binding_id: 'binding-1',
  installation_id: 'installation-1',
  app_id: 'community.deft.campaigns-app',
  app_version_id: 'version-1',
  action_key: 'send_campaign_email',
  label: 'Send campaign email',
  automation_requests: [{ key: 'daily_campaign_send', label: 'Daily campaign send' }],
};
const preview = {
  schema_version: 'deft.app_run.v1',
  title: 'Send September campaign',
  summary: 'Send to one selected contact',
  resource_refs: [{ resource_kind: 'campaign', resource_id: 'campaign-1', label: 'September campaign' }],
  fields: { recipient_count: 1 },
};

test('action discovery and resolution preserve only server-authorized relation options', () => {
  const listed = normalizeAppActionList({ result: { resource, actions: [action] } });
  const resolved = normalizeAppActionResolve({ result: {
    action,
    resource,
    inputs: [
      { input_key: 'subject', kind: 'resource_field' },
      { input_key: 'to', kind: 'selected_relation_field', relation_key: 'contacts', relation_revision: 2, options: [{ ...resource, ref: { ...ref, provider: { kind: 'module', provider_instance_id: 'contacts-module' }, resource_type: 'contacts', resource_id: 'contact-1' }, label: 'Ada' }] },
    ],
  } });
  assert.equal(listed.actions[0].bindingId, 'binding-1');
  assert.deepEqual(listed.actions[0].automationRequests, [{ key: 'daily_campaign_send', label: 'Daily campaign send' }]);
  assert.equal(resolved.inputs[1].kind, 'selected_relation_field');
  if (resolved.inputs[1].kind === 'selected_relation_field') {
    assert.equal(resolved.inputs[1].options[0].ref.resourceId, 'contact-1');
    assert.equal(resolved.inputs[1].relationRevision, 2);
  }
});

test('prepared action exposes safe preview and keeps the sealed candidate opaque', () => {
  const prepared = normalizeAppActionPrepare({ result: {
    action,
    safe_preview: preview,
    input_candidate: { version: 'v1', ciphertext_b64: 'sealed' },
    replay_identity: `sha256:${'a'.repeat(64)}`,
    authority_vector: { should_not_reach_ui_model: true },
  } });
  assert.equal(prepared.safePreview.title, 'Send September campaign');
  assert.deepEqual(prepared.inputCandidate, { version: 'v1', ciphertext_b64: 'sealed' });
  assert.equal('authority_vector' in prepared, false);
});

test('safe preview normalization rejects secret-bearing keys at any depth', () => {
  assert.throws(() => normalizeAppActionPrepare({ result: {
    action,
    safe_preview: { ...preview, fields: { nested: { access_token: 'do-not-render' } } },
    input_candidate: { ciphertext_b64: 'sealed' },
    replay_identity: `sha256:${'a'.repeat(64)}`,
  } }), /Unsafe App preview metadata/);
});

test('Run normalization projects safe status and authorized retained results', () => {
  const rawRun = {
    id: 'run-1',
    state: 'succeeded',
    safe_preview: preview,
    safe_outcome: { success: true, provider_call_attempted: true, result_status: 'retained', summary: 'Sent' },
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:01:00.000Z',
    terminal_at: '2026-09-01T00:01:00.000Z',
    provider_instance_id: 'must-not-be-projected',
  };
  const run = normalizeAppRun({ run: rawRun });
  const result = normalizeAppRunResult({ run: rawRun, value: { schema_version: 'deft.app_run_provider_result.v1', provider_succeeded: true, output: { message_id: 'provider-message-1' } } });
  assert.equal(run.safeOutcome?.summary, 'Sent');
  assert.equal('provider_instance_id' in run, false);
  assert.deepEqual(result.value, { schema_version: 'deft.app_run_provider_result.v1', provider_succeeded: true, output: { message_id: 'provider-message-1' } });
});
