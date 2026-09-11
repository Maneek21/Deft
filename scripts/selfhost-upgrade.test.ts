import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildUpgradePlan, composeArgs, executeUpgradePlan, parseUpgradeArgs } from './selfhost-upgrade.ts';

test('release upgrade records the recovery set before pulling a mutable target', () => {
  const options = parseUpgradeArgs(['--prod', '--release', '--compose-file', 'compose.site.yml']);
  const plan = buildUpgradePlan(options);
  assert.deepEqual(plan.map((step) => step.label), [
    'Stop app writes',
    'Back up the stopped recovery set',
    'Pull target release images',
    'Apply versioned database upgrade',
    'Recreate app on target version',
    'Run self-host doctor',
    'Run connector smoke test',
  ]);
  assert.deepEqual(composeArgs(options), [
    'compose',
    '-f', 'docker-compose.yml',
    '-f', 'compose.prod.yml',
    '-f', 'compose.release.yml',
    '-f', 'compose.site.yml',
  ]);
  const backup = plan.find((step) => step.label === 'Back up the stopped recovery set');
  assert.ok(backup?.args.includes('--app-stopped'));
});

test('upgrade flags remove only explicitly skipped gates', () => {
  const options = parseUpgradeArgs(['--no-backup', '--skip-build', '--skip-doctor', '--skip-smoke']);
  const labels = buildUpgradePlan(options).map((step) => step.label);
  assert.deepEqual(labels, [
    'Stop app writes',
    'Apply versioned database upgrade',
    'Recreate app on target version',
  ]);
});

test('unknown options are rejected', () => {
  assert.throws(() => parseUpgradeArgs(['--force-magic']), /Unknown option/);
});

test('failure before migration restarts the previous app', async () => {
  const options = parseUpgradeArgs(['--skip-build', '--skip-doctor', '--skip-smoke']);
  const observed: string[] = [];
  await assert.rejects(executeUpgradePlan(options, async (step) => {
    observed.push(step.label);
    if (step.label === 'Back up the stopped recovery set') throw new Error('backup failed');
  }), /backup failed/);
  assert.deepEqual(observed, [
    'Stop app writes',
    'Back up the stopped recovery set',
    'Restart previous app container',
  ]);
});

for (const failureLabel of [
  'Apply versioned database upgrade',
  'Recreate app on target version',
  'Run self-host doctor',
  'Run connector smoke test',
]) {
  test(`failure at ${failureLabel} leaves the previous app stopped`, async () => {
    const options = parseUpgradeArgs(['--skip-build']);
    const observed: string[] = [];
    await assert.rejects(executeUpgradePlan(options, async (step) => {
      observed.push(step.label);
      if (step.label === failureLabel) throw new Error('injected failure');
    }), /injected failure/);
    assert.equal(observed.includes('Restart previous app container'), false);
    assert.equal(observed.at(-1), 'Stop app after failed upgrade');
  });
}
