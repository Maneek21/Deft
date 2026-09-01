import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';

import {
  APP_RUN_CONTRACT_VERSIONS,
  RESOURCE_CONTRACT_VERSIONS,
  parseAppRunSubmission,
} from '@deft/shared';

import { parseEnvironmentAppRunKeyrings } from '../src/lib/app-run-keyrings.js';
import {
  AppRunPreparedInputService,
  appRelationAuthorityId,
  digestPreparedAppAuthority,
  projectPreparedAppAuthorityRefs,
} from '../src/lib/app-run-prepared-input.js';
import { AppRunSecretService } from '../src/lib/app-run-secrets.js';
import { digestAppGrantValue } from '../src/lib/app-grant-service.js';
import { appRunReplayAuthorityMatches } from '../src/lib/app-run-service.js';

function key(byte: number): string {
  return Buffer.alloc(32, byte).toString('base64');
}

function createSecrets(): Readonly<{
  provider: ReturnType<typeof parseEnvironmentAppRunKeyrings>;
  service: AppRunSecretService;
}> {
  const provider = parseEnvironmentAppRunKeyrings(JSON.stringify({
    schema_version: APP_RUN_CONTRACT_VERSIONS.keyring,
    run_encryption: { current: 'enc-v1', keys: { 'enc-v1': key(1) } },
    receipt_signing: { current: 'sig-v1', keys: { 'sig-v1': key(2) } },
    fingerprint: { current: 'fp-v1', keys: { 'fp-v1': key(3) } },
  }));
  return { provider, service: new AppRunSecretService(provider) };
}

const bindingIdentity = {
  app_installation_id: 'installation-1',
  app_version_id: 'version-1',
  grant_snapshot_id: 'grant-snapshot-1',
  binding_id: 'binding-1',
  binding_digest: `sha256:${'a'.repeat(64)}`,
} as const;

const digest = (byte: string) => `sha256:${byte.repeat(64)}` as const;

function appAuthorityVector() {
  const campaign = {
    schema_version: RESOURCE_CONTRACT_VERSIONS.ref,
    provider: { kind: 'module' as const, provider_instance_id: 'campaign-module' },
    resource_type: 'campaigns',
    resource_id: 'campaign-1',
  };
  const contact = {
    schema_version: RESOURCE_CONTRACT_VERSIONS.ref,
    provider: { kind: 'module' as const, provider_instance_id: 'contact-module' },
    resource_type: 'contacts',
    resource_id: 'contact-1',
  };
  return {
    schema_version: 'deft.app_action_authority.v1' as const,
    caller_surface: 'human:ui' as const,
    installation: { id: bindingIdentity.app_installation_id, lifecycle_epoch: 2, grant_epoch: 3 },
    app_version: {
      id: bindingIdentity.app_version_id,
      manifest_digest: digest('1'),
      package_digest: digest('2'),
    },
    grant: { id: bindingIdentity.grant_snapshot_id, snapshot_digest: digest('3') },
    binding: {
      id: bindingIdentity.binding_id,
      action_key: 'send_campaign_email',
      binding_digest: bindingIdentity.binding_digest,
      connector_authorization_version: 4,
    },
    dependencies: [],
    provider: {
      connection_id: 'connection-mail',
      snapshot_id: 'provider-snapshot-1',
      snapshot_digest: digest('4'),
      operation_name: 'send_email',
      operation_schema_digest: digest('5'),
    },
    run_authorization: {
      schema_version: APP_RUN_CONTRACT_VERSIONS.run,
      authenticated_subject: { actor_type: 'human' as const, user_id: 'user-1' },
      authority_refs: [{
        authority_kind: 'membership' as const,
        authority_id: 'user-1',
        version: digest('6'),
      }],
    },
    resources: [{
      ref: campaign,
      revision: 1,
      active_manifest_digest: digest('7'),
      validated_manifest_digest: digest('7'),
      updated_at: '2026-08-31T12:00:00.000Z',
    }, {
      ref: contact,
      revision: 2,
      active_manifest_digest: digest('8'),
      validated_manifest_digest: digest('8'),
      updated_at: '2026-08-31T12:01:00.000Z',
    }],
    relations: [{
      source_ref: campaign,
      relation_key: 'recipients',
      revision: 5,
      selected_ref: contact,
    }],
  };
}

