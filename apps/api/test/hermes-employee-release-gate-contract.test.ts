import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  API_SUITES,
  SUITE_CONTRACT,
  assertDisposableDatabaseName,
  buildCertificateV2,
  parseBundleEvidence,
  removeStaleCertificate,
} from '../src/scripts/hermes-employee-release-gate.js';

const MANIFEST_DIGEST = `sha256:${'a'.repeat(64)}`;
const CONTENT_DIGEST = `sha256:${'b'.repeat(64)}`;

test('database reset guard requires an explicit Deft disposable suffix', () => {
  for (const name of ['deft_test', 'deft_hermes_gate_test', 'deft_release_ci', 'deft_agent_gauntlet']) {
    assert.doesNotThrow(() => assertDisposableDatabaseName(name));
  }
  for (const name of ['deft', 'deft_social', 'deft_test_backup', 'production_test', 'deft-test']) {
    assert.throws(() => assertDisposableDatabaseName(name), /refusing to reset database/);
  }
});

test('certificate v2 exposes stable native, fallback, common, and bundle suite roles', () => {
  assert.equal(new Set(SUITE_CONTRACT.map(({ id }) => id)).size, SUITE_CONTRACT.length);
  assert.deepEqual(SUITE_CONTRACT, [
    { id: 'deft.database.fresh_schema', role: 'clean_state_database' },
    { id: 'deft.database.demo_seed', role: 'clean_state_database' },
    { id: 'deft.api.employee_boundary', role: 'api_boundary' },
    { id: 'hermes.native.deft-platform', role: 'default_adapter' },
    { id: 'hermes.legacy.agent-channel', role: 'fallback_adapter' },
    { id: 'hermes.legacy.channel-service', role: 'fallback_adapter' },
    { id: 'hermes.common.deft-employee', role: 'common_plugin' },
    { id: 'hermes.common.deft-memory', role: 'common_plugin' },
    { id: 'deft.hermes.bundle.build', role: 'bundle_build' },
    { id: 'deft.hermes.bundle.verify', role: 'bundle_verification' },
  ]);
  assert.ok(API_SUITES.includes('test/hermes-native-onboarding.test.ts'));
  assert.ok(API_SUITES.includes('test/agent-runtime-recovery.test.ts'));
  assert.ok(API_SUITES.includes('test/agent-actions-task-project-boundary.test.ts'));
  assert.ok(API_SUITES.includes('test/agent-context-project-scope.test.ts'));
  assert.ok(API_SUITES.includes('test/defty-identity-boundary.test.ts'));
  assert.ok(API_SUITES.includes('test/mcp-platform-context.test.ts'));
  assert.ok(API_SUITES.includes('test/mcp-task-project-boundary.test.ts'));
  assert.ok(API_SUITES.includes('test/mcp-task-query-project-scope.test.ts'));
  assert.ok(API_SUITES.includes('test/mcp-team-context.test.ts'));
});

test('bundle verifier evidence requires the settled schema and prefixed SHA-256 digests', () => {
  const parsed = parseBundleEvidence({
    schema: 'deft.hermes.integration.bundle_evidence.v1',
    manifest_sha256: MANIFEST_DIGEST,
    content_sha256: CONTENT_DIGEST,
    manifest: { schema: 'deft.hermes.integration.v2' },
  });
  assert.equal(parsed.manifest_sha256, MANIFEST_DIGEST);
  assert.equal(parsed.content_sha256, CONTENT_DIGEST);
  assert.throws(
    () => parseBundleEvidence({
      schema: 'deft.hermes.integration.bundle_evidence.v1',
      manifest_sha256: 'a'.repeat(64),
      content_sha256: CONTENT_DIGEST,
      manifest: {},
    }),
    /sha256:<64 lowercase hex>/,
  );
  assert.throws(
    () => parseBundleEvidence({
      schema: 'deft.hermes.integration.bundle_evidence.v0',
      manifest_sha256: MANIFEST_DIGEST,
      content_sha256: CONTENT_DIGEST,
      manifest: {},
    }),
    /unsupported schema/,
  );
});

test('certificate v2 has the exact release, runtime, adapter, digest, and pass shape', () => {
  const suites = SUITE_CONTRACT.map((definition) => ({ ...definition, result: 'passed' as const }));
  const passes = [1, 2].map((pass) => ({
    pass,
    completed_at: `2026-08-26T00:00:0${pass}.000Z`,
    suites,
    bundle: { manifest_sha256: MANIFEST_DIGEST, content_sha256: CONTENT_DIGEST },
  }));
  const certificate = buildCertificateV2({
    deft: {
      release: '0.3.0-preview.12',
      expected_tag: 'v0.3.0-preview.12',
      tag_verified: false,
      commit: 'c'.repeat(40),
    },
    hermes: {
      declared_compatibility: '>=0.20.5 <0.21.0',
      tested_runtime: {
        distribution: 'hermes-agent',
        version: '0.20.5',
        repository: 'https://github.com/NousResearch/hermes-agent.git',
        ref: 'refs/tags/v2026.8.19',
        commit: 'd'.repeat(40),
        python_version: '3.11.15',
      },
    },
    integration: {
      schema: 'deft.hermes.integration.v2',
      version: '0.4.0',
      default_adapter: { id: 'native', name: 'deft-platform', version: '0.2.0' },
      fallback_adapters: [{ id: 'legacy', name: 'deft-agent-channel-bridge', version: '0.3.0' }],
      manifest_sha256: MANIFEST_DIGEST,
      content_sha256: CONTENT_DIGEST,
    },
    passes,
  });

  assert.deepEqual(Object.keys(certificate), [
    'schema',
    'result',
    'source_tree_clean',
    'clean_state_database',
    'consecutive_passes',
    'deft',
    'hermes',
    'integration',
    'passes',
  ]);
  assert.equal(certificate.schema, 'deft.hermes.employee.release_gate.v2');
  assert.equal(certificate.result, 'passed');
  assert.equal(certificate.source_tree_clean, true);
  assert.equal(certificate.clean_state_database, true);
  assert.equal(certificate.consecutive_passes, 2);
  assert.deepEqual(certificate.passes, passes);
  assert.throws(() => buildCertificateV2({
    deft: certificate.deft,
    hermes: certificate.hermes,
    integration: certificate.integration,
    passes: [passes[0]!],
  }), /exactly two/);
});

test('stale certificate removal is idempotent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'deft-hermes-gate-'));
  const path = join(directory, 'certificate.json');
  try {
    writeFileSync(path, '{"stale":true}\n', 'utf8');
    removeStaleCertificate(path);
    assert.equal(existsSync(path), false);
    removeStaleCertificate(path);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
