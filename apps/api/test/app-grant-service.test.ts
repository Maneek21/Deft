import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DeftAppManifestV0Schema, projectDeftAppRequestedAuthority } from '@deft/app-kit';
import { buildRequestedAppGrantProjection } from '../src/lib/app-grant-service.js';
import {
  connectedAppActionBindingMatches,
  getConnectedAppPrivateInterface,
} from '../src/lib/app-connected-contract.js';
import { buildPhase5ConnectedAppPackage } from './fixtures/phase5-connected-app-package.js';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const INSTALLATION_ID = '22222222-2222-4222-8222-222222222222';
const VERSION_ID = '33333333-3333-4333-8333-333333333333';
const MANIFEST_DIGEST = `sha256:${'1'.repeat(64)}`;
const PACKAGE_DIGEST = `sha256:${'2'.repeat(64)}`;

test('Protocol v1 staging projection is deterministic and explicitly non-executable', async () => {
  const built = await buildPhase5ConnectedAppPackage();
  const input = {
    organization_id: ORG_ID,
    app_installation_id: INSTALLATION_ID,
    app_version_id: VERSION_ID,
    manifest: built.package.manifest,
    manifest_digest: built.package.manifest_digest,
    package_digest: built.digest,
  };
  const first = buildRequestedAppGrantProjection(input);
  const replay = buildRequestedAppGrantProjection(structuredClone(input));

  assert.deepEqual(replay, first);
  assert.equal(
    first.snapshot_digest,
    'sha256:2464c10f3a480c8d5d7f75c7923f8231a311bcdeb6dbfb584c8a0d7449572bed',
  );
  assert.equal(first.resource_rights.length, 2);
  assert.equal(first.classification.authority_state, 'requested_only');
  assert.equal(first.classification.executable, false);
  assert.equal(first.classification.provider_access, false);
  assert.equal(first.classification.review_required, true);
  assert.doesNotMatch(JSON.stringify(first.canonical_snapshot), /deft\.private\.v1:/);
  const portable = projectDeftAppRequestedAuthority(built.package.manifest);
  assert.deepEqual((first.canonical_snapshot as any).requirements, portable.requirements);
  assert.deepEqual(first.resource_rights, portable.resource_rights);
  assert.deepEqual(first.classification, portable.classification);
});

test('Protocol v0 staging projection is an empty compatibility request', () => {
  const manifest = DeftAppManifestV0Schema.parse({
    schema_version: '0',
    id: 'community.deft.compatibility-app',
    version: '1.0.0',
    name: 'Compatibility App',
    license: 'AGPL-3.0-only',
    compatibility: { app_protocol: '0' },
    modules: [{
      module_id: 'community.deft.compatibility',
      version: '1.0.0',
      manifest_path: 'modules/compatibility/deft.module.json',
      manifest_digest: MANIFEST_DIGEST,
    }],
    navigation: [],
  });
  const projection = buildRequestedAppGrantProjection({
    organization_id: ORG_ID,
    app_installation_id: INSTALLATION_ID,
    app_version_id: VERSION_ID,
    manifest,
    manifest_digest: MANIFEST_DIGEST,
    package_digest: PACKAGE_DIGEST,
  });

  assert.deepEqual(projection.resource_rights, []);
  assert.equal(projection.classification.executable, false);
  assert.equal(projection.classification.provider_access, false);
  assert.equal(projection.classification.review_required, false);
  assert.deepEqual(projection.classification.actions, []);
});

test('connected sandbox actions accept only the frozen resource-backed input mapping', async () => {
  const built = await buildPhase5ConnectedAppPackage();
  const action = built.package.manifest.actions[0]!;
  const requirement = built.package.manifest.capability_requirements.find(
    (candidate) => candidate.key === action.capability_requirement_key,
  );
  assert.ok(requirement);
  const privateInterface = getConnectedAppPrivateInterface(requirement.interface);
  assert.ok(privateInterface);
  assert.equal(connectedAppActionBindingMatches(privateInterface, action), true);

  const unsupported = {
    ...action,
    input_bindings: action.input_bindings.map((binding) => binding.input_key === 'subject'
      ? {
          ...binding,
          source: { kind: 'user_input' as const, input_type: 'text' as const, label: 'Subject' },
        }
      : binding),
  } as typeof action;
  assert.equal(connectedAppActionBindingMatches(privateInterface, unsupported), false);
});

test('grant staging code has no provider, connector runtime, approval, or Run dependency', () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  for (const sourceFile of ['app-grant-service.ts', 'app-service.ts']) {
    const source = readFileSync(resolve(testDir, '..', 'src', 'lib', sourceFile), 'utf8');
    for (const forbiddenImport of [
      'capability-service',
      'capability-providers',
      'mcp-client',
      'mcp-runtime',
      'app-run-service',
      'approval',
    ]) {
      assert.doesNotMatch(
        source,
        new RegExp(`from ['\"][^'\"]*${forbiddenImport}`, 'i'),
        `${sourceFile} must not import ${forbiddenImport}`,
      );
    }
  }
});

test('connected review uses Capability Service discovery but cannot invoke or create Runs', () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(resolve(testDir, '..', 'src', 'lib', 'app-review-service.ts'), 'utf8');
  assert.match(source, /from ['"]\.\/capability-service\.js['"]/);
  for (const forbiddenImport of [
    'capability-providers',
    'mcp-client',
    'mcp-runtime',
    'app-run-service',
    'app-run-runtime',
    'approval',
  ]) {
    assert.doesNotMatch(
      source,
      new RegExp(`from ['"][^'"]*${forbiddenImport}`, 'i'),
      `review lifecycle must not import ${forbiddenImport}`,
    );
  }
  assert.doesNotMatch(source, /\.invoke\s*\(/);
});
