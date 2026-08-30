import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  APP_RUN_CONTRACT_VERSIONS,
  APP_RUN_LIMITS,
  APP_RUN_SECRET_RETENTION_MS,
  APP_RUN_IDEMPOTENCY_RETENTION_MS,
  AppRunSafeOutcomeSchema,
  AppRunRetainedProviderResultSchema,
  AppRunAttemptStateSchema,
  AppRunStateSchema,
  isAppRunAttemptStateTransitionAllowed,
  classifyAppRunCrashRecovery,
  isAppRunStateTransitionAllowed,
  parseAppRunSubmission,
  parseAppRunEvent,
  parseAppRunReceiptEnvelope,
  retentionDeadline,
  idempotencyDeadline,
} from '../src/app-runs';

const digest = `sha256:${'a'.repeat(64)}`;

function submission(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: APP_RUN_CONTRACT_VERSIONS.run,
    org_id: 'org-1',
    initiating_actor: { actor_type: 'human', user_id: 'user-1' },
    execution_actor: { actor_type: 'agent_employee', agent_employee_id: 'employee-1' },
    origin: { origin_kind: 'legacy_connector', connection_id: 'connection-1' },
    operation: {
      provider: {
        org_id: 'org-1',
        provider_kind: 'mcp',
        provider_instance_id: 'connection-1',
      },
      operation_name: 'send_email',
    },
    provider_snapshot_digest: digest,
    policy: {
      risk_class: 'external_write',
      review_requirement: 'always',
      review_scope: 'per_invocation',
      retry_class: 'unsafe_or_unknown',
    },
    retention_class: 'standard',
    idempotency_key: 'caller-key',
    input: { recipient: 'person@example.com', body: 'hello' },
    authorization_snapshot: {
      schema_version: APP_RUN_CONTRACT_VERSIONS.run,
      authenticated_subject: { actor_type: 'human', user_id: 'user-1' },
      authority_refs: [
        { authority_kind: 'membership', authority_id: 'membership-1', version: '3' },
        { authority_kind: 'connector', authority_id: 'connection-1', version: '5' },
      ],
    },
    safe_preview: {
      schema_version: APP_RUN_CONTRACT_VERSIONS.run,
      title: 'Send one email',
      resource_refs: [{ resource_kind: 'contact', resource_id: 'contact-1', label: 'Recipient' }],
    },
    ...overrides,
  };
}

