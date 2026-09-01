import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { digestSupportedModuleManifest } from '../../packages/shared/src/index.js';
import {
  __test,
  assembleContinuitySnapshot,
  certificationContinuityTables,
  classifySucceededPayloadEvidence,
  deterministicCertificationKeyring,
  parseCliArgs,
} from './app-platform-phase5-certification-probe.js';

test('persisted proof Module digest matches the normalized connected manifest', async () => {
  const manifest = JSON.parse(await readFile(new URL(
    '../../examples/connected-resource-campaigns-app/modules/resource-campaigns/deft.module.json',
    import.meta.url,
  ), 'utf8')) as unknown;
  assert.equal(
    await digestSupportedModuleManifest(manifest),
    __test.EXPECTED_MODULE_MANIFEST_DIGEST,
  );
});

test('deterministic disposable keyring exactly matches the Phase 5 lifecycle fixture', () => {
  const keyring = deterministicCertificationKeyring();
  assert.deepEqual(keyring, {
    schema_version: 'deft.app_run_keyring.v1',
    run_encryption: {
      current: 'enc-v1',
      keys: { 'enc-v1': 'U7cF09jO6DwXGV6YBUf+TfwBMvSYW4qvCci2G0GsXtI=' },
    },
    receipt_signing: {
      current: 'sig-v1',
      keys: { 'sig-v1': 'kRH0f7E08kqSt1e6q0f4hV0Drytvclee4ZKGhNwNxUM=' },
    },
    fingerprint: {
      current: 'fp-v1',
      keys: { 'fp-v1': 'FEh1oMo2hracqpKl6OnCCR/fUdYCXNrNf/OY6umWLLc=' },
    },
  });
});

test('disposable keyring deterministically includes every referenced historical key ID', () => {
  const keyring = deterministicCertificationKeyring({
    run_encryption: ['enc-old', 'enc-v1'],
    receipt_signing: ['sig-old'],
    fingerprint: ['fp-old', 'fp-v1'],
  });
  assert.deepEqual(Object.keys(keyring.run_encryption.keys), ['enc-old', 'enc-v1']);
  assert.deepEqual(Object.keys(keyring.receipt_signing.keys), ['sig-old', 'sig-v1']);
  assert.deepEqual(Object.keys(keyring.fingerprint.keys), ['fp-old', 'fp-v1']);
  assert.equal(
    keyring.run_encryption.keys['enc-old'],
    deterministicCertificationKeyring({ run_encryption: ['enc-old'] })
      .run_encryption.keys['enc-old'],
  );
});

test('CLI modes require the exact output and expected-snapshot surfaces', () => {
  assert.deepEqual(parseCliArgs(['keyring', '--output', 'keys.json']), {
    mode: 'keyring', output: resolve('keys.json'),
  });
  assert.deepEqual(parseCliArgs(['snapshot', '--output', 'before.json']), {
    mode: 'snapshot', output: resolve('before.json'),
  });
  assert.deepEqual(parseCliArgs([
    'verify', '--expected-snapshot', 'before.json', '--output', 'after.json',
  ]), {
    mode: 'verify',
    expectedSnapshot: resolve('before.json'),
    output: resolve('after.json'),
  });
  assert.throws(() => parseCliArgs(['verify', '--output', 'after.json']), /USAGE_EXPECTED_SNAPSHOT_REQUIRED/);
  assert.throws(() => parseCliArgs(['snapshot', '--expected-snapshot', 'before.json', '--output', 'after.json']), /USAGE_EXPECTED_SNAPSHOT_NOT_ALLOWED/);
  assert.throws(() => parseCliArgs(['keyring', '--output', 'one', '--output', 'two']), /USAGE_UNKNOWN_OR_DUPLICATE_FLAG/);
  assert.throws(() => parseCliArgs(['verify', '--expected-snapshot', 'same', '--output', 'same']), /USAGE_OUTPUT_OVERLAPS_INPUT/);
});

test('continuity hash is deterministic, metadata-bound, and contains no row values', () => {
  const table = __test.tableSnapshot('app_runs', [{ id: 'run-1', private: 'not emitted' }]);
  const input = {
    pgvectorVersion: '0.8.1',
    migrations: [{ version: '0.3.0-preview.25', checksum: 'sha256:migration' }],
    tables: [table],
  };
  const first = assembleContinuitySnapshot(input);
  const second = assembleContinuitySnapshot(structuredClone(input));
  assert.deepEqual(first, second);
  assert.match(first.continuity_sha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(first).includes('not emitted'), false);

  const changed = assembleContinuitySnapshot({ ...input, pgvectorVersion: '0.8.2' });
  assert.notEqual(changed.continuity_sha256, first.continuity_sha256);
  assert.equal(
    assembleContinuitySnapshot({
      ...input,
      migrations: [{ version: '0.3.0-preview.26', checksum: 'sha256:track-a-migration' }],
    }, '0.3.0-preview.26').latest_migration,
    '0.3.0-preview.26',
  );
  assert.throws(
    () => assembleContinuitySnapshot(input, '0.3.0-preview.26'),
    /PHASE5_MIGRATION_NOT_CURRENT/,
  );
  assert.deepEqual(__test.parseContinuitySnapshot(first), first);
  assert.throws(
    () => __test.parseContinuitySnapshot({ ...first, continuity_sha256: `sha256:${'0'.repeat(64)}` }),
    /EXPECTED_SNAPSHOT_HASH_INVALID/,
  );
});

test('Track A continuity adds only automation authority and fire state', () => {
  assert.deepEqual(certificationContinuityTables('false'), __test.CONTINUITY_TABLES);
  assert.deepEqual(certificationContinuityTables('true'), [
    ...__test.CONTINUITY_TABLES,
    'app_automation_definitions',
    'app_automation_fires',
  ]);
  assert.throws(
    () => certificationContinuityTables('app_automation_definitions'),
    /TRACK_A_CONTINUITY_MODE_INVALID/,
  );
});

test('restore evidence accepts only retained or explicitly purged successful payloads', () => {
  assert.equal(classifySucceededPayloadEvidence({
    input_purged: false,
    result_purged: false,
    retained_input: true,
    retained_output: true,
    safe_outcome: { result_status: 'available' },
  }), 'retained');
  assert.equal(classifySucceededPayloadEvidence({
    input_purged: true,
    result_purged: true,
    retained_input: false,
    retained_output: false,
    safe_outcome: { result_status: 'expired' },
  }), 'purged');
  assert.throws(() => classifySucceededPayloadEvidence({
    input_purged: true,
    result_purged: true,
    retained_input: true,
    retained_output: false,
    safe_outcome: { result_status: 'expired' },
  }), /APP_RUN_INPUT_PURGE_EVIDENCE_INVALID/);
  assert.throws(() => classifySucceededPayloadEvidence({
    input_purged: true,
    result_purged: true,
    retained_input: false,
    retained_output: false,
    safe_outcome: { result_status: 'available' },
  }), /APP_RUN_RESULT_PURGE_EVIDENCE_INVALID/);
});
