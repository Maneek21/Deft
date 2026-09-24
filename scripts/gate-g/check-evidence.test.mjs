import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkEvidence } from './check-evidence.mjs';

const requiredFile = join(process.cwd(), 'test', 'boundary.test.ts');
const profile = { id: 'required', cases: [{ file: requiredFile, name: 'denies stale authority' }] };
const passed = { type: 'test:pass', file: requiredFile, name: 'denies stale authority', testType: 'test' };
const summary = { type: 'test:summary', nesting: 0, success: true, counts: { tests: 1, passed: 1, failed: 0, skipped: 0, todo: 0, cancelled: 0 } };

test('requires every case, final completion and no skipped work', () => {
  assert.equal(checkEvidence(profile, [passed, summary]).passed, true);
  for (const events of [
    [summary],
    [passed],
    [summary, passed],
    [{ ...passed, skip: 'flag disabled' }, summary],
    [{ ...passed, todo: true }, summary],
    [{ ...passed, type: 'test:fail' }, summary],
    [passed, passed, summary],
    [passed, { ...summary, success: false }],
    [passed, { ...summary, counts: { cancelled: 1 } }],
    [passed, { ...summary, counts: undefined }],
    [passed, { ...summary, counts: { ...summary.counts, passed: 100 } }],
    [passed, { ...summary, counts: { ...summary.counts, passed: 0 } }],
    [{ ...passed, file: join(process.cwd(), 'foreign', 'test', 'boundary.test.ts') }, summary],
    [{ ...passed, file: 'wrong/test/boundary.test.ts.evil' }, summary],
  ]) assert.equal(checkEvidence(profile, events).passed, false);
});

test('rejects empty or duplicated inventories and failures outside required cases', () => {
  assert.throws(() => checkEvidence({ cases: [] }, []), /inventory/);
  assert.throws(() => checkEvidence({ cases: [profile.cases[0], profile.cases[0]] }, []), /Duplicate/);
  assert.equal(checkEvidence(profile, [passed, { type: 'test:fail', name: 'unexpected failure' }, summary]).passed, false);
});

test('checks actual Node reporter output, including a green runner with a skipped requirement', () => {
  const directory = mkdtempSync(join(tmpdir(), 'deft-evidence-check-'));
  try {
    const fixture = join(directory, 'probe.test.mjs');
    const reporter = new URL('./acceptance-reporter.mjs', import.meta.url).href;
    const inventory = { id: 'probe', cases: [{ file: fixture, name: 'required probe' }] };
    for (const skipped of [false, true]) {
      writeFileSync(fixture, `import test from 'node:test'; test('required probe', { skip: ${skipped} }, () => {});`);
      const childEnv = { ...process.env };
      delete childEnv.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, fixture], {
        encoding: 'utf8', env: childEnv, timeout: 30_000,
      });
      assert.equal(result.status, 0, result.stderr);
      const events = result.stdout.trim().split(/\r?\n/).map(JSON.parse);
      assert.equal(checkEvidence(inventory, events).passed, !skipped);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
