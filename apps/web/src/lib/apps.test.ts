import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isConnectedAppManifest,
  normalizeAppGrantManagement,
  normalizeAppInstallation,
  normalizeAppRunReceiptBundle,
  normalizeConnectedAppHealth,
  normalizeConnectedAppReview,
} from './apps';

const now = '2026-09-01T00:00:00.000Z';
const provenance = {
  source_repository: 'https://example.test/campaigns',
  source_commit: 'abcdef0',
};
const moduleRef = {
  module_id: 'community.deft.campaigns',
  version: '1.0.0',
  manifest_path: 'modules/campaigns/deft.module.json',
  manifest_digest: 'sha256:module',
};
const compatibility = {
  schema: 'deft.app_developer.compatibility.v1',
  app_kit: { package: '@deft/app-kit', versions: ['0.1.0-alpha.1'] },
  protocol_flows: {
    '0': { package_format: 'deft.app.package.v0', install_mode: 'stage_and_activate' },
    '1': { package_format: 'deft.app.package.v1', install_mode: 'stage_only' },
  },
};

function connectedManifest(version = '1.0.0') {
  return {
    schema_version: '1',
    id: 'community.deft.campaigns-app',
    version,
    name: 'Campaigns',
    license: 'AGPL-3.0-only',
    compatibility: { app_protocol: '1' },
    provenance,
    modules: [moduleRef],
    navigation: [],
    dependencies: [{ key: 'contacts', app_id: 'community.deft.contacts-app', version: '1.0.0' }],
    resource_requirements: [
      {
        key: 'campaign',
        source: { kind: 'included_module', module_id: moduleRef.module_id, version: moduleRef.version },
        resource_type: 'campaigns',
        fields: ['subject', 'body_text'],
      },
      {
        key: 'contact',
        source: {
          kind: 'dependency_module',
          dependency_key: 'contacts',
          module_id: 'community.deft.contacts',
          version: '1.0.0',
        },
        resource_type: 'contacts',
        fields: ['email'],
      },
    ],
    capability_requirements: [{
      key: 'send_email',
      interface: { kind: 'private', namespace: 'app_lineage', key: 'send_email', version: '1' },
    }],
    connector_requirements: [{ key: 'mail', provider_kind: 'mcp' }],
    actions: [{
      key: 'send',
      label: 'Send',
      capability_requirement_key: 'send_email',
      connector_requirement_key: 'mail',
      placement: { kind: 'resource_detail', resource_requirement_key: 'campaign' },
      input_bindings: [
        {
          input_key: 'to',
          source: {
            kind: 'selected_relation_field',
            source_resource_requirement_key: 'campaign',
            relation_field_key: 'contacts',
            target_resource_requirement_key: 'contact',
            target_field_key: 'email',
            selection: 'one',
          },
        },
        {
          input_key: 'subject',
          source: { kind: 'resource_field', resource_requirement_key: 'campaign', field_key: 'subject' },
        },
        {
          input_key: 'body_text',
          source: { kind: 'resource_field', resource_requirement_key: 'campaign', field_key: 'body_text' },
        },
      ],
    }],
  };
}

function installation(protocol: '0' | '1') {
  return {
    id: 'installation-1',
    version_id: 'version-1',
    app_id: 'community.deft.campaigns-app',
    name: 'Campaigns',
    version: '1.0.0',
    state: 'staged',
    lifecycle_epoch: 0,
    grant_epoch: 0,
    active_version_id: null,
    package_digest: 'sha256:package',
    manifest_digest: 'sha256:manifest',
    manifest: protocol === '0' ? {
      schema_version: '0',
      id: 'community.deft.campaigns-app',
      version: '1.0.0',
      name: 'Campaigns',
      license: 'AGPL-3.0-only',
      compatibility: { app_protocol: '0' },
      modules: [moduleRef],
      navigation: [],
    } : connectedManifest(),
    created_at: now,
    updated_at: now,
  };
}

test('App installation normalization preserves v0 and the expanded connected v1 manifest', () => {
  const v0 = normalizeAppInstallation(installation('0'));
  const v1 = normalizeAppInstallation(installation('1'));
  assert.equal(isConnectedAppManifest(v0.manifest), false);
  assert.equal(isConnectedAppManifest(v1.manifest), true);
  if (isConnectedAppManifest(v1.manifest)) {
    assert.deepEqual(v1.manifest.resource_requirements[1].source, {
      kind: 'dependency_module',
      dependency_key: 'contacts',
      module_id: 'community.deft.contacts',
      version: '1.0.0',
    });
    assert.deepEqual(v1.manifest.capability_requirements[0].interface, {
      kind: 'private', namespace: 'app_lineage', key: 'send_email', version: '1',
    });
    assert.equal(v1.manifest.actions[0].placement.resource_requirement_key, 'campaign');
    assert.equal(v1.manifest.actions[0].input_bindings[0].source.kind, 'selected_relation_field');
  }
});