describe('App Run contract', () => {
  test('keeps origin, actor, policy, and provider identity closed and tenant-bound', () => {
    const parsed = parseAppRunSubmission(submission());
    assert.equal(parsed.origin.origin_kind, 'legacy_connector');
    assert.equal(parsed.policy.review_requirement, 'always');

    assert.throws(() => parseAppRunSubmission(submission({
      operation: {
        provider: {
          org_id: 'other-org',
          provider_kind: 'mcp',
          provider_instance_id: 'connection-1',
        },
        operation_name: 'send_email',
      },
    })), /must match Run organization/);

    assert.throws(() => parseAppRunSubmission(submission({
      origin: { origin_kind: 'plugin', plugin_id: 'unsafe' },
    })));
  });

  test('enforces byte budgets for opaque replay keys and retained JSON', () => {
    assert.throws(() => parseAppRunSubmission(submission({
      idempotency_key: 'é'.repeat(APP_RUN_LIMITS.idempotency_key_bytes),
    })), /idempotency key exceeds/);

    assert.throws(() => parseAppRunSubmission(submission({
      input: { value: 'x'.repeat(APP_RUN_LIMITS.input_bytes) },
    })), /exceeds/);
  });

  test('allows only the frozen Run transitions and explicit unknown reconciliation', () => {
    for (const state of AppRunStateSchema.options) {
      assert.equal(isAppRunStateTransitionAllowed(state, state), true);
    }
    assert.equal(isAppRunStateTransitionAllowed('pending', 'pending_approval'), true);
    assert.equal(isAppRunStateTransitionAllowed('running', 'unknown_outcome'), true);
    assert.equal(isAppRunStateTransitionAllowed('unknown_outcome', 'succeeded'), true);
    assert.equal(isAppRunStateTransitionAllowed('succeeded', 'running'), false);
    assert.equal(isAppRunStateTransitionAllowed('failed', 'pending'), false);
  });

  test('keeps attempt transitions distinct from Run reconciliation', () => {
    for (const state of AppRunAttemptStateSchema.options) {
      assert.equal(isAppRunAttemptStateTransitionAllowed(state, state), true);
    }
    assert.equal(isAppRunAttemptStateTransitionAllowed('pending', 'claimed'), true);
    assert.equal(isAppRunAttemptStateTransitionAllowed('claimed', 'provider_call_started'), true);
    assert.equal(isAppRunAttemptStateTransitionAllowed('provider_call_started', 'unknown_outcome'), true);
    assert.equal(isAppRunAttemptStateTransitionAllowed('unknown_outcome', 'succeeded'), false);
    assert.equal(isAppRunAttemptStateTransitionAllowed('failed', 'claimed'), false);
  });

  test('freezes crash recovery without retrying a possibly-started unsafe effect', () => {
    assert.equal(classifyAppRunCrashRecovery({
      retry_class: 'unsafe_or_unknown',
      provider_call_started: true,
      provider_result_known: false,
      provider_idempotency_key_bound: false,
    }), 'unknown_outcome');
    assert.equal(classifyAppRunCrashRecovery({
      retry_class: 'idempotent_with_key',
      provider_call_started: true,
      provider_result_known: false,
      provider_idempotency_key_bound: true,
    }), 'create_retry_attempt');
    assert.equal(classifyAppRunCrashRecovery({
      retry_class: 'unsafe_or_unknown',
      provider_call_started: true,
      provider_result_known: true,
      provider_idempotency_key_bound: false,
    }), 'persist_known_result');
    assert.equal(classifyAppRunCrashRecovery({
      retry_class: 'unsafe_or_unknown',
      provider_call_started: false,
      provider_result_known: false,
      provider_idempotency_key_bound: false,
    }), 'create_retry_attempt');
  });

  test('rejects opaque authorization blobs and duplicate authority versions', () => {
    assert.throws(() => parseAppRunSubmission(submission({
      authorization_snapshot: { membership_version: 3, connector_version: 5 },
    })));
    assert.throws(() => parseAppRunSubmission(submission({
      authorization_snapshot: {
        schema_version: APP_RUN_CONTRACT_VERSIONS.run,
        authenticated_subject: { actor_type: 'human', user_id: 'user-1' },
        authority_refs: [
          { authority_kind: 'membership', authority_id: 'membership-1', version: '3' },
          { authority_kind: 'membership', authority_id: 'membership-1', version: '4' },
        ],
      },
    })), /must be unique/);
  });

  test('keeps safe outcomes result-free and coherent', () => {
    assert.deepEqual(AppRunSafeOutcomeSchema.parse({
      success: true,
      provider_call_attempted: true,
      result_status: 'retained',
      summary: 'Sent',
    }), {
      success: true,
      provider_call_attempted: true,
      result_status: 'retained',
      summary: 'Sent',
    });
    assert.throws(() => AppRunSafeOutcomeSchema.parse({
      success: true,
      provider_call_attempted: true,
      result_status: 'retained',
      output: { secret: true },
    }));
    assert.throws(() => AppRunSafeOutcomeSchema.parse({
      success: false,
      provider_call_attempted: false,
      result_status: 'unavailable',
    }), /require an error code/);
  });

  test('keeps determinate provider responses in a strict retained envelope', () => {
    assert.deepEqual(AppRunRetainedProviderResultSchema.parse({
      schema_version: APP_RUN_CONTRACT_VERSIONS.provider_result,
      provider_succeeded: false,
      output: { code: 'recipient_rejected', private_detail: 'retained ciphertext only' },
    }), {
      schema_version: APP_RUN_CONTRACT_VERSIONS.provider_result,
      provider_succeeded: false,
      output: { code: 'recipient_rejected', private_detail: 'retained ciphertext only' },
    });
    assert.throws(() => AppRunRetainedProviderResultSchema.parse({
      schema_version: APP_RUN_CONTRACT_VERSIONS.provider_result,
      provider_succeeded: true,
      output: undefined,
    }));
    assert.throws(() => AppRunRetainedProviderResultSchema.parse({
      schema_version: APP_RUN_CONTRACT_VERSIONS.provider_result,
      provider_succeeded: true,
      output: { ok: true },
      raw_input: { secret: true },
    }));
  });

  test('freezes safe event and receipt envelopes without secret-bearing metadata', () => {
    const event = {
      schema_version: APP_RUN_CONTRACT_VERSIONS.event,
      event_id: 'event-1',
      org_id: 'org-1',
      run_id: 'run-1',
      sequence: 1,
      event_type: 'run_created',
      payload: { summary: 'Created' },
      occurred_at: '2026-08-30T00:00:00.000Z',
    };
    assert.equal(parseAppRunEvent(event).event_type, 'run_created');
    assert.throws(() => parseAppRunEvent({
      ...event,
      payload: { nested: { ciphertext_b64: 'not-safe' } },
    }), /secret-bearing/);

    const receipt = {
      schema_version: APP_RUN_CONTRACT_VERSIONS.receipt,
      receipt_id: 'receipt-1',
      receipt_kind: 'attempt_terminal',
      org_id: 'org-1',
      run_id: 'run-1',
      attempt_id: 'attempt-1',
      run_state: 'succeeded',
      operation: {
        provider: { org_id: 'org-1', provider_kind: 'mcp', provider_instance_id: 'provider-1' },
        operation_name: 'send_email',
      },
      policy: {
        risk_class: 'external_write',
        review_requirement: 'always',
        review_scope: 'per_invocation',
        retry_class: 'unsafe_or_unknown',
      },
      input_fingerprint: {
        key_version: 'fp-v1',
        fingerprint: `hmac-sha256:${'a'.repeat(64)}`,
      },
      output_envelope_digest: digest,
      facts: { result_status: 'retained' },
      occurred_at: '2026-08-30T00:00:01.000Z',
    };
    assert.equal(parseAppRunReceiptEnvelope(receipt).receipt_kind, 'attempt_terminal');
    assert.throws(() => parseAppRunReceiptEnvelope({ ...receipt, attempt_id: undefined }));
    assert.throws(() => parseAppRunReceiptEnvelope({
      ...receipt,
      facts: { output: { recipient: 'person@example.com' } },
    }), /secret-bearing/);
  });

  test('uses fixed retention ceilings independent of later permission changes', () => {
    const from = new Date('2026-08-30T00:00:00.000Z');
    assert.equal(
      retentionDeadline('ephemeral', from).getTime() - from.getTime(),
      APP_RUN_SECRET_RETENTION_MS.ephemeral,
    );
    assert.equal(
      retentionDeadline('extended', from).getTime() - from.getTime(),
      APP_RUN_SECRET_RETENTION_MS.extended,
    );
    assert.equal(
      idempotencyDeadline('standard', from).getTime() - from.getTime(),
      APP_RUN_IDEMPOTENCY_RETENTION_MS.standard,
    );
    assert.ok(
      idempotencyDeadline('extended', from).getTime() > retentionDeadline('extended', from).getTime(),
    );
  });
});
