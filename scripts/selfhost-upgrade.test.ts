import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildUpgradePlan, composeArgs, parseUpgradeArgs } from './selfhost-upgrade.ts';

test('release upgrade plan minimizes downtime and backs up before migration', () => {
  const options = parseUpgradeArgs(['--prod', '--release', '--compose-file', 'compose.site.yml']);
  const plan = buildUpgradePlan(options);
  assert.deepEqual(plan.map((step) => step.label), [
    'Pull target release images before downtime',
    'Stop app writes',
    'Back up the stopped database',
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