test('connected grant management projects staged review, active grants, compatibility, and recent Run data', () => {
  const grants = normalizeAppGrantManagement({ grants: {
    installation: {
      id: 'installation-1', app_id: 'community.deft.campaigns-app', state: 'active', active_version_id: 'version-1',
      active_grant_snapshot_id: 'effective-1', lifecycle_epoch: 1, grant_epoch: 1,
    },
    compatibility,
    versions: [
      {
        id: 'version-2', version: '1.1.0', protocol_version: '1', state: 'staged',
        manifest: connectedManifest('1.1.0'), package_format: 'deft.app.package.v1', provenance,
        provenance_trust: 'local_unsigned', package_digest: 'sha256:package-2', manifest_digest: 'sha256:manifest-2',
        requested_grant_snapshot_id: 'requested-2', staged_at: '2026-09-01T00:03:00.000Z',
        activated_at: null, superseded_at: null,
      },
      {
        id: 'version-1', version: '1.0.0', protocol_version: '1', state: 'active',
        manifest: connectedManifest(), package_format: 'deft.app.package.v1', provenance,
        provenance_trust: 'local_unsigned', package_digest: 'sha256:package-1', manifest_digest: 'sha256:manifest-1',
        requested_grant_snapshot_id: 'requested-1', staged_at: now,
        activated_at: '2026-09-01T00:01:00.000Z', superseded_at: null,
      },
    ],
    snapshots: [
      { id: 'requested-2', app_version_id: 'version-2', snapshot_kind: 'requested', requested_snapshot_id: null, supersedes_snapshot_id: null, resource_rights: [{}], classification: {}, snapshot_digest: 'sha256:requested-2', reviewed_at: null, created_at: '2026-09-01T00:03:00.000Z' },
      { id: 'requested-1', app_version_id: 'version-1', snapshot_kind: 'requested', requested_snapshot_id: null, supersedes_snapshot_id: null, resource_rights: [{}], classification: {}, snapshot_digest: 'sha256:requested-1', reviewed_at: null, created_at: now },
      { id: 'effective-1', app_version_id: 'version-1', snapshot_kind: 'effective', requested_snapshot_id: 'requested-1', supersedes_snapshot_id: null, resource_rights: [{}], classification: {}, snapshot_digest: 'sha256:effective', reviewed_at: '2026-09-01T00:01:00.000Z', created_at: '2026-09-01T00:01:00.000Z' },
    ],
    review_target: {
      activation_kind: 'upgrade',
      app_version_id: 'version-2',
      version: '1.1.0',
      protocol_version: '1',
      package_format: 'deft.app.package.v1',
      package_digest: 'sha256:package-2',
      manifest_digest: 'sha256:manifest-2',
      manifest: connectedManifest('1.1.0'),
      provenance,
      provenance_trust: 'local_unsigned',
      requested_snapshot_id: 'requested-2',
      requested_snapshot_digest: 'sha256:requested-2',
      requested_authority: {
        resource_rights: [{
          requirement_key: 'campaign',
          source: { kind: 'included_module', module_id: moduleRef.module_id, version: moduleRef.version },
          resource_type: 'campaigns',
          fields: ['subject', 'body_text'],
          right: 'read',
        }],
        classification: { review_required: true },
      },
      dependency_requirements: [{
        key: 'contacts', app_id: 'community.deft.contacts-app', version: '1.0.0', status: 'ready',
        installation_id: 'contacts-installation', active_version: '1.0.0', lifecycle_epoch: 2,
      }],
      connector_requirements: [{
        key: 'mail',
        provider_kind: 'mcp',
        required_operations: ['send_email'],
        current_binding: {
          mcp_connection_id: 'connection-1', name: 'Sandbox mail', binding_digest: 'sha256:binding',
          authorization_version: 3, configured: true,
        },
        candidates: [{
          id: 'connection-1', name: 'Sandbox mail', status: 'configured', eligible_for_review: true,
          authorization_version: 3, provider_schema_check: 'pending_review',
        }],
      }],
      missing_binding_keys: [],
      readiness: { dependencies_ready: true, connector_candidates_ready: true },
    },
    dependencies: [{
      id: 'dependency-1', grant_snapshot_id: 'effective-1', dependency_key: 'contacts',
      required_app_id: 'community.deft.contacts-app', required_version: '1.0.0',
      dependency_installation_id: 'contacts-installation', dependency_version_id: 'contacts-version',
      dependency_lifecycle_epoch: 2, ownership: 'preexisting', lock_digest: 'sha256:lock',
    }],
    action_bindings: [{
      id: 'binding-1', grant_snapshot_id: 'effective-1', action_key: 'send',
      capability_requirement_key: 'send_email', connector_requirement_key: 'mail',
      interface_identity: 'private:app_lineage:send_email:1', provider_kind: 'mcp',
      mcp_connection_id: 'connection-1', operation_name: 'send_email', operation_schema_digest: 'sha256:schema',
      connector_authorization_version: 3, binding_digest: 'sha256:binding',
      host_policy: {
        risk_class: 'external_write', review_requirement: 'always', review_scope: 'full', egress_class: 'external',
        retry_class: 'idempotent_with_key', retention_class: 'standard', automation_eligibility: 'denied',
        provider_idempotency_key_required: true,
      },
    }],
    recent_runs: [{
      id: 'run-1', state: 'pending_approval', operation_name: 'send_email',
      safe_preview: { title: 'Send campaign', summary: 'One recipient' }, safe_outcome: null,
      risk_class: 'external_write', review_requirement: 'always',
      result_expires_at: '2026-09-08T00:02:00.000Z', result_purged_at: null, terminal_at: null,
      created_at: '2026-09-01T00:02:00.000Z', updated_at: '2026-09-01T00:02:00.000Z',
    }],
  } });

  assert.deepEqual(grants.compatibility, compatibility);
  assert.deepEqual(grants.versions[0].provenance, provenance);
  assert.equal(grants.versions[0].provenance_trust, 'local_unsigned');
  assert.equal(grants.review_target?.activation_kind, 'upgrade');
  assert.equal(grants.review_target?.dependency_requirements[0].status, 'ready');
  assert.deepEqual(grants.review_target?.connector_requirements[0].required_operations, ['send_email']);
  assert.deepEqual(grants.review_target?.missing_binding_keys, []);
  assert.equal(grants.snapshots.find((snapshot) => snapshot.snapshot_kind === 'effective')?.snapshot_digest, 'sha256:effective');
  assert.equal(grants.action_bindings[0].grant_snapshot_id, 'effective-1');
  assert.equal(grants.dependencies[0].grant_snapshot_id, 'effective-1');
  assert.deepEqual(grants.recent_runs[0], {
    id: 'run-1', state: 'pending_approval', title: 'Send campaign', summary: 'One recipient', outcome_summary: null,
    operation_name: 'send_email', risk_class: 'external_write', review_requirement: 'always',
    result_expires_at: '2026-09-08T00:02:00.000Z', result_purged_at: null, terminal_at: null,
    created_at: '2026-09-01T00:02:00.000Z', updated_at: '2026-09-01T00:02:00.000Z',
  });
});

