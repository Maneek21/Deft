import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  DEFT_APP_DEVELOPER_COMPATIBILITY,
  DEFT_APP_KIT_VERSION,
  SANDBOX_EMAIL_SEND_CONFORMANCE_VECTORS,
  SandboxEmailSendInputSchema,
  SandboxEmailSendOutputSchema,
  buildDeftAppPackage,
  buildDeftAppRequestedAuthorityReport,
  canonicalDeftAppRequestedAuthorityReportJson,
  checkDeftAppDeveloperContract,
  parseDeftAppDeveloperCompatibility,
  parseDeftAppManifestJson,
  prepareModuleArtifact,
  projectDeftAppRequestedAuthority,
  resolveDeftAppDeveloperProtocolFlow,
} from '../src/index.js';

const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..');

async function exampleManifest(path: string) {
  return parseDeftAppManifestJson(await readFile(resolve(repositoryRoot, path), 'utf8'));
}

async function examplePackage(path: string) {
  const manifest = await exampleManifest(`${path}/deft.app.json`);
  const artifacts = await Promise.all(manifest.modules.map(async (moduleReference) => prepareModuleArtifact({
    path: moduleReference.manifest_path,
    manifest: JSON.parse(await readFile(
      resolve(repositoryRoot, path, moduleReference.manifest_path),
      'utf8',
    )) as unknown,
  })));
  return buildDeftAppPackage({ manifest, artifacts });
}

test('freezes one additive App Kit and protocol-flow compatibility contract', async () => {
  const packageJson = JSON.parse(
    await readFile(resolve(import.meta.dirname, '..', 'package.json'), 'utf8'),
  ) as { version: string };
  assert.equal(DEFT_APP_KIT_VERSION, packageJson.version);
  assert.deepEqual(DEFT_APP_DEVELOPER_COMPATIBILITY, {
    schema: 'deft.app_developer.compatibility.v1',
    app_kit: { package: '@deft/app-kit', versions: ['0.1.0-alpha.1'] },
    protocol_flows: {
      '0': { package_format: 'deft.app.package.v0', install_mode: 'stage_and_activate' },
      '1': { package_format: 'deft.app.package.v1', install_mode: 'stage_only' },
      '2': { package_format: 'deft.app.package.v2', install_mode: 'stage_only' },
    },
  });
  assert.equal(Object.isFrozen(DEFT_APP_DEVELOPER_COMPATIBILITY), true);
  assert.equal(Object.isFrozen(DEFT_APP_DEVELOPER_COMPATIBILITY.app_kit.versions), true);
  assert.equal(Object.isFrozen(DEFT_APP_DEVELOPER_COMPATIBILITY.protocol_flows['1']), true);
  assert.equal(Object.isFrozen(DEFT_APP_DEVELOPER_COMPATIBILITY.protocol_flows['2']), true);
  assert.deepEqual(
    resolveDeftAppDeveloperProtocolFlow(DEFT_APP_DEVELOPER_COMPATIBILITY, '0'),
    { package_format: 'deft.app.package.v0', install_mode: 'stage_and_activate' },
  );
  assert.deepEqual(
    resolveDeftAppDeveloperProtocolFlow(DEFT_APP_DEVELOPER_COMPATIBILITY, '1'),
    { package_format: 'deft.app.package.v1', install_mode: 'stage_only' },
  );
  assert.deepEqual(
    resolveDeftAppDeveloperProtocolFlow(DEFT_APP_DEVELOPER_COMPATIBILITY, '2'),
    { package_format: 'deft.app.package.v2', install_mode: 'stage_only' },
  );
  const { '2': _v2, ...legacyProtocolFlows } = DEFT_APP_DEVELOPER_COMPATIBILITY.protocol_flows;
  assert.throws(() => resolveDeftAppDeveloperProtocolFlow({
    ...DEFT_APP_DEVELOPER_COMPATIBILITY,
    protocol_flows: legacyProtocolFlows,
  }, '2'), /does not support App Protocol v2/);
  assert.throws(
    () => resolveDeftAppDeveloperProtocolFlow({
      ...DEFT_APP_DEVELOPER_COMPATIBILITY,
      app_kit: { package: '@deft/app-kit', versions: ['0.1.0-alpha.0'] },
    }, '1'),
    /does not support @deft\/app-kit 0\.1\.0-alpha\.1/,
  );
  assert.throws(
    () => parseDeftAppDeveloperCompatibility({
      ...DEFT_APP_DEVELOPER_COMPATIBILITY,
      provider_endpoint: 'https://attacker.example',
    }),
    /Unrecognized key/,
  );
});

