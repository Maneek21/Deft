import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  baselineChecksum,
  describeMissingRequirements,
  parseUpgradeArgs,
  validateAppliedMigrations,
} from './upgrade.ts';
import { upgradeManifest } from '../upgrades/manifest.ts';

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

test('security redaction upgrade removes every legacy cached excerpt surface', () => {
  const migration = upgradeManifest.migrations.find(
    (item) => item.version === '0.2.0-preview.4',
  );
  assert.ok(migration, 'security redaction migration must remain in the supported upgrade path');

  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(resolve(scriptsDir, '..', 'upgrades', migration.file), 'utf8');
  assert.match(sql, /UPDATE cross_references[\s\S]*SET context = NULL/i);
  assert.match(sql, /UPDATE task_comments[\s\S]*SET is_deleted = true/i);
  assert.match(sql, /position\(cr\.context in tc\.content\) > 0/i);
  assert.match(sql, /UPDATE reminders[\s\S]*message = 'Message reminder'/i);
  assert.match(sql, /UPDATE notifications[\s\S]*title = 'Message reminder'/i);
  assert.match(sql, /UPDATE messages[\s\S]*metadata = m\.metadata - 'clip_summary'/i);
  assert.match(sql, /UPDATE clips[\s\S]*SET summary = NULL/i);
  assert.ok(
    sql.indexOf('UPDATE task_comments') < sql.indexOf('UPDATE cross_references'),
    'generated comments must be correlated with stored excerpts before the excerpts are redacted',
  );
});
