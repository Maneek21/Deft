import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  baselineChecksum,
  describeMissingRequirements,
  parseUpgradeArgs,
  validateAppliedMigrations,
} from './upgrade.ts';

test('parseUpgradeArgs recognizes status and dry run', () => {
  assert.deepEqual(parseUpgradeArgs(['--status']), { status: true, dryRun: false });
  assert.deepEqual(parseUpgradeArgs(['--dry-run']), { status: false, dryRun: true });
  assert.throws(() => parseUpgradeArgs(['--surprise']), /Unknown option/);
});

test('baseline checksum is deterministic', () => {
  assert.match(baselineChecksum(), /^[a-f0-9]{64}$/);
  assert.equal(baselineChecksum(), baselineChecksum());
});

test('missing schema requirements are described precisely', () => {
  const requirements = [
    { table: 'orgs' },
    { table: 'users', column: 'notification_preferences' },
  ];
  assert.deepEqual(describeMissingRequirements(requirements, new Set(['orgs'])), [
    'users.notification_preferences',
  ]);
});

test('applied migration validation rejects unknown and changed versions', () => {
  assert.throws(
    () => validateAppliedMigrations(
      [{ version: '9.9.9', checksum: 'x', kind: 'migration' }],
      [],
      new Map(),
    ),
    /newer than this Deft build/,
  );
  assert.throws(
    () => validateAppliedMigrations(
      [{ version: '0.2.0-preview.1', checksum: 'changed', kind: 'baseline' }],
      [],
      new Map(),
    ),
    /Checksum mismatch/,
  );
});