test('checks a connected package against only the public host and provider contracts', async () => {
  const built = await examplePackage('examples/connected-resource-campaigns-app');
  const checked = await checkDeftAppDeveloperContract({
    package_json: built.json,
    host_compatibility: DEFT_APP_DEVELOPER_COMPATIBILITY,
  });
  assert.equal(checked.schema, 'deft.app_developer.contract_check.v1');
  assert.deepEqual(checked.package, {
    format: 'deft.app.package.v1',
    digest: built.digest,
    protocol_version: '1',
  });
  assert.equal(checked.install_flow.install_mode, 'stage_only');
  assert.equal(checked.requested_authority.requested_authority.classification.executable, false);
  assert.deepEqual(
    checked.sandbox_email_conformance.expected_output,
    SANDBOX_EMAIL_SEND_CONFORMANCE_VECTORS.valid.output,
  );
});

test('projects v0 as explicitly empty requested authority', async () => {
  const manifest = await exampleManifest('examples/resource-participation-contacts-app/deft.app.json');
  const projection = projectDeftAppRequestedAuthority(manifest);
  assert.deepEqual(projection.requirements, {
    dependencies: [], resources: [], capabilities: [], connectors: [], actions: [],
  });
  assert.deepEqual(projection.resource_rights, []);
  assert.deepEqual(projection.classification, {
    authority_state: 'requested_only',
    executable: false,
    provider_access: false,
    review_required: false,
    actions: [],
  });
});

test('projects connected requested authority without host identity or effective grants', async () => {
  const manifest = await exampleManifest('examples/connected-resource-campaigns-app/deft.app.json');
  const first = projectDeftAppRequestedAuthority(manifest);
  const replay = projectDeftAppRequestedAuthority(structuredClone(manifest));
  assert.deepEqual(replay, first);
  assert.equal(first.requirements.dependencies.length, 1);
  assert.equal(first.requirements.actions.length, 1);
  assert.equal(first.resource_rights.length, 2);
  assert.equal(first.resource_rights.every((right) => right.right === 'read'), true);
  assert.deepEqual(first.classification.actions[0]!.host_policy, {
    risk_class: 'external_write',
    review_requirement: 'always',
    review_scope: 'per_invocation',
    egress_class: 'email',
    retry_class: 'idempotent_with_key',
    retention_class: 'standard',
    automation_eligibility: 'forbidden',
    provider_idempotency_key_required: true,
  });

  first.requirements.dependencies.length = 0;
  first.classification.actions[0]!.host_policy.retention_class = 'standard';
  assert.equal(projectDeftAppRequestedAuthority(manifest).requirements.dependencies.length, 1);

  const report = buildDeftAppRequestedAuthorityReport(manifest);
  const json = canonicalDeftAppRequestedAuthorityReportJson(manifest);
  assert.deepEqual(JSON.parse(json), report);
  assert.equal(canonicalDeftAppRequestedAuthorityReportJson(structuredClone(manifest)), json);
  for (const forbidden of [
    '"organization_id":', '"installation_id":', '"version_id":', '"connector_id":',
    '"provider_id":', '"token":', '"secret":', '"effective_grant":', '"lineage_id":',
  ]) {
    assert.equal(json.includes(forbidden), false, forbidden);
  }
});

test('publishes provider-independent sandbox email conformance vectors', () => {
  assert.equal(SandboxEmailSendInputSchema.safeParse(
    SANDBOX_EMAIL_SEND_CONFORMANCE_VECTORS.valid.input,
  ).success, true);
  assert.equal(SandboxEmailSendOutputSchema.safeParse(
    SANDBOX_EMAIL_SEND_CONFORMANCE_VECTORS.valid.output,
  ).success, true);
  assert.deepEqual(SANDBOX_EMAIL_SEND_CONFORMANCE_VECTORS.valid.output, {
    message_id: 'sandbox_a90928f63948386da7c8a7a4',
    status: 'accepted',
  });
  assert.equal(Object.isFrozen(SANDBOX_EMAIL_SEND_CONFORMANCE_VECTORS.valid.input), true);
  for (const vector of SANDBOX_EMAIL_SEND_CONFORMANCE_VECTORS.invalid) {
    assert.equal(SandboxEmailSendInputSchema.safeParse(vector.input).success, false, vector.label);
  }
});