test('App Run receipt normalization returns only the bounded verified projection', () => {
  const raw = {
    run: {
      id: 'run-1',
      state: 'succeeded',
      operation_name: 'send_email',
      safe_preview: { title: 'Send campaign', summary: 'One recipient' },
      safe_outcome: { summary: 'Accepted by provider' },
      risk_class: 'external_write',
      review_requirement: 'always',
      review_scope: 'full',
      retry_class: 'idempotent_with_key',
      retention_class: 'standard',
      result_expires_at: '2026-09-08T00:02:00.000Z',
      result_purged_at: null,
      envelope: { secret: 'forbidden-run-envelope' },
      signature: 'forbidden-run-signature',
      signature_hmac: 'forbidden-run-hmac',
      actor: { user_id: 'forbidden-run-actor' },
      provider: { provider_instance_id: 'forbidden-run-provider' },
    },
    receipts: [{
      receipt_id: 'receipt-1',
      receipt_kind: 'attempt_terminal',
      run_state: 'succeeded',
      occurred_at: '2026-09-01T00:02:00.000Z',
      envelope_digest: 'sha256:receipt',
      signing_key_version: 'sig-v1',
      signed_at: '2026-09-01T00:02:00.000Z',
      verified: true,
      envelope: { secret: 'forbidden-receipt-envelope' },
      signature: 'forbidden-receipt-signature',
      signature_hmac: 'forbidden-receipt-hmac',
      actor: { user_id: 'forbidden-receipt-actor' },
      provider: { provider_instance_id: 'forbidden-receipt-provider' },
    }],
    envelope: { secret: 'forbidden-bundle-envelope' },
    signature: 'forbidden-bundle-signature',
    actor: { user_id: 'forbidden-bundle-actor' },
    provider: { provider_instance_id: 'forbidden-bundle-provider' },
  };

  const bundle = normalizeAppRunReceiptBundle(raw);
  assert.deepEqual(bundle, {
    run: {
      id: 'run-1',
      state: 'succeeded',
      operation_name: 'send_email',
      title: 'Send campaign',
      summary: 'One recipient',
      outcome_summary: 'Accepted by provider',
      risk_class: 'external_write',
      review_requirement: 'always',
      review_scope: 'full',
      retry_class: 'idempotent_with_key',
      retention_class: 'standard',
      result_expires_at: '2026-09-08T00:02:00.000Z',
      result_purged_at: null,
    },
    receipts: [{
      receipt_id: 'receipt-1',
      receipt_kind: 'attempt_terminal',
      run_state: 'succeeded',
      occurred_at: '2026-09-01T00:02:00.000Z',
      envelope_digest: 'sha256:receipt',
      signing_key_version: 'sig-v1',
      signed_at: '2026-09-01T00:02:00.000Z',
      verified: true,
    }],
  });

  const serialized = JSON.stringify(bundle);
  for (const forbidden of [
    'forbidden-run-envelope', 'forbidden-run-signature', 'forbidden-run-hmac', 'forbidden-run-actor',
    'forbidden-run-provider', 'forbidden-receipt-envelope', 'forbidden-receipt-signature',
    'forbidden-receipt-hmac', 'forbidden-receipt-actor', 'forbidden-receipt-provider',
    'forbidden-bundle-envelope', 'forbidden-bundle-signature', 'forbidden-bundle-actor', 'forbidden-bundle-provider',
  ]) assert.doesNotMatch(serialized, new RegExp(forbidden));
});