function automationAuthorityVector() {
  const base = appAuthorityVector();
  return {
    ...base,
    schema_version: 'deft.app_action_authority.v2' as const,
    caller_surface: 'automation' as const,
    run_authorization: {
      ...base.run_authorization,
      authenticated_subject: { actor_type: 'human' as const, user_id: 'owner-1' },
      authority_refs: [{
        authority_kind: 'membership' as const,
        authority_id: 'owner-1',
        version: digest('6'),
      }],
    },
    resources: base.resources.map((resource, index) => ({
      ...resource,
      content_digest: index === 0 ? digest('a') : digest('b'),
    })),
    automation: {
      request: { key: 'daily_campaign', digest: digest('c') },
      definition: {
        id: 'automation-definition-1',
        epoch: 1,
        digest: digest('d'),
        authorization_digest: digest('e'),
        approved_by_user_id: 'owner-1',
        approved_at: '2026-08-31T11:00:00.000Z',
        valid_from: '2026-08-31T11:00:00.000Z',
        valid_until: '2026-09-30T11:00:00.000Z',
      },
      fire: {
        id: 'automation-fire-1',
        identity: digest('f'),
        logical_local_date: '2026-09-01',
        local_time: '09:30',
        timezone: 'Asia/Calcutta',
        resolved_at_utc: '2026-09-01T04:00:00.000Z',
      },
      policy: {
        key: 'sandbox_email_send_approved_automation',
        version: '1' as const,
        digest: digest('1'),
      },
      budgets: {
        max_actions_per_fire: 1 as const,
        max_org_runs_per_utc_day: 100,
        max_pending_org_fires: 25,
      },
    },
  };
}

