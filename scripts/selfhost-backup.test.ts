import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBackupArgs } from './selfhost-backup.ts';

test('backup accepts stopped-upgrade and site overlay inputs', () => {
  assert.deepEqual(parseBackupArgs([
    '--prod', '--app-stopped', '--compose-file', 'compose.site.yml', '--backup-dir', 'safe-copy',
  ]), {
    prod: true,
    composeFiles: ['compose.site.yml'],
    backupDir: 'safe-copy',
    appStopped: true,
    dryRun: false,
  });
});

test('backup rejects unknown options', () => {
  assert.throws(() => parseBackupArgs(['--database-only']), /Unknown option/);
});
