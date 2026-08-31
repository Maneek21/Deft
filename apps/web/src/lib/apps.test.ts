import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isConnectedAppManifest,
  normalizeAppGrantManagement,
  normalizeAppInstallation,
  normalizeConnectedAppHealth,
  normalizeConnectedAppReview,
} from './apps';

const moduleRef = {
  module_id: 'community.deft.campaigns',
  version: '1.0.0',
  manifest_path: 'modules/campaigns/deft.module.json',
  manifest_digest: 'sha256:module',
};

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
    } : {
      schema_version: '1',
      id: 'community.deft.campaigns-app',
      version: '1.0.0',
      name: 'Campaigns',
      license: 'AGPL-3.0-only',
      compatibility: { app_protocol: '1' },
      modules: [moduleRef],
      navigation: [],
      dependencies: [{ key: 'contacts', app_id: 'community.deft.contacts-app', version: '1.0.0' }],
      resource_requirements: [{ key: 'campaign', resource_type: 'campaigns', fields: ['subject'] }],
      capability_requirements: [{ key: 'send_email' }],
      connector_requirements: [{ key: 'mail', provider_kind: 'mcp' }],
      actions: [{ key: 'send', label: 'Send', capability_requirement_key: 'send_email', connector_requirement_key: 'mail' }],
    },
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
  };
}

test('App installation normalization preserves v0 and discriminates connected v1 manifests', () => {
  const v0 = normalizeAppInstallation(installation('0'));
  const v1 = normalizeAppInstallation(installation('1'));
  assert.equal(isConnectedAppManifest(v0.manifest), false);
  assert.equal(isConnectedAppManifest(v1.manifest), true);
  if (isConnectedAppManifest(v1.manifest)) assert.equal(v1.manifest.actions[0].key, 'send');
});

test('connected grant management projects requested, effective, binding, dependency, and recent Run data', () => {
  const grants = normalizeAppGrantManagement({ grants: {
    installation: {
      id: 'installation-1', app_id: 'community.deft.campaigns-app', state: 'active', active_version_id: 'version-1',
      active_grant_snapshot_id: 'effective-1', lifecycle_epoch: 1, grant_epoch: 1,
    },
    versions: [{
      id: 'version-1', version: '1.0.0', protocol_version: '1', state: 'active', package_digest: 'sha256:package',
      manifest_digest: 'sha256:manifest', requested_grant_snapshot_id: 'requested-1', staged_at: '2026-09-01T00:00:00.000Z',
      activated_at: '2026-09-01T00:01:00.000Z', superseded_at: null,
    }],
    snapshots: [
      { id: 'requested-1', app_version_id: 'version-1', snapshot_kind: 'requested', requested_snapshot_id: null, supersedes_snapshot_id: null, resource_rights: [{}], classification: {}, snapshot_digest: 'sha256:requested', reviewed_at: null, created_at: '2026-09-01T00:00:00.000Z' },
      { id: 'effective-1', app_version_id: 'version-1', snapshot_kind: 'effective', requested_snapshot_id: 'requested-1', supersedes_snapshot_id: null, resource_rights: [{}], classification: {}, snapshot_digest: 'sha256:effective', reviewed_at: '2026-09-01T00:01:00.000Z', created_at: '2026-09-01T00:01:00.000Z' },
    ],
    dependencies: [{ id: 'dependency-1', dependency_key: 'contacts', required_app_id: 'community.deft.contacts-app', required_version: '1.0.0', dependency_installation_id: 'contacts-installation', dependency_version_id: 'contacts-version', dependency_lifecycle_epoch: 2, ownership: 'preexisting', lock_digest: 'sha256:lock' }],
    action_bindings: [{
      id: 'binding-1', action_key: 'send', capability_requirement_key: 'send_email', connector_requirement_key: 'mail',
      interface_identity: 'private:app_lineage:send:1', provider_kind: 'mcp', mcp_connection_id: 'connection-1', operation_name: 'sandbox_send',
      operation_schema_digest: 'sha256:schema', connector_authorization_version: 3, binding_digest: 'sha256:binding',
      host_policy: { risk_class: 'external_write', review_requirement: 'per_invocation', review_scope: 'full', egress_class: 'external', retry_class: 'idempotent', retention_class: 'standard', automation_eligibility: 'denied', provider_idempotency_key_required: true },
    }],
    recent_runs: [{ id: 'run-1', state: 'pending_approval', safe_preview: { title: 'Send campaign', summary: 'One recipient' }, safe_outcome: null, created_at: '2026-09-01T00:02:00.000Z', updated_at: '2026-09-01T00:02:00.000Z' }],
  } });

  assert.equal(grants.snapshots.find((snapshot) => snapshot.snapshot_kind === 'effective')?.snapshot_digest, 'sha256:effective');
  assert.equal(grants.action_bindings[0].mcp_connection_id, 'connection-1');
  assert.equal(grants.dependencies[0].ownership, 'preexisting');
  assert.deepEqual(grants.recent_runs[0], {
    id: 'run-1', state: 'pending_approval', title: 'Send campaign', summary: 'One recipient', outcome_summary: null,
    created_at: '2026-09-01T00:02:00.000Z', updated_at: '2026-09-01T00:02:00.000Z',
  });
});

test('review and health normalizers keep only safe management fields', () => {
  const review = normalizeConnectedAppReview({ review: {
    review_version: 'deft.app_review.v1', app_installation_id: 'installation-1', app_version_id: 'version-1',
    package_digest: 'sha256:package', requested_snapshot_id: 'requested-1', requested_snapshot_digest: 'sha256:requested',
    lifecycle_epoch: 0, grant_epoch: 0,
    permission_diff: { kind: 'initial', carry_forward_eligible: false, changed_atoms: ['action:send'], prior_authority_surface_digest: null, proposed_authority_surface_digest: 'sha256:surface' },
    classification: {}, resource_rights: [{}], dependencies: [],
    action_bindings: [{ action_key: 'send', capability_requirement_key: 'send_email', connector_requirement_key: 'mail', interface_identity: 'private:send:1', provider_kind: 'mcp', mcp_connection_id: 'connection-1', operation_name: 'sandbox_send', operation_schema_digest: 'sha256:schema', connector_authorization_version: 1, binding_digest: 'sha256:binding' }],
    authority_surface_digest: 'sha256:surface', review_digest: 'sha256:review',
  } });
  const health = normalizeConnectedAppHealth({ health: { status: 'unhealthy', installation_id: 'installation-1', active_grant_snapshot_id: null, lifecycle_epoch: 0, grant_epoch: 0, checked_provider_schemas: true, issues: [{ code: 'APP_NOT_ACTIVE', subject_id: 'installation-1', message: 'The App is not active' }] } });
  assert.equal(review.permission_diff.kind, 'initial');
  assert.equal(review.action_bindings[0].mcp_connection_id, 'connection-1');
  assert.equal(health.issues[0].code, 'APP_NOT_ACTIVE');
});