describe('App Run prepared input', () => {
  test('protects provider input without exposing plaintext and preserves replay and binding identity', () => {
    const { provider, service: secrets } = createSecrets();
    const preparedInputs = new AppRunPreparedInputService(secrets);
    const idempotencyKey = 'idem-customer-42-send-7';
    const replayIdentity = `sha256:${createHash('sha256').update(idempotencyKey).digest('hex')}`;
    const providerInput = {
      recipient: 'private-recipient@example.test',
      subject: 'Private quarterly subject',
      body: 'Private prepared message body',
    };

    try {
      const candidate = preparedInputs.protect({
        org_id: 'org-1',
        replay_identity: replayIdentity,
        binding_identity: bindingIdentity,
        provider_input: providerInput,
      });
      const opened = preparedInputs.open('org-1', candidate);

      assert.deepEqual(opened, {
        schema_version: candidate.schema_version,
        expires_at: candidate.expires_at,
        replay_identity: replayIdentity,
        binding_identity: bindingIdentity,
        provider_input: providerInput,
      });

      const ciphertextSerialization = JSON.stringify(candidate.sealed_payload);
      const candidateSerialization = JSON.stringify(candidate);
      for (const plaintext of [
        providerInput.recipient,
        providerInput.subject,
        providerInput.body,
        idempotencyKey,
      ]) {
        assert.doesNotMatch(ciphertextSerialization, new RegExp(plaintext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.doesNotMatch(candidateSerialization, new RegExp(plaintext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      }
    } finally {
      provider.destroy();
    }
  });

  test('rejects a tampered candidate identity and a different organization', () => {
    const { provider, service: secrets } = createSecrets();
    const preparedInputs = new AppRunPreparedInputService(secrets);

    try {
      const candidate = preparedInputs.protect({
        org_id: 'org-1',
        replay_identity: `sha256:${'b'.repeat(64)}`,
        binding_identity: bindingIdentity,
        provider_input: { body: 'authenticated input' },
      });

      assert.throws(() => preparedInputs.open('org-1', {
        ...candidate,
        candidate_id: 'different-candidate-id',
      }));
      assert.throws(() => preparedInputs.open('org-1', {
        ...candidate,
        expires_at: new Date(Date.parse(candidate.expires_at) + 60_000).toISOString(),
      }), /APP_RUN_PREPARED_INPUT_INVALID/);
      assert.throws(() => preparedInputs.open('org-1', {
        ...candidate,
        safe_envelope: { ...candidate.safe_envelope, key_version: 'different-key' },
      }));
      assert.throws(() => preparedInputs.open('org-2', candidate));
    } finally {
      provider.destroy();
    }
  });

  test('rejects a candidate once the injected clock reaches its expiry', () => {
    const { provider, service: secrets } = createSecrets();
    let now = new Date('2026-08-31T12:00:00.000Z');
    const preparedInputs = new AppRunPreparedInputService(secrets, () => now);

    try {
      const candidate = preparedInputs.protect({
        org_id: 'org-1',
        replay_identity: `sha256:${'c'.repeat(64)}`,
        binding_identity: bindingIdentity,
        provider_input: { body: 'short-lived input' },
      });
      assert.doesNotThrow(() => preparedInputs.open('org-1', candidate));

      now = new Date(candidate.expires_at);
      assert.throws(
        () => preparedInputs.open('org-1', candidate),
        /APP_RUN_PREPARED_INPUT_INVALID/,
      );
    } finally {
      provider.destroy();
    }
  });

  test('authenticates the exact App authority vector and projects only closed App refs', () => {
    const { provider, service: secrets } = createSecrets();
    const preparedInputs = new AppRunPreparedInputService(secrets);
    const authorityVector = appAuthorityVector();
    const authorityDigest = digestPreparedAppAuthority(authorityVector);

    try {
      assert.equal(authorityDigest, digestAppGrantValue(authorityVector));
      const candidate = preparedInputs.protect({
        org_id: 'org-1',
        replay_identity: digest('9'),
        binding_identity: bindingIdentity,
        provider_input: {
          idempotency_key: 'caller-key',
          recipient: 'private-recipient@example.test',
        },
        app_run: {
          initiating_actor: { actor_type: 'human', user_id: 'user-1' },
          execution_actor: { actor_type: 'human', user_id: 'user-1' },
          safe_preview: {
            schema_version: APP_RUN_CONTRACT_VERSIONS.run,
            title: 'Send campaign email',
            resource_refs: [],
          },
          authority_vector: authorityVector,
          authority_digest: authorityDigest,
        },
      });
      const opened = preparedInputs.open('org-1', candidate);
      assert.ok(opened.app_run);
      assert.deepEqual(opened.app_run.authority_vector, authorityVector);
      assert.deepEqual(
        opened.app_run.authority_refs,
        projectPreparedAppAuthorityRefs(authorityVector),
      );
      assert.deepEqual(
        new Set(opened.app_run.authority_refs.map((ref) => ref.authority_kind)),
        new Set([
          'app_surface', 'app_installation', 'app_version', 'app_grant',
          'app_binding', 'resource', 'relation',
        ]),
      );
      assert.doesNotMatch(JSON.stringify(candidate), /private-recipient@example\.test|caller-key/);

      assert.throws(() => preparedInputs.protect({
        org_id: 'org-1',
        replay_identity: digest('9'),
        binding_identity: { ...bindingIdentity, app_version_id: 'different-version' },
        provider_input: { idempotency_key: 'caller-key' },
        app_run: {
          initiating_actor: { actor_type: 'human', user_id: 'user-1' },
          execution_actor: { actor_type: 'human', user_id: 'user-1' },
          safe_preview: {
            schema_version: APP_RUN_CONTRACT_VERSIONS.run,
            title: 'Send campaign email',
            resource_refs: [],
          },
          authority_vector: authorityVector,
          authority_digest: authorityDigest,
        },
      }), /APP_RUN_PREPARED_INPUT_INVALID/);
    } finally {
      provider.destroy();
    }
  });

  test('binds v2 automation candidates to the approved human, definition, fire, policy, and content', () => {
    const { provider, service: secrets } = createSecrets();
    const preparedInputs = new AppRunPreparedInputService(secrets);
    const authorityVector = automationAuthorityVector();
    const appRun = {
      initiating_actor: { actor_type: 'human' as const, user_id: 'owner-1' },
      execution_actor: {
        actor_type: 'automation' as const,
        automation_id: 'automation-definition-1',
        user_id: 'owner-1',
      },
      safe_preview: {
        schema_version: APP_RUN_CONTRACT_VERSIONS.run,
        title: 'Send scheduled campaign email',
        resource_refs: [],
      },
      authority_vector: authorityVector,
      authority_digest: digestPreparedAppAuthority(authorityVector),
    };

    try {
      const candidate = preparedInputs.protect({
        org_id: 'org-1',
        replay_identity: digest('2'),
        binding_identity: bindingIdentity,
        provider_input: { idempotency_key: authorityVector.automation.fire.identity },
        app_run: appRun,
      });
      const opened = preparedInputs.open('org-1', candidate);
      assert.equal(opened.app_run?.authority_vector.schema_version, 'deft.app_action_authority.v2');
      assert.deepEqual(
        new Set(opened.app_run?.authority_refs.map((ref) => ref.authority_kind)),
        new Set([
          'app_surface', 'app_installation', 'app_version', 'app_grant',
          'app_binding', 'resource', 'relation', 'app_automation_request',
          'app_automation_definition', 'app_automation_fire', 'app_automation_policy',
        ]),
      );

      assert.throws(() => preparedInputs.protect({
        org_id: 'org-1',
        replay_identity: digest('2'),
        binding_identity: bindingIdentity,
        provider_input: { idempotency_key: authorityVector.automation.fire.identity },
        app_run: {
          ...appRun,
          execution_actor: { actor_type: 'human', user_id: 'owner-1' },
        },
      }), /Prepared automation actor is invalid/);
    } finally {
      provider.destroy();
    }
  });

  test('App replay requires exact origin and canonical surface/resource authority', () => {
    const vector = appAuthorityVector();
    const authorityRefs = [
      ...vector.run_authorization.authority_refs,
      ...projectPreparedAppAuthorityRefs(vector),
    ];
    const submission = parseAppRunSubmission({
      schema_version: APP_RUN_CONTRACT_VERSIONS.run,
      org_id: 'org-1',
      initiating_actor: { actor_type: 'human', user_id: 'user-1' },
      execution_actor: { actor_type: 'human', user_id: 'user-1' },
      origin: {
        origin_kind: 'app',
        installation_id: vector.installation.id,
        app_version_id: vector.app_version.id,
        binding_key: vector.binding.action_key,
        grant_snapshot_id: vector.grant.id,
      },
      operation: {
        provider: {
          org_id: 'org-1',
          provider_kind: 'mcp',
          provider_instance_id: vector.provider.connection_id,
        },
        operation_name: vector.provider.operation_name,
      },
      provider_snapshot_digest: vector.provider.snapshot_digest,
      policy: {
        risk_class: 'external_write',
        review_requirement: 'always',
        review_scope: 'per_invocation',
        retry_class: 'idempotent_with_key',
      },
      retention_class: 'standard',
      idempotency_key: 'app-action-replay',
      input: { idempotency_key: 'caller-key' },
      authorization_snapshot: {
        ...vector.run_authorization,
        authority_refs: authorityRefs,
      },
      safe_preview: {
        schema_version: APP_RUN_CONTRACT_VERSIONS.run,
        title: 'Send campaign email',
        resource_refs: [],
      },
    });
    const replay = {
      origin_app_installation_id: vector.installation.id,
      origin_app_version_id: vector.app_version.id,
      origin_app_binding_key: vector.binding.action_key,
      origin_app_grant_snapshot_id: vector.grant.id,
      authorization_snapshot: {
        ...submission.authorization_snapshot,
        authority_refs: [...authorityRefs].reverse(),
      },
    };
    assert.equal(appRunReplayAuthorityMatches(replay, submission), true);
    assert.equal(appRunReplayAuthorityMatches({
      ...replay,
      origin_app_binding_key: 'different_action',
    }, submission), false);
    assert.equal(appRunReplayAuthorityMatches({
      ...replay,
      authorization_snapshot: {
        ...submission.authorization_snapshot,
        authority_refs: authorityRefs.map((ref) => ref.authority_kind === 'resource'
          ? { ...ref, version: digest('0') }
          : ref),
      },
    }, submission), false);
  });

  test('automation replay additionally requires the exact persisted definition and fire lineage', () => {
    const vector = automationAuthorityVector();
    const submission = parseAppRunSubmission({
      schema_version: APP_RUN_CONTRACT_VERSIONS.run,
      org_id: 'org-1',
      initiating_actor: { actor_type: 'human', user_id: 'owner-1' },
      execution_actor: {
        actor_type: 'automation',
        automation_id: vector.automation.definition.id,
        user_id: 'owner-1',
      },
      origin: {
        origin_kind: 'app',
        installation_id: vector.installation.id,
        app_version_id: vector.app_version.id,
        binding_key: vector.binding.action_key,
        grant_snapshot_id: vector.grant.id,
      },
      operation: {
        provider: {
          org_id: 'org-1',
          provider_kind: 'mcp',
          provider_instance_id: vector.provider.connection_id,
        },
        operation_name: vector.provider.operation_name,
      },
      provider_snapshot_digest: vector.provider.snapshot_digest,
      policy: {
        risk_class: 'external_write',
        review_requirement: 'always',
        review_scope: 'approved_automation_definition',
        retry_class: 'idempotent_with_key',
      },
      retention_class: 'standard',
      idempotency_key: `app-automation:${vector.automation.fire.identity}`,
      input: { idempotency_key: vector.automation.fire.identity },
      authorization_snapshot: {
        ...vector.run_authorization,
        authority_refs: [
          ...vector.run_authorization.authority_refs,
          ...projectPreparedAppAuthorityRefs(vector),
        ],
      },
      safe_preview: {
        schema_version: APP_RUN_CONTRACT_VERSIONS.run,
        title: 'Send scheduled campaign email',
        resource_refs: [],
      },
    });
    const replay = {
      origin_app_installation_id: vector.installation.id,
      origin_app_version_id: vector.app_version.id,
      origin_app_binding_key: vector.binding.action_key,
      origin_app_grant_snapshot_id: vector.grant.id,
      origin_app_automation_definition_id: vector.automation.definition.id,
      origin_app_automation_fire_id: vector.automation.fire.id,
      authorization_snapshot: submission.authorization_snapshot,
    };
    assert.equal(appRunReplayAuthorityMatches(replay, submission, vector), true);
    assert.equal(appRunReplayAuthorityMatches({
      ...replay,
      origin_app_automation_fire_id: 'different-fire',
    }, submission, vector), false);
    assert.equal(appRunReplayAuthorityMatches(replay, submission), false);
  });

  test('keeps relation revision in authority version but out of relation identity', () => {
    const [relation] = appAuthorityVector().relations;
    assert.ok(relation);
    assert.equal(
      appRelationAuthorityId(relation),
      appRelationAuthorityId({
        source_ref: relation.source_ref,
        relation_key: relation.relation_key,
        selected_ref: relation.selected_ref,
      }),
    );
  });
});