test('App Run receipt normalization rejects an unverified receipt', () => {
  assert.throws(() => normalizeAppRunReceiptBundle({
    run: {
      id: 'run-1', state: 'succeeded', operation_name: 'send_email', safe_preview: {}, safe_outcome: null,
      risk_class: 'external_write', review_requirement: 'always', review_scope: 'full',
      retry_class: 'idempotent_with_key', retention_class: 'standard',
      result_expires_at: '2026-09-08T00:02:00.000Z', result_purged_at: null,
    },
    receipts: [{
      receipt_id: 'receipt-1', receipt_kind: 'attempt_terminal', run_state: 'succeeded',
      occurred_at: now, envelope_digest: 'sha256:receipt', signing_key_version: 'sig-v1', signed_at: now,
      verified: false,
    }],
  }), /not verified/);
});

test('review and health normalizers keep only safe management fields', () => {
  const review = normalizeConnectedAppReview({ review: {
    review_version: 'deft.app_review.v1', app_installation_id: 'installation-1', app_version_id: 'version-1',
    package_digest: 'sha256:package', requested_snapshot_id: 'requested-1', requested_snapshot_digest: 'sha256:requested',
    lifecycle_epoch: 0, grant_epoch: 0,
    permission_diff: { kind: 'initial', carry_forward_eligible: false, changed_atoms: ['action:send'], prior_authority_surface_digest: null, proposed_authority_surface_digest: 'sha256:surface' },
    classification: {}, resource_rights: [{}], dependencies: [],
    action_bindings: [{ action_key: 'send', capability_requirement_key: 'send_email', connector_requirement_key: 'mail', interface_identity: 'private:app_lineage:send_email:1', provider_kind: 'mcp', mcp_connection_id: 'connection-1', operation_name: 'send_email', operation_schema_digest: 'sha256:schema', connector_authorization_version: 1, binding_digest: 'sha256:binding' }],
    authority_surface_digest: 'sha256:surface', review_digest: 'sha256:review',
  } });
  const health = normalizeConnectedAppHealth({ health: { status: 'unhealthy', installation_id: 'installation-1', active_grant_snapshot_id: null, lifecycle_epoch: 0, grant_epoch: 0, checked_provider_schemas: true, issues: [{ code: 'APP_NOT_ACTIVE', subject_id: 'installation-1', message: 'The App is not active' }] } });
  assert.equal(review.permission_diff.kind, 'initial');
  assert.equal(review.action_bindings[0].mcp_connection_id, 'connection-1');
  assert.equal(health.issues[0].code, 'APP_NOT_ACTIVE');
});
